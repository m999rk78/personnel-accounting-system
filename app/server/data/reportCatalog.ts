import { env } from "./context";
import { reportEmployeesStatement } from "./placement";

/** Shared reference queries for the current report and the legacy workspace API. */
export function reportCatalogStatements(siteId: number) {
  return [
    env.DB.prepare("SELECT id, name, code, timezone FROM sites WHERE active = 1 ORDER BY id"),
    reportEmployeesStatement(siteId),
    env.DB.prepare(`SELECT e.id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position, e.source, e.sort_order AS sortOrder,
      e.bitrix24_stage AS bitrix24Stage, e.availability_status AS availabilityStatus, e.sync_error AS syncError,
      epa.site_id AS siteId, s.name AS siteName
      FROM employees e JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.active = 1 JOIN sites s ON s.id = epa.site_id AND s.active = 1
      WHERE e.active = 1 AND epa.site_id = ? ORDER BY e.sort_order, e.full_name, e.id`).bind(siteId),
    env.DB.prepare("SELECT id, name FROM shifts WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
    env.DB.prepare("SELECT id, name FROM zones WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
    env.DB.prepare("SELECT id, name FROM main_work_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
    env.DB.prepare("SELECT id, name, main_work_type_id AS mainWorkTypeId FROM subwork_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
    env.DB.prepare("SELECT id, name, employee_id AS employeeId FROM masters WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
  ];
}
