import { type AuthUser } from "../../auth";
import { type PermissionAction, hasPermission, hasReportStatusPermission, type PermissionResource } from "../../permissionModel";
import { canAccessProject } from "../../roles";
import { validDate, asPositiveInteger } from "./validation";
import { type UserPayload } from "./types";
import { directoryTable } from "./catalogs";

export function canManagePlacement(user: AuthUser, siteId: number | undefined, workDate: string | undefined, action: PermissionAction = "update") {
  // This legacy API writes published placements; draft rights cannot authorize it.
  if (!hasReportStatusPermission(user.permissions, "workers_report", "approved", action)) return false;
  if (!workDate || !validDate(workDate)) return false;
  return canAccessProject(user, siteId);
}

export function canRunAction(user: AuthUser, payload: UserPayload) {
  const action = payload.action;
  if (!action) return true;
  if (action === "inspect-bitrix24") return hasPermission(user.permissions, "employees", "view");
  if (action === "sync-bitrix24" || action === "link-bitrix24-employees" || action === "update-bitrix24-employee" || action === "update-selected-bitrix24-employees" || action === "acknowledge-bitrix24-difference" || action === "acknowledge-selected-bitrix24-differences" || action === "update-employee" || action === "reorder-employees") return hasPermission(user.permissions, "employees", "update");
  if (action === "delete-bitrix24-employee") return hasPermission(user.permissions, "employees", "delete");
  if (action === "create-employee" || action === "create-bitrix24-employee") return hasPermission(user.permissions, "employees", "create");
  if (action === "import-employees") return hasPermission(user.permissions, "employees", "create") || hasPermission(user.permissions, "employees", "update");
  if (action === "assign-employee-project" || action === "import-project-employees") return hasPermission(user.permissions, "project_employees", "create");
  if (action === "import-project-directory") return hasPermission(user.permissions, "project_directories", "create");
  if (action === "save-directory-items") {
    const rows = payload.directories ?? [];
    const creates = rows.some((row) => !asPositiveInteger(row.directoryId));
    const updates = rows.some((row) => Boolean(asPositiveInteger(row.directoryId)));
    return (!creates || hasPermission(user.permissions, "project_directories", "create"))
      && (!updates || hasPermission(user.permissions, "project_directories", "update"));
  }
  if (action === "create-directory" || action === "update-directory") {
    const directory = directoryTable(payload.entity);
    const resource: PermissionResource = directory?.global ? "positions" : "project_directories";
    return hasPermission(user.permissions, resource, action === "create-directory" ? "create" : "update");
  }
  if (action === "create-user") return hasPermission(user.permissions, "system_users", "create");
  if (action === "update-user" || action === "assign-site") return hasPermission(user.permissions, "system_users", "update");
  if (action === "create-position" || action === "import-positions") return hasPermission(user.permissions, "positions", "create");
  if (action === "update-position") return hasPermission(user.permissions, "positions", "update");
  if (action === "create-site") return hasPermission(user.permissions, "projects", "create");
  if (action === "update-site") return hasPermission(user.permissions, "projects", "update");
  return false;
}

export function canDeleteEntity(user: AuthUser, entity: string | null, kind: string | null) {
  if (!entity) return hasReportStatusPermission(user.permissions, "workers_report", "approved", "delete");
  if (entity === "employee") return hasPermission(user.permissions, "employees", "delete");
  if (entity === "employee-assignment") return hasPermission(user.permissions, "project_employees", "delete");
  if (entity === "user") return hasPermission(user.permissions, "system_users", "delete");
  if (entity === "site") return hasPermission(user.permissions, "projects", "delete");
  if (entity === "position") return hasPermission(user.permissions, "positions", "delete");
  if (entity === "directory") {
    const directory = directoryTable(kind);
    return hasPermission(user.permissions, directory?.global ? "positions" : "project_directories", "delete");
  }
  return false;
}
