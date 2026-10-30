import { hasPermission, type PermissionResource, type PermissionSet } from "./permissionModel.ts";

const resources: Record<string, PermissionResource> = {
  employees: "employees", positions: "positions", users: "system_users", projects: "projects",
  projectEmployees: "project_employees", directories: "project_directories",
};

/** A screen loads only its own catalogs; omitted section preserves older clients. */
export function settingsReadPolicy(permissions: PermissionSet, section: string | null) {
  const wants = (...sections: string[]) => section === null || sections.includes(section);
  const may = (resource: PermissionResource) => hasPermission(permissions, resource, "view");
  const canManageEmployees = hasPermission(permissions, "employees", "create") || hasPermission(permissions, "employees", "update");
  return {
    allowed: section === null ? Object.values(resources).some(may) : Boolean(resources[section] && may(resources[section])),
    employees: may("employees") && wants("employees")
      || hasPermission(permissions, "project_employees", "create") && wants("projectEmployees"),
    projectEmployees: may("project_employees") && wants("projectEmployees", "directories"),
    positions: (may("positions") || canManageEmployees) && wants("positions", "employees"),
    directories: may("project_directories") && wants("directories"),
    users: may("system_users") && wants("users"),
    projectStats: section === null || section === "projects",
    sync: may("employees") && wants("employees"),
  };
}
