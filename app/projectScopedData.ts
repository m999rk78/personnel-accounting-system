import { accessibleProjectIds, canAccessProject, type UserRole } from "./roles.ts";

type ScopedUser = { role: UserRole; assignedSiteId: number | null; projectAccess?: { mode: "all" | "selected"; siteIds: number[] } };
type ScopeDatabase = {
  prepare(sql: string): { bind(...values: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> } };
};

/** Global profile mutations may not remove or transfer another project's assets. */
export async function projectEntitiesAllowed(db: ScopeDatabase, user: ScopedUser, kind: "employee" | "equipment", ids: number[], exclusive = false, allowFormer = false) {
  if (user.role === "viewer") return false;
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

/** Includes role scope as a hard boundary, independent of customized permissions. */
export function scopedDataActionAllowed(user: ScopedUser, payload: { action?: string; siteId?: unknown; projectSiteId?: unknown; entity?: unknown }) {
  if (user.role === "viewer") return false;
  const siteIds = accessibleProjectIds(user);
  if (siteIds === null) return true;
  if (!siteIds.length) return false;
  const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
  if (payload.siteId !== undefined && !canAccessProject(user, positive(payload.siteId))) return false;
  if (payload.projectSiteId !== undefined && !canAccessProject(user, positive(payload.projectSiteId))) return false;
  const action = payload.action ?? "";
  if (/bitrix24/.test(action) || ["reorder-employees", "import-employees", "create-user", "update-user", "assign-site", "create-position", "update-position", "import-positions", "create-site"].includes(action)) return false;
  if ((action === "create-employee" || action === "update-employee") && !canAccessProject(user, positive(payload.projectSiteId))) return false;
  if ((action === "create-directory" || action === "update-directory") && ["employmentType", "department", "position"].includes(String(payload.entity))) return false;
  return true;
}
