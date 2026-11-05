import { type EmployeeAvailabilityStatus, type BitrixEmployeeSnapshot, normalizeBitrixText, fetchBitrixEmployeeSnapshot, selectBitrixEmployeesForImport } from "../../bitrix24Sync";
import { env } from "./context";

type ExistingBitrixEmployee = {
  id: number;
  bitrix24Id: string;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
  bitrix24Stage: string;
  availabilityStatus: EmployeeAvailabilityStatus;
  active: number;
  syncMissCount: number;
  siteId: number | null;
};

type EmployeeSyncIssue = { bitrix24Id: string | null; code: string; message: string };

function employeeProfileChanged(existing: ExistingBitrixEmployee | undefined, employee: BitrixEmployeeSnapshot) {
  return !existing || existing.fullName !== employee.fullName || existing.employmentType !== employee.employmentType
    || existing.department !== employee.department || existing.position !== employee.position || existing.bitrix24Stage !== employee.stageName;
}

export function projectOverrides() {
  const raw = process.env.BITRIX24_PROJECT_MAP?.trim();
  if (!raw) return {} as Record<string, string>;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("BITRIX24_PROJECT_MAP должен содержать корректный JSON-объект."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("BITRIX24_PROJECT_MAP должен быть JSON-объектом.");
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [normalizeBitrixText(key), String(value)]));
}

export async function synchronizeBitrixEmployees() {
  if (process.env.BITRIX24_SYNC_ENABLED !== "true") {
    throw new Error("Применение данных Битрикс24 отключено. После проверки подключения установите BITRIX24_SYNC_ENABLED=true.");
  }
  const rootDb = env.DB;
  const startedAt = new Date().toISOString();
  const runResult = await rootDb.prepare("INSERT INTO employee_sync_runs (source, status, started_at) VALUES ('bitrix24', 'running', ?)").bind(startedAt).run();
  const runId = Number(runResult.meta.last_row_id);
  try {
    const sourceSnapshot = await fetchBitrixEmployeeSnapshot();
    if (!sourceSnapshot.length) throw new Error("Битрикс24 вернул пустой список сотрудников. Изменения не применены.");
    const snapshot = selectBitrixEmployeesForImport(sourceSnapshot);
    if (!snapshot.length) throw new Error("По настроенным стадиям и объектам не найдено ни одного сотрудника. Изменения не применены.");
    const sourceById = new Map(sourceSnapshot.filter((employee) => employee.bitrix24Id).map((employee) => [employee.bitrix24Id, employee]));
    return await rootDb.transaction(async (db) => {
    const lock = await db.prepare("SELECT pg_try_advisory_xact_lock(hashtext('personnel-bitrix24-employee-sync')) AS locked").first<{ locked: boolean }>();
    if (!lock?.locked) throw new Error("Актуализация из Битрикс24 уже выполняется. Дождитесь её завершения.");
    const [sitesResult, positionsResult, existingResult, manualEmployeesResult, profileVersionsResult] = await db.readBatch([
      db.prepare("SELECT id, name, code FROM sites WHERE active = 1"),
      db.prepare("SELECT employment_type AS employmentType, department, position FROM position_catalog WHERE active = 1"),
      db.prepare(`SELECT id, bitrix24_id AS bitrix24Id, full_name AS fullName, employment_type AS employmentType, department, position,
        bitrix24_stage AS bitrix24Stage, availability_status AS availabilityStatus, active, sync_miss_count AS syncMissCount, site_id AS siteId
        FROM employees WHERE bitrix24_id IS NOT NULL`),
      db.prepare("SELECT id, full_name AS fullName FROM employees WHERE bitrix24_id IS NULL AND active = 1"),
      db.prepare("SELECT employee_id AS employeeId FROM employee_profile_versions WHERE valid_to IS NULL"),
    ]);
    const sites = sitesResult.results as Array<{ id: number; name: string; code: string }>;
    const siteByKey = new Map<string, number>();
    sites.forEach((site) => { siteByKey.set(normalizeBitrixText(site.name), site.id); siteByKey.set(normalizeBitrixText(site.code), site.id); });
    const overrides = projectOverrides();
    const positions = new Set((positionsResult.results as Array<{ employmentType: string; department: string; position: string }>).map((row) =>
      [row.employmentType, row.department, row.position].map(normalizeBitrixText).join("\u0000")));
    const existingByBitrixId = new Map((existingResult.results as ExistingBitrixEmployee[]).map((employee) => [employee.bitrix24Id, employee]));
    const profileVersionEmployeeIds = new Set((profileVersionsResult.results as Array<{ employeeId: number }>).map((version) => version.employeeId));
    const manualNames = new Set((manualEmployeesResult.results as Array<{ fullName: string }>).map((employee) => normalizeBitrixText(employee.fullName)));
    const seen = new Set<string>();
    const issues: EmployeeSyncIssue[] = [];
    const prepared: Array<BitrixEmployeeSnapshot & { siteIds: number[]; syncError: string | null; active: number }> = [];

    for (const employee of snapshot) {
      if (!employee.bitrix24Id) { issues.push({ bitrix24Id: null, code: "missing_id", message: `Карточка «${employee.fullName || "Без названия"}» не содержит ID.` }); continue; }
      if (seen.has(employee.bitrix24Id)) { issues.push({ bitrix24Id: employee.bitrix24Id, code: "duplicate_id", message: "Один ID сотрудника повторяется в ответе Битрикс24." }); continue; }
      seen.add(employee.bitrix24Id);
      const errors: string[] = [];
      if (!employee.fullName || !employee.employmentType || !employee.department || !employee.position) errors.push("не заполнены ФИО, тип, отдел или должность");
      const positionKey = [employee.employmentType, employee.department, employee.position].map(normalizeBitrixText).join("\u0000");
      if (employee.employmentType && employee.department && employee.position && !positions.has(positionKey)) errors.push("сочетание типа, отдела и должности отсутствует в справочнике");
      const siteIds = [...new Set(employee.projectKeys.flatMap((key) => {
        const normalized = normalizeBitrixText(key);
        const target = overrides[normalized] ?? key;
        const siteId = siteByKey.get(normalizeBitrixText(target));
        if (!siteId) errors.push(`проект «${key}» не найден`);
        return siteId ? [siteId] : [];
      }))];
      if (employee.availabilityStatus === "on_site" && !siteIds.length) errors.push("для стадии на объекте не указан распознанный проект");
      if (employee.availabilityStatus === "unknown") errors.push(`для стадии «${employee.stageName || employee.stageId || "не указана"}» не настроена доступность`);
      if (!existingByBitrixId.has(employee.bitrix24Id) && manualNames.has(normalizeBitrixText(employee.fullName))) {
        issues.push({ bitrix24Id: employee.bitrix24Id, code: "possible_duplicate_name", message: `В ручном справочнике уже есть сотрудник с ФИО «${employee.fullName}». Карточки не объединены автоматически.` });
      }
      const syncError = errors.length ? errors.join("; ") : null;
      if (syncError) issues.push({ bitrix24Id: employee.bitrix24Id, code: "invalid_employee", message: `${employee.fullName || `ID ${employee.bitrix24Id}`}: ${syncError}.` });
      prepared.push({ ...employee, siteIds, syncError, active: employee.availabilityStatus === "dismissed" || employee.availabilityStatus === "deleted" ? 0 : 1 });
    }

    const upserts = prepared.map((employee) => {
      const existing = existingByBitrixId.get(employee.bitrix24Id);
      const safeEmployee = employee.syncError && existing
        ? { ...employee, fullName: existing.fullName, employmentType: existing.employmentType, department: existing.department, position: existing.position }
        : employee;
      const primarySiteId = employee.availabilityStatus === "on_site" ? employee.siteIds[0] ?? null : null;
      return db.prepare(`INSERT INTO employees
        (bitrix24_id, bitrix24_stage, availability_status, bitrix24_updated_at, last_synced_at, sync_error, sync_miss_count,
         full_name, employment_type, department, position, source, site_id, sort_order, active)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'bitrix24', ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM employees), ?)
        ON CONFLICT (bitrix24_id) DO UPDATE SET
          bitrix24_stage = EXCLUDED.bitrix24_stage,
          availability_status = EXCLUDED.availability_status,
          bitrix24_updated_at = EXCLUDED.bitrix24_updated_at,
          last_synced_at = EXCLUDED.last_synced_at,
          sync_error = EXCLUDED.sync_error,
          sync_miss_count = 0,
          full_name = EXCLUDED.full_name,
          employment_type = EXCLUDED.employment_type,
          department = EXCLUDED.department,
          position = EXCLUDED.position,
          source = 'bitrix24',
          site_id = CASE
            WHEN EXCLUDED.sync_error IS NOT NULL THEN employees.site_id
            WHEN EXCLUDED.active = 0 OR EXCLUDED.availability_status <> 'on_site' OR EXCLUDED.site_id IS NULL THEN NULL
            ELSE EXCLUDED.site_id
          END,
          active = EXCLUDED.active`)
        .bind(employee.bitrix24Id, employee.stageName, employee.availabilityStatus, employee.sourceUpdatedAt, startedAt, employee.syncError,
          safeEmployee.fullName, safeEmployee.employmentType, safeEmployee.department, safeEmployee.position, primarySiteId, employee.active);
    });
    for (let offset = 0; offset < upserts.length; offset += 100) await db.batch(upserts.slice(offset, offset + 100));

    const refreshed = await db.prepare(`SELECT id, bitrix24_id AS bitrix24Id, full_name AS fullName, employment_type AS employmentType, department, position,
      bitrix24_stage AS bitrix24Stage, availability_status AS availabilityStatus, active, sync_miss_count AS syncMissCount, site_id AS siteId
      FROM employees WHERE bitrix24_id IS NOT NULL`).all<ExistingBitrixEmployee>();
    const refreshedByBitrixId = new Map(refreshed.results.map((employee) => [employee.bitrix24Id, employee]));
    const historyStatements = [];
    const assignmentStatements = [];
    const outOfScopeStatements = [];
    let added = 0;
    let updated = 0;
    let unavailable = 0;
    let archived = 0;
    let moved = 0;

    for (const employee of prepared) {
      const previous = existingByBitrixId.get(employee.bitrix24Id);
      const current = refreshedByBitrixId.get(employee.bitrix24Id);
      if (!current) continue;
      if (!previous) added += 1;
      else if (employeeProfileChanged(previous, employee) || previous.availabilityStatus !== employee.availabilityStatus || previous.active !== employee.active) updated += 1;
      if (employee.availabilityStatus !== "on_site" && employee.active) unavailable += 1;
      if (!employee.active && (!previous || previous.active)) archived += 1;
      const nextPrimarySiteId = employee.availabilityStatus === "on_site" ? employee.siteIds[0] ?? null : null;
      if (!employee.syncError && previous && previous.siteId !== nextPrimarySiteId) moved += 1;
      if (!employee.syncError && (employeeProfileChanged(previous, employee) || !profileVersionEmployeeIds.has(current.id))) {
        const effectiveAt = employee.sourceUpdatedAt ?? startedAt;
        historyStatements.push(db.prepare("UPDATE employee_profile_versions SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(effectiveAt, current.id));
        historyStatements.push(db.prepare(`INSERT INTO employee_profile_versions
          (employee_id, full_name, employment_type, department, position, bitrix24_stage, valid_from, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'bitrix24')`)
          .bind(current.id, current.fullName, current.employmentType, current.department, current.position, employee.stageName, effectiveAt));
        profileVersionEmployeeIds.add(current.id);
      }
      if (!previous || previous.availabilityStatus !== employee.availabilityStatus) {
        historyStatements.push(db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(startedAt, current.id));
        historyStatements.push(db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, ?, ?, 'bitrix24')").bind(current.id, employee.availabilityStatus, startedAt));
      }
      if (employee.syncError) continue;
      if (!employee.active) {
        assignmentStatements.push(db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = CURRENT_DATE WHERE employee_id = ? AND active = 1").bind(current.id));
        continue;
      }
      if (employee.availabilityStatus !== "on_site" || !employee.siteIds.length) {
        assignmentStatements.push(db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE) WHERE employee_id = ? AND active = 1").bind(current.id));
        continue;
      }
      if (employee.siteIds.length) {
        const placeholders = employee.siteIds.map(() => "?").join(", ");
        assignmentStatements.push(db.prepare(`UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE)
          WHERE employee_id = ? AND active = 1 AND site_id NOT IN (${placeholders})`).bind(current.id, ...employee.siteIds));
        for (const siteId of employee.siteIds) {
          assignmentStatements.push(db.prepare(`INSERT INTO employee_project_assignments (employee_id, site_id, source, start_date)
            SELECT ?, ?, 'bitrix24', CURRENT_DATE WHERE NOT EXISTS
            (SELECT 1 FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? AND active = 1)`).bind(current.id, siteId, current.id, siteId));
        }
      }
    }
    for (const employee of existingResult.results as ExistingBitrixEmployee[]) {
      const source = sourceById.get(employee.bitrix24Id);
      if (!source || seen.has(employee.bitrix24Id)) continue;
      const nextStatus: EmployeeAvailabilityStatus = source.availabilityStatus === "dismissed" ? "dismissed" : "out_of_scope";
      outOfScopeStatements.push(db.prepare(`UPDATE employees SET bitrix24_stage = ?, availability_status = ?, bitrix24_updated_at = ?,
        last_synced_at = ?, sync_error = NULL, sync_miss_count = 0, site_id = NULL, active = 0 WHERE id = ?`)
        .bind(source.stageName, nextStatus, source.sourceUpdatedAt, startedAt, employee.id));
      assignmentStatements.push(db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = CURRENT_DATE WHERE employee_id = ? AND active = 1").bind(employee.id));
      if (employee.availabilityStatus !== nextStatus) {
        historyStatements.push(db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(startedAt, employee.id));
        historyStatements.push(db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, ?, ?, 'bitrix24')").bind(employee.id, nextStatus, startedAt));
      }
      if (employee.active) archived += 1;
    }
    for (let offset = 0; offset < outOfScopeStatements.length; offset += 100) await db.batch(outOfScopeStatements.slice(offset, offset + 100));
    for (let offset = 0; offset < historyStatements.length; offset += 100) await db.batch(historyStatements.slice(offset, offset + 100));
    for (let offset = 0; offset < assignmentStatements.length; offset += 100) await db.batch(assignmentStatements.slice(offset, offset + 100));

    const missing = (existingResult.results as ExistingBitrixEmployee[]).filter((employee) => !sourceById.has(employee.bitrix24Id));
    if (missing.length) {
      const missingStatements = [];
      for (const employee of missing) {
        missingStatements.push(db.prepare("UPDATE employees SET sync_miss_count = sync_miss_count + 1, last_synced_at = ? WHERE id = ?").bind(startedAt, employee.id));
        if (employee.syncMissCount >= 1 && employee.availabilityStatus !== "deleted") {
          missingStatements.push(db.prepare("UPDATE employees SET active = 0, availability_status = 'deleted', bitrix24_stage = 'Удалён из Битрикс24', site_id = NULL WHERE id = ?").bind(employee.id));
          missingStatements.push(db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = CURRENT_DATE WHERE employee_id = ? AND active = 1").bind(employee.id));
          missingStatements.push(db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(startedAt, employee.id));
          missingStatements.push(db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, 'deleted', ?, 'bitrix24')").bind(employee.id, startedAt));
          archived += 1;
        }
      }
      for (let offset = 0; offset < missingStatements.length; offset += 100) await db.batch(missingStatements.slice(offset, offset + 100));
    }

    if (issues.length) {
      const issueStatements = issues.map((issue) => db.prepare("INSERT INTO employee_sync_issues (run_id, bitrix24_id, code, message) VALUES (?, ?, ?, ?)").bind(runId, issue.bitrix24Id, issue.code, issue.message));
      for (let offset = 0; offset < issueStatements.length; offset += 100) await db.batch(issueStatements.slice(offset, offset + 100));
    }
    const summary = { sourceReceived: sourceSnapshot.length, received: snapshot.length, excluded: sourceSnapshot.length - snapshot.length, added, updated, moved, unavailable, archived, issues: issues.length };
    await db.prepare("UPDATE employee_sync_runs SET status = 'success', completed_at = CURRENT_TIMESTAMP, summary = ? WHERE id = ?").bind(JSON.stringify(summary), runId).run();
    return { runId, ...summary, issueMessages: issues.slice(0, 10).map((issue) => issue.message) };
    });
  } catch (error) {
    await rootDb.prepare("UPDATE employee_sync_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_text = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message : "Неизвестная ошибка синхронизации", runId).run();
    throw error;
  }
}
