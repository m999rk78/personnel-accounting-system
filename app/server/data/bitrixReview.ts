import { createHash } from "node:crypto";
import { type BitrixEmployeeSnapshot, selectBitrixEmployeesForImport, selectLinkedBitrixEmployeesForReview, type BitrixLinkLocalEmployee, suggestBitrixEmployeeLinks, suggestArchivedBitrixEmployeeLinks, compareBitrixEmployees, bitrixOfficeTransferDirection, type BitrixOfficeTransferDirection, isBitrixCentralOfficeEmployee, normalizeBitrixText, observeLegacyTerminalBitrixDuplicates, type EmployeeAvailabilityStatus } from "../../bitrix24Sync";
import { bitrixReviewUpdateIds } from "../../bitrixReviewSelection";
import { env, type DatabaseExecutor } from "./context";
import { type UserPayload } from "./types";
import { asPositiveInteger } from "./validation";
import { validateEmployeeDirectoryValues } from "./catalogs";
import { projectOverrides } from "./bitrixSync";

type BitrixLinkRecord = BitrixLinkLocalEmployee & { availabilityStatus: EmployeeAvailabilityStatus; active: number; };

function officeTransferFingerprint(source: BitrixEmployeeSnapshot, direction: BitrixOfficeTransferDirection) {
  // Confirmation must describe the same direction and target as the review.
  const target = direction === "to_site" ? [source.fullName, source.employmentType, source.department, source.position,
    [...source.projectKeys].sort(), [...(source.subdivisionKeys ?? [])].sort()] : [];
  return `office_transfer:${createHash("sha256").update(JSON.stringify([direction, source.bitrix24Id, source.stageId, target])).digest("hex")}`;
}

function assertBitrixEmployeeNotInCentralOffice(sourceSnapshot: BitrixEmployeeSnapshot[], bitrix24Id: string) {
  if (sourceSnapshot.some(employee => employee.bitrix24Id === bitrix24Id && isBitrixCentralOfficeEmployee(employee))) {
    throw new Error("Сотрудник относится к подразделению «Центр. офис» и не участвует в сверке сотрудников площадки.");
  }
}

export async function buildBitrixInspection(sourceSnapshot: BitrixEmployeeSnapshot[], { observeArchivedStatuses = false } = {}) {
  const localResult = await env.DB.prepare(`SELECT e.id, e.bitrix24_id AS bitrix24Id, e.full_name AS fullName,
    e.employment_type AS employmentType, e.department, e.position, e.bitrix24_stage AS bitrix24Stage,
    e.availability_status AS "availabilityStatus", e.active,
    archive_check.status AS "archivedCheckStatus",
    EXISTS (SELECT 1 FROM employee_project_assignments previous_project WHERE previous_project.employee_id = e.id) AS "hasProjectHistory",
    STRING_AGG(DISTINCT assigned_site.name, '|||') AS "projectNames",
    STRING_AGG(DISTINCT assigned_site.code, '|||') AS "projectCodes"
    FROM employees e
    LEFT JOIN employee_project_assignments assignment ON e.active = 1 AND assignment.employee_id = e.id AND assignment.active = 1
    LEFT JOIN sites assigned_site ON assigned_site.id = assignment.site_id AND assigned_site.active = 1
    LEFT JOIN bitrix24_employee_check_states archive_check ON e.active = 0 AND archive_check.employee_id = e.id
    WHERE e.active = 1 OR e.bitrix24_id IS NOT NULL
    GROUP BY e.id, e.bitrix24_id, e.full_name, e.employment_type, e.department, e.position, e.bitrix24_stage, e.availability_status, e.active, archive_check.status`)
    .all<BitrixLinkRecord & { bitrix24Stage: string; archivedCheckStatus: string | null; hasProjectHistory: boolean; projectNames: string | null; projectCodes: string | null }>();
  const localEmployees = localResult.results;
  const activeEmployees = localEmployees.filter(employee => employee.active === 1);
  const officeIds = new Set(sourceSnapshot.filter(isBitrixCentralOfficeEmployee).map(employee => employee.bitrix24Id).filter(Boolean));
  const nonOfficeSource = sourceSnapshot.filter(employee => !isBitrixCentralOfficeEmployee(employee) && !officeIds.has(employee.bitrix24Id));
  // Archived records never enter the comparison or count as new. Their
  // reserved IDs can only be offered to eligible active records for linking.
  const archivedByBitrixId = new Map(localEmployees.flatMap(employee => employee.active === 0 && employee.bitrix24Id ? [[employee.bitrix24Id, employee] as const] : []));
  const reviewSource = nonOfficeSource.filter(employee => !archivedByBitrixId.has(employee.bitrix24Id));
  const importSnapshot = selectBitrixEmployeesForImport(reviewSource).filter(employee => !["dismissed", "deleted", "blacklisted"].includes(employee.availabilityStatus));
  const importIds = new Set(importSnapshot.map(employee => employee.bitrix24Id));
  const sourceById = new Map(sourceSnapshot.map(employee => [employee.bitrix24Id, employee]));
  const sourceIdUses = new Map<string, number>();
  const sourceNameUses = new Map<string, number>();
  for (const employee of sourceSnapshot) {
    sourceIdUses.set(employee.bitrix24Id, (sourceIdUses.get(employee.bitrix24Id) ?? 0) + 1);
    const name = normalizeBitrixText(employee.fullName);
    sourceNameUses.set(name, (sourceNameUses.get(name) ?? 0) + 1);
  }
  const activeNameUses = new Map<string, number>();
  for (const employee of activeEmployees) {
    const name = normalizeBitrixText(employee.fullName);
    activeNameUses.set(name, (activeNameUses.get(name) ?? 0) + 1);
  }
  const archiveLinkBlockedIds = new Set<string>();
  const archivedTerminalObservations: Array<{ employeeId: number; bitrix24Id: string; status: string; details: string; fingerprint: string; }> = [];
  const archiveReturns = [...archivedByBitrixId].flatMap(([bitrix24Id, archived]) => {
    const blacklisted = archived.availabilityStatus === "blacklisted" || archived.archivedCheckStatus === "blacklisted_in_bitrix";
    const dismissed = archived.availabilityStatus === "dismissed" || archived.archivedCheckStatus === "dismissed_in_bitrix";
    if (blacklisted || dismissed || archived.availabilityStatus === "central_office") archiveLinkBlockedIds.add(bitrix24Id);
    const source = sourceById.get(bitrix24Id);
    if (!source || officeIds.has(bitrix24Id) || sourceIdUses.get(bitrix24Id) !== 1
      || archived.availabilityStatus === "deleted" || archived.availabilityStatus === "central_office") return [];
    // On explicit checks remember terminal stages even for a manually archived
    // card. This is observation metadata, not a change to the employee.
    const observedStatus = source.availabilityStatus === "blacklisted" ? "blacklisted_in_bitrix"
      : source.availabilityStatus === "dismissed" && !dismissed ? "dismissed_in_bitrix" : null;
    if (observeArchivedStatuses && observedStatus && !blacklisted) {
      const details = observedStatus === "blacklisted_in_bitrix"
        ? "Архивная карточка находится в чёрном списке Битрикс24."
        : "У архивной карточки зафиксировано увольнение в Битрикс24.";
      archivedTerminalObservations.push({ employeeId: archived.id, bitrix24Id, status: observedStatus, details,
        fingerprint: JSON.stringify([observedStatus, details]) });
    }
    if ((!dismissed && !blacklisted) || !["on_site", "intershift", "transfer"].includes(source.availabilityStatus)) return [];
    const projects = [...new Set(source.projectKeys.map(project => project.trim()).filter(Boolean))];
    if (source.availabilityStatus === "on_site" && !projects.length) return [];
    const stage = source.stageName || (source.availabilityStatus === "intershift" ? "МО/О"
      : source.availabilityStatus === "transfer" ? "Перемещения" : "На объекте");
    return [{
      bitrix24Id,
      employeeName: archived.fullName || source.fullName,
      details: `После ${blacklisted ? "чёрного списка" : "увольнения"} в Битрикс24 указана стадия «${stage}».${projects.length ? ` Объект: «${projects.join("», «")}».` : ""}${blacklisted ? " Возврат в справочник требует отдельного кадрового решения." : ""}`,
    }];
  });
  const localByBitrixId = new Map(activeEmployees.flatMap(employee => employee.bitrix24Id && !officeIds.has(employee.bitrix24Id)
    ? [[employee.bitrix24Id, employee] as const] : []));
  // The import scope limits who can be added. Existing active employees must
  // still be matchable and comparable after a change of project in Bitrix24.
  const ordinarySuggestions = suggestBitrixEmployeeLinks(reviewSource,
    activeEmployees.filter(employee => !["blacklisted", "dismissed", "deleted"].includes(employee.availabilityStatus)), sourceSnapshot)
    .filter(suggestion => !localByBitrixId.has(suggestion.bitrix24Id) && (importIds.has(suggestion.bitrix24Id) || suggestion.employeeIds.length > 0));
  const inScope = new Set(selectLinkedBitrixEmployeesForReview(reviewSource, localByBitrixId.keys()).map(employee => employee.bitrix24Id));
  const linkableIds = new Set(ordinarySuggestions.map(suggestion => suggestion.bitrix24Id));
  const snapshot = reviewSource.filter(employee => inScope.has(employee.bitrix24Id) || localByBitrixId.has(employee.bitrix24Id) || linkableIds.has(employee.bitrix24Id));
  const linkedEmployees = [...localByBitrixId].map(([bitrix24Id, employee]) => ({
    bitrix24Id,
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
  }));
  const archiveSuggestions = suggestArchivedBitrixEmployeeLinks(nonOfficeSource.filter(employee => !archiveLinkBlockedIds.has(employee.bitrix24Id)), localEmployees, sourceSnapshot);
  const archiveSuggestionIds = new Set(archiveSuggestions.map(suggestion => suggestion.bitrix24Id));
  const allSuggestions = [...ordinarySuggestions, ...archiveSuggestions];
  const candidateUses = new Map<number, number>();
  for (const suggestion of allSuggestions) for (const id of suggestion.employeeIds) candidateUses.set(id, (candidateUses.get(id) ?? 0) + 1);
  const suggestions = allSuggestions.map(suggestion => suggestion.kind === "safe" && (candidateUses.get(suggestion.employeeIds[0]) !== 1 || sourceIdUses.get(suggestion.bitrix24Id) !== 1)
    ? { ...suggestion, kind: "review" as const } : suggestion);
  const suggestionById = new Map(suggestions.map((suggestion) => [suggestion.bitrix24Id, suggestion]));
  const activeById = new Map(activeEmployees.map(employee => [employee.id, employee]));
  const identity = (employee?: Pick<BitrixLinkRecord, "fullName" | "employmentType" | "department" | "position" | "availabilityStatus">) => employee
    ? [employee.fullName, employee.employmentType, employee.department, employee.position, employee.availabilityStatus] : null;
  const archiveLinks = suggestions.flatMap(suggestion => {
    const archived = archivedByBitrixId.get(suggestion.bitrix24Id);
    return archived ? [[suggestion.bitrix24Id, archived.id, suggestion.kind, identity(sourceById.get(suggestion.bitrix24Id)),
      [...suggestion.employeeIds].sort((a, b) => a - b).map(id => [id, identity(activeById.get(id))])] as const] : [];
  }).sort(([left], [right]) => left.localeCompare(right));
  const safeSuggestions = suggestions.filter(suggestion => suggestion.kind === "safe");
  const autoLinkOptions = safeSuggestions.map(({ bitrix24Id }) => ({ bitrix24Id, archivedLink: archiveSuggestionIds.has(bitrix24Id) }));
  const safePairs = safeSuggestions.map(suggestion => [suggestion.bitrix24Id, suggestion.employeeIds[0]] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  // A changed position or department does not prevent a confirmed archive transfer,
  // but a namesake or a candidate offered for another card still needs individual review.
  const archiveTransferOptions = suggestions.flatMap(({ bitrix24Id, employeeIds, kind }) => {
    if (kind !== "review" || !archiveSuggestionIds.has(bitrix24Id) || employeeIds.length !== 1) return [];
    const source = sourceById.get(bitrix24Id);
    if (!source || source.availabilityStatus === "unknown" || sourceIdUses.get(bitrix24Id) !== 1) return [];
    const name = normalizeBitrixText(source.fullName);
    const employeeId = employeeIds[0];
    return name && activeNameUses.get(name) === 1 && sourceNameUses.get(name) === 1 && candidateUses.get(employeeId) === 1
      ? [{ bitrix24Id, employeeId }] : [];
  });
  const archiveTransferIds = new Set(archiveTransferOptions.map(({ bitrix24Id }) => bitrix24Id));
  const transferPairs = [...archiveTransferOptions].sort((left, right) => left.bitrix24Id.localeCompare(right.bitrix24Id));
  const archiveLinkRevision = archiveLinks.length ? createHash("sha256").update(JSON.stringify([archiveLinks, safePairs, transferPairs])).digest("hex") : undefined;
  const sourceFieldsFor = (bitrix24Id: string) => {
    const source = sourceById.get(bitrix24Id);
    return source ? {
      sourceEmploymentType: source.employmentType,
      sourceDepartment: source.department,
      sourcePosition: source.position,
      sourceProjectKeys: source.projectKeys,
    } : {};
  };
  const comparison = compareBitrixEmployees(snapshot, linkedEmployees, reviewSource);
  const comparedDifferences = comparison.differences.map((difference) => {
    const localEmployeeId = difference.bitrix24Id ? localByBitrixId.get(difference.bitrix24Id)?.id : undefined;
    if (difference.kind !== "missing_locally" || !difference.bitrix24Id) return { ...difference, localEmployeeId };
    const sourceFields = sourceFieldsFor(difference.bitrix24Id);
    const suggestion = suggestionById.get(difference.bitrix24Id);
    if (!suggestion) return { ...difference, ...sourceFields, localEmployeeId };
    const details = suggestion.kind === "safe"
      ? "Найдено единственное точное совпадение по ФИО и кадровым данным. Карточки можно сопоставить автоматически."
      : suggestion.kind === "review"
        ? "Найдены записи с таким ФИО, но кадровые данные отличаются или ФИО повторяется. Выберите сотрудника вручную."
        : "Сотрудник с таким ФИО не найден. Выберите запись вручную или сначала исправьте ФИО в справочнике.";
    return { ...difference, ...sourceFields, details, suggestedEmployeeIds: suggestion.employeeIds, localEmployeeId };
  });
  const archiveDifferences = suggestions.flatMap(suggestion => archiveSuggestionIds.has(suggestion.bitrix24Id) ? [{
    kind: "missing_locally" as const,
    archivedLink: true,
    employeeName: suggestion.employeeName,
    bitrix24Id: suggestion.bitrix24Id,
    localEmployeeId: undefined,
    suggestedEmployeeIds: suggestion.employeeIds,
    ...sourceFieldsFor(suggestion.bitrix24Id),
    details: suggestion.kind === "safe"
      ? "Найдена действующая карточка с тем же ФИО, типом, отделом и должностью. Связь с Битрикс24 сейчас на архивной карточке."
      : archiveTransferIds.has(suggestion.bitrix24Id)
        ? "Связь с Битрикс24 сейчас на архивной карточке. Найдена одна действующая карточка с тем же ФИО. При переносе кадровые данные не изменятся."
        : "Связь с Битрикс24 сейчас на архивной карточке. Проверьте действующего сотрудника вручную перед сопоставлением.",
  }] : []);
  const legacyTerminations = observeLegacyTerminalBitrixDuplicates(sourceSnapshot, localEmployees);
  const legacyTerminalEmployeeIds = new Set(legacyTerminations.map(item => item.employeeId));
  const legacyDifferences = legacyTerminations.map(({ employeeId, bitrix24Id, status, details }) => ({
    kind: status, localEmployeeId: employeeId, bitrix24Id, employeeName: sourceById.get(bitrix24Id)!.fullName, details,
  }));
  const officeDifferences = localEmployees.flatMap(employee => {
    if (!employee.bitrix24Id || sourceIdUses.get(employee.bitrix24Id) !== 1) return [];
    const source = sourceById.get(employee.bitrix24Id);
    if (!source) return [];
    const direction = bitrixOfficeTransferDirection(source, employee);
    if (!direction) return [];
    return [{ kind: "changed" as const, officeTransfer: direction, officeTransferFingerprint: officeTransferFingerprint(source, direction),
      localEmployeeId: employee.id, bitrix24Id: source.bitrix24Id, employeeName: employee.fullName,
      details: direction === "to_office"
        ? "Подразделение в Битрикс24: «Центр. офис». После подтверждения действующие назначения на площадки закроются, а отчёты и табели сохранятся."
        : `Возвращается из офиса на объект: «${source.projectKeys.join("», «")}». После подтверждения откроется новое назначение на той же карточке.`,
    }];
  });
  const officeFingerprints = new Map(officeDifferences.map(difference => [difference.localEmployeeId, difference.officeTransferFingerprint]));
  const rawDifferences = [...archiveDifferences, ...comparedDifferences, ...legacyDifferences, ...officeDifferences];
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
  // Unlinked legacy duplicates can have a terminal warning from a previous
  // check. Remove it if the evidence no longer matches; never change the card here.
  const checkedEmployeeIds = localEmployees.filter(employee => employee.active === 1 || employee.availabilityStatus === "central_office").map(employee => employee.id);
  // Include skipped active linked records only for clearing a stale warning;
  // the review never updates their personnel card or its historical records.
  const linkedEmployeeIds = new Set(activeEmployees.filter(employee => employee.bitrix24Id).map(employee => employee.id));
  const existingStates = checkedEmployeeIds.length
    ? await env.DB.prepare(`SELECT employee_id AS "employeeId", status, details, fingerprint,
        acknowledged_at AS "acknowledgedAt" FROM bitrix24_employee_check_states WHERE employee_id = ANY(?)`)
      .bind(checkedEmployeeIds).all<{ employeeId: number; status: string; details: string; fingerprint: string; acknowledgedAt: string | null }>()
    : { results: [] as Array<{ employeeId: number; status: string; details: string; fingerprint: string; acknowledgedAt: string | null }> };
  const existingByEmployeeId = new Map(existingStates.results.map((state) => [state.employeeId, state]));
  const nextStates = new Map([...stateByEmployeeId].map(([employeeId, state]) => {
    const details = state.details.sort((left, right) => left.localeCompare(right, "ru-RU")).join("\n");
    return [employeeId, { ...state, details, fingerprint: officeFingerprints.get(employeeId) ?? JSON.stringify([state.status, details]) }] as const;
  }));
  await env.DB.transaction(async (db) => {
    const statements = [];
    if (archivedTerminalObservations.length) {
      statements.push(db.prepare(`INSERT INTO bitrix24_employee_check_states (employee_id, status, details, fingerprint, checked_at)
        SELECT employee.id, observation.status, observation.details, observation.fingerprint, ?::timestamptz
        FROM unnest(?::integer[], ?::text[], ?::text[], ?::text[], ?::text[]) AS observation(employee_id, bitrix_id, status, details, fingerprint)
        JOIN employees employee ON employee.id = observation.employee_id AND employee.bitrix24_id = observation.bitrix_id
        WHERE employee.active = 0 AND employee.availability_status NOT IN ('deleted', 'blacklisted')
        ORDER BY employee.id FOR UPDATE OF employee
        ON CONFLICT (employee_id) DO UPDATE SET status = EXCLUDED.status, details = EXCLUDED.details,
          fingerprint = EXCLUDED.fingerprint, checked_at = EXCLUDED.checked_at, acknowledged_at = NULL, acknowledged_by_user_id = NULL
        WHERE bitrix24_employee_check_states.status NOT IN ('blacklisted_in_bitrix', EXCLUDED.status)
        RETURNING employee_id`)
        .bind(checkedAt, archivedTerminalObservations.map(item => item.employeeId), archivedTerminalObservations.map(item => item.bitrix24Id),
          archivedTerminalObservations.map(item => item.status), archivedTerminalObservations.map(item => item.details),
          archivedTerminalObservations.map(item => item.fingerprint)));
    }
    for (const employeeId of checkedEmployeeIds) {
      const prior = existingByEmployeeId.get(employeeId);
      if (!nextStates.has(employeeId) && prior && (linkedEmployeeIds.has(employeeId)
        || prior.status === "dismissed_in_bitrix" || prior.status === "blacklisted_in_bitrix" || prior.fingerprint.startsWith("office_transfer:"))) {
        statements.push(db.prepare("DELETE FROM bitrix24_employee_check_states WHERE employee_id = ?").bind(employeeId));
      }
    }
    for (const [employeeId, state] of nextStates) {
      statements.push(db.prepare(`INSERT INTO bitrix24_employee_check_states
        (employee_id, status, details, fingerprint, checked_at, acknowledged_at, acknowledged_by_user_id)
        VALUES (?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT (employee_id) DO UPDATE SET status = EXCLUDED.status, details = EXCLUDED.details,
          fingerprint = EXCLUDED.fingerprint, checked_at = EXCLUDED.checked_at,
          acknowledged_at = CASE WHEN EXCLUDED.status <> 'blacklisted_in_bitrix' AND bitrix24_employee_check_states.fingerprint = EXCLUDED.fingerprint THEN bitrix24_employee_check_states.acknowledged_at ELSE NULL END,
          acknowledged_by_user_id = CASE WHEN EXCLUDED.status <> 'blacklisted_in_bitrix' AND bitrix24_employee_check_states.fingerprint = EXCLUDED.fingerprint THEN bitrix24_employee_check_states.acknowledged_by_user_id ELSE NULL END
        RETURNING employee_id`)
        .bind(employeeId, state.status, state.details, state.fingerprint, checkedAt));
    }
    for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
  });
  const differences = rawDifferences.map((difference) => {
    const nextState = difference.localEmployeeId ? nextStates.get(difference.localEmployeeId) : null;
    const previous = difference.localEmployeeId ? existingByEmployeeId.get(difference.localEmployeeId) : null;
    return { ...difference, acknowledged: Boolean(nextState && !officeFingerprints.has(difference.localEmployeeId!)
      && nextState.status !== "blacklisted_in_bitrix" && previous?.fingerprint === nextState.fingerprint && previous.acknowledgedAt) };
  });
  const activeDifferences = differences.filter((difference) => !difference.acknowledged);
  const dismissalEmployeeIds = [...new Set(activeDifferences.flatMap(difference =>
    difference.kind === "dismissed_in_bitrix" && difference.localEmployeeId && difference.bitrix24Id
      && sourceById.get(difference.bitrix24Id)?.availabilityStatus === "dismissed" ? [difference.localEmployeeId] : []))];
  const ignorableEmployeeIds = [...new Set(activeDifferences.flatMap(difference => {
    const id = difference.localEmployeeId;
    return id && nextStates.has(id) && !officeFingerprints.has(id) && nextStates.get(id)?.status !== "blacklisted_in_bitrix" ? [id] : [];
  }))];
  const warningFingerprints = Object.fromEntries(ignorableEmployeeIds.map(id => [id, nextStates.get(id)!.fingerprint]));
  const differenceCounts = activeDifferences.reduce<Record<string, number>>((counts, difference) => {
    counts[difference.kind] = (counts[difference.kind] ?? 0) + 1;
    return counts;
  }, {});
  const selectedIds = new Set(snapshot.map((employee) => employee.bitrix24Id));
  const excluded = reviewSource.filter((employee) => !selectedIds.has(employee.bitrix24Id));
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
      compared: localByBitrixId.size,
      matched: comparison.matched,
      differences: [...activeDifferences, ...differences.filter((difference) => difference.acknowledged)],
      updatableEmployeeIds: bitrixReviewUpdateIds({ differences: activeDifferences.filter(difference =>
        difference.kind !== "dismissed_in_bitrix" || difference.bitrix24Id && sourceById.get(difference.bitrix24Id)?.availabilityStatus === "dismissed") }),
      dismissalEmployeeIds,
      legacyTerminalEmployeeIds: [...legacyTerminalEmployeeIds],
      ignorableEmployeeIds,
      warningFingerprints,
      archiveReturns,
      totalDifferences: activeDifferences.length,
      differenceCounts,
      acknowledgedDifferences: differences.length - activeDifferences.length,
      sourceReceived: reviewSource.length,
      received: snapshot.length,
      excluded: excluded.length,
      incomplete: snapshot.filter((employee) => !employee.fullName || !employee.employmentType || !employee.department || !employee.position).length,
      unknownStages: snapshot.filter((employee) => employee.availabilityStatus === "unknown").length,
      stages: countValues(snapshot.map((employee) => employee.stageName || employee.stageId)),
      projects: countValues(snapshot.flatMap((employee) => employee.projectKeys.length ? employee.projectKeys : ["Не указано"])),
      excludedStages: countValues(excluded.map((employee) => employee.stageName || employee.stageId)),
      autoLinkable: autoLinkOptions.length,
      archiveAutoLinkable: autoLinkOptions.filter(option => option.archivedLink).length,
      autoLinkOptions,
      archiveTransferOptions,
      archiveLinkRevision,
      activeUnlinked: activeEmployees.filter(employee => !employee.bitrix24Id && !legacyTerminalEmployeeIds.has(employee.id)).length,
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

  assertBitrixEmployeeNotInCentralOffice(sourceSnapshot, bitrix24Id);
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

async function legacyTerminalCandidates(db: DatabaseExecutor, sourceSnapshot: BitrixEmployeeSnapshot[]) {
  const { results } = await db.prepare(`SELECT id, bitrix24_id AS "bitrix24Id", full_name AS "fullName",
    employment_type AS "employmentType", department, position, availability_status AS "availabilityStatus", active
    FROM employees WHERE active = 1 OR bitrix24_id IS NOT NULL`).all<BitrixLinkRecord>();
  return observeLegacyTerminalBitrixDuplicates(sourceSnapshot, results);
}

/** Applying a terminal status never replaces personnel data or report history. */
async function archiveTerminalBitrixEmployeeRecord(source: BitrixEmployeeSnapshot, employeeId: number, bitrix24Id: string,
  legacySources?: BitrixEmployeeSnapshot[]) {
  const status = source.availabilityStatus === "blacklisted" ? "blacklisted" : "dismissed";
  return env.DB.transaction(async db => {
    let current = await db.prepare(`SELECT id, full_name AS "fullName", employment_type AS "employmentType", department, position,
      bitrix24_stage AS "bitrix24Stage", availability_status AS "availabilityStatus", active
      FROM employees WHERE id = ? AND bitrix24_id = ? FOR UPDATE`).bind(employeeId, bitrix24Id).first<{
        id: number; fullName: string; employmentType: string; department: string; position: string; bitrix24Stage: string; availabilityStatus: EmployeeAvailabilityStatus; active: number;
      }>();
    let expectedLink: string | null = bitrix24Id;
    if (!current && legacySources) {
      const matchesSelection = (candidate: Awaited<ReturnType<typeof legacyTerminalCandidates>>[number]) =>
        candidate.employeeId === employeeId && candidate.bitrix24Id === bitrix24Id && candidate.availabilityStatus === status;
      const proposal = (await legacyTerminalCandidates(db, legacySources)).find(matchesSelection);
      if (proposal) {
        // The original archive keeps its ID. Lock both cards and recheck the
        // evidence before archiving only the selected, unlinked local card.
        const { results: pair } = await db.prepare(`SELECT id, bitrix24_id AS "bitrix24Id", full_name AS "fullName",
          employment_type AS "employmentType", department, position, bitrix24_stage AS "bitrix24Stage",
          availability_status AS "availabilityStatus", active
          FROM employees WHERE id = ANY(?::integer[]) ORDER BY id FOR UPDATE`)
          .bind([employeeId, proposal.archivedId]).all<BitrixLinkRecord & { bitrix24Stage: string }>();
        if (observeLegacyTerminalBitrixDuplicates(legacySources, pair).some(matchesSelection)) {
          current = pair.find(card => card.id === employeeId) ?? null;
          expectedLink = null;
        }
      }
    }
    if (!current) throw new Error("Связанная карточка сотрудника изменилась. Выполните проверку ещё раз.");
    if (current.availabilityStatus === "blacklisted" && status !== "blacklisted") {
      throw new Error("Сотрудник находится в чёрном списке. Снять запрет на повторный приём можно только отдельной кадровой корректировкой.");
    }
    if (current.active !== 1) throw new Error("Сотрудник уже архивирован. Выполните проверку ещё раз.");
    const updatedAt = new Date().toISOString();
    const saved = await db.prepare(`UPDATE employees SET bitrix24_stage = ?, availability_status = ?, active = 0, site_id = NULL,
      bitrix24_updated_at = ?, last_synced_at = ?, sync_error = NULL, sync_miss_count = 0
      WHERE id = ? AND active = 1 AND bitrix24_id IS NOT DISTINCT FROM ?`).bind(source.stageName, status, source.sourceUpdatedAt, updatedAt, employeeId, expectedLink).run();
    if (saved.meta.changes !== 1) throw new Error("Карточка сотрудника изменилась или уже архивирована. Выполните проверку ещё раз.");
    const statements = [db.prepare(`UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE)
      WHERE employee_id = ? AND active = 1`).bind(employeeId)];
    if (current.bitrix24Stage !== source.stageName) {
      statements.push(db.prepare(`INSERT INTO employee_profile_versions
        (employee_id, full_name, employment_type, department, position, bitrix24_stage, valid_from, valid_to, source)
        SELECT ?, ?, ?, ?, ?, ?, '-infinity'::timestamptz, ?, 'local'
        WHERE NOT EXISTS (SELECT 1 FROM employee_profile_versions WHERE employee_id = ?)`)
        .bind(employeeId, current.fullName, current.employmentType, current.department, current.position, current.bitrix24Stage, updatedAt, employeeId));
      statements.push(db.prepare("UPDATE employee_profile_versions SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(updatedAt, employeeId));
      statements.push(db.prepare(`INSERT INTO employee_profile_versions
        (employee_id, full_name, employment_type, department, position, bitrix24_stage, valid_from, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'bitrix24')`).bind(employeeId, current.fullName, current.employmentType, current.department, current.position, source.stageName, updatedAt));
    }
    if (current.availabilityStatus !== status) {
      statements.push(db.prepare(`INSERT INTO employee_availability_periods (employee_id, status, valid_from, valid_to, source)
        SELECT ?, ?, '-infinity'::timestamptz, ?, 'local'
        WHERE NOT EXISTS (SELECT 1 FROM employee_availability_periods WHERE employee_id = ?)`)
        .bind(employeeId, current.availabilityStatus, updatedAt, employeeId));
      statements.push(db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(updatedAt, employeeId));
      statements.push(db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, ?, ?, 'bitrix24')").bind(employeeId, status, updatedAt));
    }
    statements.push(db.prepare("DELETE FROM bitrix24_employee_check_states WHERE employee_id = ?").bind(employeeId));
    for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
    return { id: employeeId, name: current.fullName };
  });
}

async function requireOfficeTransferConfirmation(db: DatabaseExecutor, source: BitrixEmployeeSnapshot,
  current: BitrixLinkRecord & { hasProjectHistory?: boolean }, direction: BitrixOfficeTransferDirection, fingerprint: string) {
  if (bitrixOfficeTransferDirection(source, current) !== direction || officeTransferFingerprint(source, direction) !== fingerprint) {
    throw new Error("Перевод сотрудника изменился в Битрикс24. Выполните сверку заново.");
  }
  const warning = await db.prepare(`SELECT fingerprint FROM bitrix24_employee_check_states
    WHERE employee_id = ? AND status = 'mismatch' AND acknowledged_at IS NULL FOR UPDATE`).bind(current.id).first<{ fingerprint: string }>();
  if (warning?.fingerprint !== fingerprint) throw new Error("Подтверждение перевода устарело. Выполните сверку заново.");
}

async function moveBitrixEmployeeToCentralOffice(source: BitrixEmployeeSnapshot, employeeId: number, fingerprint: string) {
  return env.DB.transaction(async db => {
    const current = await db.prepare(`SELECT id, bitrix24_id AS "bitrix24Id", full_name AS "fullName",
      employment_type AS "employmentType", department, position, availability_status AS "availabilityStatus", active,
      EXISTS (SELECT 1 FROM employee_project_assignments a WHERE a.employee_id = employees.id) AS "hasProjectHistory"
      FROM employees WHERE id = ? AND bitrix24_id = ? FOR UPDATE`).bind(employeeId, source.bitrix24Id)
      .first<BitrixLinkRecord & { hasProjectHistory: boolean }>();
    if (!current) throw new Error("Связанная карточка сотрудника изменилась. Выполните сверку заново.");
    await requireOfficeTransferConfirmation(db, source, current, "to_office", fingerprint);
    const updatedAt = new Date().toISOString();
    const saved = await db.prepare(`UPDATE employees SET availability_status = 'central_office', active = 0, site_id = NULL,
      bitrix24_updated_at = ?, last_synced_at = ?, sync_error = NULL, sync_miss_count = 0
      WHERE id = ? AND active = 1 AND bitrix24_id = ?`).bind(source.sourceUpdatedAt, updatedAt, employeeId, source.bitrix24Id).run();
    if (saved.meta.changes !== 1) throw new Error("Карточка сотрудника изменилась. Выполните сверку заново.");
    // Only close the project membership. Keep the identity and the field HR
    // profile; office HR data does not belong in the field catalogue.
    await db.batch([
      db.prepare(`UPDATE employee_project_assignments SET active = 0,
        end_date = COALESCE(end_date, (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date) WHERE employee_id = ? AND active = 1`).bind(employeeId),
      db.prepare(`INSERT INTO employee_availability_periods (employee_id, status, valid_from, valid_to, source)
        SELECT ?, ?, '-infinity'::timestamptz, ?, 'local'
        WHERE NOT EXISTS (SELECT 1 FROM employee_availability_periods WHERE employee_id = ?)`).bind(employeeId, current.availabilityStatus, updatedAt, employeeId),
      db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(updatedAt, employeeId),
      db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, 'central_office', ?, 'bitrix24')").bind(employeeId, updatedAt),
      db.prepare("DELETE FROM bitrix24_employee_check_states WHERE employee_id = ?").bind(employeeId),
    ]);
    return { id: employeeId, name: current.fullName };
  });
}

async function updateBitrixEmployeeRecord(sourceSnapshot: BitrixEmployeeSnapshot[], employeeId: number, bitrix24Id: string,
  mayArchiveLegacy = false, transferFingerprint?: string) {
  if (transferFingerprint === undefined) assertBitrixEmployeeNotInCentralOffice(sourceSnapshot, bitrix24Id);
  const candidates = sourceSnapshot.filter(employee => employee.bitrix24Id === bitrix24Id);
  const source = candidates[0];
  if (!source) throw new Error("Карточка сотрудника больше не найдена в Битрикс24.");
  if (transferFingerprint !== undefined) {
    if (candidates.length !== 1) throw new Error("Карточка Битрикс24 не определена однозначно. Выполните сверку заново.");
    if (isBitrixCentralOfficeEmployee(source)) return moveBitrixEmployeeToCentralOffice(source, employeeId, transferFingerprint);
    if (source.availabilityStatus !== "on_site") throw new Error("Перевод сотрудника изменился в Битрикс24. Выполните сверку заново.");
  }
  if (source.availabilityStatus === "blacklisted") return archiveTerminalBitrixEmployeeRecord(source, employeeId, bitrix24Id, mayArchiveLegacy ? sourceSnapshot : undefined);
  if (!source.fullName || !source.employmentType || !source.department || !source.position) {
    throw new Error("В Битрикс24 не заполнены ФИО, тип, отдел или должность. Сначала заполните карточку Битрикс24.");
  }
  if (source.availabilityStatus === "unknown") throw new Error(`Для стадии «${source.stageName || source.stageId}» не настроен статус сотрудника.`);
  if (source.availabilityStatus === "dismissed" || source.availabilityStatus === "deleted") {
    throw new Error("Для уволенного или удалённого сотрудника используйте действие «Удалить» либо подтвердите предупреждение.");
  }
  const siteIds = await resolveBitrixEmployeeSites(source);
  const primarySiteId = source.availabilityStatus === "on_site" ? siteIds[0] ?? null : null;
  await env.DB.transaction(async (db) => {
    // The history baseline must reflect the row we actually replace, not an
    // unlocked snapshot taken before another edit or archive committed.
    const current = await db.prepare(`SELECT id, bitrix24_id AS "bitrix24Id", full_name AS "fullName",
      employment_type AS "employmentType", department, position, bitrix24_stage AS "bitrix24Stage",
      availability_status AS "availabilityStatus", active
      FROM employees WHERE id = ? FOR UPDATE`).bind(employeeId).first<BitrixLinkRecord & { bitrix24Stage: string }>();
    if (!current || current.bitrix24Id !== bitrix24Id) throw new Error("Связанная карточка сотрудника изменилась. Выполните проверку ещё раз.");
    if (transferFingerprint !== undefined) await requireOfficeTransferConfirmation(db, source, current, "to_site", transferFingerprint);
    else if (!current.active) throw new Error("Сотрудник архивирован. Повторный приём требует отдельной кадровой корректировки.");
    await validateEmployeeDirectoryValues(source.employmentType, source.department, source.position, null, db);
    const duplicate = await db.prepare("SELECT id FROM employees WHERE full_name = ? AND id <> ? AND active = 1").bind(source.fullName, employeeId).first();
    if (duplicate) throw new Error(`Сотрудник с ФИО «${source.fullName}» уже существует. Обновление остановлено, чтобы не создать дубль.`);
    const updatedAt = new Date().toISOString();
    const profileChanged = current.fullName !== source.fullName || current.employmentType !== source.employmentType
      || current.department !== source.department || current.position !== source.position || current.bitrix24Stage !== source.stageName;
    const returning = transferFingerprint !== undefined;
    const activeCondition = returning ? "active = 0 AND availability_status = 'central_office'" : "active = 1";
    const saved = await db.prepare(`UPDATE employees SET full_name = ?, employment_type = ?, department = ?, position = ?,
      bitrix24_stage = ?, availability_status = ?, bitrix24_updated_at = ?, last_synced_at = ?, sync_error = NULL,
      sync_miss_count = 0, source = 'bitrix24', active = 1, site_id = ? WHERE id = ? AND ${activeCondition} AND bitrix24_id = ?`)
      .bind(source.fullName, source.employmentType, source.department, source.position, source.stageName,
        source.availabilityStatus, source.sourceUpdatedAt, updatedAt, primarySiteId, employeeId, bitrix24Id).run();
    if (saved.meta.changes !== 1) throw new Error("Карточка сотрудника изменилась или уже архивирована. Выполните проверку ещё раз.");
    const statements = [];
    if (profileChanged || returning) {
      // Excel/manual cards have no initial profile version. Keep the old
      // values so manual-only historical timesheets do not use the new card.
      statements.push(db.prepare(`INSERT INTO employee_profile_versions
        (employee_id, full_name, employment_type, department, position, bitrix24_stage, valid_from, valid_to, source)
        SELECT ?, ?, ?, ?, ?, ?, '-infinity'::timestamptz, ?, 'local'
        WHERE NOT EXISTS (SELECT 1 FROM employee_profile_versions WHERE employee_id = ?)`)
        .bind(employeeId, current.fullName, current.employmentType, current.department, current.position, current.bitrix24Stage, updatedAt, employeeId));
      statements.push(db.prepare("UPDATE employee_profile_versions SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(updatedAt, employeeId));
      statements.push(db.prepare(`INSERT INTO employee_profile_versions
        (employee_id, full_name, employment_type, department, position, bitrix24_stage, valid_from, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'bitrix24')`)
        .bind(employeeId, source.fullName, source.employmentType, source.department, source.position, source.stageName, updatedAt));
    }
    if (current.availabilityStatus !== source.availabilityStatus) {
      statements.push(db.prepare(`INSERT INTO employee_availability_periods (employee_id, status, valid_from, valid_to, source)
        SELECT ?, ?, '-infinity'::timestamptz, ?, 'local'
        WHERE NOT EXISTS (SELECT 1 FROM employee_availability_periods WHERE employee_id = ?)`)
        .bind(employeeId, current.availabilityStatus, updatedAt, employeeId));
      statements.push(db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(updatedAt, employeeId));
      statements.push(db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, ?, ?, 'bitrix24')")
        .bind(employeeId, source.availabilityStatus, updatedAt));
    }
    if (source.availabilityStatus === "on_site" && siteIds.length) {
      const placeholders = siteIds.map(() => "?").join(", ");
      statements.push(db.prepare(`UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE)
        WHERE employee_id = ? AND active = 1 AND site_id NOT IN (${placeholders})`).bind(employeeId, ...siteIds));
      for (const siteId of siteIds) {
        const startDate = returning ? "(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date" : "CURRENT_DATE";
        statements.push(db.prepare(`INSERT INTO employee_project_assignments (employee_id, site_id, source, start_date)
          SELECT ?, ?, 'bitrix24', ${startDate} WHERE NOT EXISTS
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

export async function updateBitrixEmployee(sourceSnapshot: BitrixEmployeeSnapshot[], payload: UserPayload, { mayArchiveLegacy = false } = {}) {
  const employeeId = asPositiveInteger(payload.employeeId);
  const bitrix24Id = payload.bitrix24Id?.trim() ?? "";
  if (!employeeId || !bitrix24Id) throw new Error("Сотрудник для изменения не указан.");
  const transferFingerprint = payload.officeTransferFingerprints?.[employeeId];
  if (transferFingerprint !== undefined && typeof transferFingerprint !== "string") throw new Error("Некорректное подтверждение перевода.");
  const updatedEmployee = await updateBitrixEmployeeRecord(sourceSnapshot, employeeId, bitrix24Id, mayArchiveLegacy, transferFingerprint);
  const updated = await buildBitrixInspection(sourceSnapshot);
  return { ...updated.response, updatedEmployee };
}

export async function updateSelectedBitrixEmployees(sourceSnapshot: BitrixEmployeeSnapshot[], payload: UserPayload, { mayArchiveDismissed = false } = {}) {
  const employeeIds = [...new Set((Array.isArray(payload.employeeIds) ? payload.employeeIds : [])
    .map(asPositiveInteger).filter((id): id is number => Boolean(id)))];
  if (!employeeIds.length) throw new Error("Не выбраны сотрудники для актуализации.");
  if (employeeIds.length > 200) throw new Error("За один раз можно актуализировать не более 200 сотрудников.");
  const rows = await env.DB.prepare(`SELECT e.id, e.full_name AS "fullName", e.bitrix24_id AS "bitrix24Id",
      check_state.status AS "checkStatus", check_state.acknowledged_at AS "acknowledgedAt"
    FROM employees e
    LEFT JOIN bitrix24_employee_check_states check_state ON check_state.employee_id = e.id
    WHERE e.id = ANY(?) AND (e.active = 1 OR e.availability_status = 'central_office'
      AND check_state.fingerprint LIKE 'office_transfer:%')`).bind(employeeIds).all<{
      id: number; fullName: string; bitrix24Id: string | null; checkStatus: string | null; acknowledgedAt: string | null;
    }>();
  const rowById = new Map(rows.results.map((row) => [row.id, row]));
  const legacyByEmployeeId = new Map((mayArchiveDismissed && rows.results.some(row => !row.bitrix24Id
    && (row.checkStatus === "dismissed_in_bitrix" || row.checkStatus === "blacklisted_in_bitrix"))
    ? await legacyTerminalCandidates(env.DB, sourceSnapshot) : []).map(candidate => [candidate.employeeId, candidate]));
  const sourceById = new Map<string, BitrixEmployeeSnapshot | null>();
  for (const source of sourceSnapshot) {
    sourceById.set(source.bitrix24Id, sourceById.has(source.bitrix24Id) ? null : source);
  }
  const updatedEmployees: Array<{ id: number; name: string }> = [];
  const failedEmployees: Array<{ id: number; name: string; error: string }> = [];
  for (const employeeId of employeeIds) {
    const row = rowById.get(employeeId);
    if (!row) {
      failedEmployees.push({ id: employeeId, name: `ID ${employeeId}`, error: "Сотрудник не найден в активном справочнике." });
      continue;
    }
    const terminalStatus = row.checkStatus === "blacklisted_in_bitrix" ? "blacklisted"
      : row.checkStatus === "dismissed_in_bitrix" ? "dismissed" : null;
    const legacy = !row.bitrix24Id && terminalStatus ? legacyByEmployeeId.get(employeeId) : undefined;
    const bitrix24Id = row.bitrix24Id ?? legacy?.bitrix24Id;
    if (!bitrix24Id) {
      failedEmployees.push({ id: employeeId, name: row.fullName, error: terminalStatus
        ? "Не удалось подтвердить связь архивной карточки или нет права переносить сотрудников в архив."
        : "Нет связи с карточкой Битрикс24." });
      continue;
    }
    if ((!terminalStatus && row.checkStatus !== "mismatch") || (row.acknowledgedAt && terminalStatus !== "blacklisted")) {
      failedEmployees.push({ id: employeeId, name: row.fullName, error: "Нет активного расхождения, которое можно актуализировать." });
      continue;
    }
    try {
      const transferFingerprint = payload.officeTransferFingerprints?.[employeeId];
      if (transferFingerprint === undefined) assertBitrixEmployeeNotInCentralOffice(sourceSnapshot, bitrix24Id);
      else if (typeof transferFingerprint !== "string" || terminalStatus) throw new Error("Некорректное подтверждение перевода.");
      if (terminalStatus === "dismissed" && !mayArchiveDismissed) {
        throw new Error("Недостаточно прав для переноса уволенного сотрудника в архив.");
      }
      const source = sourceById.get(bitrix24Id);
      if (!source) {
        throw new Error(source === null
          ? "В Битрикс24 найдено несколько карточек с тем же ID. Изменения не применены."
          : "Карточка сотрудника больше не найдена в Битрикс24.");
      }
      const statusChanged = terminalStatus ? source.availabilityStatus !== terminalStatus
        : ["dismissed", "blacklisted", "deleted"].includes(source.availabilityStatus);
      if (statusChanged) {
        throw new Error("Статус сотрудника в Битрикс24 изменился после проверки. Проверьте его ещё раз перед применением.");
      }
      // ID Битрикс24 берётся из строки самого сотрудника, поэтому данные выбранных карточек не могут смешаться.
      updatedEmployees.push(terminalStatus
        ? await archiveTerminalBitrixEmployeeRecord(source, row.id, bitrix24Id, legacy ? sourceSnapshot : undefined)
        : transferFingerprint !== undefined ? await updateBitrixEmployeeRecord(sourceSnapshot, row.id, bitrix24Id, false, transferFingerprint)
          : await updateBitrixEmployeeRecord(sourceSnapshot, row.id, bitrix24Id));
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
  assertBitrixEmployeeNotInCentralOffice(sourceSnapshot, bitrix24Id);
  const source = sourceSnapshot.find((employee) => employee.bitrix24Id === bitrix24Id);
  if (source?.availabilityStatus === "dismissed") {
    const deletedEmployee = await archiveTerminalBitrixEmployeeRecord(source, employeeId, bitrix24Id, sourceSnapshot);
    const updated = await buildBitrixInspection(sourceSnapshot);
    return { ...updated.response, deletedEmployee };
  }
  if (source && source.availabilityStatus !== "deleted") {
    throw new Error("Карточка снова найдена среди действующих сотрудников Битрикс24. Удаление отменено — выполните проверку ещё раз.");
  }
  const current = await env.DB.transaction(async (db) => {
    const employee = await db.prepare("SELECT full_name AS \"fullName\" FROM employees WHERE id = ? AND bitrix24_id = ? AND active = 1 FOR UPDATE")
      .bind(employeeId, bitrix24Id).first<{ fullName: string }>();
    if (!employee) throw new Error("Сотрудник уже удалён или связь с Битрикс24 изменилась.");
    const deletedAt = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE) WHERE employee_id = ? AND active = 1").bind(employeeId),
      db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(deletedAt, employeeId),
      db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, 'deleted', ?, 'bitrix24')").bind(employeeId, deletedAt),
      db.prepare("UPDATE employees SET active = 0, site_id = NULL, availability_status = 'deleted', bitrix24_stage = 'Нет в Битрикс24', last_synced_at = ? WHERE id = ? AND active = 1").bind(deletedAt, employeeId),
      db.prepare("DELETE FROM bitrix24_employee_check_states WHERE employee_id = ?").bind(employeeId),
    ]);
    return employee;
  });
  const updated = await buildBitrixInspection(sourceSnapshot);
  return { ...updated.response, deletedEmployee: { id: employeeId, name: current.fullName } };
}

export async function linkBitrixEmployees(sourceSnapshot: BitrixEmployeeSnapshot[], requestedLinks: UserPayload["links"],
  { allowArchivedLink = false, archiveLinkRevision = "", autoLinkBitrixIds, archiveTransferLinks }: {
    allowArchivedLink?: boolean; archiveLinkRevision?: string; autoLinkBitrixIds?: unknown; archiveTransferLinks?: unknown;
  } = {}) {
  const hasBulkSelection = autoLinkBitrixIds !== undefined || archiveTransferLinks !== undefined;
  if (hasBulkSelection && requestedLinks !== undefined) throw new Error("Выберите один способ сопоставления: вручную или по отмеченным карточкам.");
  let selectedIds: string[] | undefined;
  if (autoLinkBitrixIds !== undefined) {
    if (!Array.isArray(autoLinkBitrixIds) || !autoLinkBitrixIds.length
      || autoLinkBitrixIds.some(id => typeof id !== "string" || !id || id.trim() !== id)) {
      throw new Error("Отметьте карточки с точным совпадением для сопоставления.");
    }
    selectedIds = [...new Set<string>(autoLinkBitrixIds)];
  }
  const selectedTransfers: Array<{ bitrix24Id: string; employeeId: number }> = [];
  if (archiveTransferLinks !== undefined) {
    if (!Array.isArray(archiveTransferLinks) || !archiveTransferLinks.length) throw new Error("Отметьте карточки для переноса связи.");
    for (const pair of archiveTransferLinks) {
      if (!pair || typeof pair.bitrix24Id !== "string" || !pair.bitrix24Id || pair.bitrix24Id.trim() !== pair.bitrix24Id
        || typeof pair.employeeId !== "number" || !Number.isSafeInteger(pair.employeeId) || pair.employeeId <= 0) {
        throw new Error("Проверьте выбранные карточки для переноса связи.");
      }
      selectedTransfers.push({ bitrix24Id: pair.bitrix24Id, employeeId: pair.employeeId });
    }
    if (!allowArchivedLink) throw new Error("Подтвердите перенос связи с архивной карточки.");
  }
  const inspection = await buildBitrixInspection(sourceSnapshot);
  const sourceById = new Map(inspection.snapshot.map((employee) => [employee.bitrix24Id, employee]));
  const localById = new Map(inspection.localEmployees.filter(employee => employee.active === 1).map((employee) => [employee.id, employee]));
  const linkedByBitrixId = new Map(inspection.localEmployees.flatMap((employee) => employee.bitrix24Id ? [[employee.bitrix24Id, employee] as const] : []));
  const archiveSuggestions = new Map(inspection.suggestions.flatMap(suggestion => linkedByBitrixId.get(suggestion.bitrix24Id)?.active === 0
    ? [[suggestion.bitrix24Id, suggestion] as const] : []));
  if (allowArchivedLink) {
    if (!archiveLinkRevision || archiveLinkRevision !== inspection.response.archiveLinkRevision) {
      throw new Error("Кандидаты для сопоставления изменились. Выполните проверку Битрикс24 ещё раз.");
    }
    for (const source of sourceSnapshot) if (archiveSuggestions.has(source.bitrix24Id)) sourceById.set(source.bitrix24Id, source);
  }
  const safeByBitrixId = new Map(inspection.suggestions.flatMap(suggestion => suggestion.kind === "safe" ? [[suggestion.bitrix24Id, suggestion] as const] : []));
  const availableTransfers = new Map(inspection.response.archiveTransferOptions.map(({ bitrix24Id, employeeId }) => [bitrix24Id, employeeId]));
  for (const pair of selectedTransfers) {
    if (availableTransfers.get(pair.bitrix24Id) !== pair.employeeId) {
      throw new Error("Отмеченные пары для переноса связи изменились. Выполните проверку Битрикс24 ещё раз.");
    }
  }
  const links = hasBulkSelection
    ? [...(selectedIds ?? []).map(bitrix24Id => {
      const suggestion = safeByBitrixId.get(bitrix24Id);
      if (!suggestion) throw new Error("Отмеченные совпадения изменились. Выполните проверку Битрикс24 ещё раз.");
      if (archiveSuggestions.has(bitrix24Id) && !allowArchivedLink) throw new Error("Подтвердите перенос связи с архивной карточки.");
      return { bitrix24Id, employeeId: suggestion.employeeIds[0] ?? null };
    }), ...selectedTransfers]
    : requestedLinks?.length
      ? requestedLinks.map((link) => ({ bitrix24Id: link.bitrix24Id?.trim() ?? "", employeeId: asPositiveInteger(link.employeeId) }))
      : [...safeByBitrixId.values()].filter(suggestion => allowArchivedLink || !archiveSuggestions.has(suggestion.bitrix24Id))
        .map((suggestion) => ({ bitrix24Id: suggestion.bitrix24Id, employeeId: suggestion.employeeIds[0] ?? null }));
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
    const archived = allowArchivedLink && alreadyLinked?.active === 0 && archiveSuggestions.get(source.bitrix24Id)?.employeeIds.includes(local.id)
      ? alreadyLinked : null;
    if (alreadyLinked && !archived) throw new Error(`Карточка Битрикс24 уже связана с сотрудником «${alreadyLinked.fullName}».`);
    if (local.bitrix24Id || ["blacklisted", "dismissed", "deleted"].includes(local.availabilityStatus)) {
      throw new Error(`Карточка «${local.fullName}» больше недоступна для сопоставления. Обновите результаты проверки.`);
    }
    if (bitrixIds.has(source.bitrix24Id) || employeeIds.has(local.id)) throw new Error("Одна карточка не может участвовать в нескольких сопоставлениях.");
    bitrixIds.add(source.bitrix24Id);
    employeeIds.add(local.id);
    return { source, local, archived };
  });
  const transfers = prepared.flatMap(({ source, local, archived }) => archived
    ? [{ bitrix24Id: source.bitrix24Id, archivedEmployeeId: archived.id, activeEmployeeId: local.id }] : []);
  const linked = await env.DB.transaction(async (db) => {
    const expectedRows = prepared.flatMap(({ local, archived }) => archived ? [local, archived] : [local]);
    const locked = await db.prepare(`SELECT id, bitrix24_id AS "bitrix24Id", full_name AS "fullName",
      employment_type AS "employmentType", department, position, availability_status AS "availabilityStatus", active
      FROM employees WHERE id = ANY(?::integer[]) ORDER BY id FOR UPDATE`)
      .bind(expectedRows.map(row => row.id)).all<BitrixLinkRecord>();
    const currentById = new Map(locked.results.map(row => [row.id, row]));
    const stale = "Список сотрудников изменился во время сопоставления. Обновите проверку и повторите действие.";
    if (expectedRows.some(expected => {
      const current = currentById.get(expected.id);
      return !current || (["active", "bitrix24Id", "availabilityStatus", "fullName", "employmentType", "department", "position"] as const)
        .some(field => current[field] !== expected[field]);
    })) throw new Error(stale);
    if (transfers.length) {
      const released = await db.prepare(`UPDATE employees AS employee SET bitrix24_id = NULL
        FROM unnest(?::integer[], ?::text[]) AS link(employee_id, bitrix_id)
        WHERE employee.id = link.employee_id AND employee.active = 0 AND employee.bitrix24_id = link.bitrix_id
          AND NOT EXISTS (SELECT 1 FROM bitrix24_employee_check_states check_state WHERE check_state.employee_id = employee.id
            AND check_state.status IN ('dismissed_in_bitrix', 'blacklisted_in_bitrix'))`)
        .bind(transfers.map(item => item.archivedEmployeeId), transfers.map(item => item.bitrix24Id)).run();
      if (released.meta.changes !== transfers.length) throw new Error(stale);
    }
    const attached = await db.prepare(`UPDATE employees AS employee SET bitrix24_id = link.bitrix_id
      FROM unnest(?::integer[], ?::text[]) AS link(employee_id, bitrix_id)
      WHERE employee.id = link.employee_id AND employee.active = 1 AND employee.bitrix24_id IS NULL`)
      .bind(prepared.map(item => item.local.id), prepared.map(item => item.source.bitrix24Id)).run();
    if (attached.meta.changes !== prepared.length) throw new Error(stale);
    return attached.meta.changes;
  });
  const updated = await buildBitrixInspection(sourceSnapshot);
  return { ...updated.response, linked, archiveRelinks: Object.fromEntries(transfers.map(({ bitrix24Id, ...pair }) => [bitrix24Id, pair])) };
}
