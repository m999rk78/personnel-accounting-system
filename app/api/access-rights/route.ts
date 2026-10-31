import { getDatabase } from "../../../db/client";
import { withAuditTrail } from "../../auditLog";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { hasPermission, limitPermissionsToRole, normalizePermissionSet, rolePermissionTemplate, type PermissionSet } from "../../permissionModel";
import { ensurePermissionSchema, loadEffectivePermissions, resetUserPermissions, saveUserPermissions } from "../../permissions";
import { ensureUserProjectAccessSchema, loadUserProjectAccess, saveUserProjectAccess } from "../../projectAccessServer";
import { accessibleProjectIds, hasRestrictedProjectAccess, isUserRole, visibleUserProjectAccess, type UserRole } from "../../roles";

function errorResponse(message: string, status: number) { return Response.json({ error: message }, { status }); }
function positiveInteger(value: unknown) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; }

export async function GET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return errorResponse("Требуется авторизация.", 401);
    if (!hasPermission(authUser.permissions, "access_rights", "view")) return errorResponse("Недостаточно прав для просмотра настроек доступа.", 403);
    await ensureUserProjectAccessSchema();
    const allowedIds = accessibleProjectIds(authUser);
    const scoped = allowedIds !== null;
    if (scoped && !allowedIds.length) return Response.json({ users: [], sites: [], canManage: false, currentUserId: authUser.id });
    const result = await getDatabase().prepare(`SELECT u.id, u.full_name AS fullName, u.email,
        CASE WHEN u.role = 'office' THEN 'superadmin' WHEN u.role = 'admin' THEN 'engineer' ELSE u.role END AS role,
        u.assigned_site_id AS assignedSiteId, site.name AS assignedSiteName
      FROM app_users u LEFT JOIN sites site ON site.id = u.assigned_site_id
      WHERE u.active = 1${scoped ? ` AND (EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = u.id AND access.all_projects = 1)
        OR EXISTS (SELECT 1 FROM user_project_access_sites grant_site WHERE grant_site.user_id = u.id AND grant_site.site_id = ANY(?::integer[]))
        OR (NOT EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = u.id)
          AND (u.role IN ('engineer','superadmin','office','admin') OR u.role = 'foreman' AND u.assigned_site_id = ANY(?::integer[]))))` : ""} ORDER BY u.full_name`)
      .bind(...(scoped ? [allowedIds, allowedIds] : [])).all<{ id: number; fullName: string; email: string; role: UserRole; assignedSiteId: number | null; assignedSiteName: string | null }>();
    const users = await Promise.all(result.results.filter(user => isUserRole(user.role)).map(async user => {
      const settings = await loadUserProjectAccess(user);
      const permissions = await loadEffectivePermissions(user.id, user.role, settings.projectAccess);
      return visibleUserProjectAccess({ ...user, ...permissions, customized: permissions.permissionsCustomized, ...settings }, authUser);
    }));
    const sites = await getDatabase().prepare(`SELECT id, name FROM sites WHERE active = 1${scoped ? " AND id = ANY(?::integer[])" : ""} ORDER BY name, id`)
      .bind(...(scoped ? [allowedIds] : [])).all<{ id: number; name: string }>();
    return Response.json({ users, sites: sites.results, canManage: authUser.role !== "viewer" && !scoped && hasPermission(authUser.permissions, "access_rights", "update"), currentUserId: authUser.id });
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
    if (authUser.role === "viewer" || hasRestrictedProjectAccess(authUser) || !hasPermission(authUser.permissions, "access_rights", "update")) return errorResponse("Недостаточно прав для изменения настроек доступа.", 403);
    const payload = await request.json() as { userId?: unknown; reset?: unknown; permissions?: unknown; projectAccess?: unknown; canViewPendingReports?: unknown };
    const userId = positiveInteger(payload.userId);
    if (!userId) return errorResponse("Не выбран пользователь.", 400);
    if (payload.reset !== true && payload.permissions === undefined && payload.projectAccess === undefined && payload.canViewPendingReports === undefined) return errorResponse("Не переданы изменения доступа.", 400);
    if (payload.permissions !== undefined && (!payload.permissions || typeof payload.permissions !== "object" || Array.isArray(payload.permissions))) return errorResponse("Не передан набор разрешений.", 400);
    await ensureUserProjectAccessSchema();
    await ensurePermissionSchema();
    const result = await getDatabase().transaction(async db => {
      const target = await db.prepare(`SELECT id, CASE WHEN role = 'office' THEN 'superadmin' WHEN role = 'admin' THEN 'engineer' ELSE role END AS role,
        assigned_site_id AS assignedSiteId FROM app_users WHERE id = ? AND active = 1 FOR UPDATE`).bind(userId).first<{ id: number; role: UserRole; assignedSiteId: number | null }>();
      if (!target || !isUserRole(target.role)) throw new Error("Пользователь не найден.");
      const settings = payload.projectAccess !== undefined || payload.canViewPendingReports !== undefined
        ? await saveUserProjectAccess(userId, { projectAccess: payload.projectAccess, canViewPendingReports: payload.canViewPendingReports }, authUser.id, db)
        : await loadUserProjectAccess(target, db);
      if (payload.reset === true) {
        if (userId === authUser.id && target.role !== "superadmin") throw new Error("Нельзя сбросить собственные права управления доступом.");
        await resetUserPermissions(userId, db);
      } else if (payload.permissions !== undefined) {
        const permissions = limitPermissionsToRole(target.role, normalizePermissionSet(payload.permissions as Partial<PermissionSet>), settings.projectAccess);
        if (userId === authUser.id && (!permissions.access_rights.view || !permissions.access_rights.update)) throw new Error("Нельзя отключить себе просмотр и изменение прав доступа.");
        await saveUserPermissions(userId, permissions, authUser.id, db);
      }
      const effective = payload.reset === true ? { permissions: limitPermissionsToRole(target.role, rolePermissionTemplate(target.role), settings.projectAccess), permissionsCustomized: false }
        : await loadEffectivePermissions(userId, target.role, settings.projectAccess, db);
      if (userId === authUser.id && (!effective.permissions.access_rights.view || !effective.permissions.access_rights.update)) throw new Error("Нельзя отключить себе просмотр и изменение прав доступа.");
      return { permissions: effective.permissions, customized: effective.permissionsCustomized, ...settings };
    });
    return Response.json(result);
  } catch (error) {
    console.error("Access rights update failed", error);
    return errorResponse(error instanceof Error ? error.message : "Не удалось сохранить права доступа.", 400);
  }
}
export async function POST(request: Request) { return withAuditTrail(request, handlePOST); }
