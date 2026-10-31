import { getDatabase } from "../../../db/client";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { withAuditTrail } from "../../auditLog";
import { CustomRoleError } from "../../customRoles";
import { createCustomRole, ensureCustomRolesSchema, listCustomRoles } from "../../customRolesServer";
import { hasPermission } from "../../permissionModel";
import { accessibleProjectIds, hasRestrictedProjectAccess } from "../../roles";

function canManageRoles(user: NonNullable<Awaited<ReturnType<typeof getAuthUser>>>) {
  return user.role !== "viewer" && !hasRestrictedProjectAccess(user) && hasPermission(user.permissions, "access_rights", "update");
}

export async function GET(request: Request) {
  const user = await getAuthUser(request);
  if (!user) return Response.json({ error: "Войдите в систему." }, { status: 401 });
  if (accessibleProjectIds(user)?.length === 0 || !(["access_rights", "system_users"] as const)
    .some(resource => hasPermission(user.permissions, resource, "view") || resource === "system_users"
      && (hasPermission(user.permissions, resource, "create") || hasPermission(user.permissions, resource, "update")))) {
    return Response.json({ error: "Нет права просмотра ролей." }, { status: 403 });
  }
  try {
    await ensureCustomRolesSchema();
    return Response.json({ roles: await listCustomRoles(getDatabase()), canManage: canManageRoles(user) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Roles read failed", error);
    return Response.json({ error: "Не удалось загрузить роли." }, { status: 500 });
  }
}

async function createRole(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await getAuthUser(request);
    if (!user) return Response.json({ error: "Войдите в систему." }, { status: 401 });
    if (!canManageRoles(user)) return Response.json({ error: "Нет права добавлять роли." }, { status: 403 });
    const payload = await request.json() as { name?: unknown; permissions?: unknown };
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return Response.json({ error: "Передайте название и права роли." }, { status: 400 });
    const role = await createCustomRole({ name: payload.name, permissions: payload.permissions }, user.id);
    return Response.json({ role, id: role.id }, { status: 201 });
  } catch (error) {
    if (error instanceof CustomRoleError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "Передайте название и права роли." }, { status: 400 });
    console.error("Role creation failed", error);
    return Response.json({ error: "Не удалось сохранить роль. Повторите попытку." }, { status: 500 });
  }
}

export async function POST(request: Request) { return withAuditTrail(request, createRole); }
