export type UserRole = "foreman" | "engineer" | "superadmin";

export const ROLE_LABELS: Record<UserRole, string> = {
  foreman: "Прораб",
  engineer: "Инженер",
  superadmin: "Супер-админ",
};

export function isUserRole(value: unknown): value is UserRole {
  return value === "foreman" || value === "engineer" || value === "superadmin";
}

export function canAccessGeneralSettings(role: UserRole) {
  return role !== "foreman";
}

export function canEditGlobalEmployees(role: UserRole) {
  return role === "engineer" || role === "superadmin";
}

export function canEditGlobalReferences(role: UserRole) {
  return role === "superadmin";
}

export function canManageBitrix24(role: UserRole) {
  return role === "superadmin";
}

export function canEditProjectSettings(role: UserRole) {
  return role === "engineer" || role === "superadmin";
}

export function canViewAllProjects(role: UserRole) {
  return role !== "foreman";
}
