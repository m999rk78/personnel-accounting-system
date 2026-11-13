import { getAuthUser } from "../../auth";
import { accessibleProjectIds, canAccessProject, canViewAllProjects, hasRestrictedProjectAccess } from "../../roles";
import { hasPermission, hasReportStatusPermission, type PermissionResource } from "../../permissionModel";
import { syncProjectMasters } from "../../projectMasters";
import { settingsReadPolicy } from "../../settingsReadPolicy";
import { readOptionalBatch } from "../../readOptionalBatch";
import { currentEmployeeDirectoryFilter } from "../../employeeDirectoryEligibility";
import { unauthorized, forbidden } from "./responses";
import { ensureDatabaseInitialized } from "./bootstrap";
import { asPositiveInteger, todayInMoscow, validDate } from "./validation";
import { env } from "./context";
import { placementEntriesStatement, filledDatesStatement, reportSubmissionStatement, employeeUsageStatement, foremanProgressStatement, reportTimesheetMarksStatement, placementEntriesForRangeStatement, reportEmployeesStatement } from "./placement";
import { employeeCatalogStatement, projectEmployeeCatalogStatement, projectMasterCatalogStatement, userCatalogStatement, usersWithProjectAccess } from "./catalogs";
import { mapBitrix24Cooldowns, type Bitrix24ActionLimitRow } from "./bitrixCooldown";
import { reportCatalogStatements } from "./reportCatalog";

export async function handleGET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return unauthorized();
    await ensureDatabaseInitialized();
    const url = new URL(request.url);
    const requestedSiteId = asPositiveInteger(url.searchParams.get("siteId"));
    const allowedSiteIds = accessibleProjectIds(authUser);
    const siteId = requestedSiteId ?? allowedSiteIds?.[0] ?? (canAccessProject(authUser, authUser.assignedSiteId) ? authUser.assignedSiteId : null) ?? 1;
    const scope = url.searchParams.get("scope");
    const canViewApproved = hasReportStatusPermission(authUser.permissions, "workers_report", "approved", "view");
    const canViewSubmitted = hasReportStatusPermission(authUser.permissions, "workers_report", "submitted", "view");
    const canViewReports = (["draft", "submitted", "approved"] as const).some(status => hasReportStatusPermission(authUser.permissions, "workers_report", status, "view"));
    if (scope === "navigation") {
      const sites = await env.DB.prepare("SELECT id, name, code, timezone FROM sites WHERE active = 1 ORDER BY id").all();
      return Response.json({ sites: sites.results.filter(site => canAccessProject(authUser, Number(site.id))) });
    }
    if (!canAccessProject(authUser, siteId)) return forbidden();
    const responsibleUserId = authUser.role === "foreman" ? authUser.id : undefined;
    const workDate = url.searchParams.get("date") ?? todayInMoscow();
    if (!validDate(workDate)) throw new Error("Некорректная дата отчёта.");
    const rangeStart = url.searchParams.get("rangeStart") ?? workDate;
    const rangeEnd = url.searchParams.get("rangeEnd") ?? workDate;
    if (!validDate(rangeStart) || !validDate(rangeEnd) || rangeStart > rangeEnd) throw new Error("Некорректный диапазон дат отчёта.");
    if (scope && scope !== "settings" && !canViewReports) return forbidden();
    if (scope === "carryover") {
      if (!canViewApproved) return Response.json({ sourceDate: null, entries: [] });
      const previous = await env.DB.prepare(`SELECT work_date AS workDate FROM placement_entries
          WHERE site_id = ? AND responsible_user_id = ? AND deleted_at IS NULL AND work_date < ?
          ORDER BY work_date DESC LIMIT 1`).bind(siteId, authUser.id, workDate).first<{ workDate: string }>();
      if (!previous) return Response.json({ sourceDate: null, entries: [] });
      const entries = await placementEntriesStatement(siteId, previous.workDate, authUser.id).all();
      return Response.json({ sourceDate: previous.workDate, entries: entries.results });
    }
    if (scope === "entries") {
      const [entries, filledDates, reportSubmission, employeeUsage, foremanProgress, timesheetMarks] = await env.DB.readBatch([
        placementEntriesStatement(siteId, workDate, responsibleUserId),
        filledDatesStatement(siteId, rangeStart, rangeEnd, responsibleUserId),
        reportSubmissionStatement(siteId, workDate, responsibleUserId),
        employeeUsageStatement(workDate, siteId, authUser),
        foremanProgressStatement(siteId, workDate, responsibleUserId),
        reportTimesheetMarksStatement(siteId, workDate),
      ]);
      return Response.json({
        entries: canViewApproved ? entries.results : [],
        filledDates: canViewApproved ? filledDates.results.map((row) => (row as { workDate: string }).workDate) : [],
        reportSubmitted: canViewSubmitted && Boolean((reportSubmission.results[0] as { submitted?: boolean } | undefined)?.submitted),
        employeeUsage: canViewApproved ? employeeUsage.results : [],
        foremanProgress: canViewSubmitted ? foremanProgress.results : [],
        timesheetMarks: timesheetMarks.results,
      });
    }
    if (scope === "export-range") {
      if (!canViewApproved) return forbidden();
      const rangeDays = Math.floor((Date.parse(`${rangeEnd}T00:00:00Z`) - Date.parse(`${rangeStart}T00:00:00Z`)) / 86400000) + 1;
      if (rangeDays > 366) throw new Error("Для выгрузки можно выбрать период не более 366 дней.");
      const entries = await placementEntriesForRangeStatement(siteId, rangeStart, rangeEnd, responsibleUserId).all();
      return Response.json({ entries: entries.results });
    }
    if (scope === "report-catalog") {
      if (hasPermission(authUser.permissions, "project_directories", "create") || hasPermission(authUser.permissions, "project_directories", "update")) await syncProjectMasters(env.DB, siteId);
      const [sites, reportEmployees, placementEmployees, shifts, zones, mainWorkTypes, subworkTypes, masters] = await env.DB.readBatch(reportCatalogStatements(siteId));
      return Response.json({
        sites: canViewAllProjects(authUser) ? sites.results : sites.results.filter((site) => canAccessProject(authUser, Number(site.id))),
        reportEmployees: reportEmployees.results,
        placementEmployees: placementEmployees.results,
        shifts: shifts.results,
        zones: zones.results,
        mainWorkTypes: mainWorkTypes.results,
        subworkTypes: subworkTypes.results,
        masters: masters.results,
      });
    }
    if (scope === "workspace") {
      if (hasPermission(authUser.permissions, "project_directories", "create") || hasPermission(authUser.permissions, "project_directories", "update")) await syncProjectMasters(env.DB, siteId);
      const [sites, reportEmployees, placementEmployees, shifts, zones, mainWorkTypes, subworkTypes, masters, entries, filledDates, reportSubmission, employeeUsage, foremanProgress, timesheetMarks] = await env.DB.readBatch([
        ...reportCatalogStatements(siteId),
        placementEntriesStatement(siteId, workDate, responsibleUserId),
        filledDatesStatement(siteId, rangeStart, rangeEnd, responsibleUserId),
        reportSubmissionStatement(siteId, workDate, responsibleUserId),
        employeeUsageStatement(workDate, siteId, authUser),
        foremanProgressStatement(siteId, workDate, responsibleUserId),
        reportTimesheetMarksStatement(siteId, workDate),
      ]);
      return Response.json({
        sites: canViewAllProjects(authUser) ? sites.results : sites.results.filter((site) => canAccessProject(authUser, Number(site.id))),
        employees: reportEmployees.results,
        reportEmployees: reportEmployees.results,
        placementEmployees: placementEmployees.results,
        projectEmployees: placementEmployees.results,
        positionCatalog: [],
        employmentTypes: [],
        departments: [],
        positions: [],
        shifts: shifts.results,
        zones: zones.results,
        mainWorkTypes: mainWorkTypes.results,
        subworkTypes: subworkTypes.results,
        masters: masters.results,
        entries: canViewApproved ? entries.results : [],
        filledDates: canViewApproved ? filledDates.results.map((row) => (row as { workDate: string }).workDate) : [],
        reportSubmitted: canViewSubmitted && Boolean((reportSubmission.results[0] as { submitted?: boolean } | undefined)?.submitted),
        employeeUsage: canViewApproved ? employeeUsage.results : [],
        foremanProgress: canViewSubmitted ? foremanProgress.results : [],
        timesheetMarks: timesheetMarks.results,
        users: [],
      });
    }
    if (scope === "settings") {
      const settingsResources: PermissionResource[] = [
        "employees", "positions", "system_users", "projects", "project_employees", "project_directories",
      ];
      if (!settingsResources.some((resource) => hasPermission(authUser.permissions, resource, "view"))) return forbidden();
      const reads = settingsReadPolicy(authUser.permissions, url.searchParams.get("section"));
      if (hasRestrictedProjectAccess(authUser)) reads.sync = false;
      if (!reads.allowed) return forbidden();
      if (reads.directories) if (hasPermission(authUser.permissions, "project_directories", "create") || hasPermission(authUser.permissions, "project_directories", "update")) await syncProjectMasters(env.DB, siteId);
      const [sites, employees, projectEmployees, positionCatalog, employmentTypes, departments, positions, shifts, zones, mainWorkTypes, subworkTypes, masters, users, syncStatus, bitrix24ActionLimits, projectStats] = await readOptionalBatch(env.DB, [
        env.DB.prepare("SELECT id, name, code, timezone FROM sites WHERE active = 1 ORDER BY id"),
        reads.employees ? employeeCatalogStatement(authUser, url.searchParams.get("section") === "projectEmployees") : null,
        reads.projectEmployees ? projectEmployeeCatalogStatement(siteId) : null,
        reads.positions ? env.DB.prepare("SELECT id, employment_type AS employmentType, department, position FROM position_catalog WHERE active = 1 ORDER BY employment_type, department, position") : null,
        reads.positions ? env.DB.prepare("SELECT id, name FROM personnel_options WHERE active = 1 AND kind = 'employmentType' ORDER BY name") : null,
        reads.positions ? env.DB.prepare("SELECT id, name FROM personnel_options WHERE active = 1 AND kind = 'department' ORDER BY name") : null,
        reads.positions ? env.DB.prepare("SELECT id, name FROM personnel_options WHERE active = 1 AND kind = 'position' ORDER BY name") : null,
        reads.directories ? env.DB.prepare("SELECT id, name FROM shifts WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId) : null,
        reads.directories ? env.DB.prepare("SELECT id, name FROM zones WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId) : null,
        reads.directories ? env.DB.prepare("SELECT id, name FROM main_work_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId) : null,
        reads.directories ? env.DB.prepare("SELECT id, name, main_work_type_id AS mainWorkTypeId FROM subwork_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId) : null,
        reads.directories ? projectMasterCatalogStatement(siteId) : null,
        reads.users ? userCatalogStatement(authUser) : null,
        reads.sync ? env.DB.prepare("SELECT id, status, started_at AS startedAt, completed_at AS completedAt, summary, error_text AS errorText FROM employee_sync_runs ORDER BY id DESC LIMIT 1") : null,
        reads.sync ? env.DB.prepare("SELECT action_key AS actionKey, last_started_at AS lastStartedAt FROM bitrix24_action_limits WHERE action_key IN ('inspect-bitrix24', 'sync-bitrix24')") : null,
        reads.projectStats ? env.DB.prepare(`SELECT project.id AS siteId,
            COALESCE(staff.employee_count, 0)::int AS employeeCount,
            (SELECT COUNT(*)::int FROM app_users foreman WHERE foreman.active = 1 AND foreman.role = 'foreman' AND ?::boolean AND (
              EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = foreman.id AND access.all_projects = 1)
              OR EXISTS (SELECT 1 FROM user_project_access access JOIN user_project_access_sites grant_site ON grant_site.user_id = access.user_id
                WHERE access.user_id = foreman.id AND access.all_projects = 0 AND grant_site.site_id = project.id)
              OR (NOT EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = foreman.id) AND foreman.assigned_site_id = project.id)
            )) AS foremanCount
          FROM sites project
          LEFT JOIN (SELECT assignment.site_id, COUNT(DISTINCT employee.id) AS employee_count
            FROM employee_project_assignments assignment JOIN employees employee ON employee.id = assignment.employee_id
            WHERE assignment.active = 1 AND ${currentEmployeeDirectoryFilter("employee")} AND ?::boolean GROUP BY assignment.site_id) staff ON staff.site_id = project.id
          WHERE project.active = 1 ORDER BY project.id`)
          .bind(hasPermission(authUser.permissions, "system_users", "view"), hasPermission(authUser.permissions, "employees", "view")) : null,
      ]);
      const canViewEmployees = hasPermission(authUser.permissions, "employees", "view");
      const canManageEmployees = hasPermission(authUser.permissions, "employees", "create") || hasPermission(authUser.permissions, "employees", "update");
      const canViewProjectEmployees = hasPermission(authUser.permissions, "project_employees", "view");
      const canChooseProjectEmployees = hasPermission(authUser.permissions, "project_employees", "create");
      const canViewPositions = hasPermission(authUser.permissions, "positions", "view") || canManageEmployees;
      const canViewProjectDirectories = hasPermission(authUser.permissions, "project_directories", "view");
      const canViewSystemUsers = hasPermission(authUser.permissions, "system_users", "view");
      const canViewAllSites = canViewAllProjects(authUser);
      return Response.json({
        sites: canViewAllSites ? sites.results : sites.results.filter((site) => canAccessProject(authUser, Number(site.id))),
        employees: canViewEmployees || canChooseProjectEmployees ? employees.results : [],
        reportEmployees: [],
        placementEmployees: canViewProjectEmployees ? projectEmployees.results : [],
        projectEmployees: canViewProjectEmployees ? projectEmployees.results : [],
        positionCatalog: canViewPositions ? positionCatalog.results : [],
        employmentTypes: canViewPositions ? employmentTypes.results : [],
        departments: canViewPositions ? departments.results : [],
        positions: canViewPositions ? positions.results : [],
        shifts: canViewProjectDirectories ? shifts.results : [],
        zones: canViewProjectDirectories ? zones.results : [],
        mainWorkTypes: canViewProjectDirectories ? mainWorkTypes.results : [],
        subworkTypes: canViewProjectDirectories ? subworkTypes.results : [],
        masters: canViewProjectDirectories ? masters.results : [],
        entries: [],
        filledDates: [],
        reportSubmitted: false,
        employeeUsage: [],
        foremanProgress: [],
        timesheetMarks: [],
        users: canViewSystemUsers ? (await usersWithProjectAccess(users.results, authUser)).filter(Boolean) : [],
        syncStatus: canViewEmployees && !hasRestrictedProjectAccess(authUser) ? syncStatus.results[0] ?? null : null,
        bitrix24Cooldowns: canViewEmployees && !hasRestrictedProjectAccess(authUser) ? mapBitrix24Cooldowns(bitrix24ActionLimits.results as Bitrix24ActionLimitRow[]) : undefined,
        projectStats: reads.projectStats ? projectStats.results.filter(row => canViewAllSites || canAccessProject(authUser, Number(row.siteId))) : undefined,
      });
    }
    if (hasPermission(authUser.permissions, "project_directories", "view") || hasPermission(authUser.permissions, "workers_report", "view")) if (hasPermission(authUser.permissions, "project_directories", "create") || hasPermission(authUser.permissions, "project_directories", "update")) await syncProjectMasters(env.DB, siteId);
    const [sites, employees, reportEmployees, placementEmployees, projectEmployees, positionCatalog, employmentTypes, departments, positions, shifts, zones, mainWorkTypes, subworkTypes, masters, entries, filledDates, reportSubmission, users, syncStatus, bitrix24ActionLimits, employeeUsage, foremanProgress, timesheetMarks] = await env.DB.readBatch([
      env.DB.prepare("SELECT id, name, code, timezone FROM sites WHERE active = 1 ORDER BY id"),
      employeeCatalogStatement(authUser),
      reportEmployeesStatement(siteId),
      projectEmployeeCatalogStatement(siteId),
      projectEmployeeCatalogStatement(siteId),
      env.DB.prepare("SELECT id, employment_type AS employmentType, department, position FROM position_catalog WHERE active = 1 ORDER BY employment_type, department, position"),
      env.DB.prepare("SELECT id, name FROM personnel_options WHERE active = 1 AND kind = 'employmentType' ORDER BY name"),
      env.DB.prepare("SELECT id, name FROM personnel_options WHERE active = 1 AND kind = 'department' ORDER BY name"),
      env.DB.prepare("SELECT id, name FROM personnel_options WHERE active = 1 AND kind = 'position' ORDER BY name"),
      env.DB.prepare("SELECT id, name FROM shifts WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name FROM zones WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name FROM main_work_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name, main_work_type_id AS mainWorkTypeId FROM subwork_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      projectMasterCatalogStatement(siteId),
      placementEntriesStatement(siteId, workDate, responsibleUserId),
      filledDatesStatement(siteId, rangeStart, rangeEnd, responsibleUserId),
      reportSubmissionStatement(siteId, workDate, responsibleUserId),
      userCatalogStatement(authUser),
      env.DB.prepare("SELECT id, status, started_at AS startedAt, completed_at AS completedAt, summary, error_text AS errorText FROM employee_sync_runs ORDER BY id DESC LIMIT 1"),
      env.DB.prepare("SELECT action_key AS actionKey, last_started_at AS lastStartedAt FROM bitrix24_action_limits WHERE action_key IN ('inspect-bitrix24', 'sync-bitrix24')"),
      employeeUsageStatement(workDate, siteId, authUser),
      foremanProgressStatement(siteId, workDate, responsibleUserId),
      reportTimesheetMarksStatement(siteId, workDate),
    ]);
    const canViewWorkerReports = canViewReports;
    const canViewEmployees = hasPermission(authUser.permissions, "employees", "view");
    const canManageEmployees = hasPermission(authUser.permissions, "employees", "create") || hasPermission(authUser.permissions, "employees", "update");
    const canViewProjectEmployees = hasPermission(authUser.permissions, "project_employees", "view");
    const canChooseProjectEmployees = hasPermission(authUser.permissions, "project_employees", "create");
    const canViewPositions = hasPermission(authUser.permissions, "positions", "view") || canManageEmployees;
    const canViewProjectDirectories = hasPermission(authUser.permissions, "project_directories", "view") || canViewWorkerReports;
    const canViewSystemUsers = hasPermission(authUser.permissions, "system_users", "view");
    const canViewAllSites = canViewAllProjects(authUser);
    return Response.json({
      sites: canViewAllSites ? sites.results : sites.results.filter((site) => canAccessProject(authUser, Number(site.id))),
      employees: canViewEmployees || canChooseProjectEmployees
        ? employees.results
        : [],
      reportEmployees: canViewWorkerReports ? reportEmployees.results : [],
      placementEmployees: canViewWorkerReports ? placementEmployees.results : [],
      projectEmployees: canViewProjectEmployees ? projectEmployees.results : [],
      positionCatalog: canViewPositions ? positionCatalog.results : [],
      employmentTypes: canViewPositions ? employmentTypes.results : [],
      departments: canViewPositions ? departments.results : [],
      positions: canViewPositions ? positions.results : [],
      shifts: canViewProjectDirectories ? shifts.results : [],
      zones: canViewProjectDirectories ? zones.results : [],
      mainWorkTypes: canViewProjectDirectories ? mainWorkTypes.results : [],
      subworkTypes: canViewProjectDirectories ? subworkTypes.results : [],
      masters: canViewProjectDirectories ? masters.results : [],
      entries: canViewApproved ? entries.results : [],
      filledDates: canViewApproved ? filledDates.results.map((row) => (row as { workDate: string }).workDate) : [],
      reportSubmitted: canViewSubmitted && Boolean((reportSubmission.results[0] as { submitted?: boolean } | undefined)?.submitted),
      employeeUsage: canViewApproved ? employeeUsage.results : [],
      foremanProgress: canViewSubmitted ? foremanProgress.results : [],
      timesheetMarks: canViewWorkerReports ? timesheetMarks.results : [],
      users: canViewSystemUsers ? (await usersWithProjectAccess(users.results, authUser)).filter(Boolean) : [],
      syncStatus: canViewEmployees && !hasRestrictedProjectAccess(authUser) ? syncStatus.results[0] ?? null : null,
      bitrix24Cooldowns: hasPermission(authUser.permissions, "employees", "view") ? mapBitrix24Cooldowns(bitrix24ActionLimits.results as Bitrix24ActionLimitRow[]) : undefined,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось загрузить данные." }, { status: 500 });
  }
}
