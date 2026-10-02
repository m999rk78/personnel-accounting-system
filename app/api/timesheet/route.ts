import { getDatabase } from "../../../db/client";
import { withAuditTrail } from "../../auditLog";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { hasPermission } from "../../permissionModel";

type TimesheetEmployee = {
  id: number;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
};

type TimesheetEntry = {
  employeeId: number;
  workDate: string;
  hours: number;
  masters: string;
  zones: string;
};

type TimesheetMark = {
  employeeId: number;
  workDate: string;
  hours: number | null;
  code: string | null;
  note: string;
  updatedBy: string;
};

const TIMESHEET_CODES = new Set(["В", "ДО", "МО", "ПЕ", "УВ", "ПР"]);
let schemaPromise: Promise<void> | null = null;

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validMonth(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function nextMonthStart(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber === 12) return `${year + 1}-01-01`;
  return `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
}

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

async function ensureTimesheetSchema() {
  if (!schemaPromise) {
    const db = getDatabase();
    schemaPromise = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS timesheet_marks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        work_date TEXT NOT NULL,
        hours INTEGER CHECK (hours BETWEEN 1 AND 10),
        code TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK ((hours IS NOT NULL AND code IS NULL) OR (hours IS NULL AND code IS NOT NULL))
      )`),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_timesheet_marks_unique_day ON timesheet_marks(site_id, employee_id, work_date)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_timesheet_marks_month ON timesheet_marks(site_id, work_date)"),
    ]).then(() => undefined).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function resolveSite(
  requestedSiteId: number,
  authUser: NonNullable<Awaited<ReturnType<typeof getAuthUser>>>,
): Promise<{ error: Response } | { siteId: number; site: { id: number; name: string } }> {
  if (authUser.role === "foreman" && !authUser.assignedSiteId) return { error: errorResponse("Для пользователя не назначен объект.", 403) };
  const siteId = authUser.role === "foreman" ? authUser.assignedSiteId! : requestedSiteId;
  const site = await getDatabase().prepare("SELECT id, name FROM sites WHERE id = ? AND active = 1")
    .bind(siteId).first<{ id: number; name: string }>();
  if (!site) return { error: errorResponse("Объект не найден.", 404) };
  return { siteId, site };
}

export async function GET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return errorResponse("Требуется авторизация.", 401);
    if (!hasPermission(authUser.permissions, "workers_timesheet", "view")) return errorResponse("Нет доступа к табелю рабочих.", 403);

    const url = new URL(request.url);
    const requestedSiteId = positiveInteger(url.searchParams.get("siteId"));
    const month = url.searchParams.get("month");
    if (!requestedSiteId || !validMonth(month)) return errorResponse("Некорректный объект или месяц табеля.", 400);

    await ensureTimesheetSchema();
    const resolved = await resolveSite(requestedSiteId, authUser);
    if ("error" in resolved) return resolved.error;
    const { siteId, site } = resolved;
    const startDate = `${month}-01`;
    const endDate = nextMonthStart(month);
    const db = getDatabase();

    const [employeesResult, entriesResult, marksResult] = await db.readBatch([
      db.prepare(`SELECT e.id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position
        FROM employees e
        WHERE (e.active = 1 AND EXISTS (
          SELECT 1 FROM employee_project_assignments epa
          WHERE epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1
        )) OR EXISTS (
          SELECT 1 FROM placement_entries pe
          WHERE pe.employee_id = e.id AND pe.site_id = ?
            AND pe.work_date >= ? AND pe.work_date < ? AND pe.deleted_at IS NULL
            AND UPPER(TRIM(pe.employment_type_snapshot)) = 'ОПР'
        ) OR EXISTS (
          SELECT 1 FROM timesheet_marks tm
          WHERE tm.employee_id = e.id AND tm.site_id = ? AND tm.work_date >= ? AND tm.work_date < ?
        )
        ORDER BY e.full_name`).bind(siteId, siteId, startDate, endDate, siteId, startDate, endDate),
      db.prepare(`SELECT pe.employee_id AS employeeId, pe.work_date AS workDate,
          SUM(pe.hours)::int AS hours,
          COALESCE(STRING_AGG(DISTINCT COALESCE(NULLIF(pe.master_name_snapshot, ''), m.name), ', '), '') AS masters,
          COALESCE(STRING_AGG(DISTINCT z.name, ', '), '') AS zones
        FROM placement_entries pe
        LEFT JOIN masters m ON m.id = pe.master_id
        LEFT JOIN zones z ON z.id = pe.zone_id
        WHERE pe.site_id = ? AND pe.work_date >= ? AND pe.work_date < ? AND pe.deleted_at IS NULL
          AND UPPER(TRIM(pe.employment_type_snapshot)) = 'ОПР'
        GROUP BY pe.employee_id, pe.work_date
        ORDER BY pe.work_date, pe.employee_id`).bind(siteId, startDate, endDate),
      db.prepare(`SELECT employee_id AS employeeId, work_date AS workDate, hours, code, note, created_by AS updatedBy
        FROM timesheet_marks
        WHERE site_id = ? AND work_date >= ? AND work_date < ?
        ORDER BY work_date, employee_id`).bind(siteId, startDate, endDate),
    ]);

    return Response.json({
      siteId,
      siteName: site.name,
      month,
      canEdit: hasPermission(authUser.permissions, "workers_timesheet", "create")
        || hasPermission(authUser.permissions, "workers_timesheet", "update")
        || hasPermission(authUser.permissions, "workers_timesheet", "delete"),
      canCreate: hasPermission(authUser.permissions, "workers_timesheet", "create"),
      canUpdate: hasPermission(authUser.permissions, "workers_timesheet", "update"),
      canDelete: hasPermission(authUser.permissions, "workers_timesheet", "delete"),
      employees: employeesResult.results as TimesheetEmployee[],
      entries: entriesResult.results as TimesheetEntry[],
      marks: marksResult.results as TimesheetMark[],
    });
  } catch (error) {
    console.error("Timesheet request failed", error);
    return errorResponse(error instanceof Error ? error.message : "Не удалось сформировать табель.", 500);
  }
}

async function handlePOST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authUser = await getAuthUser(request);
    if (!authUser) return errorResponse("Требуется авторизация.", 401);
    if (!hasPermission(authUser.permissions, "workers_timesheet", "view")) return errorResponse("Нет доступа к табелю рабочих.", 403);

    const payload = await request.json() as { siteId?: unknown; employeeId?: unknown; workDate?: unknown; value?: unknown; note?: unknown };
    const requestedSiteId = positiveInteger(payload.siteId);
    const employeeId = positiveInteger(payload.employeeId);
    if (!requestedSiteId || !employeeId || !validDate(payload.workDate)) return errorResponse("Некорректная строка табеля.", 400);
    await ensureTimesheetSchema();
    const resolved = await resolveSite(requestedSiteId, authUser);
    if ("error" in resolved) return resolved.error;
    const { siteId } = resolved;
    const workMonth = payload.workDate.slice(0, 7);
    const monthStartDate = `${workMonth}-01`;
    const monthEndDate = nextMonthStart(workMonth);
    const db = getDatabase();
    const employee = await db.prepare(`SELECT e.id FROM employees e WHERE e.id = ? AND (
        EXISTS (SELECT 1 FROM employee_project_assignments epa WHERE epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1)
        OR EXISTS (SELECT 1 FROM placement_entries pe WHERE pe.employee_id = e.id AND pe.site_id = ? AND pe.work_date >= ? AND pe.work_date < ? AND pe.deleted_at IS NULL AND UPPER(TRIM(pe.employment_type_snapshot)) = 'ОПР')
        OR EXISTS (SELECT 1 FROM timesheet_marks tm WHERE tm.employee_id = e.id AND tm.site_id = ? AND tm.work_date >= ? AND tm.work_date < ?)
      )`).bind(employeeId, siteId, siteId, monthStartDate, monthEndDate, siteId, monthStartDate, monthEndDate).first<{ id: number }>();
    if (!employee) return errorResponse("Сотрудник не относится к выбранному проекту.", 404);

    const rawValue = typeof payload.value === "number" ? String(payload.value) : String(payload.value ?? "").trim().toLocaleUpperCase("ru-RU");
    const existingMark = await db.prepare("SELECT id FROM timesheet_marks WHERE site_id = ? AND employee_id = ? AND work_date = ?")
      .bind(siteId, employeeId, payload.workDate).first<{ id: number }>();
    if (!rawValue) {
      if (!existingMark) return Response.json({ deleted: false, employeeId, workDate: payload.workDate });
      if (!hasPermission(authUser.permissions, "workers_timesheet", "delete")) return errorResponse("Нет права удалять отметки табеля.", 403);
      await db.prepare("DELETE FROM timesheet_marks WHERE site_id = ? AND employee_id = ? AND work_date = ?")
        .bind(siteId, employeeId, payload.workDate).run();
      return Response.json({ deleted: true, employeeId, workDate: payload.workDate });
    }
    if (!hasPermission(authUser.permissions, "workers_timesheet", existingMark ? "update" : "create")) {
      return errorResponse(existingMark ? "Нет права изменять отметки табеля." : "Нет права добавлять отметки табеля.", 403);
    }

    const numericHours = /^\d+$/.test(rawValue) ? Number(rawValue) : null;
    if (numericHours !== null && (!Number.isInteger(numericHours) || numericHours < 1 || numericHours > 10)) {
      return errorResponse("Количество часов должно быть целым числом от 1 до 10.", 400);
    }
    const code = numericHours === null ? rawValue : null;
    if (code && !TIMESHEET_CODES.has(code)) return errorResponse("Неизвестный табельный код.", 400);
    const note = typeof payload.note === "string" ? payload.note.trim().slice(0, 300) : "";

    await db.prepare(`INSERT INTO timesheet_marks (site_id, employee_id, work_date, hours, code, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (site_id, employee_id, work_date) DO UPDATE SET
        hours = EXCLUDED.hours, code = EXCLUDED.code, note = EXCLUDED.note,
        created_by = EXCLUDED.created_by, updated_at = CURRENT_TIMESTAMP`)
      .bind(siteId, employeeId, payload.workDate, numericHours, code, note, authUser.fullName).run();

    const mark: TimesheetMark = { employeeId, workDate: payload.workDate, hours: numericHours, code, note, updatedBy: authUser.fullName };
    return Response.json({ mark });
  } catch (error) {
    console.error("Timesheet update failed", error);
    return errorResponse(error instanceof Error ? error.message : "Не удалось сохранить отметку табеля.", 400);
  }
}

export async function POST(request: Request) {
  return withAuditTrail(request, handlePOST);
}
