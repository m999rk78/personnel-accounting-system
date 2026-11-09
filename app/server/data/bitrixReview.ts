import { type BitrixEmployeeSnapshot, selectBitrixEmployeesForImport, selectLinkedBitrixEmployeesForReview, type BitrixLinkLocalEmployee, suggestBitrixEmployeeLinks, compareBitrixEmployees, normalizeBitrixText, type EmployeeAvailabilityStatus } from "../../bitrix24Sync";
import { bitrixReviewUpdateIds } from "../../bitrixReviewSelection";
import { env } from "./context";
import { type UserPayload } from "./types";
import { asPositiveInteger } from "./validation";
import { validateEmployeeDirectoryValues } from "./catalogs";
import { projectOverrides } from "./bitrixSync";

export async function buildBitrixInspection(sourceSnapshot: BitrixEmployeeSnapshot[]) {
  const importSnapshot = selectBitrixEmployeesForImport(sourceSnapshot).filter(employee => !["dismissed", "deleted", "blacklisted"].includes(employee.availabilityStatus));
  const sourceById = new Map(importSnapshot.map((employee) => [employee.bitrix24Id, employee]));
  const localResult = await env.DB.prepare(`SELECT e.id, e.bitrix24_id AS bitrix24Id, e.full_name AS fullName,
    e.employment_type AS employmentType, e.department, e.position, e.bitrix24_stage AS bitrix24Stage,
    e.availability_status AS "availabilityStatus", e.active,
    STRING_AGG(DISTINCT assigned_site.name, '|||') AS "projectNames",
    STRING_AGG(DISTINCT assigned_site.code, '|||') AS "projectCodes"
    FROM employees e
    LEFT JOIN employee_project_assignments assignment ON assignment.employee_id = e.id AND assignment.active = 1
    LEFT JOIN sites assigned_site ON assigned_site.id = assignment.site_id AND assigned_site.active = 1
    WHERE e.active = 1 OR e.bitrix24_id IS NOT NULL
    GROUP BY e.id, e.bitrix24_id, e.full_name, e.employment_type, e.department, e.position, e.bitrix24_stage, e.availability_status, e.active`)
    .all<BitrixLinkLocalEmployee & { bitrix24Stage: string; availabilityStatus: EmployeeAvailabilityStatus; active: number; projectNames: string | null; projectCodes: string | null }>();
  const localEmployees = localResult.results;
  const snapshot = selectLinkedBitrixEmployeesForReview(sourceSnapshot, localEmployees.flatMap(employee => employee.bitrix24Id ? [employee.bitrix24Id] : []));
  const reviewIds = new Set(snapshot.map(employee => employee.bitrix24Id));
  const localByBitrixId = new Map(localEmployees.flatMap((employee) => employee.bitrix24Id ? [[employee.bitrix24Id, employee] as const] : []));
  // Keep all linked identities for duplicate prevention, but do not revive old
  // missing/out-of-scope warnings for unrelated archived personnel.
  const linkedEmployees = localEmployees.flatMap((employee) => employee.bitrix24Id && (employee.active === 1 || reviewIds.has(employee.bitrix24Id) || employee.availabilityStatus === "blacklisted") ? [{
    bitrix24Id: employee.bitrix24Id,
    fullName: employee.fullName,
    employmentType: employee.employmentType,
    department: employee.department,
    position: employee.position,
    bitrix24Stage: employee.bitrix24Stage,
    availabilityStatus: employee.availabilityStatus,
    active: employee.active,
    projectKeys: [...new Set((employee.projectNames?.split("|||") ?? [])
      .map((value) => value.trim())
      .filter(Boolean))],
    projectAliases: [...new Set([employee.projectNames, employee.projectCodes]
      .flatMap((value) => value?.split("|||") ?? [])
      .map((value) => value.trim())
      .filter(Boolean))],
  }] : []);
  const suggestions = suggestBitrixEmployeeLinks(importSnapshot, localEmployees);
  const suggestionById = new Map(suggestions.map((suggestion) => [suggestion.bitrix24Id, suggestion]));
  const comparison = compareBitrixEmployees(snapshot, linkedEmployees, sourceSnapshot);
  const rawDifferences = comparison.differences.map((difference) => {
    const localEmployeeId = difference.bitrix24Id ? localByBitrixId.get(difference.bitrix24Id)?.id : undefined;
    if (difference.kind !== "missing_locally" || !difference.bitrix24Id) return { ...difference, localEmployeeId };
    const source = sourceById.get(difference.bitrix24Id);
    const sourceFields = source ? {
      sourceEmploymentType: source.employmentType,
      sourceDepartment: source.department,
      sourcePosition: source.position,
      sourceProjectKeys: source.projectKeys,
    } : {};
    const suggestion = suggestionById.get(difference.bitrix24Id);
    if (!suggestion) return { ...difference, ...sourceFields, localEmployeeId };
    const details = suggestion.kind === "safe"
      ? "Найдено единственное точное совпадение по ФИО и кадровым данным. Карточки можно сопоставить автоматически."
      : suggestion.kind === "review"
        ? "Найдены записи с таким ФИО, но кадровые данные отличаются или ФИО повторяется. Выберите сотрудника вручную."
        : "Сотрудник с таким ФИО не найден. Выберите запись вручную или сначала исправьте ФИО в справочнике.";
    return { ...difference, ...sourceFields, details, suggestedEmployeeIds: suggestion.employeeIds, localEmployeeId };
  });
  const checkedAt = new Date().toISOString();
  const stateByEmployeeId = new Map<number, { status: "mismatch" | "missing_in_bitrix" | "dismissed_in_bitrix" | "blacklisted_in_bitrix"; details: string[] }>();
  for (const difference of rawDifferences) {
    if (!difference.localEmployeeId || !["changed", "blacklisted_in_bitrix", "incomplete", "unknown_stage", "outside_scope", "missing_in_bitrix", "dismissed_in_bitrix"].includes(difference.kind)) continue;
    const status = difference.kind === "missing_in_bitrix" ? "missing_in_bitrix" as const
      : difference.kind === "dismissed_in_bitrix" ? "dismissed_in_bitrix" as const
        : difference.kind === "blacklisted_in_bitrix" ? "blacklisted_in_bitrix" as const
        : "mismatch" as const;
    const current = stateByEmployeeId.get(difference.localEmployeeId);
    if (current) { current.details.push(difference.details); if (status === "blacklisted_in_bitrix") current.status = status; }
    else stateByEmployeeId.set(difference.localEmployeeId, { status, details: [difference.details] });
  }
  const checkedEmployeeIds = localEmployees.flatMap((employee) => employee.bitrix24Id ? [employee.id] : []);
  const existingStates = checkedEmployeeIds.length
    ? await env.DB.prepare(`SELECT employee_id AS "employeeId", status, details, fingerprint,
        acknowledged_at AS "acknowledgedAt" FROM bitrix24_employee_check_states WHERE employee_id = ANY(?)`)
      .bind(checkedEmployeeIds).all<{ employeeId: number; status: string; details: string; fingerprint: string; acknowledgedAt: string | null }>()
    : { results: [] as Array<{ employeeId: number; status: string; details: string; fingerprint: string; acknowledgedAt: string | null }> };
  const existingByEmployeeId = new Map(existingStates.results.map((state) => [state.employeeId, state]));
  const nextStates = new Map([...stateByEmployeeId].map(([employeeId, state]) => {
    const details = state.details.sort((left, right) => left.localeCompare(right, "ru-RU")).join("\n");
    return [employeeId, { ...state, details, fingerprint: JSON.stringify([state.status, details]) }] as const;
  }));
  await env.DB.transaction(async (db) => {
    const statements = [];
    for (const employeeId of checkedEmployeeIds) {
      if (!nextStates.has(employeeId) && existingByEmployeeId.has(employeeId)) {
        statements.push(db.prepare("DELETE FROM bitrix24_employee_check_states WHERE employee_id = ?").bind(employeeId));
      }
    }
    for (const [employeeId, state] of nextStates) {
      statements.push(db.prepare(`INSERT INTO bitrix24_employee_check_states
        (employee_id, status, details, fingerprint, checked_at, acknowledged_at, acknowledged_by_user_id)
        VALUES (?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT (employee_id) DO UPDATE SET status = EXCLUDED.status, details = EXCLUDED.details,
          fingerprint = EXCLUDED.fingerprint, checked_at = EXCLUDED.checked_at,
          acknowledged_at = CASE WHEN bitrix24_employee_check_states.fingerprint = EXCLUDED.fingerprint THEN bitrix24_employee_check_states.acknowledged_at ELSE NULL END,
          acknowledged_by_user_id = CASE WHEN bitrix24_employee_check_states.fingerprint = EXCLUDED.fingerprint THEN bitrix24_employee_check_states.acknowledged_by_user_id ELSE NULL END
        RETURNING employee_id`)
        .bind(employeeId, state.status, state.details, state.fingerprint, checkedAt));
    }
    for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
  });
  const differences = rawDifferences.map((difference) => {
    const nextState = difference.localEmployeeId ? nextStates.get(difference.localEmployeeId) : null;
    const previous = difference.localEmployeeId ? existingByEmployeeId.get(difference.localEmployeeId) : null;
    return { ...difference, acknowledged: Boolean(nextState && nextState.status !== "blacklisted_in_bitrix" && previous?.fingerprint === nextState.fingerprint && previous.acknowledgedAt) };
  });
  const activeDifferences = differences.filter((difference) => !difference.acknowledged);
  const differenceCounts = activeDifferences.reduce<Record<string, number>>((counts, difference) => {
    counts[difference.kind] = (counts[difference.kind] ?? 0) + 1;
    return counts;
  }, {});
  const selectedIds = new Set(snapshot.map((employee) => employee.bitrix24Id));
  const excluded = sourceSnapshot.filter((employee) => !selectedIds.has(employee.bitrix24Id));
  const countValues = (values: string[]) => Object.entries(values.reduce<Record<string, number>>((counts, value) => {
    const key = value || "Не указано";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => left.localeCompare(right, "ru-RU"));
  return {
    snapshot,
    localEmployees,
    suggestions,
    response: {
      status: activeDifferences.length ? "mismatch" as const : "ok" as const,
      checkedAt,
      compared: comparison.compared,
      matched: comparison.matched,
      differences: [...activeDifferences, ...differences.filter((difference) => difference.acknowledged)].slice(0, 100),
      updatableEmployeeIds: bitrixReviewUpdateIds({ differences: activeDifferences.filter(difference => difference.kind === "blacklisted_in_bitrix"
        || difference.bitrix24Id && localByBitrixId.get(difference.bitrix24Id)?.active === 1) }),
      totalDifferences: activeDifferences.length,
      differenceCounts,
      acknowledgedDifferences: differences.length - activeDifferences.length,
      sourceReceived: sourceSnapshot.length,
      received: snapshot.length,
      excluded: excluded.length,
      incomplete: snapshot.filter((employee) => !employee.fullName || !employee.employmentType || !employee.department || !employee.position).length,
      unknownStages: snapshot.filter((employee) => employee.availabilityStatus === "unknown").length,
      stages: countValues(snapshot.map((employee) => employee.stageName || employee.stageId)),
      projects: countValues(snapshot.flatMap((employee) => employee.projectKeys.length ? employee.projectKeys : ["Не указано"])),
      excludedStages: countValues(excluded.map((employee) => employee.stageName || employee.stageId)),
      autoLinkable: suggestions.filter((suggestion) => suggestion.kind === "safe").length,
      needsReview: suggestions.filter((suggestion) => suggestion.kind === "review").length,
      unmatched: suggestions.filter((suggestion) => suggestion.kind === "unmatched").length,
    },
  };
}

export async function createBitrixEmployee(sourceSnapshot: BitrixEmployeeSnapshot[], payload: UserPayload) {
  const bitrix24Id = payload.bitrix24Id?.trim() ?? "";
  const positionId = asPositiveInteger(payload.positionId);
  const projectSiteId = payload.projectSiteId == null ? null : asPositiveInteger(payload.projectSiteId);
  if (!bitrix24Id || !positionId || (payload.projectSiteId != null && !projectSiteId)) {
    throw new Error("Выберите должность и объект сотрудника.");
  }

  const source = selectBitrixEmployeesForImport(sourceSnapshot).find((employee) => employee.bitrix24Id === bitrix24Id);
  if (!source) throw new Error("Карточка Битрикс24 не найдена среди сотрудников выбранных стадий и проектов.");
  if (!source.fullName.trim()) throw new Error("В карточке Битрикс24 не заполнено ФИО сотрудника.");
  if (source.availabilityStatus === "dismissed" || source.availabilityStatus === "deleted" || source.availabilityStatus === "blacklisted") {
    throw new Error("Уволенного или удалённого сотрудника нельзя добавить в активный справочник.");
  }

  const position = await env.DB.prepare(`SELECT employment_type AS "employmentType", department, position
    FROM position_catalog WHERE id = ? AND active = 1`).bind(positionId).first<{ employmentType: string; department: string; position: string }>();
  if (!position) throw new Error("Выбранная должность не найдена или уже удалена.");
  await validateEmployeeDirectoryValues(position.employmentType, position.department, position.position, projectSiteId);

  const localEmployees = await env.DB.prepare(`SELECT id, bitrix24_id AS "bitrix24Id", full_name AS "fullName"
    FROM employees WHERE active = 1 OR bitrix24_id IS NOT NULL`).all<{ id: number; bitrix24Id: string | null; fullName: string }>();
  const linked = localEmployees.results.find((employee) => employee.bitrix24Id === bitrix24Id);
  if (linked) throw new Error(`Карточка Битрикс24 уже связана с сотрудником «${linked.fullName}».`);
  const sameName = localEmployees.results.find((employee) => normalizeBitrixText(employee.fullName) === normalizeBitrixText(source.fullName));
  if (sameName) throw new Error(`Сотрудник «${sameName.fullName}» уже есть в системе. Используйте сопоставление, чтобы не создавать дубль.`);

  const createdAt = new Date().toISOString();
  const availabilityStatus: EmployeeAvailabilityStatus = projectSiteId
    ? "on_site"
    : source.availabilityStatus === "on_site" ? "unassigned" : source.availabilityStatus;
  const employeeId = await env.DB.transaction(async (db) => {
    const result = await db.prepare(`INSERT INTO employees
      (bitrix24_id, bitrix24_stage, availability_status, bitrix24_updated_at, last_synced_at, sync_error, sync_miss_count,
       full_name, employment_type, department, position, source, site_id, sort_order, active)
      VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, 'bitrix24', ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM employees), 1)`)
      .bind(bitrix24Id, source.stageName, availabilityStatus, source.sourceUpdatedAt, createdAt, source.fullName,
        position.employmentType, position.department, position.position, projectSiteId).run();
    const id = Number(result.meta.last_row_id);
    if (!id) throw new Error("Не удалось определить созданного сотрудника.");
    await db.batch([
      db.prepare(`INSERT INTO employee_profile_versions
        (employee_id, full_name, employment_type, department, position, bitrix24_stage, valid_from, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'bitrix24')`)
        .bind(id, source.fullName, position.employmentType, position.department, position.position, source.stageName, createdAt),
      db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, ?, ?, 'bitrix24')")
        .bind(id, availabilityStatus, createdAt),
      ...(projectSiteId ? [db.prepare(`INSERT INTO employee_project_assignments
        (employee_id, site_id, source, start_date) VALUES (?, ?, 'manual', CURRENT_DATE)`).bind(id, projectSiteId)] : []),
    ]);
    return id;
  });

  const updated = await buildBitrixInspection(sourceSnapshot);
  return { ...updated.response, createdEmployee: { id: employeeId, name: source.fullName } };
}

async function resolveBitrixEmployeeSites(source: BitrixEmployeeSnapshot) {
  if (source.availabilityStatus !== "on_site") return [] as number[];
  const sites = await env.DB.prepare("SELECT id, name, code FROM sites WHERE active = 1").all<{ id: number; name: string; code: string }>();
  const byKey = new Map<string, number>();
  for (const site of sites.results) {
    byKey.set(normalizeBitrixText(site.name), site.id);
    byKey.set(normalizeBitrixText(site.code), site.id);
  }
  const overrides = projectOverrides();
  const siteIds = [...new Set(source.projectKeys.flatMap((key) => {
    const target = overrides[normalizeBitrixText(key)] ?? key;
    const siteId = byKey.get(normalizeBitrixText(target));
    return siteId ? [siteId] : [];
  }))];
  if (!siteIds.length) throw new Error("В карточке Битрикс24 не указан объект, известный нашей системе. Сначала настройте соответствие проекта.");
  return siteIds;
}

/** Applying a terminal status never replaces personnel data or report history. */
async function archiveTerminalBitrixEmployeeRecord(source: BitrixEmployeeSnapshot, employeeId: number, bitrix24Id: string) {
  const status = source.availabilityStatus === "blacklisted" ? "blacklisted" : "dismissed";
  return env.DB.transaction(async db => {
    const current = await db.prepare(`SELECT id, full_name AS "fullName", employment_type AS "employmentType", department, position,
      bitrix24_stage AS "bitrix24Stage", availability_status AS "availabilityStatus"
      FROM employees WHERE id = ? AND bitrix24_id = ? FOR UPDATE`).bind(employeeId, bitrix24Id).first<{
        id: number; fullName: string; employmentType: string; department: string; position: string; bitrix24Stage: string; availabilityStatus: EmployeeAvailabilityStatus;
      }>();
    if (!current) throw new Error("Связанная карточка сотрудника изменилась. Выполните проверку ещё раз.");
    if (current.availabilityStatus === "blacklisted" && status !== "blacklisted") {
      throw new Error("Сотрудник находится в чёрном списке. Снять запрет на повторный приём можно только отдельной кадровой корректировкой.");
    }
    const updatedAt = new Date().toISOString();
    await db.prepare(`UPDATE employees SET bitrix24_stage = ?, availability_status = ?, active = 0, site_id = NULL,
      bitrix24_updated_at = ?, last_synced_at = ?, sync_error = NULL, sync_miss_count = 0
      WHERE id = ? AND bitrix24_id = ?`).bind(source.stageName, status, source.sourceUpdatedAt, updatedAt, employeeId, bitrix24Id).run();
    const statements = [db.prepare(`UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE)
      WHERE employee_id = ? AND active = 1`).bind(employeeId)];
    if (current.bitrix24Stage !== source.stageName) {
      statements.push(db.prepare("UPDATE employee_profile_versions SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(updatedAt, employeeId));
      statements.push(db.prepare(`INSERT INTO employee_profile_versions
        (employee_id, full_name, employment_type, department, position, bitrix24_stage, valid_from, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'bitrix24')`).bind(employeeId, current.fullName, current.employmentType, current.department, current.position, source.stageName, updatedAt));
    }
    if (current.availabilityStatus !== status) {
      statements.push(db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(updatedAt, employeeId));
      statements.push(db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, ?, ?, 'bitrix24')").bind(employeeId, status, updatedAt));
    }
    statements.push(db.prepare("DELETE FROM bitrix24_employee_check_states WHERE employee_id = ?").bind(employeeId));
    for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
    return { id: employeeId, name: current.fullName };
  });
}

async function updateBitrixEmployeeRecord(sourceSnapshot: BitrixEmployeeSnapshot[], employeeId: number, bitrix24Id: string) {
  const source = sourceSnapshot.find((employee) => employee.bitrix24Id === bitrix24Id);
  if (!source) throw new Error("Карточка сотрудника больше не найдена в Битрикс24.");
  if (source.availabilityStatus === "blacklisted") return archiveTerminalBitrixEmployeeRecord(source, employeeId, bitrix24Id);
  if (!source.fullName || !source.employmentType || !source.department || !source.position) {
    throw new Error("В Битрикс24 не заполнены ФИО, тип, отдел или должность. Сначала заполните карточку Битрикс24.");
  }
  if (source.availabilityStatus === "unknown") throw new Error(`Для стадии «${source.stageName || source.stageId}» не настроен статус сотрудника.`);
  if (source.availabilityStatus === "dismissed" || source.availabilityStatus === "deleted") {
    throw new Error("Для уволенного или удалённого сотрудника используйте действие «Удалить» либо подтвердите предупреждение.");
  }
  const current = await env.DB.prepare(`SELECT id, bitrix24_id AS "bitrix24Id", full_name AS "fullName",
      employment_type AS "employmentType", department, position, bitrix24_stage AS "bitrix24Stage",
      availability_status AS "availabilityStatus", active
    FROM employees WHERE id = ?`).bind(employeeId).first<{
      id: number; bitrix24Id: string | null; fullName: string; employmentType: string; department: string; position: string;
      bitrix24Stage: string; availabilityStatus: EmployeeAvailabilityStatus; active: number;
    }>();
  if (!current || current.bitrix24Id !== bitrix24Id) throw new Error("Связанная карточка сотрудника изменилась. Выполните проверку ещё раз.");
  if (!current.active) throw new Error("Сотрудник архивирован. Повторный приём требует отдельной кадровой корректировки.");
  await validateEmployeeDirectoryValues(source.employmentType, source.department, source.position, null);
  const duplicate = await env.DB.prepare("SELECT id FROM employees WHERE full_name = ? AND id <> ? AND active = 1").bind(source.fullName, employeeId).first();
  if (duplicate) throw new Error(`Сотрудник с ФИО «${source.fullName}» уже существует. Обновление остановлено, чтобы не создать дубль.`);
  const siteIds = await resolveBitrixEmployeeSites(source);
  const primarySiteId = source.availabilityStatus === "on_site" ? siteIds[0] ?? null : null;
  const updatedAt = new Date().toISOString();
  const profileChanged = current.fullName !== source.fullName || current.employmentType !== source.employmentType
    || current.department !== source.department || current.position !== source.position || current.bitrix24Stage !== source.stageName;
  await env.DB.transaction(async (db) => {
    await db.prepare(`UPDATE employees SET full_name = ?, employment_type = ?, department = ?, position = ?,
      bitrix24_stage = ?, availability_status = ?, bitrix24_updated_at = ?, last_synced_at = ?, sync_error = NULL,
      sync_miss_count = 0, source = 'bitrix24', site_id = ? WHERE id = ? AND active = 1 AND bitrix24_id = ?`)
      .bind(source.fullName, source.employmentType, source.department, source.position, source.stageName,
        source.availabilityStatus, source.sourceUpdatedAt, updatedAt, primarySiteId, employeeId, bitrix24Id).run();
    const statements = [];
    if (profileChanged) {
      statements.push(db.prepare("UPDATE employee_profile_versions SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(updatedAt, employeeId));
      statements.push(db.prepare(`INSERT INTO employee_profile_versions
        (employee_id, full_name, employment_type, department, position, bitrix24_stage, valid_from, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'bitrix24')`)
        .bind(employeeId, source.fullName, source.employmentType, source.department, source.position, source.stageName, updatedAt));
    }
    if (current.availabilityStatus !== source.availabilityStatus) {
      statements.push(db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(updatedAt, employeeId));
      statements.push(db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, ?, ?, 'bitrix24')")
        .bind(employeeId, source.availabilityStatus, updatedAt));
    }
    if (source.availabilityStatus === "on_site" && siteIds.length) {
      const placeholders = siteIds.map(() => "?").join(", ");
      statements.push(db.prepare(`UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE)
        WHERE employee_id = ? AND active = 1 AND site_id NOT IN (${placeholders})`).bind(employeeId, ...siteIds));
      for (const siteId of siteIds) {
        statements.push(db.prepare(`INSERT INTO employee_project_assignments (employee_id, site_id, source, start_date)
          SELECT ?, ?, 'bitrix24', CURRENT_DATE WHERE NOT EXISTS
          (SELECT 1 FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? AND active = 1)`).bind(employeeId, siteId, employeeId, siteId));
      }
    } else {
      statements.push(db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE) WHERE employee_id = ? AND active = 1").bind(employeeId));
    }
    statements.push(db.prepare("DELETE FROM bitrix24_employee_check_states WHERE employee_id = ?").bind(employeeId));
    for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
  });
  return { id: employeeId, name: source.fullName };
}

export async function updateBitrixEmployee(sourceSnapshot: BitrixEmployeeSnapshot[], payload: UserPayload) {
  const employeeId = asPositiveInteger(payload.employeeId);
  const bitrix24Id = payload.bitrix24Id?.trim() ?? "";
  if (!employeeId || !bitrix24Id) throw new Error("Сотрудник для изменения не указан.");
  const updatedEmployee = await updateBitrixEmployeeRecord(sourceSnapshot, employeeId, bitrix24Id);
  const updated = await buildBitrixInspection(sourceSnapshot);
  return { ...updated.response, updatedEmployee };
}

export async function updateSelectedBitrixEmployees(sourceSnapshot: BitrixEmployeeSnapshot[], payload: UserPayload) {
  const employeeIds = [...new Set((Array.isArray(payload.employeeIds) ? payload.employeeIds : [])
    .map(asPositiveInteger).filter((id): id is number => Boolean(id)))];
  if (!employeeIds.length) throw new Error("Не выбраны сотрудники для актуализации.");
  if (employeeIds.length > 200) throw new Error("За один раз можно актуализировать не более 200 сотрудников.");
  const rows = await env.DB.prepare(`SELECT e.id, e.full_name AS "fullName", e.bitrix24_id AS "bitrix24Id",
      check_state.status AS "checkStatus", check_state.acknowledged_at AS "acknowledgedAt"
    FROM employees e
    LEFT JOIN bitrix24_employee_check_states check_state ON check_state.employee_id = e.id
    WHERE e.id = ANY(?) AND (e.active = 1 OR check_state.status = 'blacklisted_in_bitrix')`).bind(employeeIds).all<{
      id: number; fullName: string; bitrix24Id: string | null; checkStatus: string | null; acknowledgedAt: string | null;
    }>();
  const rowById = new Map(rows.results.map((row) => [row.id, row]));
  const updatedEmployees: Array<{ id: number; name: string }> = [];
  const failedEmployees: Array<{ id: number; name: string; error: string }> = [];
  for (const employeeId of employeeIds) {
    const row = rowById.get(employeeId);
    if (!row) {
      failedEmployees.push({ id: employeeId, name: `ID ${employeeId}`, error: "Сотрудник не найден в активном справочнике." });
      continue;
    }
    if (!row.bitrix24Id) {
      failedEmployees.push({ id: employeeId, name: row.fullName, error: "Нет связи с карточкой Битрикс24." });
      continue;
    }
    const canArchiveBlacklist = row.checkStatus === "blacklisted_in_bitrix";
    if (!canArchiveBlacklist && (row.checkStatus !== "mismatch" || row.acknowledgedAt)) {
      failedEmployees.push({ id: employeeId, name: row.fullName, error: "Нет активного расхождения, которое можно актуализировать." });
      continue;
    }
    try {
      // ID Битрикс24 берётся из строки самого сотрудника, поэтому данные выбранных карточек не могут смешаться.
      updatedEmployees.push(await updateBitrixEmployeeRecord(sourceSnapshot, row.id, row.bitrix24Id));
    } catch (error) {
      failedEmployees.push({ id: row.id, name: row.fullName, error: error instanceof Error ? error.message : "Не удалось обновить сотрудника." });
    }
  }
  if (!updatedEmployees.length) {
    throw new Error(failedEmployees[0]?.error ?? "Не удалось актуализировать выбранных сотрудников.");
  }
  const updated = await buildBitrixInspection(sourceSnapshot);
  return { ...updated.response, updatedEmployees, failedEmployees };
}

export async function deleteBitrixEmployee(sourceSnapshot: BitrixEmployeeSnapshot[], payload: UserPayload) {
  const employeeId = asPositiveInteger(payload.employeeId);
  const bitrix24Id = payload.bitrix24Id?.trim() ?? "";
  if (!employeeId || !bitrix24Id) throw new Error("Сотрудник для удаления не указан.");
  const source = sourceSnapshot.find((employee) => employee.bitrix24Id === bitrix24Id);
  if (source?.availabilityStatus === "dismissed") {
    const deletedEmployee = await archiveTerminalBitrixEmployeeRecord(source, employeeId, bitrix24Id);
    const updated = await buildBitrixInspection(sourceSnapshot);
    return { ...updated.response, deletedEmployee };
  }
  if (source && source.availabilityStatus !== "deleted") {
    throw new Error("Карточка снова найдена среди действующих сотрудников Битрикс24. Удаление отменено — выполните проверку ещё раз.");
  }
  const current = await env.DB.prepare("SELECT full_name AS \"fullName\" FROM employees WHERE id = ? AND bitrix24_id = ? AND active = 1")
    .bind(employeeId, bitrix24Id).first<{ fullName: string }>();
  if (!current) throw new Error("Сотрудник уже удалён или связь с Битрикс24 изменилась.");
  const deletedAt = new Date().toISOString();
  await env.DB.transaction(async (db) => {
    await db.batch([
      db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE) WHERE employee_id = ? AND active = 1").bind(employeeId),
      db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(deletedAt, employeeId),
      db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, 'deleted', ?, 'bitrix24')").bind(employeeId, deletedAt),
      db.prepare("UPDATE employees SET active = 0, site_id = NULL, availability_status = 'deleted', bitrix24_stage = 'Нет в Битрикс24', last_synced_at = ? WHERE id = ? AND active = 1").bind(deletedAt, employeeId),
      db.prepare("DELETE FROM bitrix24_employee_check_states WHERE employee_id = ?").bind(employeeId),
    ]);
  });
  const updated = await buildBitrixInspection(sourceSnapshot);
  return { ...updated.response, deletedEmployee: { id: employeeId, name: current.fullName } };
}

export async function linkBitrixEmployees(sourceSnapshot: BitrixEmployeeSnapshot[], requestedLinks: UserPayload["links"]) {
  const inspection = await buildBitrixInspection(sourceSnapshot);
  const sourceById = new Map(inspection.snapshot.map((employee) => [employee.bitrix24Id, employee]));
  const localById = new Map(inspection.localEmployees.filter(employee => employee.active === 1).map((employee) => [employee.id, employee]));
  const linkedByBitrixId = new Map(inspection.localEmployees.flatMap((employee) => employee.bitrix24Id ? [[employee.bitrix24Id, employee] as const] : []));
  const links = requestedLinks?.length
    ? requestedLinks.map((link) => ({ bitrix24Id: link.bitrix24Id?.trim() ?? "", employeeId: asPositiveInteger(link.employeeId) }))
    : inspection.suggestions.filter((suggestion) => suggestion.kind === "safe").map((suggestion) => ({ bitrix24Id: suggestion.bitrix24Id, employeeId: suggestion.employeeIds[0] ?? null }));
  if (!links.length) return { ...inspection.response, linked: 0 };
  const bitrixIds = new Set<string>();
  const employeeIds = new Set<number>();
  const prepared = links.map((link) => {
    const source = sourceById.get(link.bitrix24Id);
    const local = link.employeeId ? localById.get(link.employeeId) : null;
    if (!source) throw new Error("Карточка Битрикс24 не найдена среди сотрудников выбранных стадий и проектов.");
    if (["dismissed", "deleted", "blacklisted"].includes(source.availabilityStatus)) throw new Error("Уволенную или находящуюся в чёрном списке карточку нельзя связывать с активным сотрудником.");
    if (!local) throw new Error("Сотрудник для сопоставления не найден.");
    const alreadyLinked = linkedByBitrixId.get(source.bitrix24Id);
    if (alreadyLinked && alreadyLinked.id !== local.id) throw new Error(`Карточка Битрикс24 уже связана с сотрудником «${alreadyLinked.fullName}».`);
    if (local.bitrix24Id && local.bitrix24Id !== source.bitrix24Id) throw new Error(`Сотрудник «${local.fullName}» уже связан с другой карточкой Битрикс24.`);
    if (bitrixIds.has(source.bitrix24Id) || employeeIds.has(local.id)) throw new Error("Одна карточка не может участвовать в нескольких сопоставлениях.");
    bitrixIds.add(source.bitrix24Id);
    employeeIds.add(local.id);
    return { source, local };
  });
  const linked = await env.DB.transaction(async (db) => {
    const statements = prepared.map(({ source, local }) => db.prepare(`UPDATE employees SET bitrix24_id = ?, bitrix24_stage = ?,
      bitrix24_updated_at = ?, last_synced_at = CURRENT_TIMESTAMP, sync_error = NULL
      WHERE id = ? AND active = 1 AND bitrix24_id IS NULL`)
      .bind(source.bitrix24Id, source.stageName, source.sourceUpdatedAt, local.id));
    const results = [];
    for (let offset = 0; offset < statements.length; offset += 100) results.push(...await db.batch(statements.slice(offset, offset + 100)));
    const count = results.reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
    if (count !== prepared.length) throw new Error("Список сотрудников изменился во время сопоставления. Обновите проверку и повторите действие.");
    return count;
  });
  const updated = await buildBitrixInspection(sourceSnapshot);
  return { ...updated.response, linked };
}
