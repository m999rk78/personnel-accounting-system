import { canAccessProject } from "../../roles";
import { getDatabase, type PostgresDatabase } from "../../../db/client";
import { withAuditTrail } from "../../auditLog";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { hasPermission } from "../../permissionModel";
import { isPersonnelTimesheetCode, isPersonnelTimesheetHours } from "../../personnelTimesheetValues";
import { resolvePersonnelTimesheetRoster, type PersonnelTimesheetAssignment } from "../../personnelTimesheetRoster";
import { currentProjectDate } from "../../projectClock";
import { currentEmployeeDirectoryFilter } from "../../employeeDirectoryEligibility";

type TimesheetEmployee = {
  id: number;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
};

type RosterEmployee = TimesheetEmployee & {
  directoryActive?: number;
  assignments: PersonnelTimesheetAssignment[];
  reportDates: string[];
  reportTrackedByDate?: Record<string, boolean>;
  markDates: string[];
  exits: Array<{ workDate: string; code: string }>;
  profileDate: string | null;
  profileVersionDate?: string | null;
};

type TimesheetEntry = {
  employeeId: number;
  workDate: string;
  hours: number;
  reportTracked?: boolean;
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
  revision?: string;
};

let schemaPromise: Promise<void> | null = null;

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validMonth(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) > 0 && value < "9999-12";
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value) || !validMonth(value.slice(0, 7))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nextMonthStart(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber === 12) return `${String(year + 1).padStart(4, "0")}-01-01`;
  return `${String(year).padStart(4, "0")}-${String(monthNumber + 1).padStart(2, "0")}-01`;
}

/** Load the evidence for a project/month. The domain resolver decides membership
 * and daily boundaries identically for reads and writes. No directory mutation
 * or inferred transfer is performed while forming a timesheet. Same-day manual
 * marks use their creation time so a later transfer doesn't relabel them. */
function rosterEmployeesStatement(db: Pick<PostgresDatabase, "prepare">, siteId: number, startDate: string, endDate: string, employeeId?: number) {
  const employeeFilter = employeeId === undefined ? "" : "AND employee_id = ?";
  const employeeBinding = employeeId === undefined ? [] : [employeeId];
  return db.prepare(`WITH assignment_roster AS (
    SELECT a.employee_id, json_agg(json_build_object('startDate', a.start_date, 'endDate', a.end_date,
      'active', a.active = 1 AND assigned.active = 1) ORDER BY a.start_date NULLS FIRST, a.id) AS assignments
    FROM employee_project_assignments a JOIN employees assigned ON assigned.id = a.employee_id
    WHERE a.site_id = ? AND (a.start_date < ? OR a.start_date IS NULL) ${employeeFilter}
    GROUP BY a.employee_id
  ), report_history AS (
    SELECT employee_id, json_agg(work_date ORDER BY work_date) AS dates,
      json_object_agg(work_date, report_tracked) AS tracked FROM (
      SELECT employee_id, work_date, BOOL_OR(UPPER(TRIM(employment_type_snapshot)) = 'ОПР') AS report_tracked
      FROM placement_entries
      WHERE site_id = ? AND work_date >= ? AND work_date < ? AND deleted_at IS NULL ${employeeFilter}
      GROUP BY employee_id, work_date
    ) daily_reports
    GROUP BY employee_id
  ), mark_history AS (
    SELECT employee_id, json_agg(work_date ORDER BY work_date) AS dates, MAX(work_date) AS last_date,
      (array_agg(created_at ORDER BY work_date DESC))[1] AS last_recorded_at FROM timesheet_marks
    WHERE site_id = ? AND work_date >= ? AND work_date < ? ${employeeFilter}
    GROUP BY employee_id
  )
  SELECT e.id, CASE WHEN ${currentEmployeeDirectoryFilter("e")} THEN 1 ELSE 0 END AS directoryActive,
    COALESCE(NULLIF(snapshot.employee_name_snapshot, ''), profile.full_name, e.full_name) AS fullName,
    COALESCE(NULLIF(snapshot.employment_type_snapshot, ''), profile.employment_type, e.employment_type) AS employmentType,
    COALESCE(NULLIF(snapshot.department_snapshot, ''), profile.department, e.department) AS department,
    COALESCE(NULLIF(snapshot.position_snapshot, ''), profile.position, e.position) AS position,
    snapshot.work_date AS profileDate,
    profile.valid_from AS profileVersionDate,
    COALESCE(a.assignments, '[]'::json) AS assignments,
    COALESCE(r.dates, '[]'::json) AS reportDates,
    COALESCE(r.tracked, '{}'::json) AS reportTrackedByDate,
    COALESCE(m.dates, '[]'::json) AS markDates,
    COALESCE((SELECT json_agg(json_build_object('workDate', tm.work_date, 'code', tm.code) ORDER BY tm.work_date)
      FROM timesheet_marks tm WHERE tm.site_id = ? AND tm.employee_id = e.id
        AND tm.work_date < ? AND tm.code IN ('УВ', 'ПЕ')), '[]'::json) AS exits
  FROM (SELECT employee_id FROM assignment_roster UNION SELECT employee_id FROM report_history UNION SELECT employee_id FROM mark_history) roster
  JOIN employees e ON e.id = roster.employee_id
  LEFT JOIN assignment_roster a ON a.employee_id = e.id
  LEFT JOIN report_history r ON r.employee_id = e.id
  LEFT JOIN mark_history m ON m.employee_id = e.id
  LEFT JOIN LATERAL (
    SELECT pe.employee_name_snapshot, pe.employment_type_snapshot, pe.department_snapshot, pe.position_snapshot, pe.work_date
    FROM placement_entries pe WHERE pe.employee_id = e.id AND pe.site_id = ?
      AND pe.work_date >= ? AND pe.work_date < ? AND pe.deleted_at IS NULL
    ORDER BY pe.work_date DESC, pe.id DESC LIMIT 1
  ) snapshot ON TRUE
  LEFT JOIN LATERAL (
    SELECT v.full_name, v.employment_type, v.department, v.position, v.valid_from
    FROM employee_profile_versions v WHERE v.employee_id = e.id
      AND v.valid_from < COALESCE(
        CASE WHEN snapshot.work_date IS NULL AND (m.last_recorded_at AT TIME ZONE 'Europe/Moscow')::date = m.last_date::date
          THEN m.last_recorded_at END,
        COALESCE(snapshot.work_date::date + 1, m.last_date::date + 1, ?::date)::timestamp AT TIME ZONE 'Europe/Moscow')
    ORDER BY v.valid_from DESC, v.id DESC LIMIT 1
  ) profile ON TRUE
  ORDER BY e.sort_order, e.full_name, e.id`).bind(
    siteId, endDate, ...employeeBinding,
    siteId, startDate, endDate, ...employeeBinding,
    siteId, startDate, endDate, ...employeeBinding,
    siteId, endDate, siteId, startDate, endDate, endDate,
  );
}

function resolveEmployeeRoster(candidate: RosterEmployee, month: string, currentMonth = currentProjectDate().slice(0, 7)) {
  return resolvePersonnelTimesheetRoster({
    month, currentMonth,
    employeeActive: candidate.directoryActive !== 0,
    assignments: candidate.assignments ?? [], reportDates: candidate.reportDates ?? [],
    markDates: candidate.markDates ?? [], exits: candidate.exits ?? [],
  });
}

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

async function ensureTimesheetSchema() {
  if (!schemaPromise) {
    const schemaTask = process.env.NODE_ENV === "production" && process.env.DATABASE_RUNTIME_BOOTSTRAP !== "true"
      ? Promise.resolve()
      : (() => {
        const db = getDatabase();
        return db.batch([
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
        ]).then(() => undefined);
      })();
    schemaPromise = schemaTask.catch((error) => {
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
  if (!canAccessProject(authUser, requestedSiteId)) return { error: errorResponse("Нет доступа к проекту. Доступ к этому проекту не предоставлен.", 403) };
  const siteId = requestedSiteId;
  const site = await getDatabase().prepare("SELECT id, name FROM sites WHERE id = ? AND active = 1")
    .bind(siteId).first<{ id: number; name: string }>();
  if (!site) return { error: errorResponse("Объект не найден.", 404) };
  return { siteId, site };
}

async function readTimesheetMonth(
  transaction: Pick<PostgresDatabase, "prepare" | "readBatch">,
  site: { id: number; name: string },
  month: string,
  authUser: NonNullable<Awaited<ReturnType<typeof getAuthUser>>>,
  currentMonth: string,
) {
  const siteId = site.id;
  const startDate = `${month}-01`;
  const endDate = nextMonthStart(month);
  const [employeesResult, entriesResult, marksResult] = await transaction.readBatch([
    rosterEmployeesStatement(transaction, siteId, startDate, endDate),
    transaction.prepare(`SELECT pe.employee_id AS employeeId, pe.work_date AS workDate,
      SUM(pe.hours)::int AS hours,
      TRUE AS reportTracked,
      COALESCE(STRING_AGG(DISTINCT COALESCE(NULLIF(pe.master_name_snapshot, ''), m.name), ', '), '') AS masters,
      COALESCE(STRING_AGG(DISTINCT z.name, ', '), '') AS zones
    FROM placement_entries pe
    LEFT JOIN masters m ON m.id = pe.master_id
    LEFT JOIN zones z ON z.id = pe.zone_id
    WHERE pe.site_id = ? AND pe.work_date >= ? AND pe.work_date < ? AND pe.deleted_at IS NULL
      AND UPPER(TRIM(pe.employment_type_snapshot)) = 'ОПР'
    GROUP BY pe.employee_id, pe.work_date
    ORDER BY pe.work_date, pe.employee_id`).bind(siteId, startDate, endDate),
    transaction.prepare(`SELECT employee_id AS employeeId, work_date AS workDate, hours, code, note, created_by AS updatedBy,
      id::text || ':' || xmin::text || ':' || updated_at::text AS revision
    FROM timesheet_marks
    WHERE site_id = ? AND work_date >= ? AND work_date < ?
    ORDER BY work_date, employee_id`).bind(siteId, startDate, endDate),
  ]);

  const employees = (employeesResult.results as RosterEmployee[]).flatMap(candidate => {
    const roster = resolveEmployeeRoster(candidate, month, currentMonth);
    if (!roster.included) return [];
    return [{
      id: candidate.id, fullName: candidate.fullName, employmentType: candidate.employmentType,
      department: candidate.department, position: candidate.position, profileDate: candidate.profileDate ?? null,
      profileSource: candidate.profileDate ? "report" : candidate.profileVersionDate ? "profile" : "directory",
      reportDates: candidate.reportDates ?? [], reportTrackedByDate: candidate.reportTrackedByDate ?? {},
      historyOnly: candidate.directoryActive === 0, roster,
    }];
  });

  return {
    siteId,
    siteName: site.name,
    month,
    canEdit: hasPermission(authUser.permissions, "workers_timesheet", "create")
      || hasPermission(authUser.permissions, "workers_timesheet", "update")
      || hasPermission(authUser.permissions, "workers_timesheet", "delete"),
    canCreate: hasPermission(authUser.permissions, "workers_timesheet", "create"),
    canUpdate: hasPermission(authUser.permissions, "workers_timesheet", "update"),
    canDelete: hasPermission(authUser.permissions, "workers_timesheet", "delete"),
    employees,
    entries: entriesResult.results as TimesheetEntry[],
    marks: marksResult.results as TimesheetMark[],
  };
}

export async function GET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return errorResponse("Требуется авторизация.", 401);
    if (!hasPermission(authUser.permissions, "workers_timesheet", "view")) return errorResponse("Нет доступа к табелю рабочих.", 403);

    const url = new URL(request.url);
    const requestedSiteId = positiveInteger(url.searchParams.get("siteId"));
    const month = url.searchParams.get("month");
    const startMonth = url.searchParams.get("startMonth");
    const endMonth = url.searchParams.get("endMonth");
    const rangeRequested = startMonth !== null || endMonth !== null;
    if (!requestedSiteId || (rangeRequested
      ? month !== null || !validMonth(startMonth) || !validMonth(endMonth) || startMonth > endMonth
      : !validMonth(month))) return errorResponse("Некорректный объект или период табеля.", 400);
    const months: string[] = [];
    if (rangeRequested) {
      let cursor = startMonth!;
      while (cursor <= endMonth!) {
        if (months.length === 13) return errorResponse("Для выгрузки можно выбрать не более 13 календарных месяцев.", 400);
        months.push(cursor);
        cursor = nextMonthStart(cursor).slice(0, 7);
      }
    } else months.push(month!);

    await ensureTimesheetSchema();
    const resolved = await resolveSite(requestedSiteId, authUser);
    if ("error" in resolved) return resolved.error;
    const currentMonth = currentProjectDate().slice(0, 7);
    // A report can move across a month boundary while Excel is loading. All
    // months must share one snapshot, including assignments and manual marks.
    const payloads = await getDatabase().transaction(async transaction => {
      await transaction.prepare("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").run();
      const results = [];
      for (const selectedMonth of months) results.push(await readTimesheetMonth(transaction, resolved.site, selectedMonth, authUser, currentMonth));
      return results;
    });
    return Response.json(rangeRequested ? { months: payloads } : payloads[0]);
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
    if (!(["create", "update", "delete"] as const).some(action => hasPermission(authUser.permissions, "workers_timesheet", action))) return errorResponse("Нет права изменять табель рабочих.", 403);

    const payload = await request.json() as { siteId?: unknown; employeeId?: unknown; workDate?: unknown; value?: unknown; note?: unknown; expectedRevision?: unknown; allowRosterRemoval?: unknown };
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

    const rawValue = typeof payload.value === "number" ? String(payload.value) : String(payload.value ?? "").trim().toLocaleUpperCase("ru-RU");
    const workDate = payload.workDate;
    const guardedWrite = Object.hasOwn(payload, "expectedRevision");
    if (guardedWrite && payload.expectedRevision !== null && typeof payload.expectedRevision !== "string") {
      return errorResponse("Некорректная версия отметки. Обновите табель.", 400);
    }
    return await db.transaction(async transaction => {
      // Different days in one month can together remove the last historical row.
      // Serialize membership checks as well as individual cell updates.
      await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .bind(`timesheet-month:${siteId}:${employeeId}:${workMonth}`).first();
      await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
        .bind(`timesheet-mark:${siteId}:${employeeId}:${workDate}`).first();
      const candidate = await rosterEmployeesStatement(transaction, siteId, monthStartDate, monthEndDate, employeeId).first<RosterEmployee>();
      if (!candidate || !resolveEmployeeRoster(candidate, workMonth).included) {
        return errorResponse("Сотрудник не относится к выбранному проекту за этот месяц.", 404);
      }
      const existingMark = await transaction.prepare("SELECT id FROM timesheet_marks WHERE site_id = ? AND employee_id = ? AND work_date = ?")
        .bind(siteId, employeeId, workDate).first<{ id: number }>();
      const readRevision = () => transaction.prepare("SELECT id::text || ':' || xmin::text || ':' || updated_at::text AS revision FROM timesheet_marks WHERE site_id = ? AND employee_id = ? AND work_date = ?")
        .bind(siteId, employeeId, workDate).first<{ revision: string }>();
      if (guardedWrite && payload.expectedRevision !== (existingMark ? (await readRevision())?.revision ?? null : null)) {
        return errorResponse("Эта ячейка уже изменена. Обновите табель и проверьте актуальное значение перед повторной правкой.", 409);
      }
      if (!rawValue) {
        if (!existingMark) return Response.json({ deleted: false, employeeId, workDate });
        if (!hasPermission(authUser.permissions, "workers_timesheet", "delete")) return errorResponse("Нет права удалять отметки табеля.", 403);
        const remaining = {
          ...candidate,
          markDates: (candidate.markDates ?? []).filter(date => date !== workDate),
          exits: (candidate.exits ?? []).filter(exit => exit.workDate !== workDate),
        };
        if (guardedWrite && payload.allowRosterRemoval !== true && !resolveEmployeeRoster(remaining, workMonth).included) {
          return errorResponse("Это последняя отметка сотрудника за месяц. Обновите табель и подтвердите удаление строки.", 409);
        }
        await transaction.prepare("DELETE FROM timesheet_marks WHERE site_id = ? AND employee_id = ? AND work_date = ?")
          .bind(siteId, employeeId, workDate).run();
        return Response.json({ deleted: true, employeeId, workDate });
      }
      if (!hasPermission(authUser.permissions, "workers_timesheet", existingMark ? "update" : "create")) {
        return errorResponse(existingMark ? "Нет права изменять отметки табеля." : "Нет права добавлять отметки табеля.", 403);
      }

      const numericHours = /^\d+$/.test(rawValue) ? Number(rawValue) : null;
      if (numericHours !== null && !isPersonnelTimesheetHours(numericHours)) {
        return errorResponse("Количество часов должно быть целым числом от 1 до 10.", 400);
      }
      const code = numericHours === null ? rawValue : null;
      if (code && !isPersonnelTimesheetCode(code)) return errorResponse("Неизвестный табельный код.", 400);
      const note = typeof payload.note === "string" ? payload.note.trim().slice(0, 300) : "";

      await transaction.prepare(`INSERT INTO timesheet_marks (site_id, employee_id, work_date, hours, code, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (site_id, employee_id, work_date) DO UPDATE SET
          hours = EXCLUDED.hours, code = EXCLUDED.code, note = EXCLUDED.note,
          created_by = EXCLUDED.created_by, updated_at = CURRENT_TIMESTAMP`)
        .bind(siteId, employeeId, workDate, numericHours, code, note, authUser.fullName).run();

      const mark: TimesheetMark = { employeeId, workDate, hours: numericHours, code, note, updatedBy: authUser.fullName };
      if (guardedWrite) mark.revision = (await readRevision())?.revision;
      return Response.json({ mark });
    });
  } catch (error) {
    console.error("Timesheet update failed", error);
    return errorResponse(error instanceof Error ? error.message : "Не удалось сохранить отметку табеля.", 400);
  }
}

export async function POST(request: Request) {
  return withAuditTrail(request, handlePOST);
}
