export type UserRole = "foreman" | "engineer" | "viewer" | "superadmin";
export type ProjectAccess = { mode: "all" | "selected"; siteIds: number[] };
export type ProjectAccessUser = { role: UserRole; customRoleId?: number | null; assignedSiteId?: number | null; projectAccess?: ProjectAccess; canViewPendingReports?: boolean };

export const ROLE_LABELS: Record<UserRole, string> = {
  foreman: "Прораб", engineer: "Инженер", viewer: "Просмотр", superadmin: "Супер-админ",
};

export function isUserRole(value: unknown): value is UserRole {
  return value === "foreman" || value === "engineer" || value === "viewer" || value === "superadmin";
}

/** Assignment remains the default project for legacy foremen, not a permission boundary. */
export function requiresAssignedProject(role: UserRole) { return role === "foreman"; }

export function defaultProjectAccess(role: UserRole, assignedSiteId?: number | null, customRoleId?: number | null): ProjectAccess {
  if (customRoleId !== undefined && customRoleId !== null) return { mode: "selected", siteIds: [] };
  if (role === "superadmin" || role === "engineer") return { mode: "all", siteIds: [] };
  return { mode: "selected", siteIds: role === "foreman" && Number.isSafeInteger(assignedSiteId) && Number(assignedSiteId) > 0 ? [Number(assignedSiteId)] : [] };
}

export function effectiveProjectAccess(user: ProjectAccessUser): ProjectAccess {
  if (user.role === "superadmin") return { mode: "all", siteIds: [] };
  if (!isUserRole(user.role)) return { mode: "selected", siteIds: [] };
  if (!user.projectAccess) return defaultProjectAccess(user.role, user.assignedSiteId, user.customRoleId);
  if (user.projectAccess.mode === "all") return { mode: "all", siteIds: [] };
  return { mode: "selected", siteIds: [...new Set((user.projectAccess.siteIds ?? []).filter(id => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b) };
}

export function accessibleProjectIds(user: ProjectAccessUser): number[] | null {
  const access = effectiveProjectAccess(user);
  return access.mode === "all" ? null : access.siteIds;
}
export function hasRestrictedProjectAccess(user: ProjectAccessUser) { return accessibleProjectIds(user) !== null; }
export function canAccessProject(user: ProjectAccessUser, siteId: number | null | undefined) {
  if (!Number.isSafeInteger(siteId) || Number(siteId) < 1) return false;
  const ids = accessibleProjectIds(user);
  return ids === null || ids.includes(Number(siteId));
}
export function canViewAllProjects(user: UserRole | ProjectAccessUser) {
  return !hasRestrictedProjectAccess(typeof user === "string" ? { role: user } : user);
}

/** A user-list DTO must not reveal projects outside the observer's own scope. */
export function visibleUserProjectAccess<T extends ProjectAccessUser>(target: T, observer: ProjectAccessUser) {
  const visibleIds = accessibleProjectIds(observer);
  if (visibleIds === null) return { ...target, projectAccessLimitedToViewer: false };
  const targetIds = accessibleProjectIds(target);
  const siteIds = targetIds === null ? visibleIds : targetIds.filter(id => visibleIds.includes(id));
  const assignedSiteId = canAccessProject(observer, target.assignedSiteId) ? target.assignedSiteId ?? null : null;
  return { ...target, assignedSiteId, projectAccess: { mode: "selected" as const, siteIds }, projectAccessLimitedToViewer: true,
    ...("assignedSiteName" in target ? { assignedSiteName: assignedSiteId ? target.assignedSiteName : null } : {}) };
}
export function canViewPendingReportsFor(user: ProjectAccessUser) { return user.role !== "viewer" || user.canViewPendingReports === true; }
export function canAccessGeneralSettings(role: UserRole) { return role === "engineer" || role === "superadmin"; }
export function canEditGlobalEmployees(role: UserRole) { return role === "engineer" || role === "superadmin"; }
export function canEditGlobalReferences(role: UserRole) { return role === "superadmin"; }
export function canManageBitrix24(role: UserRole) { return role === "superadmin"; }
export function canInspectBitrix24(role: UserRole) { return role === "engineer" || role === "superadmin"; }
export function canEditProjectSettings(role: UserRole) { return role === "engineer" || role === "superadmin"; }
export function canAccessTimesheets(role: UserRole) { return role === "engineer" || role === "viewer" || role === "superadmin"; }
