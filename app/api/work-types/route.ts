import { getDatabase } from "../../../db/client";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { withAuditTrail } from "../../auditLog";
import { hasPermission } from "../../permissionModel";
import { canAccessProject } from "../../roles";
import { assignWorkTypeChildren, importWorkTypeDirectory } from "../../workTypeHierarchyServer";
import { archiveWorkTypesDirectory, saveWorkTypesDirectory, type WorkTypeParentInput, type WorkTypeChildInput } from "../../workTypesEditingServer";

export async function POST(request: Request) {
  return withAuditTrail(request, async () => {
    try {
      assertSameOrigin(request);
      const user = await getAuthUser(request);
      if (!user) return Response.json({ error: "Войдите в систему." }, { status: 401 });
      if (user.role === "viewer") return Response.json({ error: "Роль «Просмотр» не может изменять справочники." }, { status: 403 });
      const payload = await request.json() as { action?: string; siteId: number; mainWorkTypeId?: number; ids?: number[]; entries?: Array<{ name: string; subworkName: string }>; parents?: unknown[]; children?: unknown[] };
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Укажите данные справочника работ.");
      if (!canAccessProject(user, payload.siteId)) return Response.json({ error: "Нет доступа к этому проекту." }, { status: 403 });
      if (!hasPermission(user.permissions, "project_directories", "view")) return Response.json({ error: "Нет доступа к справочникам проекта." }, { status: 403 });
      if (payload.action === "save") {
        if (!Array.isArray(payload.parents) || !Array.isArray(payload.children) || [...payload.parents, ...payload.children].some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Укажите строки справочника.");
        const parents = payload.parents as WorkTypeParentInput[];
        const children = payload.children as WorkTypeChildInput[];
        const rows = [...parents, ...children];
        if (rows.some(row => row.id === undefined) && !hasPermission(user.permissions, "project_directories", "create")) return Response.json({ error: "Для добавления строк нужны права добавления в справочники проекта." }, { status: 403 });
        if (rows.some(row => row.id !== undefined) && !hasPermission(user.permissions, "project_directories", "update")) return Response.json({ error: "Для изменения строк нужны права изменения справочников проекта." }, { status: 403 });
        return Response.json(await saveWorkTypesDirectory(getDatabase(), payload.siteId, { parents, children }));
      }
      if (payload.action === "archive") {
        if (!hasPermission(user.permissions, "project_directories", "delete")) return Response.json({ error: "Для архивирования строк нужны права удаления из справочников проекта." }, { status: 403 });
        if (!Array.isArray(payload.parents) || !Array.isArray(payload.children)) throw new Error("Выберите строки для архивирования.");
        return Response.json(await archiveWorkTypesDirectory(getDatabase(), payload.siteId, { parents: payload.parents as number[], children: payload.children as number[] }));
      }
      if (payload.action === "assign") {
        if (!hasPermission(user.permissions, "project_directories", "update")) return Response.json({ error: "Для назначения вида работы нужны права изменения справочников проекта." }, { status: 403 });
        if (typeof payload.mainWorkTypeId !== "number" || !Array.isArray(payload.ids)) throw new Error("Выберите вид работы и от 1 до 500 подвидов.");
        const count = await assignWorkTypeChildren(getDatabase(), payload.siteId, payload.mainWorkTypeId, payload.ids);
        return Response.json({ count });
      }
      if (!hasPermission(user.permissions, "project_directories", "create") || !hasPermission(user.permissions, "project_directories", "update")) return Response.json({ error: "Для импорта нужны права добавления и изменения справочников проекта." }, { status: 403 });
      if (payload.action !== undefined) throw new Error("Неизвестное действие со справочником работ.");
      if (!Array.isArray(payload.entries) || payload.entries.some(row => !row || typeof row !== "object")) throw new Error("Укажите строки справочника.");
      const count = await importWorkTypeDirectory(getDatabase(), payload.siteId, payload.entries);
      return Response.json({ count });
    } catch (cause) { return Response.json({ error: cause instanceof Error ? cause.message : "Не удалось импортировать справочник." }, { status: 400 }); }
  });
}
