import { getDatabase } from "../../../db/client";
import { withAuditTrail } from "../../auditLog";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { hasPermission, limitPermissionsToRole, normalizePermissionSet, rolePermissionTemplate, type PermissionSet } from "../../permissionModel";
import { ensurePermissionSchema, loadEffectivePermissions, resetUserPermissions, saveUserPermissions } from "../../permissions";
import { canManageUserProjectAccess, ensureUserProjectAccessSchema, loadUserProjectAccess, normalizeProjectAccess, saveUserProjectAccess } from "../../projectAccessServer";
import { accessibleProjectIds, isUserRole, visibleUserProjectAccess, type UserRole } from "../../roles";
import { ensureCustomRolesSchema, loadCustomRole } from "../../customRolesServer";

function errorResponse(message: string, status: number) { return Response.json({ error: message }, { status }); }
function positiveInteger(value: unknown) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; }

export async function GET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return errorResponse("Требуется авторизация.", 401);
    if (!hasPermission(authUser.permissions, "access_rights", "view")) return errorResponse("Недостаточно прав для просмотра настроек доступа.", 403);
    await ensureUserProjectAccessSchema();
    await ensureCustomRolesSchema();
    const allowedIds = accessibleProjectIds(authUser);
    const scoped = allowedIds !== null;
    if (scoped && !allowedIds.length) return Response.json({ users: [], sites: [], canManage: false, currentUserId: authUser.id });
    const result = await getDatabase().prepare(`SELECT u.id, u.full_name AS fullName, u.email,
        CASE WHEN u.role = 'office' THEN 'superadmin' WHEN u.role = 'admin' THEN 'engineer' ELSE u.role END AS role,
        u.assigned_site_id AS assignedSiteId, site.name AS assignedSiteName, u.custom_role_id AS customRoleId
      FROM app_users u LEFT JOIN sites site ON site.id = u.assigned_site_id
      WHERE u.active = 1${scoped ? ` AND (EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = u.id AND access.all_projects = 1)
        OR EXISTS (SELECT 1 FROM user_project_access_sites grant_site WHERE grant_site.user_id = u.id AND grant_site.site_id = ANY(?::integer[]))
        OR (NOT EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = u.id)
          AND u.custom_role_id IS NULL AND (u.role IN ('engineer','superadmin','office','admin') OR u.role = 'foreman' AND u.assigned_site_id = ANY(?::integer[]))))` : ""} ORDER BY u.full_name`)
      .bind(...(scoped ? [allowedIds, allowedIds] : [])).all<{ id: number; fullName: string; email: string; role: UserRole; assignedSiteId: number | null; assignedSiteName: string | null; customRoleId?: number | null }>();
    const users = await Promise.all(result.results.filter(user => isUserRole(user.role)).map(async user => {
      const customRole = user.customRoleId ? await loadCustomRole(user.customRoleId) : null;
      if (user.customRoleId && (!customRole || customRole.baseRole !== user.role)) throw new Error("Пользовательская роль недоступна. Обновите список ролей.");
      const settings = await loadUserProjectAccess(user);
      const permissions = await loadEffectivePermissions(user.id, user.role, settings.projectAccess, getDatabase(), customRole, settings.canViewPendingReports);
      return visibleUserProjectAccess({ ...user, customRoleId: customRole?.id ?? null, customRoleName: customRole?.name ?? null,
        roleTemplate: customRole?.permissions ?? rolePermissionTemplate(user.role), ...permissions, customized: permissions.permissionsCustomized,
        permissionsManageable: canManageUserProjectAccess(authUser, settings.projectAccess), ...settings }, authUser);
    }));
    const sites = await getDatabase().prepare(`SELECT id, name FROM sites WHERE active = 1${scoped ? " AND id = ANY(?::integer[])" : ""} ORDER BY name, id`)
      .bind(...(scoped ? [allowedIds] : [])).all<{ id: number; name: string }>();
    return Response.json({ users, sites: sites.results, canManage: hasPermission(authUser.permissions, "access_rights", "update"), currentUserId: authUser.id });
  } catch (error) {
    console.error("Access rights request failed", error);
    return errorResponse(error instanceof Error ? error.message : "Не удалось загрузить права доступа.", 500);
  }
}

async function handlePOST(request: Request) {
  try {
    assertSameOrigin(request);
    const authUser = await getAuthUser(request);
    if (!authUser) return errorResponse("Требуется авторизация.", 401);
    if (!hasPermission(authUser.permissions, "access_rights", "view") || !hasPermission(authUser.permissions, "access_rights", "update")) return errorResponse("Недостаточно прав для изменения настроек доступа.", 403);
    const payload = await request.json() as { userId?: unknown; reset?: unknown; permissions?: unknown; projectAccess?: unknown; canViewPendingReports?: unknown };
    const userId = positiveInteger(payload.userId);
    if (!userId) return errorResponse("Не выбран пользователь.", 400);
    if (payload.reset !== true && payload.permissions === undefined && payload.projectAccess === undefined && payload.canViewPendingReports === undefined) return errorResponse("Не переданы изменения доступа.", 400);
    if (payload.permissions !== undefined && (!payload.permissions || typeof payload.permissions !== "object" || Array.isArray(payload.permissions))) return errorResponse("Не передан набор разрешений.", 400);
    await ensureUserProjectAccessSchema();
    await ensurePermissionSchema();
    await ensureCustomRolesSchema();
    const result = await getDatabase().transaction(async db => {
      const target = await db.prepare(`SELECT id, CASE WHEN role = 'office' THEN 'superadmin' WHEN role = 'admin' THEN 'engineer' ELSE role END AS role,
        assigned_site_id AS assignedSiteId, custom_role_id AS customRoleId FROM app_users WHERE id = ? AND active = 1 FOR UPDATE`).bind(userId).first<{ id: number; role: UserRole; assignedSiteId: number | null; customRoleId?: number | null }>();
      if (!target || !isUserRole(target.role)) throw new Error("Пользователь не найден.");
      const customRole = target.customRoleId ? await loadCustomRole(target.customRoleId, db) : null;
      if (target.customRoleId && (!customRole || customRole.baseRole !== target.role)) throw new Error("Пользовательская роль недоступна.");
      const previousSettings = await loadUserProjectAccess(target, db);
      const requestedAccess = payload.projectAccess === undefined ? previousSettings.projectAccess : normalizeProjectAccess(payload.projectAccess);
      if (!canManageUserProjectAccess(authUser, previousSettings.projectAccess) || !canManageUserProjectAccess(authUser, requestedAccess)) {
        throw Object.assign(new Error("Нельзя изменять доступ пользователя за пределами ваших проектов."), { status: 403 });
      }
      const settings = payload.projectAccess !== undefined || payload.canViewPendingReports !== undefined
        ? await saveUserProjectAccess(userId, { projectAccess: payload.projectAccess, canViewPendingReports: payload.canViewPendingReports }, authUser.id, db)
        : previousSettings;
      if (payload.reset === true) {
        await resetUserPermissions(userId, db);
      } else if (payload.permissions !== undefined) {
        const permissions = limitPermissionsToRole(target.role, normalizePermissionSet(payload.permissions as Partial<PermissionSet>), settings.projectAccess);
        if (userId === authUser.id && (!permissions.access_rights.view || !permissions.access_rights.update)) throw new Error("Нельзя отключить себе просмотр и изменение прав доступа.");
        await saveUserPermissions(userId, permissions, authUser.id, db);
      }
      const effective = await loadEffectivePermissions(userId, target.role, settings.projectAccess, db, customRole, settings.canViewPendingReports);
      if (userId === authUser.id && (!effective.permissions.access_rights.view || !effective.permissions.access_rights.update)) throw new Error("Нельзя отключить себе просмотр и изменение прав доступа.");
      return { permissions: effective.permissions, customized: effective.permissionsCustomized, ...settings };
    });
    return Response.json(result);
  } catch (error) {
    console.error("Access rights update failed", error);
    return errorResponse(error instanceof Error ? error.message : "Не удалось сохранить права доступа.", error && typeof error === "object" && "status" in error && error.status === 403 ? 403 : 400);
  }
}
export async function POST(request: Request) { return withAuditTrail(request, handlePOST); }
