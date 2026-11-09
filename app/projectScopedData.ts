import { accessibleProjectIds, canAccessProject, type UserRole } from "./roles.ts";
import { hasPermission, type PermissionSet, type PermissionResource, type PermissionAction } from "./permissionModel.ts";

type ScopedUser = { role: UserRole; assignedSiteId: number | null; projectAccess?: { mode: "all" | "selected"; siteIds: number[] }; permissions?: PermissionSet };
type ScopeDatabase = {
  prepare(sql: string): { bind(...values: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> } };
};

/** Global profile mutations may not remove or transfer another project's assets. */
export async function projectEntitiesAllowed(db: ScopeDatabase, user: ScopedUser, kind: "employee" | "equipment", ids: number[], exclusive = false, allowFormer = false) {
  const siteIds = accessibleProjectIds(user);
  if (siteIds === null) return true;
  if (!ids.length || !siteIds.length) return false;
  const table = kind === "employee" ? "employees" : "equipment_units";
  const assignments = kind === "employee" ? "employee_project_assignments" : "equipment_project_assignments";
  const foreignKey = kind === "employee" ? "employee_id" : "equipment_id";
  const result = await db.prepare(`SELECT entity.id FROM ${table} entity
    WHERE entity.id = ANY(?::integer[]) AND entity.active = 1
      AND (EXISTS (SELECT 1 FROM ${assignments} own_assignment
        WHERE own_assignment.${foreignKey} = entity.id AND own_assignment.site_id = ANY(?::integer[]) AND own_assignment.active = 1)
        ${allowFormer ? `OR (EXISTS (SELECT 1 FROM ${assignments} former_assignment
          WHERE former_assignment.${foreignKey} = entity.id AND former_assignment.site_id = ANY(?::integer[]))
          AND NOT EXISTS (SELECT 1 FROM ${assignments} current_assignment
            WHERE current_assignment.${foreignKey} = entity.id AND current_assignment.active = 1))` : ""})
      ${exclusive ? `AND NOT EXISTS (SELECT 1 FROM ${assignments} other_assignment
        WHERE other_assignment.${foreignKey} = entity.id AND NOT (other_assignment.site_id = ANY(?::integer[])) AND other_assignment.active = 1)` : ""}`)
    .bind(ids, siteIds, ...(allowFormer ? [siteIds] : []), ...(exclusive ? [siteIds] : [])).all<{ id: number }>();
  const allowed = new Set(result.results.map(row => row.id));
  return ids.every(id => allowed.has(id));
}

/** Project assets retain their explicit scope; global actions require their own grant. */
export function scopedDataActionAllowed(user: ScopedUser, payload: { action?: string; siteId?: unknown; projectSiteId?: unknown; entity?: unknown }) {
  const siteIds = accessibleProjectIds(user);
  if (siteIds === null) return true;
  if (!siteIds.length) return false;
  const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
  if (payload.siteId !== undefined && !canAccessProject(user, positive(payload.siteId))) return false;
  if (payload.projectSiteId !== undefined && !canAccessProject(user, positive(payload.projectSiteId))) return false;
  const action = payload.action ?? "";
  // Whole-registry imports and Bitrix synchronization can change assets in
  // several projects, so they still require an explicit all-project scope.
  if (/bitrix24/.test(action) || ["reorder-employees", "import-employees"].includes(action)) return false;
  const globalActions: Record<string, [PermissionResource, PermissionAction]> = {
    "create-user": ["system_users", "create"], "update-user": ["system_users", "update"], "assign-site": ["system_users", "update"],
    "create-position": ["positions", "create"], "update-position": ["positions", "update"], "import-positions": ["positions", "create"],
    "create-site": ["projects", "create"],
  };
  const grant = globalActions[action];
  if (grant) return Boolean(user.permissions && hasPermission(user.permissions, ...grant));
  if ((action === "create-employee" || action === "update-employee") && !canAccessProject(user, positive(payload.projectSiteId))) return false;
  if ((action === "create-directory" || action === "update-directory") && ["employmentType", "department", "position"].includes(String(payload.entity))) {
    return Boolean(user.permissions && hasPermission(user.permissions, "positions", action === "create-directory" ? "create" : "update"));
  }
  return true;
}
