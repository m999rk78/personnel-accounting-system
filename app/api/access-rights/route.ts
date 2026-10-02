import { getDatabase } from "../../../db/client";
import { withAuditTrail } from "../../auditLog";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { hasPermission, normalizePermissionSet, rolePermissionTemplate, type PermissionSet } from "../../permissionModel";
import { loadEffectivePermissions, resetUserPermissions, saveUserPermissions } from "../../permissions";
import { isUserRole, type UserRole } from "../../roles";

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return errorResponse("Требуется авторизация.", 401);
    if (!hasPermission(authUser.permissions, "access_rights", "view")) return errorResponse("Недостаточно прав для просмотра настроек доступа.", 403);
    const result = await getDatabase().prepare(`SELECT u.id, u.full_name AS "fullName", u.email,
        CASE WHEN u.role = 'office' THEN 'superadmin' ELSE u.role END AS role,
        u.assigned_site_id AS "assignedSiteId", site.name AS "assignedSiteName"
      FROM app_users u LEFT JOIN sites site ON site.id = u.assigned_site_id
      WHERE u.active = 1 ORDER BY u.full_name`).all<{ id: number; fullName: string; email: string; role: UserRole; assignedSiteId: number | null; assignedSiteName: string | null }>();
    const users = await Promise.all(result.results.map(async (user) => ({ ...user, ...(await loadEffectivePermissions(user.id, user.role)) })));
    return Response.json({ users, canManage: hasPermission(authUser.permissions, "access_rights", "update"), currentUserId: authUser.id });
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
    if (!hasPermission(authUser.permissions, "access_rights", "update")) return errorResponse("Недостаточно прав для изменения настроек доступа.", 403);
    const payload = await request.json() as { userId?: unknown; reset?: unknown; permissions?: unknown };
    const userId = positiveInteger(payload.userId);
    if (!userId) return errorResponse("Не выбран пользователь.", 400);
    const target = await getDatabase().prepare(`SELECT id, CASE WHEN role = 'office' THEN 'superadmin' ELSE role END AS role
      FROM app_users WHERE id = ? AND active = 1`).bind(userId).first<{ id: number; role: UserRole }>();
    if (!target || !isUserRole(target.role)) return errorResponse("Пользователь не найден.", 404);

    if (payload.reset === true) {
      if (userId === authUser.id && target.role !== "superadmin") return errorResponse("Нельзя сбросить собственные права управления доступом.", 400);
      await resetUserPermissions(userId);
      return Response.json({ permissions: rolePermissionTemplate(target.role), customized: false });
    }

    if (!payload.permissions || typeof payload.permissions !== "object") return errorResponse("Не передан набор разрешений.", 400);
    const permissions = normalizePermissionSet(payload.permissions as Partial<PermissionSet>);
    if (userId === authUser.id && (!permissions.access_rights.view || !permissions.access_rights.update)) {
      return errorResponse("Нельзя отключить себе просмотр и изменение прав доступа.", 400);
    }
    const saved = await saveUserPermissions(userId, permissions, authUser.id);
    return Response.json({ permissions: saved, customized: true });
  } catch (error) {
    console.error("Access rights update failed", error);
    return errorResponse(error instanceof Error ? error.message : "Не удалось сохранить права доступа.", 400);
  }
}

export async function POST(request: Request) {
  return withAuditTrail(request, handlePOST);
}
