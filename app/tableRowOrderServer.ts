import { getDatabase, type PostgresDatabase } from "../db/client";
import { hasPermission, type PermissionResource } from "./permissionModel";
import type { AuthUser } from "./auth";
import { reconcileRowOrder, type RowOrderId } from "./tableRowOrder";
import { groupPersonnelReportDates, isUnsavedPersonnelReportOrderId, personnelReportOrderScope } from "./personnelReportRowOrder";
import { equipmentReportOrderScope, groupEquipmentReportDates, isUnsavedEquipmentReportOrderId } from "./equipmentReportRowOrder";
import { workTypesOrderScope } from "./workTypesRowOrder";

const scopes: Record<string, { project?: boolean; personal?: boolean; resources: PermissionResource[]; sql: string }> = {
  [personnelReportOrderScope]: { project: true, personal: true, resources: ["workers_report"], sql: "" },
  [equipmentReportOrderScope]: { project: true, personal: true, resources: ["equipment_report"], sql: "" },
  [workTypesOrderScope]: { project: true, resources: ["project_directories"], sql: `SELECT id FROM (
    SELECT 'child-' || child.id AS id, CASE WHEN parent.id IS NULL THEN 1 ELSE 0 END AS unassigned,
      COALESCE(parent.name, '') AS parent_name, child.name AS child_name
      FROM subwork_types child LEFT JOIN main_work_types parent ON parent.id = child.main_work_type_id AND parent.active = 1 AND parent.site_id = child.site_id
      WHERE child.site_id = ? AND child.active = 1
    UNION ALL
    SELECT 'parent-' || parent.id AS id, 0 AS unassigned, parent.name AS parent_name, '' AS child_name
      FROM main_work_types parent WHERE parent.site_id = ? AND parent.active = 1
    ) records ORDER BY unassigned, parent_name, child_name, id` },
  employees: { resources: ["employees"], sql: "SELECT id FROM employees WHERE active = 1 ORDER BY sort_order, full_name, id" },
  equipment: { resources: ["equipment_registry"], sql: "SELECT id FROM equipment_units WHERE active = 1 ORDER BY equipment_type, model, id" },
  positions: { resources: ["positions"], sql: "SELECT id FROM position_catalog WHERE active = 1 ORDER BY employment_type, department, position, id" },
  users: { resources: ["system_users"], sql: "SELECT id FROM app_users WHERE active = 1 ORDER BY full_name, id" },
  projects: { resources: ["projects"], sql: "SELECT id FROM sites WHERE active = 1 ORDER BY id" },
  "project-personnel": { project: true, resources: ["project_employees", "workers_report", "workers_timesheet"], sql: `SELECT e.id FROM employees e WHERE e.id IN (
    SELECT employee_id FROM employee_project_assignments WHERE site_id = ?
    UNION SELECT employee_id FROM placement_entries WHERE site_id = ?
    UNION SELECT employee_id FROM timesheet_marks WHERE site_id = ?
  ) ORDER BY e.sort_order, e.full_name, e.id` },
  "project-equipment": { project: true, resources: ["project_equipment", "equipment_report", "equipment_timesheet"], sql: `SELECT id FROM equipment_units WHERE id IN (
    SELECT equipment_id FROM equipment_project_assignments WHERE site_id = ?
    UNION SELECT equipment_id FROM equipment_entries WHERE site_id = ?
    UNION SELECT equipment_id FROM equipment_timesheet_marks WHERE site_id = ?
  ) ORDER BY equipment_type, model, id` },
  ...Object.fromEntries(Object.entries({ zone: "zones", mainWorkType: "main_work_types", subworkType: "subwork_types", master: "masters" }).map(([scope, table]) => [
    `directory-${scope}`, { project: true, resources: ["project_directories"] as PermissionResource[], sql: `SELECT id FROM ${table} WHERE active = 1 AND site_id = ? ORDER BY name, id` },
  ])),
};

export function rowOrderAccess(user: AuthUser, scope: string, siteId: number | null) {
  const definition = scopes[scope];
  if (!definition) throw new Error("Неизвестная таблица.");
  if (definition.project && (!siteId || (user.role === "foreman" && user.assignedSiteId !== siteId))) throw new Error("Нет доступа к проекту.");
  const canRead = definition.resources.some((resource) => hasPermission(user.permissions, resource, "view"));
  const canWrite = definition.resources.some((resource) => hasPermission(user.permissions, resource, "update") || (resource === "project_employees" && hasPermission(user.permissions, resource, "create")));
  return { canRead, canWrite, key: `${scope}:${definition.project ? siteId : 0}${definition.personal ? `:${user.id}` : ""}`, definition };
}

let schemaReady: Promise<unknown> | undefined;
export async function ensureTableOrderSchema() {
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_RUNTIME_BOOTSTRAP !== "true") return;
  schemaReady ??= getDatabase().prepare(`CREATE TABLE IF NOT EXISTS table_row_orders (
    id TEXT PRIMARY KEY, row_ids JSONB NOT NULL DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run().catch((error) => { schemaReady = undefined; throw error; });
  await schemaReady;
}

export async function canonicalRowIds(scope: string, siteId: number | null, executor: Pick<PostgresDatabase, "prepare"> = getDatabase(), user?: AuthUser): Promise<RowOrderId[]> {
  if (scope === equipmentReportOrderScope) {
    const own = user?.role === "foreman";
    const parameters = [siteId, ...(own ? [user.id] : []), siteId, ...(own ? [user.id] : [])];
    const rows = await executor.prepare(`SELECT id FROM (
      SELECT to_char(report.work_date::date, 'YYYY-MM-DD') || '/report-' || report.id || '-' || row.id AS id,
        report.work_date::date AS day, row.created_at AS created, row.row_order AS rank
      FROM equipment_report_rows row JOIN equipment_reports report ON report.id = row.report_id
      WHERE report.site_id = ? AND report.status <> 'approved' ${own ? "AND report.owner_user_id = ?" : ""}
      UNION ALL
      SELECT to_char(entry.work_date::date, 'YYYY-MM-DD') || '/' || CASE WHEN origin.id IS NOT NULL THEN 'report-' || origin.report_id || '-' || origin.id ELSE 'approved-' || entry.id END AS id,
        entry.work_date::date AS day, entry.created_at AS created, 0 AS rank
      FROM equipment_entries entry LEFT JOIN equipment_report_rows origin ON origin.approved_entry_id = entry.id WHERE entry.site_id = ? AND entry.deleted_at IS NULL ${own ? "AND entry.responsible_user_id = ?" : ""}
    ) records ORDER BY day DESC, created DESC, rank, id DESC`).bind(...parameters).all<{ id: string }>();
    return rows.results.map(row => row.id);
  }
  if (scope === personnelReportOrderScope) {
    const own = user?.role === "foreman";
    const parameters = [siteId, ...(own ? [user.id] : []), siteId, ...(own ? [user.id] : [])];
    const rows = await executor.prepare(`SELECT id FROM (
      SELECT to_char(report.work_date::date, 'YYYY-MM-DD') || '/report-' || report.id || '-' || row.id AS id,
        report.work_date::date AS day, row.created_at AS created, row.row_order AS rank
      FROM personnel_report_rows row JOIN personnel_reports report ON report.id = row.report_id
      WHERE report.site_id = ? AND report.status <> 'approved' ${own ? "AND report.owner_user_id = ?" : ""}
      UNION ALL
      SELECT to_char(entry.work_date::date, 'YYYY-MM-DD') || '/' || CASE WHEN origin.id IS NOT NULL THEN 'report-' || origin.report_id || '-' || origin.id ELSE 'approved-' || entry.id END AS id,
        entry.work_date::date AS day, entry.created_at AS created, 0 AS rank
      FROM placement_entries entry LEFT JOIN personnel_report_rows origin ON origin.approved_entry_id = entry.id WHERE entry.site_id = ? AND entry.deleted_at IS NULL ${own ? "AND entry.responsible_user_id = ?" : ""}
    ) records ORDER BY day DESC, created DESC, rank, id DESC`).bind(...parameters).all<{ id: string }>();
    return rows.results.map(row => row.id);
  }
  const definition = scopes[scope];
  const parameterCount = (definition.sql.match(/\?/g) ?? []).length;
  const rows = await executor.prepare(definition.sql).bind(...Array(parameterCount).fill(siteId)).all<{ id: RowOrderId }>();
  return rows.results.map((row) => row.id);
}

export async function readTableOrder(scope: string, siteId: number | null, user?: AuthUser) {
  await ensureTableOrderSchema();
  const key = user ? rowOrderAccess(user, scope, siteId).key : `${scope}:${scopes[scope].project ? siteId : 0}`;
  const [available, saved] = await Promise.all([
    canonicalRowIds(scope, siteId, getDatabase(), user),
    getDatabase().prepare("SELECT row_ids AS ids FROM table_row_orders WHERE id = ?").bind(key).first<{ ids: RowOrderId[] }>(),
  ]);
  // Unsaved draft UUIDs are view preferences too, and can survive a draft session restore.
  const reportRows = scope === personnelReportOrderScope || scope === equipmentReportOrderScope;
  const isUnsavedReportOrderId = scope === equipmentReportOrderScope ? isUnsavedEquipmentReportOrderId : isUnsavedPersonnelReportOrderId;
  const drafts = reportRows ? (saved?.ids ?? []).filter((id): id is string => typeof id === "string" && isUnsavedReportOrderId(id)) : [];
  const result = reconcileRowOrder([...available, ...drafts], saved?.ids ?? []);
  if (scope === personnelReportOrderScope) groupPersonnelReportDates(result, id => String(id).slice(0, 10));
  if (scope === equipmentReportOrderScope) groupEquipmentReportDates(result, id => String(id).slice(0, 10));
  return result;
}
