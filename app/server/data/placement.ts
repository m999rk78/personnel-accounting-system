import { type AuthUser } from "../../auth";
import { hasRestrictedProjectAccess, type UserRole, canAccessProject } from "../../roles";
import { loadUserProjectAccess } from "../../projectAccessServer";
import { env, type DatabaseExecutor } from "./context";
import { type EntryPayload, type ExistingPlacementEntry } from "./types";
import { asPositiveInteger, validDate, isOprEmploymentType } from "./validation";
import { PlacementRequestError } from "./responses";
import { canManagePlacement } from "./access";

export function placementEntriesStatement(siteId: number, workDate: string, responsibleUserId?: number) {
  const ownershipFilter = responsibleUserId ? "AND pe.responsible_user_id = ?" : "";
  return env.DB.prepare(`SELECT pe.id, pe.site_id AS siteId, pe.work_date AS workDate, pe.employee_id AS employeeId,
    pe.shift_id AS shiftId, pe.zone_id AS zoneId, pe.main_work_type_id AS mainWorkTypeId,
    pe.subwork_type_id AS subworkTypeId, pe.note, pe.master_id AS masterId, pe.hours,
    pe.responsible_user_id AS responsibleUserId, responsible.full_name AS responsibleUserName, pe.revision,
    pe.position_snapshot AS positionSnapshot,
    COALESCE(NULLIF(pe.employee_name_snapshot, ''), e.full_name) AS employeeName,
    COALESCE(NULLIF(pe.employment_type_snapshot, ''), e.employment_type) AS employmentType,
    COALESCE(NULLIF(pe.department_snapshot, ''), e.department) AS department,
    s.name AS shiftName, z.name AS zoneName, mw.name AS mainWorkTypeName, sw.name AS subworkTypeName,
    COALESCE(NULLIF(pe.master_name_snapshot, ''), m.name) AS masterName
    FROM placement_entries pe
    JOIN employees e ON e.id = pe.employee_id
    JOIN shifts s ON s.id = pe.shift_id
    JOIN zones z ON z.id = pe.zone_id
    JOIN main_work_types mw ON mw.id = pe.main_work_type_id
    JOIN subwork_types sw ON sw.id = pe.subwork_type_id
    JOIN masters m ON m.id = pe.master_id
    LEFT JOIN app_users responsible ON responsible.id = pe.responsible_user_id
    WHERE pe.site_id = ? AND pe.work_date = ? AND pe.deleted_at IS NULL
      AND UPPER(TRIM(COALESCE(NULLIF(pe.employment_type_snapshot, ''), e.employment_type))) = 'ОПР'
      ${ownershipFilter}
    ORDER BY e.sort_order, e.full_name, pe.created_at, pe.id`).bind(...(responsibleUserId ? [siteId, workDate, responsibleUserId] : [siteId, workDate]));
}

export function placementEntriesForRangeStatement(siteId: number, rangeStart: string, rangeEnd: string, responsibleUserId?: number) {
  const ownershipFilter = responsibleUserId ? "AND pe.responsible_user_id = ?" : "";
  return env.DB.prepare(`SELECT pe.id, pe.site_id AS siteId, pe.work_date AS workDate, pe.employee_id AS employeeId,
    pe.shift_id AS shiftId, pe.zone_id AS zoneId, pe.main_work_type_id AS mainWorkTypeId,
    pe.subwork_type_id AS subworkTypeId, pe.note, pe.master_id AS masterId, pe.hours,
    pe.responsible_user_id AS responsibleUserId, responsible.full_name AS responsibleUserName, pe.revision,
    pe.position_snapshot AS positionSnapshot,
    COALESCE(NULLIF(pe.employee_name_snapshot, ''), e.full_name) AS employeeName,
    COALESCE(NULLIF(pe.employment_type_snapshot, ''), e.employment_type) AS employmentType,
    COALESCE(NULLIF(pe.department_snapshot, ''), e.department) AS department,
    s.name AS shiftName, z.name AS zoneName, mw.name AS mainWorkTypeName, sw.name AS subworkTypeName,
    COALESCE(NULLIF(pe.master_name_snapshot, ''), m.name) AS masterName
    FROM placement_entries pe
    JOIN employees e ON e.id = pe.employee_id
    JOIN shifts s ON s.id = pe.shift_id
    JOIN zones z ON z.id = pe.zone_id
    JOIN main_work_types mw ON mw.id = pe.main_work_type_id
    JOIN subwork_types sw ON sw.id = pe.subwork_type_id
    JOIN masters m ON m.id = pe.master_id
    LEFT JOIN app_users responsible ON responsible.id = pe.responsible_user_id
    WHERE pe.site_id = ? AND pe.work_date >= ? AND pe.work_date <= ? AND pe.deleted_at IS NULL
      AND UPPER(TRIM(COALESCE(NULLIF(pe.employment_type_snapshot, ''), e.employment_type))) = 'ОПР'
      ${ownershipFilter}
    ORDER BY pe.work_date, e.sort_order, e.full_name, pe.created_at, pe.id`)
    .bind(...(responsibleUserId ? [siteId, rangeStart, rangeEnd, responsibleUserId] : [siteId, rangeStart, rangeEnd]));
}

export function filledDatesStatement(siteId: number, rangeStart: string, rangeEnd: string, responsibleUserId?: number) {
  if (responsibleUserId) {
    return env.DB.prepare(`SELECT work_date AS "workDate" FROM placement_report_contributions
      WHERE site_id = ? AND foreman_id = ? AND work_date >= ? AND work_date <= ?
      UNION
      SELECT work_date AS "workDate" FROM placement_entries
      WHERE site_id = ? AND responsible_user_id = ? AND work_date >= ? AND work_date <= ? AND deleted_at IS NULL
        AND UPPER(TRIM(employment_type_snapshot)) = 'ОПР'
      ORDER BY "workDate"`).bind(siteId, responsibleUserId, rangeStart, rangeEnd, siteId, responsibleUserId, rangeStart, rangeEnd);
  }
  return env.DB.prepare(`SELECT work_date AS "workDate" FROM placement_report_days
    WHERE site_id = ? AND work_date >= ? AND work_date <= ?
    UNION
    SELECT work_date AS "workDate" FROM placement_entries
    WHERE site_id = ? AND work_date >= ? AND work_date <= ? AND deleted_at IS NULL
      AND UPPER(TRIM(employment_type_snapshot)) = 'ОПР'
    ORDER BY "workDate"`).bind(siteId, rangeStart, rangeEnd, siteId, rangeStart, rangeEnd);
}

export function reportSubmissionStatement(siteId: number, workDate: string, responsibleUserId?: number) {
  if (responsibleUserId) {
    return env.DB.prepare(`SELECT EXISTS (
      SELECT 1 FROM placement_report_contributions
      WHERE site_id = ? AND work_date = ? AND foreman_id = ? AND status = 'submitted'
    ) AS submitted`).bind(siteId, workDate, responsibleUserId);
  }
  return env.DB.prepare(`SELECT EXISTS (
    SELECT 1 FROM placement_report_days WHERE site_id = ? AND work_date = ?
  ) AS submitted`).bind(siteId, workDate);
}

export function employeeUsageStatement(workDate: string, siteId: number, user: AuthUser) {
  // Keep cross-project hour totals for conflict warnings without exposing other
  // projects' responsible users to a project-scoped engineer or foreman.
  const visibleOwner = hasRestrictedProjectAccess(user) ? `pe.site_id = ${siteId}` : "TRUE";
  const ownerId = `CASE WHEN ${visibleOwner} THEN pe.responsible_user_id ELSE NULL END`;
  const ownerName = `CASE WHEN ${visibleOwner} THEN COALESCE(responsible.full_name, 'Без ответственного') ELSE 'Другой проект' END`;
  return env.DB.prepare(`SELECT pe.employee_id AS employeeId, ${ownerId} AS responsibleUserId,
    ${ownerName} AS responsibleUserName, SUM(pe.hours) AS hours
    FROM placement_entries pe
    LEFT JOIN app_users responsible ON responsible.id = pe.responsible_user_id
    WHERE pe.work_date = ? AND pe.deleted_at IS NULL
      AND UPPER(TRIM(pe.employment_type_snapshot)) = 'ОПР'
      AND pe.employee_id IN (
        SELECT assignment.employee_id FROM employee_project_assignments assignment
        WHERE assignment.site_id = ? AND assignment.active = 1
        UNION
        SELECT historical.employee_id FROM placement_entries historical
        WHERE historical.site_id = ? AND historical.work_date = ? AND historical.deleted_at IS NULL
      )
    GROUP BY pe.employee_id, ${ownerId}, ${ownerName}
    ORDER BY pe.employee_id, ${ownerName}`).bind(workDate, siteId, siteId, workDate);
}

export function reportTimesheetMarksStatement(siteId: number, workDate: string) {
  return env.DB.prepare(`SELECT employee_id AS employeeId, hours, code, note
    FROM timesheet_marks
    WHERE site_id = ? AND work_date = ?
    ORDER BY employee_id`).bind(siteId, workDate);
}

export function foremanProgressStatement(siteId: number, workDate: string) {
  return env.DB.prepare(`SELECT foreman.id AS foremanId, foreman.full_name AS foremanName,
    CASE WHEN contribution.status = 'submitted' THEN 'submitted'
      WHEN COUNT(entry.id) > 0 OR contribution.status = 'draft' THEN 'draft' ELSE 'not_started' END AS status,
    contribution.submitted_at AS submittedAt,
    COUNT(DISTINCT entry.employee_id) AS employeeCount, COUNT(entry.id) AS rowCount,
    COALESCE(SUM(entry.hours), 0) AS hours
    FROM app_users foreman
    LEFT JOIN placement_report_contributions contribution
      ON contribution.foreman_id = foreman.id AND contribution.site_id = ? AND contribution.work_date = ?
    LEFT JOIN placement_entries entry
      ON entry.responsible_user_id = foreman.id AND entry.site_id = ? AND entry.work_date = ? AND entry.deleted_at IS NULL
      AND UPPER(TRIM(entry.employment_type_snapshot)) = 'ОПР'
    WHERE (foreman.active = 1 AND foreman.role = 'foreman' AND (
      EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = foreman.id AND access.all_projects = 1)
      OR EXISTS (SELECT 1 FROM user_project_access_sites grant_site WHERE grant_site.user_id = foreman.id AND grant_site.site_id = ?)
      OR (NOT EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = foreman.id) AND foreman.assigned_site_id = ?)))
      OR contribution.foreman_id IS NOT NULL
    GROUP BY foreman.id, foreman.full_name, contribution.status, contribution.submitted_at
    ORDER BY foreman.full_name`).bind(siteId, workDate, siteId, workDate, siteId, siteId);
}

export function reportEmployeesStatement(siteId: number) {
  return env.DB.prepare(`SELECT e.id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position, e.source, e.sort_order AS sortOrder,
    e.bitrix24_stage AS bitrix24Stage, e.availability_status AS availabilityStatus, e.sync_error AS syncError,
    epa.site_id AS siteId, s.name AS siteName
    FROM employees e
    JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.active = 1
    JOIN sites s ON s.id = epa.site_id AND s.active = 1
    WHERE e.active = 1 AND epa.site_id = ? AND e.full_name <> '' AND e.position <> ''
      AND UPPER(TRIM(e.employment_type)) = 'ОПР'
    ORDER BY e.sort_order, e.full_name, e.id`).bind(siteId);
}

export async function validatePayload(db: DatabaseExecutor, payload: EntryPayload, excludedId?: number) {
  const siteId = asPositiveInteger(payload.siteId);
  const employeeId = asPositiveInteger(payload.employeeId);
  const shiftId = asPositiveInteger(payload.shiftId);
  const zoneId = asPositiveInteger(payload.zoneId);
  const mainWorkTypeId = asPositiveInteger(payload.mainWorkTypeId);
  const subworkTypeId = asPositiveInteger(payload.subworkTypeId);
  const masterId = asPositiveInteger(payload.masterId);
  const hours = asPositiveInteger(payload.hours);

  if (!siteId || !employeeId || !shiftId || !zoneId || !mainWorkTypeId || !subworkTypeId || !masterId || !hours || !validDate(payload.workDate)) {
    throw new Error("Заполните все обязательные поля строки.");
  }
  if (hours < 1 || hours > 10) throw new Error("Количество часов должно быть от 1 до 10.");

  const existing = excludedId ? await db.prepare(`SELECT employee_id AS employeeId, site_id AS siteId, master_id AS masterId,
    position_snapshot AS positionSnapshot, employee_name_snapshot AS employeeNameSnapshot,
    employment_type_snapshot AS employmentTypeSnapshot, department_snapshot AS departmentSnapshot,
    master_name_snapshot AS masterNameSnapshot FROM placement_entries WHERE id = ? AND deleted_at IS NULL`)
    .bind(excludedId).first<Omit<ExistingPlacementEntry, "id" | "workDate" | "hours">>() : null;
  const keepHistoricalEmployee = existing?.employeeId === employeeId && existing.siteId === siteId;
  const employee = keepHistoricalEmployee
    ? { position: existing.positionSnapshot, fullName: existing.employeeNameSnapshot, employmentType: existing.employmentTypeSnapshot, department: existing.departmentSnapshot }
    : await db.prepare(`SELECT e.position, e.full_name AS fullName, e.employment_type AS employmentType, e.department
      FROM employees e
      JOIN employee_project_assignments assignment
        ON assignment.employee_id = e.id AND assignment.site_id = ? AND assignment.active = 1
      WHERE e.id = ? AND e.active = 1`)
      .bind(siteId, employeeId).first<{ position: string; fullName: string; employmentType: string; department: string }>();
  if (!employee?.position) throw new Error("Сотрудник отсутствует в справочнике или у него не заполнена должность.");
  if (!isOprEmploymentType(employee.employmentType)) throw new Error("В отчёт рабочих можно добавлять только сотрудников с типом ОПР.");

  const refs = await db.batch([
    db.prepare("SELECT id FROM shifts WHERE id = ? AND site_id = ? AND active = 1").bind(shiftId, siteId),
    db.prepare("SELECT id FROM zones WHERE id = ? AND site_id = ? AND active = 1").bind(zoneId, siteId),
    db.prepare("SELECT id FROM main_work_types WHERE id = ? AND site_id = ? AND active = 1").bind(mainWorkTypeId, siteId),
    db.prepare("SELECT id FROM subwork_types WHERE id = ? AND site_id = ? AND active = 1 AND main_work_type_id = ?").bind(subworkTypeId, siteId, mainWorkTypeId),
    keepHistoricalEmployee && existing?.masterId === masterId
      ? db.prepare("SELECT id FROM masters WHERE id = ? AND site_id = ?").bind(masterId, siteId)
      : db.prepare("SELECT id FROM masters WHERE id = ? AND site_id = ? AND active = 1").bind(masterId, siteId),
  ]);
  if (refs.some((result) => result.results.length === 0)) throw new Error("Одно из значений не относится к выбранному объекту.");

  const excluded = excludedId ? "AND id <> ?" : "";
  const statement = db.prepare(`SELECT COALESCE(SUM(hours), 0) AS used FROM placement_entries WHERE employee_id = ? AND work_date = ? AND deleted_at IS NULL AND UPPER(TRIM(employment_type_snapshot)) = 'ОПР' ${excluded}`);
  const total = excludedId
    ? await statement.bind(employeeId, payload.workDate, excludedId).first<{ used: number }>()
    : await statement.bind(employeeId, payload.workDate).first<{ used: number }>();
  const used = Number(total?.used ?? 0);
  if (used + hours > 10) throw new PlacementRequestError(
    `У сотрудника «${employee.fullName}» уже учтено ${used} ч. Можно добавить не более ${Math.max(0, 10 - used)} ч. Запрошено: ${hours} ч.`,
    409,
    "HOURS_CONFLICT",
    { employeeId, employeeName: employee.fullName, usedHours: used, requestedHours: hours, availableHours: Math.max(0, 10 - used) },
  );

  const master = keepHistoricalEmployee && existing?.masterId === masterId
    ? { name: existing.masterNameSnapshot }
    : await db.prepare("SELECT name FROM masters WHERE id = ?").bind(masterId).first<{ name: string }>();
  return {
    siteId, employeeId, shiftId, zoneId, mainWorkTypeId, subworkTypeId, masterId, hours, workDate: payload.workDate,
    note: payload.note?.trim() ?? "", position: employee.position, employeeName: employee.fullName,
    employmentType: employee.employmentType, department: employee.department, masterName: master?.name ?? "",
  };
}

export async function validateBulkPayloads(db: DatabaseExecutor, payloads: EntryPayload[], existingRows: ExistingPlacementEntry[] = []) {
  if (payloads.length === 0) throw new Error("Добавьте хотя бы одного сотрудника.");
  if (payloads.length > 1000) throw new Error("За один раз можно сохранить не более 1000 строк.");

  const siteId = asPositiveInteger(payloads[0].siteId);
  const workDate = payloads[0].workDate;
  if (!siteId || !validDate(workDate)) throw new Error("Не указан объект или рабочий день.");
  if (payloads.some((payload) => asPositiveInteger(payload.siteId) !== siteId || payload.workDate !== workDate)) {
    throw new Error("Все строки группы должны относиться к одному объекту и дню.");
  }

  const [employeesResult, shiftsResult, zonesResult, mainWorksResult, subworksResult, mastersResult, totalsResult] = await db.batch([
    db.prepare(`SELECT e.id, e.position, e.full_name AS fullName, e.employment_type AS employmentType, e.department
      FROM employees e
      JOIN employee_project_assignments assignment
        ON assignment.employee_id = e.id AND assignment.site_id = ? AND assignment.active = 1
      WHERE e.active = 1`).bind(siteId),
    db.prepare("SELECT id FROM shifts WHERE site_id = ? AND active = 1").bind(siteId),
    db.prepare("SELECT id FROM zones WHERE site_id = ? AND active = 1").bind(siteId),
    db.prepare("SELECT id FROM main_work_types WHERE site_id = ? AND active = 1").bind(siteId),
    db.prepare("SELECT id, main_work_type_id AS mainWorkTypeId FROM subwork_types WHERE site_id = ? AND active = 1").bind(siteId),
    db.prepare("SELECT id, name, active FROM masters WHERE site_id = ?").bind(siteId),
    db.prepare("SELECT employee_id AS employeeId, SUM(hours) AS used FROM placement_entries WHERE work_date = ? AND deleted_at IS NULL AND UPPER(TRIM(employment_type_snapshot)) = 'ОПР' GROUP BY employee_id").bind(workDate),
  ]);

  const employees = new Map((employeesResult.results as Array<{ id: number; position: string; fullName: string; employmentType: string; department: string }>).map((employee) => [employee.id, employee]));
  const shifts = new Set((shiftsResult.results as Array<{ id: number }>).map((item) => item.id));
  const zones = new Set((zonesResult.results as Array<{ id: number }>).map((item) => item.id));
  const mainWorks = new Set((mainWorksResult.results as Array<{ id: number }>).map((item) => item.id));
  const subworks = new Map((subworksResult.results as Array<{ id: number; mainWorkTypeId: number | null }>).map((item) => [item.id, item.mainWorkTypeId]));
  const masters = new Map((mastersResult.results as Array<{ id: number; name: string; active: number }>).map((item) => [item.id, item]));
  const existingById = new Map(existingRows.map((entry) => [entry.id, entry]));
  const totals = new Map((totalsResult.results as Array<{ employeeId: number; used: number }>).map((item) => [item.employeeId, Number(item.used)]));
  for (const existing of existingRows) {
    if (existing.workDate !== workDate) continue;
    totals.set(existing.employeeId, Math.max(0, (totals.get(existing.employeeId) ?? 0) - Number(existing.hours)));
  }
  const added = new Map<number, number>();

  return payloads.map((payload, index) => {
    const employeeId = asPositiveInteger(payload.employeeId);
    const shiftId = asPositiveInteger(payload.shiftId);
    const zoneId = asPositiveInteger(payload.zoneId);
    const mainWorkTypeId = asPositiveInteger(payload.mainWorkTypeId);
    const subworkTypeId = asPositiveInteger(payload.subworkTypeId);
    const masterId = asPositiveInteger(payload.masterId);
    const hours = asPositiveInteger(payload.hours);
    const existing = payload.id ? existingById.get(payload.id) : undefined;
    const keepHistoricalEmployee = existing?.employeeId === employeeId && existing.siteId === siteId;
    const currentEmployee = employeeId ? employees.get(employeeId) : undefined;
    const employee = keepHistoricalEmployee && existing
      ? { position: existing.positionSnapshot, fullName: existing.employeeNameSnapshot, employmentType: existing.employmentTypeSnapshot, department: existing.departmentSnapshot }
      : currentEmployee;
    const master = masterId ? masters.get(masterId) : undefined;
    const keepHistoricalMaster = existing?.masterId === masterId && existing.siteId === siteId;

    if (!employeeId || !shiftId || !zoneId || !mainWorkTypeId || !subworkTypeId || !masterId || !hours) {
      throw new Error(`Строка ${index + 1}: заполните все обязательные поля.`);
    }
    if (hours < 1 || hours > 10) throw new Error(`Строка ${index + 1}: количество часов должно быть от 1 до 10.`);
    if (!employee?.position) throw new Error(`Строка ${index + 1}: сотрудник недоступен или у него не заполнена должность.`);
    if (!isOprEmploymentType(employee.employmentType)) throw new Error(`Строка ${index + 1}: в отчёт рабочих можно добавлять только сотрудников с типом ОПР.`);
    if (!shifts.has(shiftId) || !zones.has(zoneId) || !mainWorks.has(mainWorkTypeId) || subworks.get(subworkTypeId) !== mainWorkTypeId || !master || (!master.active && !keepHistoricalMaster)) {
      throw new Error(`Строка ${index + 1}: одно из значений не относится к объекту.`);
    }

    const employeeTotal = (totals.get(employeeId) ?? 0) + (added.get(employeeId) ?? 0) + hours;
    if (employeeTotal > 10) {
      const usedHours = (totals.get(employeeId) ?? 0) + (added.get(employeeId) ?? 0);
      throw new PlacementRequestError(
        `У сотрудника «${employee.fullName}» уже учтено ${usedHours} ч. Можно добавить не более ${Math.max(0, 10 - usedHours)} ч. Запрошено: ${hours} ч.`,
        409,
        "HOURS_CONFLICT",
        { employeeId, employeeName: employee.fullName, usedHours, requestedHours: hours, availableHours: Math.max(0, 10 - usedHours), row: index + 1 },
      );
    }
    added.set(employeeId, (added.get(employeeId) ?? 0) + hours);

    return {
      siteId, employeeId, shiftId, zoneId, mainWorkTypeId, subworkTypeId, masterId, hours, workDate,
      note: payload.note?.trim() ?? "", position: employee.position, employeeName: employee.fullName,
      employmentType: employee.employmentType, department: employee.department,
      masterName: keepHistoricalMaster && existing ? existing.masterNameSnapshot : master.name,
    };
  });
}

export function existingPlacementEntriesStatement(db: DatabaseExecutor, ids: number[], lock = false) {
  return db.prepare(`SELECT id, site_id AS siteId, work_date AS workDate, employee_id AS employeeId,
    responsible_user_id AS responsibleUserId, revision, master_id AS masterId, hours,
    position_snapshot AS positionSnapshot, employee_name_snapshot AS employeeNameSnapshot,
    employment_type_snapshot AS employmentTypeSnapshot, department_snapshot AS departmentSnapshot,
    master_name_snapshot AS masterNameSnapshot
    FROM placement_entries WHERE id = ANY(?) AND deleted_at IS NULL
    ORDER BY id ${lock ? "FOR UPDATE" : ""}`).bind(ids);
}

export function assertPlacementOwnership(user: AuthUser, entries: ExistingPlacementEntry[]) {
  if (entries.some((entry) => !canManagePlacement(user, entry.siteId, entry.workDate) || user.role === "foreman" && entry.responsibleUserId !== user.id)) {
    throw new PlacementRequestError("Нет доступа к строкам отчёта. Прораб изменяет свои строки, инженер — строки назначенного проекта.", 403, "ENTRY_OWNERSHIP_FORBIDDEN");
  }
}

export function assertEntryRevisions(payloads: EntryPayload[], existingRows: ExistingPlacementEntry[]) {
  const existingById = new Map(existingRows.map((entry) => [entry.id, entry]));
  for (const payload of payloads) {
    const id = asPositiveInteger(payload.id);
    const expectedRevision = asPositiveInteger(payload.revision);
    if (!id || !expectedRevision) continue;
    const existing = existingById.get(id);
    if (existing && existing.revision !== expectedRevision) {
      throw new PlacementRequestError(
        "Строка уже была изменена в другой вкладке. Обновите отчёт и повторите действие.",
        409,
        "STALE_ENTRY",
        { entryId: id, expectedRevision, actualRevision: existing.revision },
      );
    }
  }
}

export async function assertLinkedReportDates(db: DatabaseExecutor, payloads: EntryPayload[], existingRows: ExistingPlacementEntry[]) {
  const byId = new Map(existingRows.map(entry => [entry.id, entry]));
  const changedIds = payloads.flatMap(payload => {
    const entry = byId.get(asPositiveInteger(payload.id) ?? 0);
    return entry && (entry.siteId !== asPositiveInteger(payload.siteId) || entry.workDate !== payload.workDate) ? [entry.id] : [];
  });
  if (!changedIds.length) return;
  // The entries are already locked. A legacy client must not move a published
  // row independently of the daily report that owns its date and project.
  const linked = await db.prepare("SELECT approved_entry_id AS entryId FROM personnel_report_rows WHERE approved_entry_id = ANY(?)")
    .bind(changedIds).all<{ entryId: number }>();
  if (linked.results.length) throw new PlacementRequestError(
    "Эти строки относятся к отчёту. Измените его дату через календарь в отчёте персонала; проект связанной записи менять нельзя.",
    409, "REPORT_IDENTITY_LOCKED", { entryIds: linked.results.map(entry => entry.entryId) },
  );
}

export async function lockPlacementHours(db: DatabaseExecutor, payloads: EntryPayload[], existingRows: ExistingPlacementEntry[] = []) {
  const keys = new Set<string>();
  for (const entry of existingRows) keys.add(`${entry.workDate}:${entry.employeeId}`);
  for (const payload of payloads) {
    const employeeId = asPositiveInteger(payload.employeeId);
    if (employeeId && validDate(payload.workDate)) keys.add(`${payload.workDate}:${employeeId}`);
  }
  for (const key of [...keys].sort()) {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`placement-hours:${key}`).first();
  }
}

export async function resolveResponsibleUsers(
  db: DatabaseExecutor,
  user: AuthUser,
  payloads: EntryPayload[],
  existingRows: ExistingPlacementEntry[] = [],
) {
  if (user.role === "foreman") return payloads.map(() => user.id as number | null);
  const existingById = new Map(existingRows.map((entry) => [entry.id, entry]));
  const requestedIds = [...new Set(payloads
    .filter((payload) => payload.responsibleUserId !== undefined && payload.responsibleUserId !== null)
    .map((payload) => asPositiveInteger(payload.responsibleUserId))
    .filter((id): id is number => id !== null))];
  const responsibleUsers = requestedIds.length
    ? await db.prepare("SELECT id, role, assigned_site_id AS assignedSiteId FROM app_users WHERE id = ANY(?) AND role = 'foreman' AND active = 1")
      .bind(requestedIds).all<{ id: number; role: UserRole; assignedSiteId: number | null }>()
    : { results: [] as Array<{ id: number; role: UserRole; assignedSiteId: number | null }> };
  const resolvedUsers = await Promise.all(responsibleUsers.results.map(async item => ({ ...item, ...await loadUserProjectAccess(item, db) })));
  const usersById = new Map(resolvedUsers.map((item) => [item.id, item]));
  return payloads.map((payload, index) => {
    const existing = payload.id ? existingById.get(payload.id) : undefined;
    if (payload.responsibleUserId === undefined) return existing?.responsibleUserId ?? null;
    if (payload.responsibleUserId === null) return null;
    const requestedId = asPositiveInteger(payload.responsibleUserId);
    const targetSiteId = asPositiveInteger(payload.siteId);
    const responsible = requestedId ? usersById.get(requestedId) : undefined;
    if (!responsible || !targetSiteId || !canAccessProject(responsible, targetSiteId)) {
      throw new Error(`Строка ${index + 1}: ответственный прораб не назначен на выбранный объект.`);
    }
    return responsible.id;
  });
}

export async function touchForemanContribution(
  db: DatabaseExecutor,
  user: AuthUser,
  siteId: number,
  workDate: string,
  submitted: boolean,
  expectedRevision?: number,
  resetToDraft = false,
) {
  if (user.role !== "foreman") return null;
  await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
    .bind(`placement-contribution:${siteId}:${workDate}:${user.id}`).first();
  const current = await db.prepare(`SELECT revision, status, submitted_at AS submittedAt FROM placement_report_contributions
    WHERE site_id = ? AND work_date = ? AND foreman_id = ? FOR UPDATE`)
    .bind(siteId, workDate, user.id).first<{ revision: number; status: "draft" | "submitted"; submittedAt: string | null }>();
  if (expectedRevision && current?.revision !== expectedRevision) {
    throw new PlacementRequestError(
      "Эта часть отчёта уже была изменена в другой вкладке. Обновите страницу и повторите действие.",
      409,
      "STALE_CONTRIBUTION",
      { expectedRevision, actualRevision: current?.revision ?? null },
    );
  }
  const status = submitted ? "submitted" : resetToDraft ? "draft" : current?.status ?? "draft";
  const submittedAt = submitted ? new Date().toISOString() : resetToDraft ? null : current?.submittedAt ?? null;
  const result = await db.prepare(`INSERT INTO placement_report_contributions
      (site_id, work_date, foreman_id, status, revision, submitted_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (site_id, work_date, foreman_id) DO UPDATE SET
      status = EXCLUDED.status,
      submitted_at = EXCLUDED.submitted_at,
      revision = placement_report_contributions.revision + 1,
      updated_at = CURRENT_TIMESTAMP
    RETURNING revision, status, submitted_at AS submittedAt`)
    .bind(siteId, workDate, user.id, status, submittedAt)
    .first<{ revision: number; status: "draft" | "submitted"; submittedAt: string | null }>();
  return result;
}

export async function finalizeGlobalReport(db: DatabaseExecutor, user: AuthUser, siteId: number, workDate: string) {
  if (user.role === "foreman") {
    throw new PlacementRequestError("Прораб сдаёт только свою часть отчёта.", 403, "GLOBAL_FINALIZE_FORBIDDEN");
  }
  await db.prepare(`INSERT INTO placement_report_days (site_id, work_date, submitted_by, submitted_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (site_id, work_date) DO UPDATE SET submitted_by = EXCLUDED.submitted_by, submitted_at = CURRENT_TIMESTAMP
    RETURNING site_id`).bind(siteId, workDate, user.id).all();
}
