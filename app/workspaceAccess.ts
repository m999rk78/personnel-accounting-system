import type { WorkspaceView } from "./appRoutes";
import { hasPermission, hasReportStatusPermission, type PermissionResource, type PermissionSet } from "./permissionModel.ts";

export const GENERAL_SETTINGS_RESOURCES: PermissionResource[] = ["employees", "equipment_registry", "positions", "system_users", "projects", "audit_log", "access_rights"];
export const PROJECT_SETTINGS_RESOURCES: PermissionResource[] = ["project_employees", "project_equipment", "project_directories"];

const VIEW_RESOURCES: Partial<Record<WorkspaceView, PermissionResource>> = {
  placement: "workers_report", equipment: "equipment_report", timesheet: "workers_timesheet", equipmentTimesheet: "equipment_timesheet",
  employees: "employees", equipmentRegistry: "equipment_registry", positions: "positions", users: "system_users", projects: "projects",
  auditLog: "audit_log", accessRights: "access_rights", projectEmployees: "project_employees", projectEquipment: "project_equipment", directories: "project_directories",
};

export function workspaceViewAllowed(permissions: PermissionSet, view: WorkspaceView) {
  if (view === "personnelStatistics" || view === "equipmentStatistics") {
    const resource = view === "personnelStatistics" ? "workers_statistics" : "equipment_statistics";
    return hasPermission(permissions, resource, "view");
  }
  if (view === "placement" || view === "equipment") {
    const resource = view === "placement" ? "workers_report" : "equipment_report";
    return (["draft", "submitted", "approved"] as const).some(status => hasReportStatusPermission(permissions, resource, status, "view"));
  }
  const resources = view === "settings" ? GENERAL_SETTINGS_RESOURCES : view === "projectSettings" ? PROJECT_SETTINGS_RESOURCES : [VIEW_RESOURCES[view]];
  return resources.some(resource => resource && hasPermission(permissions, resource, "view"));
}

export function workspaceTableAccess(permissions: PermissionSet, view: WorkspaceView) {
  const resource = VIEW_RESOURCES[view];
  const may = (action: "view" | "create" | "update" | "delete") => resource === "workers_report" || resource === "equipment_report"
    ? (["draft", "submitted", "approved"] as const).some(status => hasReportStatusPermission(permissions, resource, status, action))
    : Boolean(resource && hasPermission(permissions, resource, "view") && hasPermission(permissions, resource, action));
  const create = may("create"), update = may("update"), remove = may("delete");
  return { create, update, delete: remove, edit: create || update, select: create || update || remove,
    // Shared row orders must not leak report editing controls into read-only project settings.
    reorder: update || resource === "project_employees" && create };
}
