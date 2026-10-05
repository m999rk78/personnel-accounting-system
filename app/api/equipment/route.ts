import { getDatabase } from "../../../db/client";
import { withAuditTrail } from "../../auditLog";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { equipmentUnavailableReason } from "../../equipmentAvailability";
import { hasPermission, type PermissionAction, type PermissionResource } from "../../permissionModel";

type EquipmentInput = {
  organization?: unknown;
  equipmentType?: unknown;
  brand?: unknown;
  model?: unknown;
  registrationNumber?: unknown;
  note?: unknown;
};

type EquipmentTimesheetMark = {
  equipmentId: number;
  workDate: string;
  productiveHours: number;
  downtimeHours: number;
  note: string;
  updatedBy: string;
};

type EquipmentPlanConflict = {
  equipmentId: number;
  equipmentType: string;
  brand: string;
  model: string;
  registrationNumber: string;
  downtimeHours: number;
  note: string;
};

let equipmentSchemaPromise: Promise<void> | null = null;

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function validMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function nextMonthStart(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return monthNumber === 12 ? `${year + 1}-01-01` : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
}

function text(value: unknown, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalize(value: string) {
  return value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ").trim();
}

function equipmentIdentity(input: ReturnType<typeof equipmentValues>) {
  const registration = normalize(input.registrationNumber).replaceAll(" ", "");
  if (registration && registration !== "-") return `грз:${registration}`;
  return `единица:${[input.organization, input.equipmentType, input.brand, input.model, input.note].map(normalize).join("|")}`;
}

function equipmentValues(input: EquipmentInput) {
  return {
    organization: text(input.organization, 120),
    equipmentType: text(input.equipmentType, 120),
    brand: text(input.brand, 120),
    model: text(input.model, 180),
    registrationNumber: text(input.registrationNumber, 80),
    note: text(input.note, 300),
  };
}

function validateEquipment(input: EquipmentInput) {
  const values = equipmentValues(input);
  if (!values.organization || !values.equipmentType || !values.model) {
    throw new Error("Заполните организацию, тип и модель техники.");
  }
  return values;
}

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function projectAssignmentAction(currentSiteId: number | null, nextSiteId: number | null): PermissionAction | null {
  if (currentSiteId === nextSiteId) return null;
  if (currentSiteId === null && nextSiteId !== null) return "create";
  if (currentSiteId !== null && nextSiteId === null) return "delete";
  return "update";
}

function projectAssignmentPermissionMessage(action: PermissionAction) {
  if (action === "create") return "Нет права назначать технику на проект.";
  if (action === "delete") return "Нет права снимать технику с проекта.";
  return "Нет права переводить технику между проектами.";
}

function equipmentPlanConflictMessage(conflict: EquipmentPlanConflict) {
  const title = [conflict.equipmentType, conflict.brand, conflict.model, conflict.registrationNumber ? `• ${conflict.registrationNumber}` : ""].filter(Boolean).join(" ");
  const reason = equipmentUnavailableReason({ productiveHours: 0, downtimeHours: conflict.downtimeHours, note: conflict.note });
  return `Техника «${title}» недоступна по табелю: ${reason}. Удалите её из отчёта или исправьте отметку в табеле техники.`;
}

function equipmentAccessPayload(authUser: NonNullable<Awaited<ReturnType<typeof getAuthUser>>>) {
  return {
    canEditDaily: hasPermission(authUser.permissions, "equipment_report", "create")
      || hasPermission(authUser.permissions, "equipment_report", "update")
      || hasPermission(authUser.permissions, "equipment_report", "delete"),
    canCreateDaily: hasPermission(authUser.permissions, "equipment_report", "create"),
    canUpdateDaily: hasPermission(authUser.permissions, "equipment_report", "update"),
    canDeleteDaily: hasPermission(authUser.permissions, "equipment_report", "delete"),
    canEditTimesheet: hasPermission(authUser.permissions, "equipment_timesheet", "create")
      || hasPermission(authUser.permissions, "equipment_timesheet", "update")
      || hasPermission(authUser.permissions, "equipment_timesheet", "delete"),
    canCreateTimesheet: hasPermission(authUser.permissions, "equipment_timesheet", "create"),
    canUpdateTimesheet: hasPermission(authUser.permissions, "equipment_timesheet", "update"),
    canDeleteTimesheet: hasPermission(authUser.permissions, "equipment_timesheet", "delete"),
    canManageRegistry: hasPermission(authUser.permissions, "equipment_registry", "create")
      || hasPermission(authUser.permissions, "equipment_registry", "update")
      || hasPermission(authUser.permissions, "equipment_registry", "delete"),
    canCreateRegistry: hasPermission(authUser.permissions, "equipment_registry", "create"),
    canUpdateRegistry: hasPermission(authUser.permissions, "equipment_registry", "update"),
    canDeleteRegistry: hasPermission(authUser.permissions, "equipment_registry", "delete"),
    canManageAssignments: hasPermission(authUser.permissions, "project_equipment", "create")
      || hasPermission(authUser.permissions, "project_equipment", "update")
      || hasPermission(authUser.permissions, "project_equipment", "delete"),
    canCreateAssignments: hasPermission(authUser.permissions, "project_equipment", "create"),
    canUpdateAssignments: hasPermission(authUser.permissions, "project_equipment", "update"),
    canDeleteAssignments: hasPermission(authUser.permissions, "project_equipment", "delete"),
  };
}

async function ensureEquipmentSchema() {
  if (!equipmentSchemaPromise) {
    if (process.env.NODE_ENV === "production" && process.env.DATABASE_RUNTIME_BOOTSTRAP !== "true") {
      equipmentSchemaPromise = Promise.resolve();
      return equipmentSchemaPromise;
    }
    const db = getDatabase();
    equipmentSchemaPromise = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS equipment_units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id INTEGER NOT NULL REFERENCES sites(id),
        identity_key TEXT NOT NULL,
        organization TEXT NOT NULL,
        equipment_type TEXT NOT NULL,
        brand TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        registration_number TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS equipment_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id INTEGER NOT NULL REFERENCES sites(id),
        work_date TEXT NOT NULL,
        equipment_id INTEGER NOT NULL REFERENCES equipment_units(id),
        shift_id INTEGER NOT NULL REFERENCES shifts(id),
        zone_id INTEGER NOT NULL REFERENCES zones(id),
        main_work_type_id INTEGER NOT NULL REFERENCES main_work_types(id),
        subwork_type_id INTEGER NOT NULL REFERENCES subwork_types(id),
        note TEXT NOT NULL DEFAULT '',
        hours INTEGER NOT NULL CHECK (hours BETWEEN 1 AND 10),
        created_by TEXT NOT NULL,
        responsible_user_id INTEGER REFERENCES app_users(id),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_by_user_id INTEGER REFERENCES app_users(id),
        updated_by_user_id INTEGER REFERENCES app_users(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS equipment_project_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id INTEGER NOT NULL REFERENCES equipment_units(id),
        site_id INTEGER NOT NULL REFERENCES sites(id),
        active INTEGER NOT NULL DEFAULT 1,
        assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS equipment_timesheet_marks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id INTEGER NOT NULL REFERENCES sites(id),
        equipment_id INTEGER NOT NULL REFERENCES equipment_units(id),
        work_date DATE NOT NULL,
        productive_hours INTEGER NOT NULL DEFAULT 0 CHECK (productive_hours BETWEEN 0 AND 20),
        downtime_hours INTEGER NOT NULL DEFAULT 0 CHECK (downtime_hours BETWEEN 0 AND 20),
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (productive_hours + downtime_hours <= 20)
      )`),
      db.prepare("ALTER TABLE equipment_entries ADD COLUMN IF NOT EXISTS responsible_user_id INTEGER REFERENCES app_users(id)"),
      db.prepare("ALTER TABLE equipment_entries ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1"),
      db.prepare("ALTER TABLE equipment_entries ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES app_users(id)"),
      db.prepare("ALTER TABLE equipment_entries ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER REFERENCES app_users(id)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS equipment_report_days (
        site_id INTEGER NOT NULL REFERENCES sites(id),
        work_date DATE NOT NULL,
        submitted_by INTEGER REFERENCES app_users(id),
        submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (site_id, work_date)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS equipment_report_contributions (
        site_id INTEGER NOT NULL REFERENCES sites(id),
        work_date DATE NOT NULL,
        foreman_id INTEGER NOT NULL REFERENCES app_users(id),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        submitted_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (site_id, work_date, foreman_id)
      )`),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_units_site_identity ON equipment_units(site_id, identity_key)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_units_site_active ON equipment_units(site_id, active)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_units_active_sort ON equipment_units(equipment_type, model, registration_number, id) WHERE active = 1"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_entries_site_date ON equipment_entries(site_id, work_date)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_entries_unit_date ON equipment_entries(equipment_id, work_date)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_entries_responsible_site_date ON equipment_entries(responsible_user_id, site_id, work_date) WHERE responsible_user_id IS NOT NULL AND deleted_at IS NULL"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_report_contributions_site_date_status ON equipment_report_contributions(site_id, work_date, status)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_report_contributions_foreman_date ON equipment_report_contributions(foreman_id, work_date)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_project_assignment_unique ON equipment_project_assignments(equipment_id, site_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_project_assignment_site ON equipment_project_assignments(site_id, active)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_project_assignment_site_equipment_active ON equipment_project_assignments(site_id, equipment_id) WHERE active = 1"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_timesheet_marks_unique_day ON equipment_timesheet_marks(site_id, equipment_id, work_date)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_timesheet_marks_month ON equipment_timesheet_marks(site_id, work_date)"),
      db.prepare(`INSERT INTO equipment_project_assignments (equipment_id, site_id, active)
        SELECT id, site_id, 1 FROM equipment_units WHERE active = 1
        ON CONFLICT (equipment_id, site_id) DO NOTHING`),
      db.prepare(`UPDATE equipment_entries AS entry SET
          responsible_user_id = app_user.id,
          created_by_user_id = COALESCE(entry.created_by_user_id, app_user.id),
          updated_by_user_id = COALESCE(entry.updated_by_user_id, app_user.id)
        FROM app_users AS app_user
        WHERE entry.responsible_user_id IS NULL AND app_user.role = 'foreman' AND app_user.active = 1
          AND app_user.assigned_site_id = entry.site_id AND app_user.full_name = entry.created_by`),
    ]).then(() => undefined).catch((error) => {
      equipmentSchemaPromise = null;
      throw error;
    });
  }
  return equipmentSchemaPromise;
}

async function resolveSite(
  requestedSiteId: number,
  authUser: NonNullable<Awaited<ReturnType<typeof getAuthUser>>>,
): Promise<{ error: Response } | { siteId: number; site: { id: number; name: string } }> {
  if (authUser.role === "foreman" && !authUser.assignedSiteId) return { error: errorResponse("Для пользователя не назначен объект.", 403) };
  const siteId = authUser.role === "foreman" ? authUser.assignedSiteId! : requestedSiteId;
  const site = await getDatabase().prepare("SELECT id, name FROM sites WHERE id = ? AND active = 1").bind(siteId).first<{ id: number; name: string }>();
  if (!site) return { error: errorResponse("Объект не найден.", 404) };
  return { siteId, site };
}

async function validateReferenceIds(siteId: number, equipmentId: number, shiftId: number, zoneId: number, mainWorkTypeId: number, subworkTypeId: number) {
  const db = getDatabase();
  const [equipment, shift, zone, mainWork, subwork] = await db.readBatch([
    db.prepare(`SELECT eu.id FROM equipment_units eu
      JOIN equipment_project_assignments epa ON epa.equipment_id = eu.id AND epa.site_id = ? AND epa.active = 1
      WHERE eu.id = ? AND eu.active = 1`).bind(siteId, equipmentId),
    db.prepare("SELECT id FROM shifts WHERE id = ? AND site_id = ? AND active = 1").bind(shiftId, siteId),
    db.prepare("SELECT id FROM zones WHERE id = ? AND site_id = ? AND active = 1").bind(zoneId, siteId),
    db.prepare("SELECT id FROM main_work_types WHERE id = ? AND site_id = ? AND active = 1").bind(mainWorkTypeId, siteId),
    db.prepare("SELECT id FROM subwork_types WHERE id = ? AND site_id = ? AND active = 1").bind(subworkTypeId, siteId),
  ]);
  if (!equipment.results.length || !shift.results.length || !zone.results.length || !mainWork.results.length || !subwork.results.length) {
    throw new Error("Одно из выбранных значений отсутствует в справочниках проекта.");
  }
}

type EquipmentDatabase = Pick<ReturnType<typeof getDatabase>, "prepare">;
type EquipmentAuthUser = NonNullable<Awaited<ReturnType<typeof getAuthUser>>>;

async function touchEquipmentContribution(database: EquipmentDatabase, user: EquipmentAuthUser, siteId: number, workDate: string, submitted: boolean) {
  if (user.role !== "foreman") return;
  await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
    .bind(`equipment-contribution:${siteId}:${workDate}:${user.id}`).first();
  await database.prepare(`INSERT INTO equipment_report_contributions
      (site_id, work_date, foreman_id, status, revision, submitted_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (site_id, work_date, foreman_id) DO UPDATE SET
      status = EXCLUDED.status,
      submitted_at = CASE WHEN EXCLUDED.status = 'submitted' THEN EXCLUDED.submitted_at ELSE equipment_report_contributions.submitted_at END,
      revision = equipment_report_contributions.revision + 1,
      updated_at = CURRENT_TIMESTAMP
    RETURNING revision`)
    .bind(siteId, workDate, user.id, submitted ? "submitted" : "draft", submitted ? new Date().toISOString() : null).first();
}

function equipmentForemanProgressStatement(siteId: number, workDate: string) {
  return getDatabase().prepare(`SELECT foreman.id AS "foremanId", foreman.full_name AS "foremanName",
    CASE WHEN contribution.status = 'submitted' THEN 'submitted'
      WHEN COUNT(entry.id) > 0 OR contribution.status = 'draft' THEN 'draft' ELSE 'not_started' END AS status,
    contribution.submitted_at AS "submittedAt",
    COUNT(DISTINCT entry.equipment_id) AS "equipmentCount", COUNT(entry.id) AS "rowCount",
    COALESCE(SUM(entry.hours), 0) AS hours
    FROM app_users foreman
    LEFT JOIN equipment_report_contributions contribution
      ON contribution.foreman_id = foreman.id AND contribution.site_id = ? AND contribution.work_date = ?
    LEFT JOIN equipment_entries entry
      ON entry.responsible_user_id = foreman.id AND entry.site_id = ? AND entry.work_date = ? AND entry.deleted_at IS NULL
    WHERE (foreman.active = 1 AND foreman.role = 'foreman' AND foreman.assigned_site_id = ?)
      OR contribution.foreman_id IS NOT NULL
    GROUP BY foreman.id, foreman.full_name, contribution.status, contribution.submitted_at
    ORDER BY foreman.full_name`).bind(siteId, workDate, siteId, workDate, siteId);
}

function equipmentEntriesForDateStatement(siteId: number, workDate: string, responsibleUserId: number) {
  return getDatabase().prepare(`SELECT ee.id, ee.work_date AS "workDate", ee.equipment_id AS "equipmentId",
      ee.shift_id AS "shiftId", ee.zone_id AS "zoneId", ee.main_work_type_id AS "mainWorkTypeId",
      ee.subwork_type_id AS "subworkTypeId", ee.note, ee.hours,
      ee.responsible_user_id AS "responsibleUserId", responsible.full_name AS "responsibleUserName", ee.revision,
      eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
      eu.registration_number AS "registrationNumber",
      s.name AS "shiftName", z.name AS "zoneName", mw.name AS "mainWorkTypeName", sw.name AS "subworkTypeName"
    FROM equipment_entries ee
    JOIN equipment_units eu ON eu.id = ee.equipment_id
    JOIN shifts s ON s.id = ee.shift_id
    JOIN zones z ON z.id = ee.zone_id
    JOIN main_work_types mw ON mw.id = ee.main_work_type_id
    JOIN subwork_types sw ON sw.id = ee.subwork_type_id
    LEFT JOIN app_users responsible ON responsible.id = ee.responsible_user_id
    WHERE ee.site_id = ? AND ee.work_date = ? AND ee.responsible_user_id = ? AND ee.deleted_at IS NULL
    ORDER BY eu.equipment_type, eu.model, s.name, ee.id`).bind(siteId, workDate, responsibleUserId);
}

type EquipmentAssignmentDatabase = Pick<ReturnType<typeof getDatabase>, "prepare">;

async function setEquipmentProjectAssignment(database: EquipmentAssignmentDatabase, equipmentId: number, projectSiteId: number | null) {
  if (!projectSiteId) {
    await database.prepare(`UPDATE equipment_project_assignments SET active = 0, ended_at = CURRENT_TIMESTAMP
      WHERE equipment_id = ? AND active = 1`).bind(equipmentId).run();
    return;
  }
  await database.prepare(`UPDATE equipment_project_assignments SET active = 0, ended_at = CURRENT_TIMESTAMP
    WHERE equipment_id = ? AND active = 1 AND site_id <> ?`).bind(equipmentId, projectSiteId).run();
  await database.prepare(`UPDATE equipment_project_assignments
    SET active = 1, assigned_at = CURRENT_TIMESTAMP, ended_at = NULL
    WHERE equipment_id = ? AND site_id = ? AND active <> 1`).bind(equipmentId, projectSiteId).run();
  await database.prepare(`INSERT INTO equipment_project_assignments (equipment_id, site_id, active, assigned_at, ended_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT (equipment_id, site_id) DO UPDATE SET
      active = 1,
      ended_at = NULL`).bind(equipmentId, projectSiteId).run();
}

export async function GET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return errorResponse("Требуется авторизация.", 401);
    const url = new URL(request.url);
    const requestedSiteId = positiveInteger(url.searchParams.get("siteId"));
    const workDate = url.searchParams.get("date");
    const month = url.searchParams.get("month");
    const requestedRangeStart = url.searchParams.get("rangeStart");
    const requestedRangeEnd = url.searchParams.get("rangeEnd");
    const scope = url.searchParams.get("scope") ?? "project";
    const section = url.searchParams.get("section") ?? "daily";
    const viewMode = url.searchParams.get("view") ?? "daily";
    if (!requestedSiteId || !validDate(workDate) || !validMonth(month)) return errorResponse("Некорректный объект, дата или месяц.", 400);
    if ((requestedRangeStart && !validDate(requestedRangeStart)) || (requestedRangeEnd && !validDate(requestedRangeEnd))) return errorResponse("Некорректный диапазон дат.", 400);
    if (!["project", "global", "assignments", "carryover", "export-range"].includes(scope)) return errorResponse("Некорректный режим загрузки техники.", 400);
    if (!["daily", "month", "registry", "project"].includes(section)) return errorResponse("Некорректный раздел учёта техники.", 400);
    if (!["daily", "timesheet", "registry", "project"].includes(viewMode)) return errorResponse("Некорректный раздел учёта техники.", 400);
    const requestedResource: PermissionResource = viewMode === "timesheet"
      ? "equipment_timesheet"
      : viewMode === "registry" || scope === "global"
        ? "equipment_registry"
        : viewMode === "project" || scope === "assignments"
          ? "project_equipment"
          : "equipment_report";
    if (!hasPermission(authUser.permissions, requestedResource, "view")) return errorResponse("Нет доступа к выбранному разделу учёта техники.", 403);

    await ensureEquipmentSchema();
    const resolved = await resolveSite(requestedSiteId, authUser);
    if ("error" in resolved) return resolved.error;
    const { siteId, site } = resolved;
    const db = getDatabase();
    const responseBase = {
      siteId,
      siteName: site.name,
      workDate,
      month,
      ...equipmentAccessPayload(authUser),
      currentUserRole: authUser.role,
      currentUserName: authUser.fullName,
    };
    if (scope === "export-range") {
      const rangeStart = requestedRangeStart ?? workDate;
      const rangeEnd = requestedRangeEnd ?? workDate;
      if (!validDate(rangeStart) || !validDate(rangeEnd) || rangeStart > rangeEnd) return errorResponse("Некорректный диапазон дат.", 400);
      const rangeDays = Math.floor((Date.parse(`${rangeEnd}T00:00:00Z`) - Date.parse(`${rangeStart}T00:00:00Z`)) / 86400000) + 1;
      if (rangeDays > 366) return errorResponse("Для выгрузки можно выбрать период не более 366 дней.", 400);
      const responsibleUserId = authUser.role === "foreman" ? authUser.id : null;
      const entries = await db.prepare(`SELECT ee.id, ee.work_date AS "workDate", ee.equipment_id AS "equipmentId",
          ee.shift_id AS "shiftId", ee.zone_id AS "zoneId", ee.main_work_type_id AS "mainWorkTypeId",
          ee.subwork_type_id AS "subworkTypeId", ee.note, ee.hours,
          ee.responsible_user_id AS "responsibleUserId", responsible.full_name AS "responsibleUserName", ee.revision,
          eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
          eu.registration_number AS "registrationNumber",
          s.name AS "shiftName", z.name AS "zoneName", mw.name AS "mainWorkTypeName", sw.name AS "subworkTypeName"
        FROM equipment_entries ee
        JOIN equipment_units eu ON eu.id = ee.equipment_id
        JOIN shifts s ON s.id = ee.shift_id
        JOIN zones z ON z.id = ee.zone_id
        JOIN main_work_types mw ON mw.id = ee.main_work_type_id
        JOIN subwork_types sw ON sw.id = ee.subwork_type_id
        LEFT JOIN app_users responsible ON responsible.id = ee.responsible_user_id
        WHERE ee.site_id = ? AND ee.work_date >= ? AND ee.work_date <= ? AND ee.deleted_at IS NULL
          ${responsibleUserId ? "AND ee.responsible_user_id = ?" : ""}
        ORDER BY ee.work_date, responsible.full_name NULLS LAST, eu.equipment_type, eu.model, s.name, ee.id`)
        .bind(...(responsibleUserId ? [siteId, rangeStart, rangeEnd, responsibleUserId] : [siteId, rangeStart, rangeEnd])).all();
      return Response.json({ entries: entries.results });
    }
    if (scope === "carryover") {
      if (section !== "daily" || authUser.role !== "foreman") return Response.json({ sourceDate: null, entries: [] });
      const previous = await db.prepare(`SELECT work_date AS "workDate"
        FROM equipment_report_contributions
        WHERE site_id = ? AND foreman_id = ? AND status = 'submitted' AND work_date < ?
        ORDER BY work_date DESC LIMIT 1`).bind(siteId, authUser.id, workDate).first<{ workDate: string }>();
      if (!previous) return Response.json({ sourceDate: null, entries: [] });
      const entries = await equipmentEntriesForDateStatement(siteId, previous.workDate, authUser.id).all();
      return Response.json({ sourceDate: previous.workDate, entries: entries.results });
    }
    const monthStart = `${month}-01`;
    const monthEnd = nextMonthStart(month);
    if (viewMode === "timesheet" && section === "month" && scope === "project") {
      const [units, entries, marks] = await db.readBatch([
        db.prepare(`SELECT eu.id, eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
          eu.registration_number AS "registrationNumber", eu.note
          FROM equipment_units eu JOIN equipment_project_assignments epa ON epa.equipment_id = eu.id
          WHERE eu.active = 1 AND epa.site_id = ? AND epa.active = 1
          ORDER BY eu.equipment_type, eu.model, eu.registration_number, eu.id`).bind(siteId),
        db.prepare(`SELECT ee.id, ee.work_date AS "workDate", ee.equipment_id AS "equipmentId",
          ee.shift_id AS "shiftId", ee.zone_id AS "zoneId", ee.main_work_type_id AS "mainWorkTypeId",
          ee.subwork_type_id AS "subworkTypeId", ee.note, ee.hours,
          ee.responsible_user_id AS "responsibleUserId", responsible.full_name AS "responsibleUserName", ee.revision,
          eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
          eu.registration_number AS "registrationNumber",
          s.name AS "shiftName", z.name AS "zoneName", mw.name AS "mainWorkTypeName", sw.name AS "subworkTypeName"
          FROM equipment_entries ee
          JOIN equipment_units eu ON eu.id = ee.equipment_id
          JOIN shifts s ON s.id = ee.shift_id
          JOIN zones z ON z.id = ee.zone_id
          JOIN main_work_types mw ON mw.id = ee.main_work_type_id
          JOIN subwork_types sw ON sw.id = ee.subwork_type_id
          LEFT JOIN app_users responsible ON responsible.id = ee.responsible_user_id
          WHERE ee.site_id = ? AND ee.work_date >= ? AND ee.work_date < ? AND ee.deleted_at IS NULL
          ORDER BY ee.work_date, eu.equipment_type, eu.model, ee.id`).bind(siteId, monthStart, monthEnd),
        db.prepare(`SELECT equipment_id AS "equipmentId", work_date AS "workDate",
          productive_hours AS "productiveHours", downtime_hours AS "downtimeHours",
          note, created_by AS "updatedBy"
          FROM equipment_timesheet_marks
          WHERE site_id = ? AND work_date >= ? AND work_date < ?
          ORDER BY work_date, equipment_id`).bind(siteId, monthStart, monthEnd),
      ]);
      return Response.json({
        ...responseBase,
        reportSubmitted: false,
        foremanProgress: [],
        units: units.results,
        availableUnits: [],
        sites: [],
        entries: entries.results,
        marks: marks.results,
        dailyTimesheetMarks: [],
        filledDates: [],
        shifts: [],
        zones: [],
        mainWorkTypes: [],
        subworkTypes: [],
      });
    }
    if (viewMode === "registry" && section === "registry" && scope === "global") {
      const [units, sites] = await db.readBatch([
        db.prepare(`SELECT eu.id, eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
          eu.registration_number AS "registrationNumber", eu.note,
          (SELECT epa.site_id FROM equipment_project_assignments epa
            WHERE epa.equipment_id = eu.id AND epa.active = 1 ORDER BY epa.assigned_at DESC LIMIT 1) AS "assignedSiteId",
          (SELECT s.name FROM equipment_project_assignments epa JOIN sites s ON s.id = epa.site_id
            WHERE epa.equipment_id = eu.id AND epa.active = 1 ORDER BY epa.assigned_at DESC LIMIT 1) AS "assignedSiteName"
          FROM equipment_units eu WHERE eu.active = 1
          ORDER BY eu.equipment_type, eu.model, eu.registration_number, eu.id`),
        db.prepare("SELECT id, name FROM sites WHERE active = 1 ORDER BY name"),
      ]);
      return Response.json({
        ...responseBase,
        reportSubmitted: false,
        foremanProgress: [],
        units: units.results,
        availableUnits: [],
        sites: sites.results,
        entries: [],
        marks: [],
        dailyTimesheetMarks: [],
        filledDates: [],
        shifts: [],
        zones: [],
        mainWorkTypes: [],
        subworkTypes: [],
      });
    }
    if (viewMode === "project" && section === "project" && scope === "assignments") {
      const [units, availableUnits] = await db.readBatch([
        db.prepare(`SELECT eu.id, eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
          eu.registration_number AS "registrationNumber", eu.note
          FROM equipment_units eu JOIN equipment_project_assignments epa ON epa.equipment_id = eu.id
          WHERE eu.active = 1 AND epa.site_id = ? AND epa.active = 1
          ORDER BY eu.equipment_type, eu.model, eu.registration_number, eu.id`).bind(siteId),
        db.prepare(`SELECT eu.id, eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
          eu.registration_number AS "registrationNumber", eu.note,
          (SELECT epa.site_id FROM equipment_project_assignments epa
            WHERE epa.equipment_id = eu.id AND epa.active = 1 ORDER BY epa.assigned_at DESC LIMIT 1) AS "assignedSiteId",
          (SELECT s.name FROM equipment_project_assignments epa JOIN sites s ON s.id = epa.site_id
            WHERE epa.equipment_id = eu.id AND epa.active = 1 ORDER BY epa.assigned_at DESC LIMIT 1) AS "assignedSiteName"
          FROM equipment_units eu WHERE eu.active = 1
          ORDER BY eu.equipment_type, eu.model, eu.registration_number, eu.id`),
      ]);
      return Response.json({
        ...responseBase,
        reportSubmitted: false,
        foremanProgress: [],
        units: units.results,
        availableUnits: availableUnits.results,
        sites: [],
        entries: [],
        marks: [],
        dailyTimesheetMarks: [],
        filledDates: [],
        shifts: [],
        zones: [],
        mainWorkTypes: [],
        subworkTypes: [],
      });
    }
    const rangeStart = requestedRangeStart && validDate(requestedRangeStart) ? requestedRangeStart : monthStart;
    const rangeEnd = requestedRangeEnd && validDate(requestedRangeEnd) ? requestedRangeEnd : workDate;
    const responsibleUserId = authUser.role === "foreman" && section === "daily" ? authUser.id : null;
    const unitsStatement = scope === "global"
      ? db.prepare(`SELECT eu.id, eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
          eu.registration_number AS "registrationNumber", eu.note,
          (SELECT epa.site_id FROM equipment_project_assignments epa
            WHERE epa.equipment_id = eu.id AND epa.active = 1 ORDER BY epa.assigned_at DESC LIMIT 1) AS "assignedSiteId",
          (SELECT s.name FROM equipment_project_assignments epa JOIN sites s ON s.id = epa.site_id
            WHERE epa.equipment_id = eu.id AND epa.active = 1 ORDER BY epa.assigned_at DESC LIMIT 1) AS "assignedSiteName"
        FROM equipment_units eu WHERE eu.active = 1
        ORDER BY eu.equipment_type, eu.model, eu.registration_number, eu.id`)
      : db.prepare(`SELECT eu.id, eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
          eu.registration_number AS "registrationNumber", eu.note
        FROM equipment_units eu JOIN equipment_project_assignments epa ON epa.equipment_id = eu.id
        WHERE eu.active = 1 AND epa.site_id = ? AND epa.active = 1
        ORDER BY eu.equipment_type, eu.model, eu.registration_number, eu.id`).bind(siteId);
    const entriesStatement = db.prepare(`SELECT ee.id, ee.work_date AS "workDate", ee.equipment_id AS "equipmentId",
        ee.shift_id AS "shiftId", ee.zone_id AS "zoneId", ee.main_work_type_id AS "mainWorkTypeId",
        ee.subwork_type_id AS "subworkTypeId", ee.note, ee.hours,
        ee.responsible_user_id AS "responsibleUserId", responsible.full_name AS "responsibleUserName", ee.revision,
        eu.organization, eu.equipment_type AS "equipmentType", eu.brand, eu.model,
        eu.registration_number AS "registrationNumber",
        s.name AS "shiftName", z.name AS "zoneName", mw.name AS "mainWorkTypeName", sw.name AS "subworkTypeName"
      FROM equipment_entries ee
      JOIN equipment_units eu ON eu.id = ee.equipment_id
      JOIN shifts s ON s.id = ee.shift_id
      JOIN zones z ON z.id = ee.zone_id
      JOIN main_work_types mw ON mw.id = ee.main_work_type_id
      JOIN subwork_types sw ON sw.id = ee.subwork_type_id
      LEFT JOIN app_users responsible ON responsible.id = ee.responsible_user_id
      WHERE ee.site_id = ? AND ee.work_date = ? AND ee.deleted_at IS NULL
        ${responsibleUserId ? "AND ee.responsible_user_id = ?" : ""}
      ORDER BY ee.work_date, responsible.full_name NULLS LAST, eu.equipment_type, eu.model, s.name, ee.id`)
      .bind(...(responsibleUserId ? [siteId, workDate, responsibleUserId] : [siteId, workDate]));
    const filledDatesStatement = db.prepare(`SELECT DISTINCT work_date AS "workDate" FROM equipment_entries
      WHERE site_id = ? AND work_date >= ? AND work_date <= ? AND deleted_at IS NULL
        ${responsibleUserId ? "AND responsible_user_id = ?" : ""}
      ORDER BY work_date`).bind(...(responsibleUserId ? [siteId, rangeStart, rangeEnd, responsibleUserId] : [siteId, rangeStart, rangeEnd]));
    const reportSubmissionStatement = authUser.role === "foreman"
      ? db.prepare(`SELECT status = 'submitted' AS submitted FROM equipment_report_contributions
          WHERE site_id = ? AND work_date = ? AND foreman_id = ?`).bind(siteId, workDate, authUser.id)
      : db.prepare("SELECT TRUE AS submitted FROM equipment_report_days WHERE site_id = ? AND work_date = ?").bind(siteId, workDate);
    const [units, entries, dailyTimesheetMarks, filledDates, shifts, zones, mainWorkTypes, subworkTypes, reportSubmission, foremanProgress] = await db.readBatch([
      unitsStatement,
      entriesStatement,
      db.prepare(`SELECT equipment_id AS "equipmentId", work_date AS "workDate",
          productive_hours AS "productiveHours", downtime_hours AS "downtimeHours",
          note, created_by AS "updatedBy"
        FROM equipment_timesheet_marks
        WHERE site_id = ? AND work_date = ?
        ORDER BY equipment_id`).bind(siteId, workDate),
      filledDatesStatement,
      db.prepare("SELECT id, name FROM shifts WHERE site_id = ? AND active = 1 ORDER BY id").bind(siteId),
      db.prepare("SELECT id, name FROM zones WHERE site_id = ? AND active = 1 ORDER BY name").bind(siteId),
      db.prepare("SELECT id, name FROM main_work_types WHERE site_id = ? AND active = 1 ORDER BY name").bind(siteId),
      db.prepare("SELECT id, name FROM subwork_types WHERE site_id = ? AND active = 1 ORDER BY name").bind(siteId),
      reportSubmissionStatement,
      equipmentForemanProgressStatement(siteId, workDate),
    ]);

    return Response.json({
      ...responseBase,
      reportSubmitted: Boolean((reportSubmission.results[0] as { submitted?: boolean } | undefined)?.submitted),
      foremanProgress: foremanProgress.results,
      units: units.results,
      availableUnits: [],
      sites: [],
      entries: entries.results,
      marks: [],
      dailyTimesheetMarks: dailyTimesheetMarks.results as EquipmentTimesheetMark[],
      filledDates: filledDates.results.map((row) => String(row.workDate)),
      shifts: shifts.results,
      zones: zones.results,
      mainWorkTypes: mainWorkTypes.results,
      subworkTypes: subworkTypes.results,
    });
  } catch (error) {
    console.error("Equipment request failed", error);
    return errorResponse(error instanceof Error ? error.message : "Не удалось загрузить учёт техники.", 500);
  }
}

async function handlePOST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authUser = await getAuthUser(request);
    if (!authUser) return errorResponse("Требуется авторизация.", 401);
    const payload = await request.json() as Record<string, unknown>;
    const requestedSiteId = positiveInteger(payload.siteId);
    if (!requestedSiteId) return errorResponse("Не указан объект.", 400);
    await ensureEquipmentSchema();
    const resolved = await resolveSite(requestedSiteId, authUser);
    if ("error" in resolved) return resolved.error;
    const { siteId } = resolved;
    const db = getDatabase();

    if (payload.action === "submit-daily-report") {
      if (!hasPermission(authUser.permissions, "equipment_report", "update")) return errorResponse("Нет права подтверждать отчёт техники.", 403);
      const reportWorkDate = payload.workDate;
      if (!validDate(reportWorkDate)) return errorResponse("Некорректная дата отчёта.", 400);
      const planConflict = await db.prepare(`SELECT eu.id AS "equipmentId", eu.equipment_type AS "equipmentType",
          eu.brand, eu.model, eu.registration_number AS "registrationNumber",
          etm.downtime_hours AS "downtimeHours", etm.note
        FROM equipment_entries ee
        JOIN equipment_timesheet_marks etm
          ON etm.site_id = ee.site_id AND etm.equipment_id = ee.equipment_id AND etm.work_date = ee.work_date
        JOIN equipment_units eu ON eu.id = ee.equipment_id
        WHERE ee.site_id = ? AND ee.work_date = ? AND ee.deleted_at IS NULL
          AND etm.productive_hours = 0 AND etm.downtime_hours > 0
          ${authUser.role === "foreman" ? "AND ee.responsible_user_id = ?" : ""}
        ORDER BY eu.equipment_type, eu.model, ee.id
        LIMIT 1`).bind(...(authUser.role === "foreman" ? [siteId, reportWorkDate, authUser.id] : [siteId, reportWorkDate])).first<EquipmentPlanConflict>();
      if (planConflict) return errorResponse(equipmentPlanConflictMessage(planConflict), 409);
      await db.transaction(async (transaction) => {
        if (authUser.role === "foreman") {
          await touchEquipmentContribution(transaction, authUser, siteId, reportWorkDate, true);
        } else {
          await transaction.prepare(`INSERT INTO equipment_report_days (site_id, work_date, submitted_by, submitted_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT (site_id, work_date) DO UPDATE SET submitted_by = EXCLUDED.submitted_by, submitted_at = CURRENT_TIMESTAMP
            RETURNING site_id`)
            .bind(siteId, reportWorkDate, authUser.id).first();
        }
      });
      return Response.json({ submitted: true });
    }

    if (payload.action === "save-timesheet-mark") {
      if (!hasPermission(authUser.permissions, "equipment_timesheet", "view")) return errorResponse("Нет доступа к табелю техники.", 403);
      if (!validDate(payload.workDate)) return errorResponse("Некорректная дата табеля.", 400);
      const equipmentId = positiveInteger(payload.equipmentId);
      if (!equipmentId) return errorResponse("Не выбрана единица техники.", 400);
      const equipment = await db.prepare(`SELECT eu.id FROM equipment_units eu WHERE eu.id = ? AND eu.active = 1 AND (
          EXISTS (SELECT 1 FROM equipment_project_assignments epa WHERE epa.equipment_id = eu.id AND epa.site_id = ? AND epa.active = 1)
          OR EXISTS (SELECT 1 FROM equipment_entries ee WHERE ee.equipment_id = eu.id AND ee.site_id = ? AND ee.work_date = ? AND ee.deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM equipment_timesheet_marks etm WHERE etm.equipment_id = eu.id AND etm.site_id = ? AND etm.work_date = ?)
        )`).bind(equipmentId, siteId, siteId, payload.workDate, siteId, payload.workDate).first<{ id: number }>();
      if (!equipment) return errorResponse("Техника не относится к выбранному проекту.", 404);
      const existingMark = await db.prepare("SELECT id FROM equipment_timesheet_marks WHERE site_id = ? AND equipment_id = ? AND work_date = ?")
        .bind(siteId, equipmentId, payload.workDate).first<{ id: number }>();

      if (payload.clear === true) {
        if (!existingMark) return Response.json({ deleted: false, equipmentId, workDate: payload.workDate });
        if (!hasPermission(authUser.permissions, "equipment_timesheet", "delete")) return errorResponse("Нет права удалять отметки табеля техники.", 403);
        await db.transaction(async (transaction) => {
          await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`equipment-hours:${payload.workDate}:${equipmentId}`).first();
          await transaction.prepare("DELETE FROM equipment_timesheet_marks WHERE site_id = ? AND equipment_id = ? AND work_date = ?")
            .bind(siteId, equipmentId, payload.workDate).run();
        });
        return Response.json({ deleted: true, equipmentId, workDate: payload.workDate });
      }
      if (!hasPermission(authUser.permissions, "equipment_timesheet", existingMark ? "update" : "create")) {
        return errorResponse(existingMark ? "Нет права изменять отметки табеля техники." : "Нет права добавлять отметки табеля техники.", 403);
      }

      const productiveHours = Number(payload.productiveHours);
      const downtimeHours = Number(payload.downtimeHours);
      if (!Number.isInteger(productiveHours) || productiveHours < 0 || productiveHours > 20
        || !Number.isInteger(downtimeHours) || downtimeHours < 0 || downtimeHours > 20
        || productiveHours + downtimeHours > 20) {
        return errorResponse("Укажите целые часы от 0 до 20. Сумма работы и простоя не должна превышать 20 часов.", 400);
      }
      const note = text(payload.note, 300);
      await db.transaction(async (transaction) => {
        await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`equipment-hours:${payload.workDate}:${equipmentId}`).first();
        await transaction.prepare(`INSERT INTO equipment_timesheet_marks
            (site_id, equipment_id, work_date, productive_hours, downtime_hours, note, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (site_id, equipment_id, work_date) DO UPDATE SET
            productive_hours = EXCLUDED.productive_hours, downtime_hours = EXCLUDED.downtime_hours,
            note = EXCLUDED.note, created_by = EXCLUDED.created_by, updated_at = CURRENT_TIMESTAMP`)
          .bind(siteId, equipmentId, payload.workDate, productiveHours, downtimeHours, note, authUser.fullName).run();
      });
      const mark: EquipmentTimesheetMark = { equipmentId, workDate: payload.workDate, productiveHours, downtimeHours, note, updatedBy: authUser.fullName };
      return Response.json({ mark });
    }

    if (payload.action === "save-entry") {
      const entryId = positiveInteger(payload.id);
      if (!hasPermission(authUser.permissions, "equipment_report", entryId ? "update" : "create")) {
        return errorResponse(entryId ? "Нет права изменять строки отчёта техники." : "Нет права добавлять строки отчёта техники.", 403);
      }
      if (!validDate(payload.workDate)) return errorResponse("Некорректная дата записи.", 400);
      const equipmentId = positiveInteger(payload.equipmentId);
      const shiftId = positiveInteger(payload.shiftId);
      const zoneId = positiveInteger(payload.zoneId);
      const mainWorkTypeId = positiveInteger(payload.mainWorkTypeId);
      const subworkTypeId = positiveInteger(payload.subworkTypeId);
      const hours = positiveInteger(payload.hours);
      if (!equipmentId || !shiftId || !zoneId || !mainWorkTypeId || !subworkTypeId || !hours || hours > 10) {
        return errorResponse("Заполните технику, смену, зону, работу, подработу и часы от 1 до 10.", 400);
      }
      await validateReferenceIds(siteId, equipmentId, shiftId, zoneId, mainWorkTypeId, subworkTypeId);
      const note = text(payload.note, 500);
      const existing = entryId ? await db.prepare(`SELECT work_date AS "workDate", equipment_id AS "equipmentId",
          responsible_user_id AS "responsibleUserId", revision
        FROM equipment_entries WHERE id = ? AND site_id = ? AND deleted_at IS NULL`)
        .bind(entryId, siteId).first<{ workDate: string; equipmentId: number; responsibleUserId: number | null; revision: number }>() : null;
      if (entryId && !existing) return errorResponse("Строка техники не найдена.", 404);
      if (authUser.role === "foreman" && existing && existing.responsibleUserId !== authUser.id) {
        return errorResponse("Прораб может изменять только собственные строки отчёта назначенного проекта.", 403);
      }
      const expectedRevision = positiveInteger(payload.revision);
      if (existing && expectedRevision && existing.revision !== expectedRevision) {
        return errorResponse("Строка уже была изменена в другой вкладке. Обновите отчёт и повторите действие.", 409);
      }
      await db.transaction(async (transaction) => {
        const lockKeys = new Set([`${payload.workDate}:${equipmentId}`]);
        if (existing) lockKeys.add(`${existing.workDate}:${existing.equipmentId}`);
        for (const key of [...lockKeys].sort()) {
          await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`equipment-hours:${key}`).first();
        }
        const planConflict = await transaction.prepare(`SELECT eu.id AS "equipmentId", eu.equipment_type AS "equipmentType",
            eu.brand, eu.model, eu.registration_number AS "registrationNumber",
            etm.downtime_hours AS "downtimeHours", etm.note
          FROM equipment_timesheet_marks etm
          JOIN equipment_units eu ON eu.id = etm.equipment_id
          WHERE etm.site_id = ? AND etm.equipment_id = ? AND etm.work_date = ?
            AND etm.productive_hours = 0 AND etm.downtime_hours > 0
          LIMIT 1`).bind(siteId, equipmentId, payload.workDate).first<EquipmentPlanConflict>();
        if (planConflict) throw new Error(equipmentPlanConflictMessage(planConflict));
        const used = await transaction.prepare(`SELECT COALESCE(SUM(hours), 0) AS hours FROM equipment_entries
          WHERE site_id = ? AND work_date = ? AND equipment_id = ? AND deleted_at IS NULL
            AND (?::integer IS NULL OR id <> ?::integer)`)
          .bind(siteId, payload.workDate, equipmentId, entryId, entryId).first<{ hours: number }>();
        if (Number(used?.hours ?? 0) + hours > 20) {
          throw new Error(`У выбранной техники уже учтено ${Number(used?.hours ?? 0)} ч. За сутки можно указать не более 20 ч.`);
        }
        if (entryId) {
          const result = await transaction.prepare(`UPDATE equipment_entries SET work_date = ?, equipment_id = ?, shift_id = ?, zone_id = ?,
            main_work_type_id = ?, subwork_type_id = ?, note = ?, hours = ?, created_by = ?, updated_by_user_id = ?,
            revision = revision + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND site_id = ? AND deleted_at IS NULL AND revision = ?`)
            .bind(payload.workDate, equipmentId, shiftId, zoneId, mainWorkTypeId, subworkTypeId, note, hours, authUser.fullName,
              authUser.id, entryId, siteId, existing!.revision).run();
          if (!result.meta.changes) throw new Error("Строка уже была изменена. Обновите отчёт и повторите действие.");
        } else {
          const responsibleUserId = authUser.role === "foreman" ? authUser.id : null;
          await transaction.prepare(`INSERT INTO equipment_entries
            (site_id, work_date, equipment_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, hours, created_by,
             responsible_user_id, created_by_user_id, updated_by_user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(siteId, payload.workDate, equipmentId, shiftId, zoneId, mainWorkTypeId, subworkTypeId, note, hours, authUser.fullName,
              responsibleUserId, authUser.id, authUser.id).run();
        }
        await touchEquipmentContribution(transaction, authUser, siteId, payload.workDate as string, false);
      });
      return Response.json({ saved: true });
    }

    if (payload.action === "delete-entry") {
      if (!hasPermission(authUser.permissions, "equipment_report", "delete")) return errorResponse("Нет права удалять строки отчёта техники.", 403);
      const entryId = positiveInteger(payload.id);
      if (!entryId) return errorResponse("Не указана строка.", 400);
      const entry = await db.prepare(`SELECT work_date AS "workDate", responsible_user_id AS "responsibleUserId"
        FROM equipment_entries WHERE id = ? AND site_id = ? AND deleted_at IS NULL`).bind(entryId, siteId).first<{ workDate: string; responsibleUserId: number | null }>();
      if (!entry) return errorResponse("Строка техники не найдена.", 404);
      if (authUser.role === "foreman" && entry.responsibleUserId !== authUser.id) {
        return errorResponse("Прораб может удалять только собственные строки отчёта назначенного проекта.", 403);
      }
      await db.transaction(async (transaction) => {
        await transaction.prepare("UPDATE equipment_entries SET deleted_at = CURRENT_TIMESTAMP, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?")
          .bind(authUser.id, entryId, siteId).run();
        await touchEquipmentContribution(transaction, authUser, siteId, entry.workDate, false);
      });
      return Response.json({ deleted: true });
    }

    if (payload.action === "import-entries") {
      if (!hasPermission(authUser.permissions, "equipment_report", "create")) return errorResponse("Нет права импортировать строки отчёта техники.", 403);
      if (!Array.isArray(payload.entries) || !payload.entries.length || payload.entries.length > 5000) return errorResponse("В файле нет строк расстановки или их слишком много.", 400);
      const importEntries = payload.entries.map((entry) => (entry ?? {}) as Record<string, unknown>);
      const names = (key: string) => Array.from(new Set(importEntries.map((entry) => text(entry[key], 240)).filter((value) => value && value !== "-")));
      const directoryImports = [
        { table: "zones", values: names("zoneName") },
        { table: "main_work_types", values: names("mainWorkTypeName") },
        { table: "subwork_types", values: names("subworkTypeName") },
      ];
      await db.transaction(async (transaction) => {
        for (const directory of directoryImports) {
          for (const name of directory.values) {
            await transaction.prepare(`UPDATE ${directory.table} SET active = 1 WHERE site_id = ? AND LOWER(name) = LOWER(?)`).bind(siteId, name).run();
            await transaction.prepare(`INSERT INTO ${directory.table} (site_id, name, active)
              SELECT ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM ${directory.table} WHERE site_id = ? AND LOWER(name) = LOWER(?))`)
              .bind(siteId, name, siteId, name).run();
          }
        }
      });
      const [unitsResult, shiftsResult, zonesResult, mainWorkResult, subworkResult] = await db.readBatch([
        db.prepare(`SELECT id, organization, equipment_type AS "equipmentType", brand, model,
          registration_number AS "registrationNumber" FROM equipment_units eu
          JOIN equipment_project_assignments epa ON epa.equipment_id = eu.id
          WHERE epa.site_id = ? AND epa.active = 1 AND eu.active = 1`).bind(siteId),
        db.prepare("SELECT id, name FROM shifts WHERE site_id = ? AND active = 1").bind(siteId),
        db.prepare("SELECT id, name FROM zones WHERE site_id = ? AND active = 1").bind(siteId),
        db.prepare("SELECT id, name FROM main_work_types WHERE site_id = ? AND active = 1").bind(siteId),
        db.prepare("SELECT id, name FROM subwork_types WHERE site_id = ? AND active = 1").bind(siteId),
      ]);
      type ImportUnit = { id: number; organization: string; equipmentType: string; brand: string; model: string; registrationNumber: string };
      const units = unitsResult.results as ImportUnit[];
      const options = (rows: typeof shiftsResult.results) => new Map(rows.map((row) => [normalize(String(row.name ?? "")), Number(row.id)]));
      const shifts = options(shiftsResult.results);
      const zones = options(zonesResult.results);
      const mainWorkTypes = options(mainWorkResult.results);
      const subworkTypes = options(subworkResult.results);
      const byRegistration = new Map(units.filter((unit) => unit.registrationNumber && !["-", "—"].includes(unit.registrationNumber)).map((unit) => [normalize(unit.registrationNumber).replaceAll(" ", ""), unit]));
      const issues: string[] = [];
      const prepared = importEntries.flatMap((entry, index) => {
        const workDate = text(entry.workDate, 10);
        const equipmentName = text(entry.equipmentName, 400);
        const parts = equipmentName.split("//").map((part) => part.trim());
        const registration = normalize(parts[2] ?? "").replaceAll(" ", "");
        let unit = registration && !["-", "—"].includes(registration) ? byRegistration.get(registration) : undefined;
        if (!unit) {
          const typeName = normalize(parts[0] ?? "");
          const modelName = normalize(parts[1] ?? "");
          const organization = normalize(parts[3] ?? "");
          const candidates = units.filter((candidate) => normalize(candidate.equipmentType) === typeName
            && normalize(candidate.organization) === organization
            && [normalize(candidate.model), normalize(`${candidate.brand} ${candidate.model}`)].includes(modelName));
          if (candidates.length === 1) unit = candidates[0];
        }
        const shiftId = shifts.get(normalize(text(entry.shiftName)));
        const zoneId = zones.get(normalize(text(entry.zoneName)));
        const mainWorkTypeId = mainWorkTypes.get(normalize(text(entry.mainWorkTypeName)));
        const subworkTypeId = subworkTypes.get(normalize(text(entry.subworkTypeName)));
        const hours = Number(entry.hours);
        const missing = [
          !validDate(workDate) ? "дата" : "",
          !unit ? "техника" : "",
          !shiftId ? "смена" : "",
          !zoneId ? "зона" : "",
          !mainWorkTypeId ? "основная работа" : "",
          !subworkTypeId ? "вид подработ" : "",
          !Number.isInteger(hours) || hours < 1 || hours > 10 ? "часы" : "",
        ].filter(Boolean);
        if (missing.length) {
          issues.push(`Строка ${index + 1}: не найдено или некорректно — ${missing.join(", ")}`);
          return [];
        }
        return [{ workDate, equipmentId: unit!.id, shiftId: shiftId!, zoneId: zoneId!, mainWorkTypeId: mainWorkTypeId!, subworkTypeId: subworkTypeId!, note: text(entry.note, 500), hours }];
      });
      if (issues.length) return errorResponse(`Импорт остановлен. ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? `; ещё ошибок: ${issues.length - 5}` : ""}. Проверьте справочники проекта.`, 400);

      let imported = 0;
      let skipped = 0;
      await db.transaction(async (transaction) => {
        for (const entry of prepared) {
          await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
            .bind(`equipment-hours:${entry.workDate}:${entry.equipmentId}`).first();
          const planConflict = await transaction.prepare(`SELECT eu.id AS "equipmentId", eu.equipment_type AS "equipmentType",
              eu.brand, eu.model, eu.registration_number AS "registrationNumber",
              etm.downtime_hours AS "downtimeHours", etm.note
            FROM equipment_timesheet_marks etm
            JOIN equipment_units eu ON eu.id = etm.equipment_id
            WHERE etm.site_id = ? AND etm.equipment_id = ? AND etm.work_date = ?
              AND etm.productive_hours = 0 AND etm.downtime_hours > 0
            LIMIT 1`).bind(siteId, entry.equipmentId, entry.workDate).first<EquipmentPlanConflict>();
          if (planConflict) throw new Error(equipmentPlanConflictMessage(planConflict));
          const existing = await transaction.prepare(`SELECT id FROM equipment_entries
            WHERE site_id = ? AND work_date = ? AND equipment_id = ? AND shift_id = ? AND zone_id = ?
              AND main_work_type_id = ? AND subwork_type_id = ? AND note = ? AND hours = ? AND deleted_at IS NULL
            LIMIT 1`).bind(siteId, entry.workDate, entry.equipmentId, entry.shiftId, entry.zoneId, entry.mainWorkTypeId, entry.subworkTypeId, entry.note, entry.hours).first();
          if (existing) {
            skipped += 1;
            continue;
          }
          const used = await transaction.prepare(`SELECT COALESCE(SUM(hours), 0) AS hours FROM equipment_entries
            WHERE site_id = ? AND work_date = ? AND equipment_id = ? AND deleted_at IS NULL`)
            .bind(siteId, entry.workDate, entry.equipmentId).first<{ hours: number }>();
          if (Number(used?.hours ?? 0) + entry.hours > 20) {
            throw new Error(`У техники из импортируемой строки уже учтено ${Number(used?.hours ?? 0)} ч. За сутки можно указать не более 20 ч.`);
          }
          await transaction.prepare(`INSERT INTO equipment_entries
            (site_id, work_date, equipment_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, hours, created_by,
             responsible_user_id, created_by_user_id, updated_by_user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(siteId, entry.workDate, entry.equipmentId, entry.shiftId, entry.zoneId, entry.mainWorkTypeId, entry.subworkTypeId, entry.note, entry.hours,
              authUser.fullName, authUser.role === "foreman" ? authUser.id : null, authUser.id, authUser.id).run();
          imported += 1;
        }
        if (authUser.role === "foreman") {
          for (const workDate of [...new Set(prepared.map((entry) => entry.workDate))]) {
            await touchEquipmentContribution(transaction, authUser, siteId, workDate, false);
          }
        }
      });
      return Response.json({ imported, skipped });
    }

    if (payload.action === "assign-unit-project") {
      if (!hasPermission(authUser.permissions, "project_equipment", "create")) return errorResponse("Нет права добавлять технику в проект.", 403);
      const equipmentId = positiveInteger(payload.equipmentId);
      if (!equipmentId) return errorResponse("Выберите технику из общего реестра.", 400);
      const unit = await db.prepare("SELECT id FROM equipment_units WHERE id = ? AND active = 1").bind(equipmentId).first();
      if (!unit) return errorResponse("Единица техники не найдена.", 404);
      await db.transaction(async (transaction) => setEquipmentProjectAssignment(transaction, equipmentId, siteId));
      return Response.json({ assigned: true, equipmentId, siteId });
    }

    if (payload.action === "remove-unit-project") {
      if (!hasPermission(authUser.permissions, "project_equipment", "delete")) return errorResponse("Нет права удалять технику из проекта.", 403);
      const equipmentId = positiveInteger(payload.equipmentId);
      if (!equipmentId) return errorResponse("Не указана техника.", 400);
      const result = await db.prepare(`UPDATE equipment_project_assignments SET active = 0, ended_at = CURRENT_TIMESTAMP
        WHERE equipment_id = ? AND site_id = ? AND active = 1`).bind(equipmentId, siteId).run();
      if (!result.meta.changes) return errorResponse("Техника не относится к выбранному проекту.", 404);
      return Response.json({ assigned: false, equipmentId, siteId });
    }

    if (payload.action === "save-unit") {
      const unitId = positiveInteger(payload.id);
      if (!hasPermission(authUser.permissions, "equipment_registry", unitId ? "update" : "create")) {
        return errorResponse(unitId ? "Нет права изменять реестр техники." : "Нет права добавлять технику в реестр.", 403);
      }
      const values = validateEquipment(payload as EquipmentInput);
      const identityKey = equipmentIdentity(values);
      const noProject = payload.projectSiteId === undefined || payload.projectSiteId === null || (typeof payload.projectSiteId === "string" && !payload.projectSiteId.trim());
      const projectSiteId = noProject ? null : positiveInteger(payload.projectSiteId);
      if (!noProject && !projectSiteId) return errorResponse("Выбран некорректный проект.", 400);
      if (projectSiteId) {
        const project = await db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(projectSiteId).first();
        if (!project) return errorResponse("Выбранный проект не найден.", 404);
      }
      const matchedUnit = unitId
        ? await db.prepare("SELECT id FROM equipment_units WHERE id = ? AND active = 1").bind(unitId).first<{ id: number }>()
        : await db.prepare("SELECT id FROM equipment_units WHERE identity_key = ? ORDER BY active DESC, id LIMIT 1").bind(identityKey).first<{ id: number }>();
      if (!unitId && matchedUnit && !hasPermission(authUser.permissions, "equipment_registry", "update")) {
        return errorResponse("Такая техника уже есть в реестре. Для её изменения нужно право редактирования.", 403);
      }
      const currentAssignment = matchedUnit
        ? await db.prepare("SELECT site_id AS \"siteId\" FROM equipment_project_assignments WHERE equipment_id = ? AND active = 1 ORDER BY assigned_at DESC LIMIT 1")
          .bind(matchedUnit.id).first<{ siteId: number }>()
        : null;
      const assignmentAction = projectAssignmentAction(currentAssignment?.siteId ?? null, projectSiteId);
      if (assignmentAction && !hasPermission(authUser.permissions, "project_equipment", assignmentAction)) {
        return errorResponse(projectAssignmentPermissionMessage(assignmentAction), 403);
      }
      const savedUnitId = await db.transaction(async (transaction) => {
        let targetUnitId = unitId;
        if (targetUnitId) {
          const result = await transaction.prepare(`UPDATE equipment_units SET identity_key = ?, organization = ?, equipment_type = ?, brand = ?,
            model = ?, registration_number = ?, note = ?, active = 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`)
            .bind(identityKey, values.organization, values.equipmentType, values.brand, values.model, values.registrationNumber, values.note, targetUnitId).run();
          if (!result.meta.changes) throw new Error("Единица техники не найдена.");
        } else {
          const existing = await transaction.prepare("SELECT id FROM equipment_units WHERE identity_key = ? ORDER BY active DESC, id LIMIT 1").bind(identityKey).first<{ id: number }>();
          if (existing) {
            targetUnitId = existing.id;
            await transaction.prepare(`UPDATE equipment_units SET organization = ?, equipment_type = ?, brand = ?, model = ?,
              registration_number = ?, note = ?, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .bind(values.organization, values.equipmentType, values.brand, values.model, values.registrationNumber, values.note, targetUnitId).run();
          } else {
            const created = await transaction.prepare(`INSERT INTO equipment_units
              (site_id, identity_key, organization, equipment_type, brand, model, registration_number, note)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
              .bind(projectSiteId ?? siteId, identityKey, values.organization, values.equipmentType, values.brand, values.model, values.registrationNumber, values.note).run();
            targetUnitId = created.meta.last_row_id;
          }
        }
        if (!targetUnitId) throw new Error("Не удалось сохранить единицу техники.");
        await setEquipmentProjectAssignment(transaction, targetUnitId, projectSiteId);
        return targetUnitId;
      });
      return Response.json({ saved: true, id: savedUnitId });
    }

    if (payload.action === "delete-unit") {
      if (!hasPermission(authUser.permissions, "equipment_registry", "delete")) return errorResponse("Нет права удалять технику из реестра.", 403);
      const unitId = positiveInteger(payload.id);
      if (!unitId) return errorResponse("Не указана единица техники.", 400);
      await db.batch([
        db.prepare("UPDATE equipment_units SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(unitId),
        db.prepare("UPDATE equipment_project_assignments SET active = 0, ended_at = CURRENT_TIMESTAMP WHERE equipment_id = ?").bind(unitId),
      ]);
      return Response.json({ deleted: true });
    }

    if (payload.action === "import-units") {
      if (!hasPermission(authUser.permissions, "equipment_registry", "create")) return errorResponse("Нет права импортировать технику в реестр.", 403);
      if (!Array.isArray(payload.units) || !payload.units.length || payload.units.length > 1000) return errorResponse("В файле нет строк реестра или их слишком много.", 400);
      const siteRows = await db.prepare("SELECT id, name FROM sites WHERE active = 1").all<{ id: number; name: string }>();
      const sitesByName = new Map(siteRows.results.map((project) => [normalize(project.name), project.id]));
      const prepared = payload.units.map((unit, index) => {
        try {
          const row = (unit ?? {}) as EquipmentInput & { projectName?: unknown };
          const values = validateEquipment(row);
          const hasProjectColumn = Object.prototype.hasOwnProperty.call(row, "projectName");
          const projectName = text(row.projectName, 240);
          const normalizedProject = normalize(projectName);
          const projectSiteId = !hasProjectColumn
            ? undefined
            : !projectName || ["не назначена", "не назначен", "без проекта", "-", "—"].includes(normalizedProject)
              ? null
              : sitesByName.get(normalizedProject) ?? null;
          if (hasProjectColumn && projectName && projectSiteId === null && !["не назначена", "не назначен", "без проекта", "-", "—"].includes(normalizedProject)) {
            throw new Error(`проект «${projectName}» не найден`);
          }
          return { values, identityKey: equipmentIdentity(values), projectSiteId };
        } catch (error) {
          throw new Error(`Строка ${index + 1}: ${error instanceof Error ? error.message : "некорректные данные"}`);
        }
      });
      const identityKeys = [...new Set(prepared.map((item) => item.identityKey))];
      const existingRows = identityKeys.length
        ? await db.prepare("SELECT id, identity_key AS \"identityKey\" FROM equipment_units WHERE identity_key = ANY(?) ORDER BY active DESC, id").bind(identityKeys).all<{ id: number; identityKey: string }>()
        : { results: [] as Array<{ id: number; identityKey: string }> };
      const existingByIdentity = new Map<string, number>();
      for (const row of existingRows.results) if (!existingByIdentity.has(row.identityKey)) existingByIdentity.set(row.identityKey, row.id);
      if (existingByIdentity.size && !hasPermission(authUser.permissions, "equipment_registry", "update")) {
        return errorResponse("Файл содержит технику, которая уже есть в реестре. Для обновления таких строк нужно право редактирования.", 403);
      }
      const existingIds = [...existingByIdentity.values()];
      const assignmentRows = existingIds.length
        ? await db.prepare("SELECT equipment_id AS \"equipmentId\", site_id AS \"siteId\" FROM equipment_project_assignments WHERE equipment_id = ANY(?) AND active = 1").bind(existingIds).all<{ equipmentId: number; siteId: number }>()
        : { results: [] as Array<{ equipmentId: number; siteId: number }> };
      const assignmentByEquipment = new Map(assignmentRows.results.map((row) => [row.equipmentId, row.siteId]));
      for (const item of prepared) {
        if (item.projectSiteId === undefined) continue;
        const existingId = existingByIdentity.get(item.identityKey);
        const assignmentAction = projectAssignmentAction(existingId ? assignmentByEquipment.get(existingId) ?? null : null, item.projectSiteId);
        if (assignmentAction && !hasPermission(authUser.permissions, "project_equipment", assignmentAction)) {
          return errorResponse(projectAssignmentPermissionMessage(assignmentAction), 403);
        }
      }
      await db.transaction(async (transaction) => {
        for (const item of prepared) {
          const existingId = existingByIdentity.get(item.identityKey);
          let targetUnitId: number | null = existingId ?? null;
          if (existingId) {
            await transaction.prepare(`UPDATE equipment_units SET organization = ?, equipment_type = ?, brand = ?, model = ?,
              registration_number = ?, note = ?, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .bind(item.values.organization, item.values.equipmentType, item.values.brand, item.values.model, item.values.registrationNumber, item.values.note, existingId).run();
          } else {
            const created = await transaction.prepare(`INSERT INTO equipment_units
              (site_id, identity_key, organization, equipment_type, brand, model, registration_number, note)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
              .bind(item.projectSiteId ?? siteId, item.identityKey, item.values.organization, item.values.equipmentType, item.values.brand, item.values.model, item.values.registrationNumber, item.values.note).run();
            targetUnitId = created.meta.last_row_id;
          }
          if (!targetUnitId) throw new Error("Не удалось импортировать единицу техники.");
          if (item.projectSiteId !== undefined) await setEquipmentProjectAssignment(transaction, targetUnitId, item.projectSiteId);
        }
      });
      return Response.json({ imported: prepared.length });
    }

    return errorResponse("Неизвестное действие.", 400);
  } catch (error) {
    console.error("Equipment update failed", error);
    const message = error instanceof Error ? error.message : "Не удалось сохранить учёт техники.";
    if (/unique|duplicate|idx_equipment_units_site_identity/i.test(message)) return errorResponse("Единица техники с такими данными уже существует.", 409);
    return errorResponse(message, 400);
  }
}

export async function POST(request: Request) {
  return withAuditTrail(request, handlePOST);
}
