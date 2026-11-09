import type { PostgresDatabase } from "../db/client";
import type { AuthUser } from "./auth";
import { equipmentExcelName } from "./equipmentExcel";
import { equipmentUnavailableReason } from "./equipmentAvailability";
import { rememberPersonnelImportOrder as rememberEquipmentImportOrder } from "./personnelImportOrderServer";
import type { EquipmentReport, EquipmentReportApprovedEntry, EquipmentReportAvailabilityMark, EquipmentReportData, EquipmentReportEntrySaveRequest, EquipmentReportDateRequest, EquipmentReportEntryDateRequest, EquipmentReportRequest, EquipmentReportRow, EquipmentReportRowValidationIssue, EquipmentReportValidationIssue, EquipmentReportValidationRequest, EquipmentReportValidationResult } from "./equipmentReportTypes";
import {
  assertCanSaveEquipmentReport, assertEquipmentReportHours, assertEquipmentReportOwner,
  assertEquipmentReportRevision, assertEquipmentReportSiteAccess, canReviewEquipmentReport, canViewPendingReportsFor,
  completeEquipmentReportRows, nextEquipmentReportStatus, normalizeEquipmentReportRows,
  EquipmentReportError, validEquipmentReportDate, equipmentReportRowChanged, inspectEquipmentReportRows,
  collectEquipmentReportHourIssues, type NormalizedEquipmentReportRow,
} from "./equipmentReportWorkflow";

type Executor = Pick<PostgresDatabase, "prepare" | "batch" | "readBatch">;
type Header = Omit<EquipmentReport, "rows">;
type Equipment = { id: number; organization: string; equipmentType: string; brand: string; model: string; registrationNumber: string };
type RowSnapshots = Equipment & { equipmentName: string };

const snapshotFields = ["equipment_name", "organization", "equipment_type", "brand", "model", "registration_number"] as const;
const schemaByDatabase = new WeakMap<object, Promise<void>>();
/** Additive local bootstrap; production applies migration 0024 explicitly. */
export async function ensureEquipmentReportSchema(db: PostgresDatabase) {
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_RUNTIME_BOOTSTRAP !== "true") return;
  let pending = schemaByDatabase.get(db);
  if (!pending) {
    pending = db.batch([
      ...snapshotFields.map(field => db.prepare(`ALTER TABLE equipment_entries ADD COLUMN IF NOT EXISTS ${field}_snapshot TEXT NOT NULL DEFAULT ''`)),
      db.prepare(`CREATE TABLE IF NOT EXISTS equipment_reports (
        id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id), work_date DATE NOT NULL,
        owner_user_id INTEGER NOT NULL REFERENCES app_users(id),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        submitted_at TIMESTAMPTZ, submitted_by_user_id INTEGER REFERENCES app_users(id),
        reviewed_at TIMESTAMPTZ, reviewed_by_user_id INTEGER REFERENCES app_users(id), review_comment TEXT NOT NULL DEFAULT '',
        created_by_user_id INTEGER NOT NULL REFERENCES app_users(id), updated_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_reports_site_date ON equipment_reports(site_id, work_date)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_equipment_reports_review ON equipment_reports(site_id, status, work_date)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_reports_active_owner_day ON equipment_reports(site_id, work_date, owner_user_id) WHERE status <> 'approved'"),
      db.prepare(`CREATE TABLE IF NOT EXISTS equipment_report_rows (
        id SERIAL PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES equipment_reports(id) ON DELETE CASCADE, row_order INTEGER NOT NULL,
        equipment_id INTEGER REFERENCES equipment_units(id), shift_id INTEGER REFERENCES shifts(id), zone_id INTEGER REFERENCES zones(id),
        main_work_type_id INTEGER REFERENCES main_work_types(id), subwork_type_id INTEGER REFERENCES subwork_types(id),
        hours INTEGER CHECK (hours IS NULL OR hours BETWEEN 1 AND 10), note TEXT NOT NULL DEFAULT '',
        equipment_name_snapshot TEXT NOT NULL DEFAULT '', organization_snapshot TEXT NOT NULL DEFAULT '', equipment_type_snapshot TEXT NOT NULL DEFAULT '',
        brand_snapshot TEXT NOT NULL DEFAULT '', model_snapshot TEXT NOT NULL DEFAULT '', registration_number_snapshot TEXT NOT NULL DEFAULT '',
        approved_entry_id INTEGER REFERENCES equipment_entries(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_report_rows_order ON equipment_report_rows(report_id, row_order)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_report_rows_approved_entry ON equipment_report_rows(approved_entry_id)"),
    ]).then(() => undefined).catch(error => { schemaByDatabase.delete(db); throw error; });
    schemaByDatabase.set(db, pending);
  }
  await pending;
}

const HEADER_SELECT = `SELECT report.id, report.site_id AS siteId, report.work_date AS workDate,
  report.owner_user_id AS ownerUserId, owner.full_name AS ownerName, report.status, report.revision,
  report.submitted_at AS submittedAt, report.reviewed_at AS reviewedAt, report.reviewed_by_user_id AS reviewedByUserId,
  reviewer.full_name AS reviewedByName, report.review_comment AS reviewComment,
  report.created_at AS createdAt, report.updated_at AS updatedAt
  FROM equipment_reports report JOIN app_users owner ON owner.id = report.owner_user_id
  LEFT JOIN app_users reviewer ON reviewer.id = report.reviewed_by_user_id`;

function reportRowsStatement(db: Executor, reportIds: number[], publishedValues = true) {
  const value = (column: string) => publishedValues ? `CASE WHEN report.status = 'approved' AND published.id IS NOT NULL THEN published.${column} ELSE draft_row.${column} END` : `draft_row.${column}`;
  return db.prepare(`SELECT draft_row.id, draft_row.report_id AS reportId, report.site_id AS siteId, report.work_date AS workDate,
    ${value("equipment_id")} AS equipmentId, ${value("shift_id")} AS shiftId, ${value("zone_id")} AS zoneId,
    ${value("main_work_type_id")} AS mainWorkTypeId, ${value("subwork_type_id")} AS subworkTypeId,
    ${value("hours")} AS hours, ${value("note")} AS note, ${value("created_at")} AS createdAt, ${value("updated_at")} AS updatedAt,
    draft_row.row_order AS rowOrder, ${value("equipment_name_snapshot")} AS equipmentName,
    ${value("organization_snapshot")} AS organization, ${value("equipment_type_snapshot")} AS equipmentType,
    ${value("brand_snapshot")} AS brand, ${value("model_snapshot")} AS model, ${value("registration_number_snapshot")} AS registrationNumber,
    COALESCE(shift.name, '') AS shiftName, COALESCE(zone.name, '') AS zoneName,
    COALESCE(main_work.name, '') AS mainWorkTypeName, COALESCE(subwork.name, '') AS subworkTypeName,
    draft_row.approved_entry_id AS approvedEntryId, published.revision AS approvedEntryRevision
    FROM equipment_report_rows draft_row JOIN equipment_reports report ON report.id = draft_row.report_id
    LEFT JOIN equipment_entries published ON published.id = draft_row.approved_entry_id
    LEFT JOIN shifts shift ON shift.id = ${value("shift_id")} LEFT JOIN zones zone ON zone.id = ${value("zone_id")}
    LEFT JOIN main_work_types main_work ON main_work.id = ${value("main_work_type_id")}
    LEFT JOIN subwork_types subwork ON subwork.id = ${value("subwork_type_id")}
    WHERE draft_row.report_id = ANY(?) ${publishedValues ? "AND (report.status <> 'approved' OR published.deleted_at IS NULL AND published.id IS NOT NULL)" : ""}
    ORDER BY report.work_date DESC, report.id DESC, draft_row.row_order, draft_row.id LIMIT 20001`).bind(reportIds);
}

async function readReport(db: Executor, id: number): Promise<EquipmentReport> {
  const header = await db.prepare(`${HEADER_SELECT} WHERE report.id = ?`).bind(id).first<Header>();
  if (!header) throw new EquipmentReportError("Отчёт не найден.", 404, "REPORT_NOT_FOUND");
  const rows = await reportRowsStatement(db, [id]).all<EquipmentReportRow>();
  return { ...header, rows: rows.results };
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

async function assertActiveSite(db: Executor, user: AuthUser, siteId: number) {
  assertEquipmentReportSiteAccess(user, siteId);
  if (!await db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(siteId).first()) {
    throw new EquipmentReportError("Проект не найден.", 404, "SITE_NOT_FOUND");
  }
}

export async function listEquipmentReports(db: Executor, user: AuthUser, siteId: number, from: string | null, to: string | null): Promise<EquipmentReportData> {
  await assertActiveSite(db, user, siteId);
  if ((from !== null && !validEquipmentReportDate(from)) || (to !== null && !validEquipmentReportDate(to)) || (from && to && from > to)) {
    throw new EquipmentReportError("Укажите корректный период отчёта.");
  }
  const rangeFilter = `${from ? " AND report.work_date >= ?" : ""}${to ? " AND report.work_date <= ?" : ""}`;
  const ownFilter = user.role === "foreman" ? " AND report.owner_user_id = ?" : "";
  const hidePending = !canViewPendingReportsFor(user);
  const privateDrafts = !hidePending && user.role !== "foreman";
  const statusFilter = hidePending ? " AND report.status = 'approved'"
    : privateDrafts ? " AND (report.status IN ('approved', 'submitted') OR report.owner_user_id = ?)" : "";
  const parameters = [siteId, ...(from ? [from] : []), ...(to ? [to] : []), ...(user.role === "foreman" ? [user.id] : [])];
  const headers = await db.prepare(`${HEADER_SELECT} WHERE report.site_id = ? ${rangeFilter} ${ownFilter} ${statusFilter}
    ORDER BY report.work_date DESC, report.id DESC LIMIT 5001`).bind(...parameters, ...(privateDrafts ? [user.id] : [])).all<Header>();
  const visibleHeaders = headers.results.filter(report => {
    if (user.role === "foreman" && report.ownerUserId !== user.id) return false;
    if (hidePending) return report.status === "approved";
    return report.status === "approved" || report.status === "submitted" || report.ownerUserId === user.id;
  });
  if (visibleHeaders.length > 5000) throw new EquipmentReportError("В выбранном периоде слишком много отчётов. Сузьте период.", 413, "REPORT_RANGE_TOO_LARGE");
  const entryFilter = `${from ? " AND entry.work_date >= ?" : ""}${to ? " AND entry.work_date <= ?" : ""}${user.role === "foreman" ? " AND entry.responsible_user_id = ?" : ""}`;
  const entries = await db.prepare(`SELECT entry.id, entry.site_id AS siteId, entry.work_date AS workDate,
    entry.equipment_id AS equipmentId, entry.shift_id AS shiftId, entry.zone_id AS zoneId,
    entry.main_work_type_id AS mainWorkTypeId, entry.subwork_type_id AS subworkTypeId,
    entry.hours, entry.note, entry.revision, entry.responsible_user_id AS responsibleUserId, COALESCE(responsible.full_name, '') AS responsibleUserName,
    entry.created_at AS createdAt, entry.updated_at AS updatedAt, COALESCE(origin.row_order, 0) AS rowOrder,
    origin.id AS orderRowId, origin.report_id AS orderReportId,
    entry.equipment_name_snapshot AS equipmentName,
    CASE WHEN entry.equipment_name_snapshot <> '' THEN entry.organization_snapshot ELSE equipment.organization END AS organization,
    CASE WHEN entry.equipment_name_snapshot <> '' THEN entry.equipment_type_snapshot ELSE equipment.equipment_type END AS equipmentType,
    CASE WHEN entry.equipment_name_snapshot <> '' THEN entry.brand_snapshot ELSE equipment.brand END AS brand,
    CASE WHEN entry.equipment_name_snapshot <> '' THEN entry.model_snapshot ELSE equipment.model END AS model,
    CASE WHEN entry.equipment_name_snapshot <> '' THEN entry.registration_number_snapshot ELSE equipment.registration_number END AS registrationNumber,
    shift.name AS shiftName, zone.name AS zoneName, main_work.name AS mainWorkTypeName, subwork.name AS subworkTypeName
    FROM equipment_entries entry JOIN equipment_units equipment ON equipment.id = entry.equipment_id
    JOIN shifts shift ON shift.id = entry.shift_id JOIN zones zone ON zone.id = entry.zone_id
    JOIN main_work_types main_work ON main_work.id = entry.main_work_type_id
    JOIN subwork_types subwork ON subwork.id = entry.subwork_type_id
    LEFT JOIN app_users responsible ON responsible.id = entry.responsible_user_id
    LEFT JOIN equipment_report_rows origin ON origin.approved_entry_id = entry.id
    WHERE entry.site_id = ? AND entry.deleted_at IS NULL ${entryFilter}
    ORDER BY entry.created_at DESC, origin.row_order, entry.id DESC LIMIT 20001`)
    .bind(...parameters).all<EquipmentReportApprovedEntry>();
  for (const entry of entries.results) if (!entry.equipmentName) entry.equipmentName = equipmentExcelName(entry);
  if (entries.results.length > 20000) throw new EquipmentReportError("В выбранном периоде больше 20 000 строк. Сузьте период.", 413, "REPORT_RANGE_TOO_LARGE");
  const rows = visibleHeaders.length ? await reportRowsStatement(db, visibleHeaders.map((report) => report.id)).all<EquipmentReportRow>() : { results: [] as EquipmentReportRow[] };
  if (rows.results.length > 20000) throw new EquipmentReportError("В выбранном периоде больше 20 000 строк черновиков. Сузьте период.", 413, "REPORT_RANGE_TOO_LARGE");
  const byReport = new Map<number, EquipmentReportRow[]>();
  for (const row of rows.results) {
    if (!byReport.has(row.reportId)) byReport.set(row.reportId, []);
    byReport.get(row.reportId)!.push(row);
  }
  const availabilityMarks = user.role === "viewer" && !user.permissions.equipment_timesheet?.view ? { results: [] as EquipmentReportAvailabilityMark[] } : await db.prepare(`SELECT equipment_id AS equipmentId, work_date AS workDate,
      productive_hours AS productiveHours, downtime_hours AS downtimeHours, note
    FROM equipment_timesheet_marks WHERE site_id = ? ${from ? "AND work_date >= ?" : ""} ${to ? "AND work_date <= ?" : ""}
    ORDER BY work_date DESC, equipment_id LIMIT 20001`).bind(siteId, ...(from ? [from] : []), ...(to ? [to] : [])).all<EquipmentReportAvailabilityMark>();
  if (availabilityMarks.results.length > 20000) throw new EquipmentReportError("В выбранном периоде слишком много отметок техники. Сузьте период.", 413, "REPORT_RANGE_TOO_LARGE");
  return { reports: visibleHeaders.map((report) => ({ ...report, ...(hidePending ? { reviewComment: "" } : {}), rows: byReport.get(report.id) ?? [] })), entries: entries.results, availabilityMarks: availabilityMarks.results, canReview: canReviewEquipmentReport(user), from, to };
}

async function inspectReferences(db: Executor, siteId: number, rows: NormalizedEquipmentReportRow[], historical: ReadonlyMap<number, EquipmentReportRow> = new Map()) {
  const equipmentIds = [...new Set(rows.flatMap(row => row.equipmentId ? [row.equipmentId] : []))];
  const equipment = await db.prepare(`SELECT equipment.id, equipment.organization, equipment.equipment_type AS equipmentType,
      equipment.brand, equipment.model, equipment.registration_number AS registrationNumber FROM equipment_units equipment
    WHERE equipment.id = ANY(?) AND equipment.active = 1 AND EXISTS (
      SELECT 1 FROM equipment_project_assignments assignment WHERE assignment.equipment_id = equipment.id AND assignment.site_id = ? AND assignment.active = 1
    )`).bind(equipmentIds, siteId).all<Equipment>();
  const byEquipment = new Map(equipment.results.map(unit => [unit.id, unit]));
  const fields = ["shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId"] as const;
  const tables = ["shifts", "zones", "main_work_types", "subwork_types"] as const;
  const results = await db.readBatch(fields.map((field, index) => db.prepare(`SELECT id, name${field === "subworkTypeId" ? ", main_work_type_id AS mainWorkTypeId" : ""} FROM ${tables[index]}
    WHERE site_id = ? AND active = 1 AND id = ANY(?)`).bind(siteId, [...new Set(rows.flatMap(row => row[field] ? [row[field]] : []))])));
  const references = results.map(result => new Map((result.results as Array<{ id: number; name: string }>).map(entry => [entry.id, entry.name])));
  const subworkParents = new Map((results[3].results as Array<{ id: number; mainWorkTypeId: number | null }>).map(child => [child.id, child.mainWorkTypeId]));
  const issues: EquipmentReportRowValidationIssue[] = [];
  const snapshots = rows.map((row, index) => {
    const previous = historical.get(index);
    const sameEquipment = Boolean(previous?.equipmentId && previous.equipmentId === row.equipmentId);
    const unit = row.equipmentId ? byEquipment.get(row.equipmentId) : undefined;
    const sameWorkPair = Boolean(previous?.mainWorkTypeId && previous.mainWorkTypeId === row.mainWorkTypeId && previous.subworkTypeId === row.subworkTypeId);
    const add = (code: string, message: string) => issues.push({ code, message: `Строка ${index + 1}: ${message}`, rowNumbers: [index + 1], ...(row.equipmentId ? { equipmentId: row.equipmentId } : {}), ...(unit ? { equipmentName: equipmentExcelName(unit) } : {}) });
    if (row.equipmentId && !unit && !sameEquipment) add("INVALID_EQUIPMENT", "выберите действующую технику, назначенную на проект.");
    if (row.subworkTypeId && !sameWorkPair && (!row.mainWorkTypeId || subworkParents.get(row.subworkTypeId) !== row.mainWorkTypeId)) add("INVALID_WORK_HIERARCHY", "подвид не относится к выбранному виду работы.");
    const labels = ["Смена", "Зона", "Вид работы", "Подвид работы"];
    fields.forEach((field, fieldIndex) => {
      const unchanged = field === "subworkTypeId" ? sameWorkPair : Boolean(previous?.[field] && previous[field] === row[field]);
      if (row[field] && !references[fieldIndex].has(row[field]!) && !unchanged) add("INVALID_REFERENCE", `значение поля «${labels[fieldIndex]}» отсутствует в справочнике проекта.`);
    });
    const identity = unit ?? { id: 0, organization: "", equipmentType: "", brand: "", model: "", registrationNumber: "" };
    return sameEquipment && previous ? rowSnapshot(previous) : { ...identity, equipmentName: unit ? equipmentExcelName(unit) : "" };
  });
  return { snapshots, issues };
}

async function validateReferences(db: Executor, siteId: number, rows: NormalizedEquipmentReportRow[], historical: ReadonlyMap<number, EquipmentReportRow> = new Map()): Promise<RowSnapshots[]> {
  const result = await inspectReferences(db, siteId, rows, historical);
  if (result.issues.length) throw new EquipmentReportError(result.issues[0].message, 400, result.issues[0].code, { issues: result.issues });
  return result.snapshots;
}

async function approvedHoursForDate(db: Executor, workDate: string, equipmentIds: number[], excludedIds: number[] = []) {
  const approved = await db.prepare(`SELECT equipment_id AS equipmentId, SUM(hours)::int AS hours FROM equipment_entries
    WHERE work_date = ? AND deleted_at IS NULL AND equipment_id = ANY(?) AND NOT (id = ANY(?))
    GROUP BY equipment_id`).bind(workDate, equipmentIds, excludedIds).all<{ equipmentId: number; hours: number }>();
  return new Map(approved.results.map(entry => [entry.equipmentId, entry.hours]));
}

async function availabilityIssues(db: Executor, siteId: number, workDate: string, rows: NormalizedEquipmentReportRow[], names: ReadonlyMap<number, string>) {
  const equipmentIds = [...new Set(rows.flatMap(row => row.equipmentId ? [row.equipmentId] : []))];
  const blocked = await db.prepare(`SELECT equipment_id AS equipmentId, downtime_hours AS downtimeHours, note
    FROM equipment_timesheet_marks WHERE site_id = ? AND work_date = ? AND equipment_id = ANY(?)
      AND productive_hours = 0 AND downtime_hours > 0`).bind(siteId, workDate, equipmentIds).all<{ equipmentId: number; downtimeHours: number; note: string }>();
  return blocked.results.map(mark => ({ equipmentId: mark.equipmentId, equipmentName: names.get(mark.equipmentId) ?? "", code: "EQUIPMENT_UNAVAILABLE",
    rowNumbers: rows.flatMap((row, index) => row.equipmentId === mark.equipmentId ? [index + 1] : []),
    message: `Техника «${names.get(mark.equipmentId) ?? mark.equipmentId}» недоступна по табелю: ${equipmentUnavailableReason({ ...mark, productiveHours: 0 })}. Исправьте отметку в табеле техники.` }));
}

async function checkHours(db: Executor, siteId: number, workDate: string, rows: ReturnType<typeof completeEquipmentReportRows>, lock: boolean, names: ReadonlyMap<number, string>, excludedIds: number[] = [], previousEquipmentIds: number[] = []) {
  const equipmentIds = [...new Set(rows.map(row => row.equipmentId))];
  if (lock) for (const key of [...new Set([...equipmentIds, ...previousEquipmentIds])].map(id => `${workDate}:${id}`).sort()) {
    // Same lock namespace as the existing equipment/timesheet APIs.
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`equipment-hours:${key}`).first();
  }
  const issues = await availabilityIssues(db, siteId, workDate, rows, names);
  if (issues.length) throw new EquipmentReportError(issues.map(issue => issue.message).join("\n"), 409, "EQUIPMENT_UNAVAILABLE", { issues });
  assertEquipmentReportHours(rows, await approvedHoursForDate(db, workDate, equipmentIds, excludedIds), names);
}

/** A read-only preview; authoritative mutations always run the same final guards again. */
export async function validateEquipmentReportSubmissions(db: Executor, user: AuthUser, payload: EquipmentReportValidationRequest): Promise<EquipmentReportValidationResult> {
  if (user.role === "viewer") throw new EquipmentReportError("Роль «Просмотр» не может изменять отчёты.", 403, "REPORT_FORBIDDEN");
  if (!positiveId(payload.siteId) || !Array.isArray(payload.reports) || !payload.reports.length || payload.reports.length > 100) throw new EquipmentReportError("Укажите проект и от 1 до 100 отчётов для проверки.");
  const keys = new Set<string>(); const reportIds = new Set<number>(); const newDates = new Set<string>();
  let total = 0;
  for (const target of payload.reports) {
    if (!target || typeof target !== "object" || typeof target.key !== "string" || !target.key.trim() || target.key.length > 200 || keys.has(target.key) || !validEquipmentReportDate(target.workDate) || !Array.isArray(target.rows) || target.rows.length > 1000) throw new EquipmentReportError("Некорректные даты, ключи или строки проверяемых отчётов.");
    keys.add(target.key); total += target.rows.length;
    if (target.reportId !== undefined) {
      if (!positiveId(target.reportId) || reportIds.has(target.reportId)) throw new EquipmentReportError("Один отчёт указан повторно или имеет некорректный идентификатор.");
      reportIds.add(target.reportId);
    } else {
      if (newDates.has(target.workDate)) throw new EquipmentReportError("Для одной даты указан более чем один новый отчёт.");
      newDates.add(target.workDate);
    }
  }
  if (total > 5000) throw new EquipmentReportError("Проверьте не более 5000 строк за один раз.", 413, "REPORT_TOO_LARGE");
  await assertActiveSite(db, user, payload.siteId);
  if (!user.permissions.equipment_report.update) throw new EquipmentReportError("Нет права отправлять отчёты на проверку.", 403, "REPORT_FORBIDDEN");
  const existing = reportIds.size ? await db.prepare(`${HEADER_SELECT} WHERE report.id = ANY(?)`).bind([...reportIds]).all<Header>() : { results: [] as Header[] };
  // Authorise the entire batch before returning any reference, revision or hour details.
  for (const current of existing.results) {
    assertEquipmentReportOwner(user, current);
    if (current.siteId !== payload.siteId) throw new EquipmentReportError("Отчёт не относится к выбранному проекту.", 403, "REPORT_FORBIDDEN");
  }
  if (newDates.size && !user.permissions.equipment_report.create) throw new EquipmentReportError("Нет права создавать отчёты.", 403, "REPORT_FORBIDDEN");
  const currentById = new Map<number, EquipmentReport>();
  for (const header of existing.results) currentById.set(header.id, await readReport(db, header.id));
  const active = newDates.size ? await db.prepare(`SELECT id, work_date AS workDate FROM equipment_reports
    WHERE site_id = ? AND owner_user_id = ? AND status <> 'approved' AND work_date = ANY(?)`)
    .bind(payload.siteId, user.id, [...newDates]).all<{ id: number; workDate: string }>() : { results: [] as Array<{ id: number; workDate: string }> };
  const issues: EquipmentReportValidationIssue[] = [];
  const normalized: Array<{ target: EquipmentReportValidationRequest["reports"][number]; rows: NormalizedEquipmentReportRow[]; current?: EquipmentReport; offset: number }> = [];
  const flattened: NormalizedEquipmentReportRow[] = [];
  const issueFromError = (target: EquipmentReportValidationRequest["reports"][number], error: unknown) => {
    if (!(error instanceof EquipmentReportError)) throw error;
    if (error.status === 403) throw error;
    issues.push({ key: target.key, workDate: target.workDate, code: error.code, message: error.message });
  };
  for (const target of payload.reports) {
    const current = target.reportId ? currentById.get(target.reportId) : undefined;
    const inspected = inspectEquipmentReportRows(target.rows);
    const rows = inspected.rows;
    if (current) {
      if (rows.some(row => !row.id) && !user.permissions.equipment_report.create) throw new EquipmentReportError("Нет права добавлять строки отчёта.", 403, "REPORT_FORBIDDEN");
      if (current.rows.some(previous => !rows.some(row => row.id === previous.id)) && !user.permissions.equipment_report.delete) throw new EquipmentReportError("Нет права удалять строки отчёта.", 403, "REPORT_FORBIDDEN");
      if (current.workDate !== target.workDate) issues.push({ key: target.key, workDate: target.workDate, code: "REPORT_DATE_MISMATCH", message: "Нельзя изменить дату существующего отчёта." });
      try { assertEquipmentReportRevision(current.revision, target.revision); } catch (error) { issueFromError(target, error); }
      try { nextEquipmentReportStatus(user, current, "submit"); } catch (error) { issueFromError(target, error); }
    } else if (target.reportId) issues.push({ key: target.key, workDate: target.workDate, code: "REPORT_NOT_FOUND", message: "Отчёт не найден. Обновите таблицу." });
    else if (active.results.some(report => report.workDate === target.workDate)) issues.push({ key: target.key, workDate: target.workDate, code: "REPORT_EXISTS", message: "На эту дату уже есть ваш черновик. Обновите таблицу и продолжите его заполнение." });
    for (const issue of inspected.issues) issues.push({ ...issue, key: target.key, workDate: target.workDate });
    const retained = new Set<number>();
    rows.forEach((row, index) => {
      if (row.id && (retained.has(row.id) || !current?.rows.some(previous => previous.id === row.id))) issues.push({ key: target.key, workDate: target.workDate, rowNumbers: [index + 1], code: "INVALID_REPORT_ROW", message: `Строка ${index + 1}: строка не принадлежит этому отчёту или указана повторно.` });
      if (row.id) retained.add(row.id);
      if (current?.status === "approved" && row.id) {
        const previous = current.rows.find(previous => previous.id === row.id);
        if (previous) try { assertEquipmentReportRevision(previous.approvedEntryRevision!, row.approvedEntryRevision); } catch (error) {
          if (!(error instanceof EquipmentReportError)) throw error;
          issues.push({ key: target.key, workDate: target.workDate, rowNumbers: [index + 1], code: error.code, message: error.message });
        }
      }
    });
    normalized.push({ target, rows, current, offset: flattened.length });
    flattened.push(...rows);
  }
  const references = await inspectReferences(db, payload.siteId, flattened);
  for (const item of normalized) for (const issue of references.issues) {
    const rowNumbers = issue.rowNumbers?.filter(number => number > item.offset && number <= item.offset + item.rows.length).map(number => number - item.offset);
    if (!rowNumbers?.length) continue;
    const message = issue.message.replace(/^Строка \d+:/, `Строка ${rowNumbers[0]}:`);
    issues.push({ ...issue, key: item.target.key, workDate: item.target.workDate, rowNumbers, message });
  }
  for (const date of new Set(normalized.map(item => item.target.workDate))) {
    const dateReports = normalized.filter(item => item.target.workDate === date);
    const dateRows = dateReports.flatMap(item => item.rows.flatMap((row, index) => row.equipmentId && row.hours ? [{ item, index, equipmentId: row.equipmentId, hours: row.hours }] : []));
    const excludedIds = dateReports.flatMap(item => item.current?.status === "approved" && item.current.workDate === date ? item.current.rows.flatMap(row => row.approvedEntryId ? [row.approvedEntryId] : []) : []);
    const approved = await approvedHoursForDate(db, date, [...new Set(dateRows.map(row => row.equipmentId))], excludedIds);
    const names = new Map(dateRows.map(row => [row.equipmentId, references.snapshots[row.item.offset + row.index].equipmentName]));
    const unavailable = await availabilityIssues(db, payload.siteId, date, dateRows.map(row => row.item.rows[row.index]), names);
    for (const issue of unavailable) for (const item of dateReports) {
      const rowNumbers = dateRows.filter(row => row.item === item && row.equipmentId === issue.equipmentId).map(row => row.index + 1);
      if (rowNumbers.length) issues.push({ ...issue, key: item.target.key, workDate: date, rowNumbers });
    }
    const conflicts = collectEquipmentReportHourIssues(dateRows, approved, names);
    for (const conflict of conflicts) for (const item of dateReports) {
      const rowNumbers = dateRows.filter(row => row.item === item && row.equipmentId === conflict.equipmentId).map(row => row.index + 1);
      if (rowNumbers.length) issues.push({ ...conflict, key: item.target.key, workDate: date, rowNumbers });
    }
  }
  return { issues };
}

function snapshotValues(snapshot: RowSnapshots) { return [snapshot.equipmentName, snapshot.organization, snapshot.equipmentType, snapshot.brand, snapshot.model, snapshot.registrationNumber]; }
function snapshotsChanged(row: EquipmentReportRow, snapshot: RowSnapshots) { return snapshotValues(snapshot).some((value, index) => value !== [row.equipmentName, row.organization, row.equipmentType, row.brand, row.model, row.registrationNumber][index]); }
function rowSnapshot(row: EquipmentReportRow): RowSnapshots { return { id: row.equipmentId ?? 0, equipmentName: row.equipmentName, organization: row.organization, equipmentType: row.equipmentType, brand: row.brand, model: row.model, registrationNumber: row.registrationNumber }; }

async function saveDraftRows(db: Executor, reportId: number, rows: NormalizedEquipmentReportRow[], snapshots: RowSnapshots[], previous: EquipmentReportRow[]) {
  const previousById = new Map(previous.map(row => [row.id, row]));
  const retainedIds = rows.flatMap(row => row.id ? [row.id] : []);
  if (new Set(retainedIds).size !== retainedIds.length || retainedIds.some(id => !previousById.has(id))) throw new EquipmentReportError("Строка не принадлежит этому отчёту или указана повторно. Обновите таблицу.", 409, "INVALID_REPORT_ROW");
  await db.prepare("DELETE FROM equipment_report_rows WHERE report_id = ? AND NOT (id = ANY(?))").bind(reportId, retainedIds).run();
  await db.prepare("UPDATE equipment_report_rows SET row_order = -id WHERE report_id = ?").bind(reportId).run();
  const stamp = await db.prepare("SELECT clock_timestamp() AS changedAt").first<{ changedAt: string }>();
  if (!stamp) throw new Error("Не удалось определить время сохранения.");
  for (let offset = 0; offset < rows.length; offset += 100) await db.batch(rows.slice(offset, offset + 100).map((row, index) => {
    const snapshot = snapshots[offset + index];
    const values = [row.equipmentId, row.shiftId, row.zoneId, row.mainWorkTypeId, row.subworkTypeId, row.hours, row.note, ...snapshotValues(snapshot)];
    if (row.id) {
      const old = previousById.get(row.id)!;
      const changed = equipmentReportRowChanged(old, row) || snapshotsChanged(old, snapshot);
      return db.prepare(`UPDATE equipment_report_rows SET row_order = ?, equipment_id = ?, shift_id = ?, zone_id = ?,
        main_work_type_id = ?, subwork_type_id = ?, hours = ?, note = ?, equipment_name_snapshot = ?, organization_snapshot = ?,
        equipment_type_snapshot = ?, brand_snapshot = ?, model_snapshot = ?, registration_number_snapshot = ?,
        updated_at = CASE WHEN ? THEN ?::timestamptz ELSE updated_at END WHERE report_id = ? AND id = ? RETURNING id`)
        .bind(offset + index, ...values, changed, stamp.changedAt, reportId, row.id);
    }
    return db.prepare(`INSERT INTO equipment_report_rows (report_id, row_order, equipment_id, shift_id, zone_id, main_work_type_id,
      subwork_type_id, hours, note, equipment_name_snapshot, organization_snapshot, equipment_type_snapshot, brand_snapshot,
      model_snapshot, registration_number_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(reportId, offset + index, ...values, stamp.changedAt, stamp.changedAt);
  }));
}

async function updatePublishedEntry(db: Executor, user: AuthUser, entryId: number, row: NormalizedEquipmentReportRow, snapshot: RowSnapshots) {
  await db.prepare(`UPDATE equipment_entries SET equipment_id = ?, shift_id = ?, zone_id = ?, main_work_type_id = ?,
    subwork_type_id = ?, hours = ?, note = ?, equipment_name_snapshot = ?, organization_snapshot = ?, equipment_type_snapshot = ?,
    brand_snapshot = ?, model_snapshot = ?, registration_number_snapshot = ?, updated_by_user_id = ?,
    updated_at = clock_timestamp(), revision = revision + 1 WHERE id = ? AND deleted_at IS NULL RETURNING id`)
    .bind(row.equipmentId, row.shiftId, row.zoneId, row.mainWorkTypeId, row.subworkTypeId, row.hours, row.note, ...snapshotValues(snapshot), user.id, entryId).run();
}

/** Published IDs and original ownership survive approved corrections. */
async function publishEquipmentReportRows(db: Executor, user: AuthUser, report: EquipmentReport) {
  const source = await reportRowsStatement(db, [report.id], false).all<EquipmentReportRow>();
  for (const row of source.results) {
    const snapshot = rowSnapshot(row);
    if (row.approvedEntryId) {
      const previous = report.rows.find(previous => previous.id === row.id);
      if (!previous || equipmentReportRowChanged(previous, row) || snapshotsChanged(previous, snapshot)) await updatePublishedEntry(db, user, row.approvedEntryId, row, snapshot);
    } else {
      const values = [report.siteId, report.workDate, row.equipmentId, row.shiftId, row.zoneId, row.mainWorkTypeId, row.subworkTypeId,
        row.note, row.hours, ...snapshotValues(snapshot), report.ownerName, report.ownerUserId, report.ownerUserId, user.id, row.createdAt, row.updatedAt];
      const entry = await db.prepare(`INSERT INTO equipment_entries
        (site_id, work_date, equipment_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, hours,
        equipment_name_snapshot, organization_snapshot, equipment_type_snapshot, brand_snapshot, model_snapshot, registration_number_snapshot,
        created_by, responsible_user_id, created_by_user_id, updated_by_user_id, created_at, updated_at)
        VALUES (${values.map(() => "?").join(", ")}) RETURNING id`).bind(...values).first<{ id: number }>();
      if (!entry) throw new Error("Не удалось опубликовать строку отчёта.");
      await db.prepare("UPDATE equipment_report_rows SET approved_entry_id = ? WHERE id = ? RETURNING id").bind(entry.id, row.id).run();
    }
  }
}

/** Older approved entries have no draft header. Correct them with their own optimistic revision. */
export async function mutateEquipmentReportEntry(database: PostgresDatabase, user: AuthUser, payload: EquipmentReportEntrySaveRequest): Promise<EquipmentReportApprovedEntry> {
  if (user.role === "viewer") throw new EquipmentReportError("Роль «Просмотр» не может изменять отчёты.", 403, "REPORT_FORBIDDEN");
  return database.transaction(async db => {
    if (!canReviewEquipmentReport(user)) throw new EquipmentReportError("Исправлять подтверждённые записи может только инженер.", 403, "REPORT_FORBIDDEN");
    if (!positiveId(payload.entryId) || !positiveId(payload.siteId) || !validEquipmentReportDate(payload.workDate)) throw new EquipmentReportError("Укажите запись, проект и дату отчёта.");
    await assertActiveSite(db, user, payload.siteId);
    const previous = await db.prepare(`SELECT entry.id, entry.site_id AS siteId, entry.work_date AS workDate, entry.equipment_id AS equipmentId,
      entry.revision, source.report_id AS reportId FROM equipment_entries entry
      LEFT JOIN equipment_report_rows source ON source.approved_entry_id = entry.id
      WHERE entry.id = ? AND entry.deleted_at IS NULL
      ORDER BY entry.id FOR UPDATE OF entry`).bind(payload.entryId)
      .first<{ id: number; siteId: number; workDate: string; equipmentId: number; revision: number; reportId: number | null }>();
    if (!previous) throw new EquipmentReportError("Запись уже удалена. Обновите таблицу.", 409, "STALE_REPORT");
    if (previous.siteId !== payload.siteId || previous.workDate !== payload.workDate) throw new EquipmentReportError("Нельзя изменить проект или дату существующей записи.");
    if (previous.reportId) throw new EquipmentReportError("Запись относится к отчёту. Обновите таблицу и исправьте отчёт целиком.", 409, "STALE_REPORT");
    assertEquipmentReportRevision(previous.revision, payload.revision);
    const rows = normalizeEquipmentReportRows([payload.row]);
    const complete = completeEquipmentReportRows(rows);
    const original = (await listEquipmentReports(db, user, payload.siteId, payload.workDate, payload.workDate)).entries.find(entry => entry.id === previous.id);
    if (!original) throw new EquipmentReportError("Запись уже изменена. Обновите таблицу.", 409, "STALE_REPORT");
    const snapshots = await validateReferences(db, payload.siteId, rows, new Map([[0, { ...original, reportId: 0, approvedEntryId: original.id }]]));
    await checkHours(db, payload.siteId, payload.workDate, complete, true, new Map([[complete[0].equipmentId, snapshots[0].equipmentName]]), [previous.id], [previous.equipmentId]);
    await updatePublishedEntry(db, user, previous.id, rows[0], snapshots[0]);
    const result = await listEquipmentReports(db, user, payload.siteId, payload.workDate, payload.workDate);
    const entry = result.entries.find(entry => entry.id === previous.id);
    if (!entry) throw new Error("Не удалось загрузить исправленную запись.");
    return entry;
  });
}

/** Date edits share the same unit/day locks as publication and timesheet marks. */
async function lockEquipmentReportDates(db: Executor, dates: string[], equipmentIds: number[]) {
  const keys = [...new Set(dates.flatMap(date => equipmentIds.map(id => `${date}:${id}`)))].sort();
  for (const key of keys) await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`equipment-hours:${key}`).first();
}

function assertEquipmentDate(value: unknown): asserts value is string {
  if (!validEquipmentReportDate(value) || value.startsWith("0000-")) throw new EquipmentReportError("Укажите корректную дату отчёта.");
}

async function updateEquipmentReportDay(db: Executor, user: AuthUser, siteId: number, oldDate: string, workDate: string) {
  // Different owners and units can move in opposite directions at once. Their
  // shared day-marker rows still need a common deterministic lock order.
  for (const date of [...new Set([oldDate, workDate])].sort()) {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`equipment-published-day:${siteId}:${date}`).first();
  }
  await db.prepare(`INSERT INTO equipment_report_days (site_id, work_date, submitted_by, submitted_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT (site_id, work_date) DO UPDATE SET
    submitted_by = EXCLUDED.submitted_by, submitted_at = CURRENT_TIMESTAMP RETURNING site_id`)
    .bind(siteId, workDate, user.id).run();
  // Another foreman's approved report or legacy entries keep the original day.
  await db.prepare(`DELETE FROM equipment_report_days WHERE site_id = ? AND work_date = ?
    AND NOT EXISTS (SELECT 1 FROM equipment_entries WHERE site_id = ? AND work_date = ? AND deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM equipment_reports WHERE site_id = ? AND work_date = ? AND status = 'approved')`)
    .bind(siteId, oldDate, siteId, oldDate, siteId, oldDate).run();
}

async function changeEquipmentReportDate(db: Executor, user: AuthUser, payload: EquipmentReportDateRequest): Promise<EquipmentReport> {
  assertEquipmentDate(payload.workDate);
  if (!positiveId(payload.reportId)) throw new EquipmentReportError("Некорректный отчёт.");
  await db.prepare("SELECT id FROM equipment_reports WHERE id = ? FOR UPDATE").bind(payload.reportId).first();
  const initial = await readReport(db, payload.reportId);
  assertCanSaveEquipmentReport(user, initial);
  await assertActiveSite(db, user, initial.siteId);
  assertEquipmentReportRevision(initial.revision, payload.revision);
  if (initial.workDate === payload.workDate) return initial;
  for (const date of [...new Set([initial.workDate, payload.workDate])].sort()) {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .bind(`equipment-report:${initial.siteId}:${date}:${initial.ownerUserId}`).first();
  }
  if (initial.status !== "approved") {
    const existing = await db.prepare(`SELECT id FROM equipment_reports WHERE site_id = ? AND work_date = ?
      AND owner_user_id = ? AND status <> 'approved' AND id <> ?`)
      .bind(initial.siteId, payload.workDate, initial.ownerUserId, initial.id).first<{ id: number }>();
    if (existing) throw new EquipmentReportError("На выбранную дату уже есть отчёт этого прораба. Выберите другую дату или продолжите заполнение существующего отчёта.", 409, "REPORT_EXISTS", { reportId: existing.id });
  }
  const linked = await db.prepare(`SELECT entry.id, entry.site_id AS siteId, entry.work_date AS workDate,
    entry.deleted_at AS deletedAt FROM equipment_entries entry
    JOIN equipment_report_rows source ON source.approved_entry_id = entry.id
    WHERE source.report_id = ? ORDER BY entry.id FOR UPDATE OF entry`).bind(initial.id)
    .all<{ id: number; siteId: number; workDate: string; deletedAt: string | null }>();
  const current = await readReport(db, initial.id);
  const source = (await reportRowsStatement(db, [initial.id], false).all<EquipmentReportRow>()).results;
  if (linked.results.some(entry => entry.deletedAt || entry.siteId !== initial.siteId || entry.workDate !== initial.workDate)
    || current.status === "approved" && (source.length !== current.rows.length || source.some(row => !row.approvedEntryId) || linked.results.length !== source.length)
    || current.status !== "approved" && linked.results.length) {
    throw new EquipmentReportError("Подтверждённые записи отчёта уже изменены. Обновите таблицу перед переносом.", 409, "STALE_REPORT");
  }
  const normalized = normalizeEquipmentReportRows(current.rows);
  const equipmentIds = [...new Set(normalized.flatMap(row => row.equipmentId ? [row.equipmentId] : []))];
  const names = new Map(current.rows.flatMap(row => row.equipmentId ? [[row.equipmentId, row.equipmentName] as const] : []));
  await lockEquipmentReportDates(db, [initial.workDate, payload.workDate], equipmentIds);
  if (current.status === "approved" || current.status === "submitted") {
    await checkHours(db, current.siteId, payload.workDate, completeEquipmentReportRows(normalized), false, names,
      linked.results.map(entry => entry.id));
  } else {
    // An incomplete draft stays incomplete, but an unavailable assigned unit is
    // still explained before its date is changed.
    const issues = await availabilityIssues(db, current.siteId, payload.workDate, normalized, names);
    if (issues.length) throw new EquipmentReportError(issues.map(issue => issue.message).join("\n"), 409, "EQUIPMENT_UNAVAILABLE", { issues });
  }
  if (current.status === "approved" && linked.results.length) {
    await db.prepare(`UPDATE equipment_entries SET work_date = ?, updated_by_user_id = ?,
      updated_at = clock_timestamp(), revision = revision + 1 WHERE id = ANY(?) AND deleted_at IS NULL RETURNING id`)
      .bind(payload.workDate, user.id, linked.results.map(entry => entry.id)).run();
  }
  await db.prepare(`UPDATE equipment_reports SET work_date = ?, revision = revision + 1,
    updated_by_user_id = ?, updated_at = clock_timestamp() WHERE id = ? RETURNING id`)
    .bind(payload.workDate, user.id, current.id).run();
  await db.prepare("UPDATE equipment_report_rows SET updated_at = clock_timestamp() WHERE report_id = ?").bind(current.id).run();
  if (current.status === "approved") await updateEquipmentReportDay(db, user, current.siteId, initial.workDate, payload.workDate);
  return readReport(db, current.id);
}

/** Move old published rows without recreating identity or historical snapshots. */
export async function changeEquipmentReportEntryDate(database: PostgresDatabase, user: AuthUser, payload: EquipmentReportEntryDateRequest): Promise<EquipmentReportApprovedEntry> {
  if (user.role === "viewer" || !canReviewEquipmentReport(user)) throw new EquipmentReportError("Исправлять подтверждённые записи может только инженер.", 403, "REPORT_FORBIDDEN");
  assertEquipmentDate(payload.workDate);
  if (!positiveId(payload.entryId) || !positiveId(payload.siteId)) throw new EquipmentReportError("Укажите запись и проект отчёта.");
  return database.transaction(async db => {
    await assertActiveSite(db, user, payload.siteId);
    const previous = await db.prepare(`SELECT entry.id, entry.site_id AS siteId, entry.work_date AS workDate,
      entry.equipment_id AS equipmentId, entry.revision, source.report_id AS reportId FROM equipment_entries entry
      LEFT JOIN equipment_report_rows source ON source.approved_entry_id = entry.id
      WHERE entry.id = ? AND entry.deleted_at IS NULL ORDER BY entry.id FOR UPDATE OF entry`).bind(payload.entryId)
      .first<{ id: number; siteId: number; workDate: string; equipmentId: number; revision: number; reportId: number | null }>();
    if (!previous || previous.siteId !== payload.siteId) throw new EquipmentReportError("Запись уже изменена. Обновите таблицу.", 409, "STALE_REPORT");
    if (previous.reportId) throw new EquipmentReportError("Запись относится к отчёту. Измените дату отчёта целиком.", 409, "STALE_REPORT");
    assertEquipmentReportRevision(previous.revision, payload.revision);
    const original = (await listEquipmentReports(db, user, payload.siteId, previous.workDate, previous.workDate)).entries.find(entry => entry.id === previous.id);
    if (!original) throw new EquipmentReportError("Запись уже изменена. Обновите таблицу.", 409, "STALE_REPORT");
    if (previous.workDate === payload.workDate) return original;
    await lockEquipmentReportDates(db, [previous.workDate, payload.workDate], [previous.equipmentId]);
    const rows = completeEquipmentReportRows(normalizeEquipmentReportRows([original]));
    await checkHours(db, payload.siteId, payload.workDate, rows, false, new Map([[original.equipmentId, original.equipmentName]]), [previous.id]);
    await db.prepare(`UPDATE equipment_entries SET work_date = ?, updated_by_user_id = ?,
      updated_at = clock_timestamp(), revision = revision + 1 WHERE id = ? AND deleted_at IS NULL RETURNING id`)
      .bind(payload.workDate, user.id, previous.id).run();
    await updateEquipmentReportDay(db, user, payload.siteId, previous.workDate, payload.workDate);
    const entry = (await listEquipmentReports(db, user, payload.siteId, payload.workDate, payload.workDate)).entries.find(entry => entry.id === previous.id);
    if (!entry) throw new Error("Не удалось загрузить перенесённую запись.");
    return entry;
  });
}

export async function mutateEquipmentReport(database: PostgresDatabase, user: AuthUser, payload: Exclude<EquipmentReportRequest, EquipmentReportEntrySaveRequest | EquipmentReportValidationRequest | EquipmentReportEntryDateRequest>): Promise<EquipmentReport> {
  if (user.role === "viewer") throw new EquipmentReportError("Роль «Просмотр» не может изменять отчёты.", 403, "REPORT_FORBIDDEN");
  return database.transaction(async (db) => {
    if (payload.action === "change-date") return changeEquipmentReportDate(db, user, payload);
    if (payload.action === "save") {
      if (!positiveId(payload.siteId) || !validEquipmentReportDate(payload.workDate)) throw new EquipmentReportError("Укажите проект и корректную дату отчёта.");
      await assertActiveSite(db, user, payload.siteId);
      const rows = normalizeEquipmentReportRows(payload.rows);
      const importOrder = payload.importEquipmentOrder;
      if (importOrder !== undefined) {
        if (!Array.isArray(importOrder) || importOrder.length > 5000 || importOrder.some(id => !positiveId(id)) || new Set(importOrder).size !== importOrder.length) {
          throw new EquipmentReportError("Порядок импорта должен содержать не более 5000 уникальных единиц техники.", 400, "INVALID_IMPORT_ORDER");
        }
        const assigned = await db.prepare(`SELECT equipment.id FROM equipment_units equipment
          WHERE equipment.id = ANY(?) AND equipment.active = 1 AND EXISTS (
            SELECT 1 FROM equipment_project_assignments assignment
            WHERE assignment.equipment_id = equipment.id AND assignment.site_id = ? AND assignment.active = 1
          )`).bind(importOrder, payload.siteId).all<{ id: number }>();
        if (assigned.results.length !== importOrder.length) throw new EquipmentReportError("Одна из единиц техники порядка импорта не назначена на этот проект или архивирована.", 400, "INVALID_IMPORT_ORDER");
      }
      let snapshots: RowSnapshots[] = [];
      let reportId = payload.reportId;
      let previousRows: EquipmentReportRow[] = [];
      let approvedReport: EquipmentReport | undefined;
      if (reportId !== undefined) {
        if (!positiveId(reportId)) throw new EquipmentReportError("Некорректный отчёт.");
        await db.prepare("SELECT id FROM equipment_reports WHERE id = ? FOR UPDATE").bind(reportId).first();
        // Lock published rows before reading their versions, using the same
        // entry-then-hours lock order as the legacy equipment API.
        await db.prepare(`SELECT entry.id FROM equipment_entries entry JOIN equipment_report_rows source ON source.approved_entry_id = entry.id
          WHERE source.report_id = ? ORDER BY entry.id FOR UPDATE OF entry`).bind(reportId).all();
        const current = await readReport(db, reportId);
        assertCanSaveEquipmentReport(user, current);
        assertEquipmentReportRevision(current.revision, payload.revision);
        if (current.siteId !== payload.siteId || current.workDate !== payload.workDate) throw new EquipmentReportError("Нельзя изменить проект или дату существующего отчёта.");
        if (rows.some(row => !row.id) && !user.permissions.equipment_report.create) throw new EquipmentReportError("Нет права добавлять строки отчёта.", 403, "REPORT_FORBIDDEN");
        if (current.rows.some(previous => !rows.some(row => row.id === previous.id)) && !user.permissions.equipment_report.delete) throw new EquipmentReportError("Нет права удалять строки отчёта.", 403, "REPORT_FORBIDDEN");
        previousRows = current.rows;
        const historical = new Map<number, EquipmentReportRow>();
        if (current.status === "approved") rows.forEach((row, index) => {
          const previous = current.rows.find(previous => previous.id === row.id);
          if (previous) historical.set(index, previous);
        });
        snapshots = await validateReferences(db, payload.siteId, rows, historical);
        if (current.status === "submitted" || current.status === "approved") {
          const complete = completeEquipmentReportRows(rows);
          if (current.status === "approved") {
            approvedReport = current;
            for (const row of rows) if (row.id) {
              const previous = current.rows.find(previous => previous.id === row.id);
              if (previous) assertEquipmentReportRevision(previous.approvedEntryRevision!, row.approvedEntryRevision);
            }
          }
          await checkHours(db, current.siteId, current.workDate, complete, current.status === "approved",
            new Map(complete.map((row, index) => [row.equipmentId, snapshots[index].equipmentName])),
            current.status === "approved" ? current.rows.flatMap(row => row.approvedEntryId ? [row.approvedEntryId] : []) : [],
            current.status === "approved" ? current.rows.flatMap(row => row.equipmentId ? [row.equipmentId] : []) : []);
        }
        await db.prepare(`UPDATE equipment_reports SET revision = revision + 1, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id`)
          .bind(user.id, reportId).run();
      } else {
        assertCanSaveEquipmentReport(user);
        snapshots = await validateReferences(db, payload.siteId, rows);
        // Serializes two tabs trying to create the same owner's active report.
        await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`equipment-report:${payload.siteId}:${payload.workDate}:${user.id}`).first();
        const existing = await db.prepare("SELECT id FROM equipment_reports WHERE site_id = ? AND work_date = ? AND owner_user_id = ? AND status <> 'approved'")
          .bind(payload.siteId, payload.workDate, user.id).first<{ id: number }>();
        if (existing) throw new EquipmentReportError("На эту дату уже есть ваш черновик. Откройте его и продолжите заполнение.", 409, "REPORT_EXISTS", { reportId: existing.id });
        const inserted = await db.prepare(`INSERT INTO equipment_reports (site_id, work_date, owner_user_id, created_by_user_id, updated_by_user_id)
          VALUES (?, ?, ?, ?, ?) RETURNING id`).bind(payload.siteId, payload.workDate, user.id, user.id, user.id).first<{ id: number }>();
        if (!inserted) throw new Error("Не удалось создать черновик.");
        reportId = inserted.id;
      }
      if (approvedReport) {
        const removedIds = previousRows.flatMap(previous => !rows.some(row => row.id === previous.id) && previous.approvedEntryId ? [previous.approvedEntryId] : []);
        if (removedIds.length) await db.prepare(`UPDATE equipment_entries SET deleted_at = clock_timestamp(),
          updated_at = clock_timestamp(), updated_by_user_id = ?, revision = revision + 1 WHERE id = ANY(?) RETURNING id`).bind(user.id, removedIds).run();
      }
      await saveDraftRows(db, reportId, rows, snapshots, previousRows);
      if (approvedReport) await publishEquipmentReportRows(db, user, approvedReport);
      if (importOrder?.length) await rememberEquipmentImportOrder(db, "project-equipment", payload.siteId, importOrder);
      return readReport(db, reportId);
    }
    if (!["submit", "approve", "reject", "reopen"].includes(payload.action) || !positiveId(payload.reportId)) throw new EquipmentReportError("Некорректное действие с отчётом.");
    await db.prepare("SELECT id FROM equipment_reports WHERE id = ? FOR UPDATE").bind(payload.reportId).first();
    const current = await readReport(db, payload.reportId);
    assertEquipmentReportOwner(user, current);
    await assertActiveSite(db, user, current.siteId);
    assertEquipmentReportRevision(current.revision, payload.revision);
    if (payload.comment !== undefined && (typeof payload.comment !== "string" || payload.comment.length > 4000)) throw new EquipmentReportError("Некорректный комментарий проверки.");
    const comment = payload.comment?.trim() ?? "";
    const status = nextEquipmentReportStatus(user, current, payload.action, comment);
    if (status === "submitted" || status === "approved") {
      const normalized = normalizeEquipmentReportRows(current.rows);
      const rows = completeEquipmentReportRows(normalized);
      const snapshots = await validateReferences(db, current.siteId, rows);
      await checkHours(db, current.siteId, current.workDate, rows, status === "approved", new Map(rows.map((row, index) => [row.equipmentId, snapshots[index].equipmentName])));
      if (status === "submitted") {
        // Freeze the equipment identity presented to the reviewer.
        await db.batch(current.rows.map((row, index) => db.prepare(`UPDATE equipment_report_rows SET equipment_name_snapshot = ?,
          organization_snapshot = ?, equipment_type_snapshot = ?, brand_snapshot = ?, model_snapshot = ?, registration_number_snapshot = ? WHERE id = ? RETURNING id`)
          .bind(...snapshotValues(snapshots[index]), row.id)));
      } else {
        await publishEquipmentReportRows(db, user, current);
        await db.prepare(`INSERT INTO equipment_report_days (site_id, work_date, submitted_by, submitted_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT (site_id, work_date) DO UPDATE SET
          submitted_by = EXCLUDED.submitted_by, submitted_at = CURRENT_TIMESTAMP RETURNING site_id`)
          .bind(current.siteId, current.workDate, user.id).all();
      }
    }
    const review = status === "approved" || status === "rejected";
    await db.prepare(`UPDATE equipment_reports SET status = ?, revision = revision + 1,
      submitted_at = CASE WHEN ? = 'submitted' THEN CURRENT_TIMESTAMP ELSE submitted_at END,
      submitted_by_user_id = CASE WHEN ? = 'submitted' THEN ? ELSE submitted_by_user_id END,
      reviewed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
      reviewed_by_user_id = ?, review_comment = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? RETURNING id`).bind(status, status, status, user.id, review, review ? user.id : null, review ? comment : "", user.id, current.id).run();
    return readReport(db, current.id);
  });
}
