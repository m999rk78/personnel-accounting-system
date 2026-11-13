import { env } from "./context";
import { reportEmployeesStatement } from "./placement";
import { projectEmployeeCatalogStatement, projectMasterCatalogStatement } from "./catalogs";

/** Shared reference queries for the current report and the legacy workspace API. */
export function reportCatalogStatements(siteId: number) {
  return [
    env.DB.prepare("SELECT id, name, code, timezone FROM sites WHERE active = 1 ORDER BY id"),
    reportEmployeesStatement(siteId),
    projectEmployeeCatalogStatement(siteId),
    env.DB.prepare("SELECT id, name FROM shifts WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
    env.DB.prepare("SELECT id, name FROM zones WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
    env.DB.prepare("SELECT id, name FROM main_work_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
    env.DB.prepare("SELECT id, name, main_work_type_id AS mainWorkTypeId FROM subwork_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
    projectMasterCatalogStatement(siteId),
  ];
}
