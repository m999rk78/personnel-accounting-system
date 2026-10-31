import { canAccessProject, defaultProjectAccess, effectiveProjectAccess, isUserRole, type ProjectAccess, type UserRole } from "./roles.ts";

type ProjectUser = { role: UserRole; assignedSiteId: number | null; projectAccess?: ProjectAccess; projectAccessLimitedToViewer?: boolean };

/** List projections describe visible projects; they are never authorization actors. */
export function displayedUserProjectAccess(user: ProjectUser): ProjectAccess {
  return user.projectAccessLimitedToViewer && user.projectAccess ? user.projectAccess : effectiveProjectAccess(user);
}

export function userRoleChanges(role: UserRole, assignedSiteId: string, projectAccess?: ProjectAccess) {
  const access = role === "superadmin" ? { mode: "all" as const, siteIds: [] }
    : role === "viewer" ? { mode: "selected" as const, siteIds: [] }
      : projectAccess ?? defaultProjectAccess(role, Number(assignedSiteId) || null);
  return { role, assignedSiteId: access.mode === "selected" ? String(access.siteIds[0] ?? "") : "", projectAccess: access, canViewPendingReports: role !== "viewer" };
}

export function pastedUserRole(value: string): UserRole | null {
  const role = value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
  if (isUserRole(role)) return role;
  if (role === "прораб") return "foreman";
  if (role === "инженер") return "engineer";
  if (role === "просмотр" || role === "наблюдатель") return "viewer";
  if (/^супер[\s-]?(админ|администратор)$/.test(role)) return "superadmin";
  return null;
}

export function userProjectLabel(role: UserRole, assignedSiteId: number | null | undefined, sites: readonly { id: number; name: string }[], projectAccess?: ProjectAccess, projectAccessLimitedToViewer = false) {
  const access = displayedUserProjectAccess({ role, assignedSiteId: assignedSiteId ?? null, projectAccess, projectAccessLimitedToViewer });
  if (access.mode === "all") return "Все проекты";
  if (!access.siteIds.length) return "Нет доступа к проектам";
  const names = access.siteIds.map(id => sites.find(site => site.id === id)?.name ?? "Недоступный проект");
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} и ещё ${names.length - 2}` : names.join(", ");
}

export function userDraftProjectAccess(draft: { role: UserRole; assignedSiteId: string; projectAccess?: ProjectAccess }): ProjectAccess {
  return effectiveProjectAccess({ role: draft.role, assignedSiteId: Number(draft.assignedSiteId) || null, projectAccess: draft.projectAccess });
}

export function userProjectAccessValid(access: ProjectAccess, sites: readonly { id: number }[], allowEmpty = false) {
  return access.mode === "all" || (allowEmpty || access.siteIds.length > 0) && access.siteIds.every(id => sites.some(site => site.id === id));
}

export function userVisibleProjects<T extends { id: number }>(user: ProjectUser, sites: readonly T[]): T[] {
  return sites.filter(site => canAccessProject(user, site.id));
}

/** Undefined means all projects; a numeric legacy scope or list restricts edits. */
export function profileProjectChangeAllowed(requiredSiteId: number | readonly number[] | undefined, value: string) {
  if (requiredSiteId === undefined) return true;
  const ids = typeof requiredSiteId === "number" ? [requiredSiteId] : requiredSiteId;
  return Boolean(value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && ids.includes(Number(value));
}
