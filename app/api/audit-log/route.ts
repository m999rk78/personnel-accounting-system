import { getDatabase } from "../../../db/client";
import { ensureAuditSchema } from "../../auditLog";
import { getAuthUser } from "../../auth";
import { hasPermission } from "../../permissionModel";

function positiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return Response.json({ error: "Требуется авторизация." }, { status: 401 });
    if (!hasPermission(authUser.permissions, "audit_log", "view")) return Response.json({ error: "Журнал действий недоступен для вашей учётной записи." }, { status: 403 });
    await ensureAuditSchema();

    const url = new URL(request.url);
    const limit = Math.min(500, positiveInteger(url.searchParams.get("limit"), 200));
    const beforeId = positiveInteger(url.searchParams.get("beforeId"), 0);
    const result = beforeId
      ? await getDatabase().prepare(`SELECT id, actor_user_id AS "actorUserId", actor_name AS "actorName", actor_role AS "actorRole",
          category, action_key AS "actionKey", entity_type AS "entityType", entity_id AS "entityId", site_id AS "siteId",
          site_name AS "siteName", summary, before_data AS "beforeData", after_data AS "afterData", created_at AS "createdAt"
        FROM audit_events WHERE id < ? ORDER BY id DESC LIMIT ?`).bind(beforeId, limit).all()
      : await getDatabase().prepare(`SELECT id, actor_user_id AS "actorUserId", actor_name AS "actorName", actor_role AS "actorRole",
          category, action_key AS "actionKey", entity_type AS "entityType", entity_id AS "entityId", site_id AS "siteId",
          site_name AS "siteName", summary, before_data AS "beforeData", after_data AS "afterData", created_at AS "createdAt"
        FROM audit_events ORDER BY id DESC LIMIT ?`).bind(limit).all();
    return Response.json({ events: result.results, hasMore: result.results.length === limit });
  } catch (error) {
    console.error("Audit log request failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось загрузить журнал действий." }, { status: 500 });
  }
}
