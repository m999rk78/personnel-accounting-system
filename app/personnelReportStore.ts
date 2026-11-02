import type { PostgresDatabase } from "../db/client";
import type { AuthUser } from "./auth";
import type { PersonnelReport, PersonnelReportApprovedEntry, PersonnelReportData, PersonnelReportDateRequest, PersonnelReportEntryDateRequest, PersonnelReportEntrySaveRequest, PersonnelReportRequest, PersonnelReportRow, PersonnelReportRowValidationIssue, PersonnelReportValidationIssue, PersonnelReportValidationRequest, PersonnelReportValidationResult } from "./personnelReportTypes";
import {
  assertCanSavePersonnelReport, assertPersonnelReportHours, assertPersonnelReportOwner,
  assertPersonnelReportRevision, assertPersonnelReportSiteAccess, canReviewPersonnelReport, canViewPendingReportsFor,
  completePersonnelReportRows, nextPersonnelReportStatus, normalizePersonnelReportRows,
  PersonnelReportError, validPersonnelReportDate, personnelReportRowChanged, inspectPersonnelReportRows,
  collectPersonnelReportHourIssues, type NormalizedPersonnelReportRow,
} from "./personnelReportWorkflow";

type Executor = Pick<PostgresDatabase, "prepare" | "batch" | "readBatch">;
type Header = Omit<PersonnelReport, "rows">;
type Employee = { id: number; fullName: string; position: string; employmentType: string; department: string };
type RowSnapshots = { position: string; employeeName: string; employmentType: string; department: string; masterName: string };

// The same additive tables are created by migration 0019 in production. Keeping
// development bootstrap here lets a local-only preview run without migrating a
// configured cloud database from a build script.
let schemaPromise: Promise<void> | null = null;
export async function ensurePersonnelReportSchema(db: PostgresDatabase) {
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_RUNTIME_BOOTSTRAP !== "true") return;
  if (!schemaPromise) {
    schemaPromise = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS personnel_reports (
        id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id), work_date DATE NOT NULL,
        owner_user_id INTEGER NOT NULL REFERENCES app_users(id),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        submitted_at TIMESTAMPTZ, submitted_by_user_id INTEGER REFERENCES app_users(id),
        reviewed_at TIMESTAMPTZ, reviewed_by_user_id INTEGER REFERENCES app_users(id),
        review_comment TEXT NOT NULL DEFAULT '',
        created_by_user_id INTEGER NOT NULL REFERENCES app_users(id), updated_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_personnel_reports_site_date ON personnel_reports(site_id, work_date)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_personnel_reports_review ON personnel_reports(site_id, status, work_date)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_personnel_reports_active_owner_day ON personnel_reports(site_id, work_date, owner_user_id) WHERE status <> 'approved'"),
      db.prepare(`CREATE TABLE IF NOT EXISTS personnel_report_rows (
        id SERIAL PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES personnel_reports(id) ON DELETE CASCADE,
        row_order INTEGER NOT NULL, employee_id INTEGER REFERENCES employees(id), shift_id INTEGER REFERENCES shifts(id),
        zone_id INTEGER REFERENCES zones(id), main_work_type_id INTEGER REFERENCES main_work_types(id),
        subwork_type_id INTEGER REFERENCES subwork_types(id), master_id INTEGER REFERENCES masters(id),
        hours INTEGER CHECK (hours IS NULL OR hours BETWEEN 1 AND 10), note TEXT NOT NULL DEFAULT '',
        position_snapshot TEXT NOT NULL DEFAULT '', employee_name_snapshot TEXT NOT NULL DEFAULT '',
        employment_type_snapshot TEXT NOT NULL DEFAULT '', department_snapshot TEXT NOT NULL DEFAULT '', master_name_snapshot TEXT NOT NULL DEFAULT '',
        approved_entry_id INTEGER REFERENCES placement_entries(id)
      )`),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_personnel_report_rows_order ON personnel_report_rows(report_id, row_order)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_personnel_report_rows_approved_entry ON personnel_report_rows(approved_entry_id)"),
      db.prepare("ALTER TABLE personnel_report_rows ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ"),
      db.prepare("ALTER TABLE personnel_report_rows ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ"),
      db.prepare(`UPDATE personnel_report_rows row SET created_at = COALESCE(row.created_at, report.created_at),
        updated_at = COALESCE(row.updated_at, report.updated_at) FROM personnel_reports report
        WHERE row.report_id = report.id AND (row.created_at IS NULL OR row.updated_at IS NULL)`),
      db.prepare("ALTER TABLE personnel_report_rows ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL"),
    ]).then(() => undefined).catch((error) => { schemaPromise = null; throw error; });
  }
  await schemaPromise;
}

const HEADER_SELECT = `SELECT report.id, report.site_id AS siteId, report.work_date AS workDate,
  report.owner_user_id AS ownerUserId, owner.full_name AS ownerName, report.status, report.revision,
  report.submitted_at AS submittedAt, report.reviewed_at AS reviewedAt, report.reviewed_by_user_id AS reviewedByUserId,
  reviewer.full_name AS reviewedByName, report.review_comment AS reviewComment,
  report.created_at AS createdAt, report.updated_at AS updatedAt
  FROM personnel_reports report JOIN app_users owner ON owner.id = report.owner_user_id
  LEFT JOIN app_users reviewer ON reviewer.id = report.reviewed_by_user_id`;

function reportRowsStatement(db: Executor, reportIds: number[], publishedValues = true) {
  const value = (column: string) => publishedValues ? `CASE WHEN report.status = 'approved' AND published.id IS NOT NULL THEN published.${column} ELSE draft_row.${column} END` : `draft_row.${column}`;
  return db.prepare(`SELECT draft_row.id, draft_row.report_id AS reportId, report.site_id AS siteId, report.work_date AS workDate,
    ${value("employee_id")} AS employeeId, ${value("shift_id")} AS shiftId, ${value("zone_id")} AS zoneId, ${value("main_work_type_id")} AS mainWorkTypeId,
    ${value("subwork_type_id")} AS subworkTypeId, ${value("master_id")} AS masterId, ${value("hours")} AS hours, ${value("note")} AS note,
    ${value("created_at")} AS createdAt, ${value("updated_at")} AS updatedAt, draft_row.row_order AS rowOrder,
    COALESCE(NULLIF(${value("employee_name_snapshot")}, ''), employee.full_name, '') AS employeeName,
    COALESCE(NULLIF(${value("employment_type_snapshot")}, ''), employee.employment_type, '') AS employmentType,
    COALESCE(NULLIF(${value("department_snapshot")}, ''), employee.department, '') AS department,
    COALESCE(NULLIF(${value("position_snapshot")}, ''), employee.position, '') AS positionSnapshot,
    COALESCE(shift.name, '') AS shiftName, COALESCE(zone.name, '') AS zoneName,
    COALESCE(main_work.name, '') AS mainWorkTypeName, COALESCE(subwork.name, '') AS subworkTypeName,
    COALESCE(NULLIF(${value("master_name_snapshot")}, ''), master.name, '') AS masterName, draft_row.approved_entry_id AS approvedEntryId, published.revision AS approvedEntryRevision
    FROM personnel_report_rows draft_row JOIN personnel_reports report ON report.id = draft_row.report_id
    LEFT JOIN placement_entries published ON published.id = draft_row.approved_entry_id
    LEFT JOIN employees employee ON employee.id = ${value("employee_id")}
    LEFT JOIN shifts shift ON shift.id = ${value("shift_id")} LEFT JOIN zones zone ON zone.id = ${value("zone_id")}
    LEFT JOIN main_work_types main_work ON main_work.id = ${value("main_work_type_id")}
    LEFT JOIN subwork_types subwork ON subwork.id = ${value("subwork_type_id")} LEFT JOIN masters master ON master.id = ${value("master_id")}
    WHERE draft_row.report_id = ANY(?) ${publishedValues ? "AND (report.status <> 'approved' OR published.deleted_at IS NULL AND published.id IS NOT NULL)" : ""} ORDER BY report.work_date DESC, report.id DESC, draft_row.row_order, draft_row.id LIMIT 20001`).bind(reportIds);
}

async function readReport(db: Executor, id: number): Promise<PersonnelReport> {
  const header = await db.prepare(`${HEADER_SELECT} WHERE report.id = ?`).bind(id).first<Header>();
  if (!header) throw new PersonnelReportError("Отчёт не найден.", 404, "REPORT_NOT_FOUND");
  const rows = await reportRowsStatement(db, [id]).all<PersonnelReportRow>();
  return { ...header, rows: rows.results };
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

async function assertActiveSite(db: Executor, user: AuthUser, siteId: number) {
  assertPersonnelReportSiteAccess(user, siteId);
  if (!await db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(siteId).first()) {
    throw new PersonnelReportError("Проект не найден.", 404, "SITE_NOT_FOUND");
  }
}

export async function listPersonnelReports(db: Executor, user: AuthUser, siteId: number, from: string | null, to: string | null): Promise<PersonnelReportData> {
  await assertActiveSite(db, user, siteId);
  if ((from !== null && !validPersonnelReportDate(from)) || (to !== null && !validPersonnelReportDate(to)) || (from && to && from > to)) {
    throw new PersonnelReportError("Укажите корректный период отчёта.");
  }
  const rangeFilter = `${from ? " AND report.work_date >= ?" : ""}${to ? " AND report.work_date <= ?" : ""}`;
  const ownFilter = user.role === "foreman" ? " AND report.owner_user_id = ?" : "";
  const hidePending = !canViewPendingReportsFor(user);
  const statusFilter = hidePending ? " AND report.status = 'approved'" : "";
  const parameters = [siteId, ...(from ? [from] : []), ...(to ? [to] : []), ...(user.role === "foreman" ? [user.id] : [])];
  const headers = await db.prepare(`${HEADER_SELECT} WHERE report.site_id = ? ${rangeFilter} ${ownFilter} ${statusFilter}
    ORDER BY report.work_date DESC, report.id DESC LIMIT 5001`).bind(...parameters).all<Header>();
  const visibleHeaders = hidePending ? headers.results.filter(report => report.status === "approved") : headers.results;
  if (visibleHeaders.length > 5000) throw new PersonnelReportError("В выбранном периоде слишком много отчётов. Сузьте период.", 413, "REPORT_RANGE_TOO_LARGE");
  const entryFilter = `${from ? " AND entry.work_date >= ?" : ""}${to ? " AND entry.work_date <= ?" : ""}${user.role === "foreman" ? " AND entry.responsible_user_id = ?" : ""}`;
  const entries = await db.prepare(`SELECT entry.id, entry.site_id AS siteId, entry.work_date AS workDate,
    entry.employee_id AS employeeId, entry.shift_id AS shiftId, entry.zone_id AS zoneId,
    entry.main_work_type_id AS mainWorkTypeId, entry.subwork_type_id AS subworkTypeId, entry.master_id AS masterId,
    entry.hours, entry.note, entry.revision, entry.responsible_user_id AS responsibleUserId, responsible.full_name AS responsibleUserName,
    entry.created_at AS createdAt, entry.updated_at AS updatedAt, COALESCE(origin.row_order, 0) AS rowOrder,
    origin.id AS orderRowId, origin.report_id AS orderReportId,
    COALESCE(NULLIF(entry.employee_name_snapshot, ''), employee.full_name) AS employeeName,
    COALESCE(NULLIF(entry.employment_type_snapshot, ''), employee.employment_type) AS employmentType,
    COALESCE(NULLIF(entry.department_snapshot, ''), employee.department) AS department, entry.position_snapshot AS positionSnapshot,
    shift.name AS shiftName, zone.name AS zoneName, main_work.name AS mainWorkTypeName, subwork.name AS subworkTypeName,
    COALESCE(NULLIF(entry.master_name_snapshot, ''), master.name) AS masterName
    FROM placement_entries entry JOIN employees employee ON employee.id = entry.employee_id
    JOIN shifts shift ON shift.id = entry.shift_id JOIN zones zone ON zone.id = entry.zone_id
    JOIN main_work_types main_work ON main_work.id = entry.main_work_type_id
    JOIN subwork_types subwork ON subwork.id = entry.subwork_type_id JOIN masters master ON master.id = entry.master_id
    LEFT JOIN app_users responsible ON responsible.id = entry.responsible_user_id
    LEFT JOIN personnel_report_rows origin ON origin.approved_entry_id = entry.id
    WHERE entry.site_id = ? AND entry.deleted_at IS NULL
      AND UPPER(TRIM(COALESCE(NULLIF(entry.employment_type_snapshot, ''), employee.employment_type))) = 'ОПР' ${entryFilter}
    ORDER BY entry.created_at DESC, origin.row_order, entry.id DESC LIMIT 20001`)
    .bind(...parameters).all<PersonnelReportApprovedEntry>();
  if (entries.results.length > 20000) throw new PersonnelReportError("В выбранном периоде больше 20 000 строк. Сузьте период.", 413, "REPORT_RANGE_TOO_LARGE");
  const rows = visibleHeaders.length ? await reportRowsStatement(db, visibleHeaders.map((report) => report.id)).all<PersonnelReportRow>() : { results: [] as PersonnelReportRow[] };
  if (rows.results.length > 20000) throw new PersonnelReportError("В выбранном периоде больше 20 000 строк черновиков. Сузьте период.", 413, "REPORT_RANGE_TOO_LARGE");
  const byReport = new Map<number, PersonnelReportRow[]>();
  for (const row of rows.results) {
    if (!byReport.has(row.reportId)) byReport.set(row.reportId, []);
    byReport.get(row.reportId)!.push(row);
  }
  return { reports: visibleHeaders.map((report) => ({ ...report, ...(hidePending ? { reviewComment: "" } : {}), rows: byReport.get(report.id) ?? [] })), entries: entries.results, canReview: canReviewPersonnelReport(user), from, to };
}

async function inspectReferences(db: Executor, siteId: number, rows: NormalizedPersonnelReportRow[], historical: ReadonlyMap<number, PersonnelReportRow> = new Map()) {
  const employeeIds = [...new Set(rows.flatMap((row) => row.employeeId ? [row.employeeId] : []))];
  const employees = await db.prepare(`SELECT employee.id, employee.full_name AS fullName, employee.position,
    employee.employment_type AS employmentType, employee.department FROM employees employee
    WHERE employee.id = ANY(?) AND employee.active = 1 AND EXISTS (
      SELECT 1 FROM employee_project_assignments assignment WHERE assignment.employee_id = employee.id AND assignment.site_id = ? AND assignment.active = 1
    )`).bind(employeeIds, siteId).all<Employee>();
  const byEmployee = new Map(employees.results.map((employee) => [employee.id, employee]));
  const fields = ["shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId", "masterId"] as const;
  const tables = ["shifts", "zones", "main_work_types", "subwork_types", "masters"] as const;
  const results = await db.readBatch(fields.map((field, index) => db.prepare(`SELECT id, name${fields[index] === "subworkTypeId" ? ", main_work_type_id AS mainWorkTypeId" : ""} FROM ${tables[index]}
    WHERE site_id = ? AND active = 1 AND id = ANY(?)`).bind(siteId, [...new Set(rows.flatMap((row) => row[field] ? [row[field]] : []))])));
  const references = results.map((result) => new Map((result.results as Array<{ id: number; name: string }>).map((entry) => [entry.id, entry.name])));
  const subworkParents = new Map((results[3].results as Array<{ id: number; mainWorkTypeId: number | null }>).map(child => [child.id, child.mainWorkTypeId]));
  const issues: PersonnelReportRowValidationIssue[] = [];
  const snapshots = rows.map((row, index) => {
    const previous = historical.get(index);
    const sameEmployee = Boolean(previous?.employeeId && previous.employeeId === row.employeeId);
    const sameMaster = Boolean(previous?.masterId && previous.masterId === row.masterId);
    const sameWorkPair = Boolean(previous?.mainWorkTypeId && previous.mainWorkTypeId === row.mainWorkTypeId && previous.subworkTypeId === row.subworkTypeId);
    const employee = row.employeeId ? byEmployee.get(row.employeeId) : null;
    const add = (code: string, message: string) => issues.push({ code, message: `Строка ${index + 1}: ${message}`, rowNumbers: [index + 1], ...(row.employeeId ? { employeeId: row.employeeId } : {}), ...(employee ? { employeeName: employee.fullName } : {}) });
    if (row.subworkTypeId && !sameWorkPair && (!row.mainWorkTypeId || subworkParents.get(row.subworkTypeId) !== row.mainWorkTypeId)) add("INVALID_WORK_HIERARCHY", "подвид не относится к выбранному виду работы.");
    if (row.employeeId && !sameEmployee && (!employee || !employee.position || employee.employmentType.trim().toLocaleUpperCase("ru-RU") !== "ОПР")) {
      add("INVALID_EMPLOYEE", "выберите действующего сотрудника ОПР с должностью, назначенного на проект.");
    }
    const labels = ["Смена", "Зона", "Вид работы", "Подвид работы", "Мастер"];
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      const id = row[fields[fieldIndex]];
      const unchanged = fields[fieldIndex] === "subworkTypeId" ? sameWorkPair : Boolean(previous?.[fields[fieldIndex]] && previous[fields[fieldIndex]] === id);
      if (id && !references[fieldIndex].has(id) && !unchanged) add("INVALID_REFERENCE", `значение поля «${labels[fieldIndex]}» отсутствует в справочнике проекта.`);
    }
    return { position: sameEmployee ? previous!.positionSnapshot : employee?.position ?? "", employeeName: sameEmployee ? previous!.employeeName : employee?.fullName ?? "",
      employmentType: sameEmployee ? previous!.employmentType : employee?.employmentType ?? "", department: sameEmployee ? previous!.department : employee?.department ?? "",
      masterName: sameMaster ? previous!.masterName : row.masterId ? references[4].get(row.masterId) ?? "" : "" };
  });
  return { snapshots, issues };
}

async function validateReferences(db: Executor, siteId: number, rows: NormalizedPersonnelReportRow[], historical: ReadonlyMap<number, PersonnelReportRow> = new Map()): Promise<RowSnapshots[]> {
  const result = await inspectReferences(db, siteId, rows, historical);
  if (result.issues.length) throw new PersonnelReportError(result.issues[0].message, 400, result.issues[0].code, { issues: result.issues });
  return result.snapshots;
}

async function approvedHoursForDate(db: Executor, workDate: string, employeeIds: number[], excludedIds: number[] = []) {
  const approved = await db.prepare(`SELECT entry.employee_id AS employeeId, SUM(entry.hours)::int AS hours FROM placement_entries entry
    JOIN employees employee ON employee.id = entry.employee_id
    WHERE entry.work_date = ? AND entry.deleted_at IS NULL
      AND UPPER(TRIM(COALESCE(NULLIF(entry.employment_type_snapshot, ''), employee.employment_type))) = 'ОПР'
      AND entry.employee_id = ANY(?) AND NOT (entry.id = ANY(?))
    GROUP BY entry.employee_id`).bind(workDate, employeeIds, excludedIds).all<{ employeeId: number; hours: number }>();
  return new Map(approved.results.map(entry => [entry.employeeId, entry.hours]));
}

async function checkHours(db: Executor, workDate: string, rows: ReturnType<typeof completePersonnelReportRows>, lock: boolean, names: ReadonlyMap<number, string>, excludedIds: number[] = [], previousEmployeeIds: number[] = []) {
  const employeeIds = [...new Set(rows.map((row) => row.employeeId))];
  if (lock) for (const key of [...new Set([...employeeIds, ...previousEmployeeIds])].map((id) => `${workDate}:${id}`).sort()) {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`placement-hours:${key}`).first();
  }
  assertPersonnelReportHours(rows, await approvedHoursForDate(db, workDate, employeeIds, excludedIds), names);
}

/** A read-only preview; authoritative mutations always run the same final guards again. */
export async function validatePersonnelReportSubmissions(db: Executor, user: AuthUser, payload: PersonnelReportValidationRequest): Promise<PersonnelReportValidationResult> {
  if (user.role === "viewer") throw new PersonnelReportError("Роль «Просмотр» не может изменять отчёты.", 403, "REPORT_FORBIDDEN");
  if (!positiveId(payload.siteId) || !Array.isArray(payload.reports) || !payload.reports.length || payload.reports.length > 100) throw new PersonnelReportError("Укажите проект и от 1 до 100 отчётов для проверки.");
  const keys = new Set<string>(); const reportIds = new Set<number>(); const newDates = new Set<string>();
  let total = 0;
  for (const target of payload.reports) {
    if (!target || typeof target !== "object" || typeof target.key !== "string" || !target.key.trim() || target.key.length > 200 || keys.has(target.key) || !validPersonnelReportDate(target.workDate) || !Array.isArray(target.rows) || target.rows.length > 1000) throw new PersonnelReportError("Некорректные даты, ключи или строки проверяемых отчётов.");
    keys.add(target.key); total += target.rows.length;
    if (target.reportId !== undefined) {
      if (!positiveId(target.reportId) || reportIds.has(target.reportId)) throw new PersonnelReportError("Один отчёт указан повторно или имеет некорректный идентификатор.");
      reportIds.add(target.reportId);
    } else {
      if (newDates.has(target.workDate)) throw new PersonnelReportError("Для одной даты указан более чем один новый отчёт.");
      newDates.add(target.workDate);
    }
  }
  if (total > 5000) throw new PersonnelReportError("Проверьте не более 5000 строк за один раз.", 413, "REPORT_TOO_LARGE");
  await assertActiveSite(db, user, payload.siteId);
  if (!user.permissions.workers_report.update) throw new PersonnelReportError("Нет права отправлять отчёты на проверку.", 403, "REPORT_FORBIDDEN");
  const existing = reportIds.size ? await db.prepare(`${HEADER_SELECT} WHERE report.id = ANY(?)`).bind([...reportIds]).all<Header>() : { results: [] as Header[] };
  // Authorise the entire batch before returning any reference, revision or hour details.
  for (const current of existing.results) {
    assertPersonnelReportOwner(user, current);
    if (current.siteId !== payload.siteId) throw new PersonnelReportError("Отчёт не относится к выбранному проекту.", 403, "REPORT_FORBIDDEN");
  }
  if (newDates.size && !user.permissions.workers_report.create) throw new PersonnelReportError("Нет права создавать отчёты.", 403, "REPORT_FORBIDDEN");
  const currentById = new Map<number, PersonnelReport>();
  for (const header of existing.results) currentById.set(header.id, await readReport(db, header.id));
  const active = newDates.size ? await db.prepare(`SELECT id, work_date AS workDate FROM personnel_reports
    WHERE site_id = ? AND owner_user_id = ? AND status <> 'approved' AND work_date = ANY(?)`)
    .bind(payload.siteId, user.id, [...newDates]).all<{ id: number; workDate: string }>() : { results: [] as Array<{ id: number; workDate: string }> };
  const issues: PersonnelReportValidationIssue[] = [];
  const normalized: Array<{ target: PersonnelReportValidationRequest["reports"][number]; rows: NormalizedPersonnelReportRow[]; current?: PersonnelReport; offset: number }> = [];
  const flattened: NormalizedPersonnelReportRow[] = [];
  const issueFromError = (target: PersonnelReportValidationRequest["reports"][number], error: unknown) => {
    if (!(error instanceof PersonnelReportError)) throw error;
    if (error.status === 403) throw error;
    issues.push({ key: target.key, workDate: target.workDate, code: error.code, message: error.message });
  };
  for (const target of payload.reports) {
    const current = target.reportId ? currentById.get(target.reportId) : undefined;
    const inspected = inspectPersonnelReportRows(target.rows);
    const rows = inspected.rows;
    if (current) {
      if (rows.some(row => !row.id) && !user.permissions.workers_report.create) throw new PersonnelReportError("Нет права добавлять строки отчёта.", 403, "REPORT_FORBIDDEN");
      if (current.rows.some(previous => !rows.some(row => row.id === previous.id)) && !user.permissions.workers_report.delete) throw new PersonnelReportError("Нет права удалять строки отчёта.", 403, "REPORT_FORBIDDEN");
      if (current.workDate !== target.workDate) issues.push({ key: target.key, workDate: target.workDate, code: "REPORT_DATE_MISMATCH", message: "Нельзя изменить дату существующего отчёта." });
      try { assertPersonnelReportRevision(current.revision, target.revision); } catch (error) { issueFromError(target, error); }
      try { nextPersonnelReportStatus(user, current, "submit"); } catch (error) { issueFromError(target, error); }
    } else if (target.reportId) issues.push({ key: target.key, workDate: target.workDate, code: "REPORT_NOT_FOUND", message: "Отчёт не найден. Обновите таблицу." });
    else if (active.results.some(report => report.workDate === target.workDate)) issues.push({ key: target.key, workDate: target.workDate, code: "REPORT_EXISTS", message: "На эту дату уже есть ваш черновик. Обновите таблицу и продолжите его заполнение." });
    for (const issue of inspected.issues) issues.push({ ...issue, key: target.key, workDate: target.workDate });
    const retained = new Set<number>();
    rows.forEach((row, index) => {
      if (row.id && (retained.has(row.id) || !current?.rows.some(previous => previous.id === row.id))) issues.push({ key: target.key, workDate: target.workDate, rowNumbers: [index + 1], code: "INVALID_REPORT_ROW", message: `Строка ${index + 1}: строка не принадлежит этому отчёту или указана повторно.` });
      if (row.id) retained.add(row.id);
      if (current?.status === "approved" && row.id) {
        const previous = current.rows.find(previous => previous.id === row.id);
        if (previous) try { assertPersonnelReportRevision(previous.approvedEntryRevision!, row.approvedEntryRevision); } catch (error) {
          if (!(error instanceof PersonnelReportError)) throw error;
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
    const dateRows = dateReports.flatMap(item => item.rows.flatMap((row, index) => row.employeeId && row.hours ? [{ item, index, employeeId: row.employeeId, hours: row.hours }] : []));
    const excludedIds = dateReports.flatMap(item => item.current?.status === "approved" && item.current.workDate === date ? item.current.rows.flatMap(row => row.approvedEntryId ? [row.approvedEntryId] : []) : []);
    const approved = await approvedHoursForDate(db, date, [...new Set(dateRows.map(row => row.employeeId))], excludedIds);
    const names = new Map(dateRows.map(row => [row.employeeId, references.snapshots[row.item.offset + row.index].employeeName]));
    const conflicts = collectPersonnelReportHourIssues(dateRows, approved, names);
    for (const conflict of conflicts) for (const item of dateReports) {
      const rowNumbers = dateRows.filter(row => row.item === item && row.employeeId === conflict.employeeId).map(row => row.index + 1);
      if (rowNumbers.length) issues.push({ ...conflict, key: item.target.key, workDate: date, rowNumbers });
    }
  }
  return { issues };
}

async function saveDraftRows(db: Executor, reportId: number, rows: NormalizedPersonnelReportRow[], snapshots: RowSnapshots[], previous: PersonnelReportRow[]) {
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const retainedIds = rows.flatMap((row) => row.id ? [row.id] : []);
  if (new Set(retainedIds).size !== retainedIds.length || retainedIds.some((id) => !previousById.has(id))) {
    throw new PersonnelReportError("Строка не принадлежит этому отчёту или указана повторно. Обновите таблицу.", 409, "INVALID_REPORT_ROW");
  }
  await db.prepare("DELETE FROM personnel_report_rows WHERE report_id = ? AND NOT (id = ANY(?))").bind(reportId, retainedIds).run();
  // Free the positive order slots before reordering the surviving rows.
  await db.prepare("UPDATE personnel_report_rows SET row_order = -id WHERE report_id = ?").bind(reportId).run();
  const stamp = await db.prepare("SELECT clock_timestamp() AS changedAt").first<{ changedAt: string }>();
  if (!stamp) throw new Error("Не удалось определить время сохранения.");
  for (let offset = 0; offset < rows.length; offset += 100) {
    await db.batch(rows.slice(offset, offset + 100).map((row, index) => {
      const snapshot = snapshots[offset + index];
      if (row.id) {
        const previous = previousById.get(row.id)!;
        const changed = personnelReportRowChanged(previous, row) || snapshotsChanged(previous, snapshot);
        return db.prepare(`UPDATE personnel_report_rows SET row_order = ?, employee_id = ?, shift_id = ?, zone_id = ?,
          main_work_type_id = ?, subwork_type_id = ?, master_id = ?, hours = ?, note = ?, position_snapshot = ?, employee_name_snapshot = ?,
          employment_type_snapshot = ?, department_snapshot = ?, master_name_snapshot = ?,
          updated_at = CASE WHEN ? THEN ?::timestamptz ELSE updated_at END WHERE report_id = ? AND id = ? RETURNING id`)
          .bind(offset + index, row.employeeId, row.shiftId, row.zoneId, row.mainWorkTypeId, row.subworkTypeId,
            row.masterId, row.hours, row.note, snapshot.position, snapshot.employeeName, snapshot.employmentType, snapshot.department,
            snapshot.masterName, changed, stamp.changedAt, reportId, row.id);
      }
      return db.prepare(`INSERT INTO personnel_report_rows (report_id, row_order, employee_id, shift_id, zone_id,
        main_work_type_id, subwork_type_id, master_id, hours, note, position_snapshot, employee_name_snapshot,
        employment_type_snapshot, department_snapshot, master_name_snapshot, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .bind(reportId, offset + index, row.employeeId, row.shiftId, row.zoneId, row.mainWorkTypeId, row.subworkTypeId,
          row.masterId, row.hours, row.note, snapshot.position, snapshot.employeeName, snapshot.employmentType, snapshot.department, snapshot.masterName, stamp.changedAt, stamp.changedAt);
    }));
  }
}

function snapshotsChanged(row: PersonnelReportRow, snapshot: RowSnapshots) {
  return row.positionSnapshot !== snapshot.position || row.employeeName !== snapshot.employeeName || row.employmentType !== snapshot.employmentType || row.department !== snapshot.department || row.masterName !== snapshot.masterName;
}

async function updatePublishedEntry(db: Executor, user: AuthUser, entryId: number, row: NormalizedPersonnelReportRow, snapshot: RowSnapshots) {
  await db.prepare(`UPDATE placement_entries SET employee_id = ?, shift_id = ?, zone_id = ?, main_work_type_id = ?,
    subwork_type_id = ?, master_id = ?, hours = ?, note = ?, position_snapshot = ?, employee_name_snapshot = ?,
    employment_type_snapshot = ?, department_snapshot = ?, master_name_snapshot = ?, updated_by_user_id = ?,
    updated_at = clock_timestamp(), revision = revision + 1 WHERE id = ? AND deleted_at IS NULL RETURNING id`)
    .bind(row.employeeId, row.shiftId, row.zoneId, row.mainWorkTypeId, row.subworkTypeId, row.masterId, row.hours, row.note,
      snapshot.position, snapshot.employeeName, snapshot.employmentType, snapshot.department, snapshot.masterName, user.id, entryId).run();
}

/** Publish new rows, or correct existing entries in place. Ownership and entry IDs stay intact. */
async function publishPersonnelReportRows(db: Executor, user: AuthUser, report: PersonnelReport) {
  const source = await reportRowsStatement(db, [report.id], false).all<PersonnelReportRow>();
  for (const row of source.results) {
    const snapshot = { position: row.positionSnapshot, employeeName: row.employeeName, employmentType: row.employmentType, department: row.department, masterName: row.masterName };
    if (row.approvedEntryId) {
      const previous = report.rows.find(previous => previous.id === row.id);
      if (!previous || personnelReportRowChanged(previous, row) || snapshotsChanged(previous, snapshot)) await updatePublishedEntry(db, user, row.approvedEntryId, row, snapshot);
    } else {
      const entry = await db.prepare(`INSERT INTO placement_entries
        (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours,
        position_snapshot, employee_name_snapshot, employment_type_snapshot, department_snapshot, master_name_snapshot,
        created_by, responsible_user_id, created_by_user_id, updated_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .bind(report.siteId, report.workDate, row.employeeId, row.shiftId, row.zoneId, row.mainWorkTypeId, row.subworkTypeId,
          row.note, row.masterId, row.hours, row.positionSnapshot, row.employeeName, row.employmentType, row.department,
          row.masterName, report.ownerName, report.ownerUserId, report.ownerUserId, user.id, row.createdAt, row.updatedAt).first<{ id: number }>();
      if (!entry) throw new Error("Не удалось опубликовать строку отчёта.");
      await db.prepare("UPDATE personnel_report_rows SET approved_entry_id = ? WHERE id = ? RETURNING id").bind(entry.id, row.id).run();
    }
  }
}

function assertPersonnelDateChange(value: unknown) {
  if (!validPersonnelReportDate(value) || value.startsWith("0000-")) {
    throw new PersonnelReportError("Укажите корректную дату отчёта.");
  }
}

async function lockPersonnelDateHours(db: Executor, from: string, to: string, employeeIds: number[]) {
  const keys = [...new Set([from, to].flatMap(date => employeeIds.map(id => `${date}:${id}`)))].sort();
  for (const key of keys) await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`placement-hours:${key}`).first();
}

async function movePersonnelPublishedDay(db: Executor, user: AuthUser, siteId: number, from: string, to: string) {
  // Different owners can transfer different employees in opposite directions.
  // Lock their shared day markers in the same order before either row is written.
  for (const date of [...new Set([from, to])].sort()) {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`personnel-published-day:${siteId}:${date}`).first();
  }
  await db.prepare(`INSERT INTO placement_report_days (site_id, work_date, submitted_by, submitted_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT (site_id, work_date) DO UPDATE SET
    submitted_by = EXCLUDED.submitted_by, submitted_at = CURRENT_TIMESTAMP RETURNING site_id`)
    .bind(siteId, to, user.id).all();
  // Another foreman's report or an older standalone entry can still use the
  // original day. Their submission marker must survive this transfer.
  await db.prepare(`DELETE FROM placement_report_days day WHERE day.site_id = ? AND day.work_date = ?
    AND NOT EXISTS (SELECT 1 FROM placement_entries entry WHERE entry.site_id = day.site_id
      AND entry.work_date = day.work_date AND entry.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM personnel_reports report WHERE report.site_id = day.site_id
      AND report.work_date = day.work_date AND report.status = 'approved')`)
    .bind(siteId, from).run();
}

/** A date belongs to the daily report: keep its identity and move all rows atomically. */
export async function mutatePersonnelReportDate(database: PostgresDatabase, user: AuthUser, payload: PersonnelReportDateRequest): Promise<PersonnelReport> {
  if (user.role === "viewer") throw new PersonnelReportError("Роль «Просмотр» не может изменять отчёты.", 403, "REPORT_FORBIDDEN");
  if (payload.action !== "change-date" || !positiveId(payload.reportId)) throw new PersonnelReportError("Укажите отчёт.");
  assertPersonnelDateChange(payload.workDate);
  return database.transaction(async db => {
    await db.prepare("SELECT id FROM personnel_reports WHERE id = ? FOR UPDATE").bind(payload.reportId).first();
    // Match the save/approval lock order: report, published rows, hour keys.
    const published = await db.prepare(`SELECT entry.id, entry.site_id AS siteId, entry.work_date AS workDate,
      entry.employee_id AS employeeId, entry.hours, entry.revision, entry.deleted_at AS deletedAt,
      source.id AS reportRowId FROM placement_entries entry
      JOIN personnel_report_rows source ON source.approved_entry_id = entry.id
      WHERE source.report_id = ? ORDER BY entry.id FOR UPDATE OF entry`).bind(payload.reportId)
      .all<{ id: number; siteId: number; workDate: string; employeeId: number; hours: number; revision: number; deletedAt: string | null; reportRowId: number }>();
    const current = await readReport(db, payload.reportId);
    assertCanSavePersonnelReport(user, current);
    await assertActiveSite(db, user, current.siteId);
    assertPersonnelReportRevision(current.revision, payload.revision);
    if (current.workDate === payload.workDate) return current;
    for (const key of [...new Set([current.workDate, payload.workDate])].map(date => `personnel-report:${current.siteId}:${date}:${current.ownerUserId}`).sort()) {
      await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(key).first();
    }
    if (current.status !== "approved") {
      const existing = await db.prepare(`SELECT id FROM personnel_reports WHERE site_id = ? AND work_date = ?
        AND owner_user_id = ? AND status <> 'approved' AND id <> ?`)
        .bind(current.siteId, payload.workDate, current.ownerUserId, current.id).first<{ id: number }>();
      if (existing) throw new PersonnelReportError("На выбранную дату уже есть незавершённый отчёт этого прораба. Выберите другую дату или продолжите существующий отчёт.", 409, "REPORT_EXISTS", { reportId: existing.id });
    }
    const rawRows = await reportRowsStatement(db, [current.id], false).all<PersonnelReportRow>();
    const publishedById = new Map(published.results.map(entry => [entry.id, entry]));
    if (current.status === "approved") {
      if (rawRows.results.length !== current.rows.length || rawRows.results.some(row => {
        const entry = row.approvedEntryId ? publishedById.get(row.approvedEntryId) : undefined;
        return !entry || entry.deletedAt || entry.siteId !== current.siteId || entry.workDate !== current.workDate || entry.reportRowId !== row.id;
      })) throw new PersonnelReportError("Подтверждённые записи отчёта уже изменены. Обновите таблицу перед переносом.", 409, "STALE_REPORT");
    } else if (published.results.length) throw new PersonnelReportError("Состояние отчёта уже изменено. Обновите таблицу.", 409, "STALE_REPORT");
    if (current.status === "submitted" || current.status === "approved") {
      const rows = completePersonnelReportRows(normalizePersonnelReportRows(current.rows));
      await lockPersonnelDateHours(db, current.workDate, payload.workDate, rows.map(row => row.employeeId));
      await checkHours(db, payload.workDate, rows, false, new Map(current.rows.flatMap(row => row.employeeId ? [[row.employeeId, row.employeeName]] : [])),
        current.status === "approved" ? published.results.map(entry => entry.id) : []);
    }
    if (current.status === "approved") {
      const ids = published.results.map(entry => entry.id);
      const moved = await db.prepare(`UPDATE placement_entries SET work_date = ?, updated_by_user_id = ?,
        updated_at = clock_timestamp(), revision = revision + 1 WHERE id = ANY(?) AND deleted_at IS NULL RETURNING id`)
        .bind(payload.workDate, user.id, ids).all<{ id: number }>();
      if (moved.results.length !== ids.length) throw new PersonnelReportError("Подтверждённые записи отчёта уже изменены. Обновите таблицу.", 409, "STALE_REPORT");
    }
    await db.prepare(`UPDATE personnel_reports SET work_date = ?, revision = revision + 1,
      updated_by_user_id = ?, updated_at = clock_timestamp() WHERE id = ? RETURNING id`)
      .bind(payload.workDate, user.id, current.id).run();
    await db.prepare("UPDATE personnel_report_rows SET updated_at = clock_timestamp() WHERE report_id = ?").bind(current.id).run();
    if (current.status === "approved") await movePersonnelPublishedDay(db, user, current.siteId, current.workDate, payload.workDate);
    return readReport(db, current.id);
  });
}

/** Approved entries created before daily reports retain their own revision and identity. */
export async function mutatePersonnelReportEntryDate(database: PostgresDatabase, user: AuthUser, payload: PersonnelReportEntryDateRequest): Promise<PersonnelReportApprovedEntry> {
  if (user.role === "viewer" || !canReviewPersonnelReport(user)) throw new PersonnelReportError("Изменять дату подтверждённой записи может только инженер.", 403, "REPORT_FORBIDDEN");
  if (payload.action !== "change-entry-date" || !positiveId(payload.entryId) || !positiveId(payload.siteId)) throw new PersonnelReportError("Укажите запись и проект.");
  assertPersonnelDateChange(payload.workDate);
  return database.transaction(async db => {
    await assertActiveSite(db, user, payload.siteId);
    const previous = await db.prepare(`SELECT entry.id, entry.site_id AS siteId, entry.work_date AS workDate,
      entry.employee_id AS employeeId, entry.hours, entry.revision, source.report_id AS reportId,
      COALESCE(NULLIF(entry.employee_name_snapshot, ''), employee.full_name) AS employeeName
      FROM placement_entries entry JOIN employees employee ON employee.id = entry.employee_id
      LEFT JOIN personnel_report_rows source ON source.approved_entry_id = entry.id
      WHERE entry.id = ? AND entry.deleted_at IS NULL
        AND UPPER(TRIM(COALESCE(NULLIF(entry.employment_type_snapshot, ''), employee.employment_type))) = 'ОПР'
      ORDER BY entry.id FOR UPDATE OF entry`).bind(payload.entryId)
      .first<{ id: number; siteId: number; workDate: string; employeeId: number; hours: number; revision: number; reportId: number | null; employeeName: string }>();
    if (!previous) throw new PersonnelReportError("Запись уже удалена. Обновите таблицу.", 409, "STALE_REPORT");
    if (previous.siteId !== payload.siteId) throw new PersonnelReportError("Нельзя изменить проект существующей записи.", 403, "REPORT_FORBIDDEN");
    if (previous.reportId) throw new PersonnelReportError("Запись относится к отчёту. Обновите таблицу и измените дату отчёта целиком.", 409, "STALE_REPORT");
    assertPersonnelReportRevision(previous.revision, payload.revision);
    if (previous.workDate !== payload.workDate) {
      await lockPersonnelDateHours(db, previous.workDate, payload.workDate, [previous.employeeId]);
      const issues = collectPersonnelReportHourIssues([previous], await approvedHoursForDate(db, payload.workDate, [previous.employeeId], [previous.id]), new Map([[previous.employeeId, previous.employeeName]]));
      if (issues.length) throw new PersonnelReportError(issues.map(issue => issue.message).join("\n"), 409, "HOURS_CONFLICT", { ...issues[0], issues });
      await db.prepare(`UPDATE placement_entries SET work_date = ?, updated_by_user_id = ?,
        updated_at = clock_timestamp(), revision = revision + 1 WHERE id = ? AND deleted_at IS NULL RETURNING id`)
        .bind(payload.workDate, user.id, previous.id).run();
      await movePersonnelPublishedDay(db, user, previous.siteId, previous.workDate, payload.workDate);
    }
    const result = await listPersonnelReports(db, user, payload.siteId, payload.workDate, payload.workDate);
    const entry = result.entries.find(entry => entry.id === previous.id);
    if (!entry) throw new Error("Не удалось загрузить исправленную запись.");
    return entry;
  });
}

/** Older approved entries have no draft header. Correct them with their own optimistic revision. */
export async function mutatePersonnelReportEntry(database: PostgresDatabase, user: AuthUser, payload: PersonnelReportEntrySaveRequest): Promise<PersonnelReportApprovedEntry> {
  if (user.role === "viewer") throw new PersonnelReportError("Роль «Просмотр» не может изменять отчёты.", 403, "REPORT_FORBIDDEN");
  return database.transaction(async db => {
    if (!canReviewPersonnelReport(user)) throw new PersonnelReportError("Исправлять подтверждённые записи может только инженер.", 403, "REPORT_FORBIDDEN");
    if (!positiveId(payload.entryId) || !positiveId(payload.siteId) || !validPersonnelReportDate(payload.workDate)) throw new PersonnelReportError("Укажите запись, проект и дату отчёта.");
    await assertActiveSite(db, user, payload.siteId);
    const previous = await db.prepare(`SELECT entry.id, entry.site_id AS siteId, entry.work_date AS workDate, entry.employee_id AS employeeId,
      entry.revision, source.report_id AS reportId FROM placement_entries entry
      JOIN employees employee ON employee.id = entry.employee_id
      LEFT JOIN personnel_report_rows source ON source.approved_entry_id = entry.id
      WHERE entry.id = ? AND entry.deleted_at IS NULL
        AND UPPER(TRIM(COALESCE(NULLIF(entry.employment_type_snapshot, ''), employee.employment_type))) = 'ОПР'
      ORDER BY entry.id FOR UPDATE OF entry`).bind(payload.entryId)
      .first<{ id: number; siteId: number; workDate: string; employeeId: number; revision: number; reportId: number | null }>();
    if (!previous) throw new PersonnelReportError("Запись уже удалена. Обновите таблицу.", 409, "STALE_REPORT");
    if (previous.siteId !== payload.siteId || previous.workDate !== payload.workDate) throw new PersonnelReportError("Нельзя изменить проект или дату существующей записи.");
    if (previous.reportId) throw new PersonnelReportError("Запись относится к отчёту. Обновите таблицу и исправьте отчёт целиком.", 409, "STALE_REPORT");
    assertPersonnelReportRevision(previous.revision, payload.revision);
    const rows = normalizePersonnelReportRows([payload.row]);
    const complete = completePersonnelReportRows(rows);
    const original = (await listPersonnelReports(db, user, payload.siteId, payload.workDate, payload.workDate)).entries.find(entry => entry.id === previous.id);
    if (!original) throw new PersonnelReportError("Запись уже изменена. Обновите таблицу.", 409, "STALE_REPORT");
    const snapshots = await validateReferences(db, payload.siteId, rows, new Map([[0, { ...original, reportId: 0, approvedEntryId: original.id }]]));
    await checkHours(db, payload.workDate, complete, true, new Map([[complete[0].employeeId, snapshots[0].employeeName]]), [previous.id], [previous.employeeId]);
    await updatePublishedEntry(db, user, previous.id, rows[0], snapshots[0]);
    const result = await listPersonnelReports(db, user, payload.siteId, payload.workDate, payload.workDate);
    const entry = result.entries.find(entry => entry.id === previous.id);
    if (!entry) throw new Error("Не удалось загрузить исправленную запись.");
    return entry;
  });
}

export async function mutatePersonnelReport(database: PostgresDatabase, user: AuthUser, payload: Exclude<PersonnelReportRequest, PersonnelReportEntrySaveRequest | PersonnelReportValidationRequest | PersonnelReportDateRequest | PersonnelReportEntryDateRequest>): Promise<PersonnelReport> {
  if (user.role === "viewer") throw new PersonnelReportError("Роль «Просмотр» не может изменять отчёты.", 403, "REPORT_FORBIDDEN");
  return database.transaction(async (db) => {
    if (payload.action === "save") {
      if (!positiveId(payload.siteId) || !validPersonnelReportDate(payload.workDate)) throw new PersonnelReportError("Укажите проект и корректную дату отчёта.");
      await assertActiveSite(db, user, payload.siteId);
      const rows = normalizePersonnelReportRows(payload.rows);
      let snapshots: RowSnapshots[] = [];
      let reportId = payload.reportId;
      let previousRows: PersonnelReportRow[] = [];
      let approvedReport: PersonnelReport | undefined;
      if (reportId !== undefined) {
        if (!positiveId(reportId)) throw new PersonnelReportError("Некорректный отчёт.");
        await db.prepare("SELECT id FROM personnel_reports WHERE id = ? FOR UPDATE").bind(reportId).first();
        // Lock published rows before reading their versions, using the same
        // entry-then-hours lock order as the legacy placement API.
        await db.prepare(`SELECT entry.id FROM placement_entries entry JOIN personnel_report_rows source ON source.approved_entry_id = entry.id
          WHERE source.report_id = ? ORDER BY entry.id FOR UPDATE OF entry`).bind(reportId).all();
        const current = await readReport(db, reportId);
        assertCanSavePersonnelReport(user, current);
        assertPersonnelReportRevision(current.revision, payload.revision);
        if (current.siteId !== payload.siteId || current.workDate !== payload.workDate) throw new PersonnelReportError("Нельзя изменить проект или дату существующего отчёта.");
        if (rows.some(row => !row.id) && !user.permissions.workers_report.create) throw new PersonnelReportError("Нет права добавлять строки отчёта.", 403, "REPORT_FORBIDDEN");
        if (current.rows.some(previous => !rows.some(row => row.id === previous.id)) && !user.permissions.workers_report.delete) throw new PersonnelReportError("Нет права удалять строки отчёта.", 403, "REPORT_FORBIDDEN");
        previousRows = current.rows;
        const historical = new Map<number, PersonnelReportRow>();
        if (current.status === "approved") rows.forEach((row, index) => {
          const previous = current.rows.find(previous => previous.id === row.id);
          if (previous) historical.set(index, previous);
        });
        snapshots = await validateReferences(db, payload.siteId, rows, historical);
        if (current.status === "submitted" || current.status === "approved") {
          const complete = completePersonnelReportRows(rows);
          if (current.status === "approved") {
            approvedReport = current;
            for (const row of rows) if (row.id) {
              const previous = current.rows.find(previous => previous.id === row.id);
              if (previous) assertPersonnelReportRevision(previous.approvedEntryRevision!, row.approvedEntryRevision);
            }
          }
          await checkHours(db, current.workDate, complete, current.status === "approved",
            new Map(complete.map((row, index) => [row.employeeId, snapshots[index].employeeName])),
            current.status === "approved" ? current.rows.flatMap(row => row.approvedEntryId ? [row.approvedEntryId] : []) : [],
            current.status === "approved" ? current.rows.flatMap(row => row.employeeId ? [row.employeeId] : []) : []);
        }
        await db.prepare(`UPDATE personnel_reports SET revision = revision + 1, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id`)
          .bind(user.id, reportId).run();
      } else {
        assertCanSavePersonnelReport(user);
        snapshots = await validateReferences(db, payload.siteId, rows);
        // Serializes two tabs trying to create the same owner's active report.
        await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`personnel-report:${payload.siteId}:${payload.workDate}:${user.id}`).first();
        const existing = await db.prepare("SELECT id FROM personnel_reports WHERE site_id = ? AND work_date = ? AND owner_user_id = ? AND status <> 'approved'")
          .bind(payload.siteId, payload.workDate, user.id).first<{ id: number }>();
        if (existing) throw new PersonnelReportError("На эту дату уже есть ваш черновик. Откройте его и продолжите заполнение.", 409, "REPORT_EXISTS", { reportId: existing.id });
        const inserted = await db.prepare(`INSERT INTO personnel_reports (site_id, work_date, owner_user_id, created_by_user_id, updated_by_user_id)
          VALUES (?, ?, ?, ?, ?) RETURNING id`).bind(payload.siteId, payload.workDate, user.id, user.id, user.id).first<{ id: number }>();
        if (!inserted) throw new Error("Не удалось создать черновик.");
        reportId = inserted.id;
      }
      if (approvedReport) {
        const removedIds = previousRows.flatMap(previous => !rows.some(row => row.id === previous.id) && previous.approvedEntryId ? [previous.approvedEntryId] : []);
        if (removedIds.length) await db.prepare(`UPDATE placement_entries SET deleted_at = clock_timestamp(),
          updated_at = clock_timestamp(), updated_by_user_id = ?, revision = revision + 1 WHERE id = ANY(?) RETURNING id`).bind(user.id, removedIds).run();
      }
      await saveDraftRows(db, reportId, rows, snapshots, previousRows);
      if (approvedReport) await publishPersonnelReportRows(db, user, approvedReport);
      return readReport(db, reportId);
    }
    if (!["submit", "approve", "reject", "reopen"].includes(payload.action) || !positiveId(payload.reportId)) throw new PersonnelReportError("Некорректное действие с отчётом.");
    await db.prepare("SELECT id FROM personnel_reports WHERE id = ? FOR UPDATE").bind(payload.reportId).first();
    const current = await readReport(db, payload.reportId);
    assertPersonnelReportOwner(user, current);
    await assertActiveSite(db, user, current.siteId);
    assertPersonnelReportRevision(current.revision, payload.revision);
    if (payload.comment !== undefined && (typeof payload.comment !== "string" || payload.comment.length > 4000)) throw new PersonnelReportError("Некорректный комментарий проверки.");
    const comment = payload.comment?.trim() ?? "";
    const status = nextPersonnelReportStatus(user, current, payload.action, comment);
    if (status === "submitted" || status === "approved") {
      const normalized = normalizePersonnelReportRows(current.rows);
      const rows = completePersonnelReportRows(normalized);
      const snapshots = await validateReferences(db, current.siteId, rows);
      await checkHours(db, current.workDate, rows, status === "approved", new Map(rows.map((row, index) => [row.employeeId, snapshots[index].employeeName])));
      if (status === "submitted") {
        // Freeze the employee/master labels the engineer is about to review.
        await db.batch(current.rows.map((row, index) => db.prepare(`UPDATE personnel_report_rows SET position_snapshot = ?,
          employee_name_snapshot = ?, employment_type_snapshot = ?, department_snapshot = ?, master_name_snapshot = ? WHERE id = ? RETURNING id`)
          .bind(snapshots[index].position, snapshots[index].employeeName, snapshots[index].employmentType, snapshots[index].department, snapshots[index].masterName, row.id)));
      } else {
        await publishPersonnelReportRows(db, user, current);
        await db.prepare(`INSERT INTO placement_report_days (site_id, work_date, submitted_by, submitted_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT (site_id, work_date) DO UPDATE SET
          submitted_by = EXCLUDED.submitted_by, submitted_at = CURRENT_TIMESTAMP RETURNING site_id`)
          .bind(current.siteId, current.workDate, user.id).all();
      }
    }
    const review = status === "approved" || status === "rejected";
    await db.prepare(`UPDATE personnel_reports SET status = ?, revision = revision + 1,
      submitted_at = CASE WHEN ? = 'submitted' THEN CURRENT_TIMESTAMP ELSE submitted_at END,
      submitted_by_user_id = CASE WHEN ? = 'submitted' THEN ? ELSE submitted_by_user_id END,
      reviewed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
      reviewed_by_user_id = ?, review_comment = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? RETURNING id`).bind(status, status, status, user.id, review, review ? user.id : null, review ? comment : "", user.id, current.id).run();
    return readReport(db, current.id);
  });
}
