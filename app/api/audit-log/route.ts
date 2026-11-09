import { getDatabase } from "../../../db/client";
import { ensureAuditSchema } from "../../auditLog";
import { getAuthUser } from "../../auth";
import { hasPermission, hasReportStatusPermission } from "../../permissionModel";
import { accessibleProjectIds, hasRestrictedProjectAccess } from "../../roles";

function positiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return Response.json({ error: "Требуется авторизация." }, { status: 401 });
    if (!hasPermission(authUser.permissions, "audit_log", "view")) return Response.json({ error: "Журнал действий недоступен для вашей учётной записи." }, { status: 403 });
    const scoped = hasRestrictedProjectAccess(authUser);
    const siteIds = accessibleProjectIds(authUser);
    if (scoped && !siteIds?.length) return Response.json({ error: "Для пользователя не назначен проект." }, { status: 403 });
    await ensureAuditSchema();

    const url = new URL(request.url);
    const limit = Math.min(500, positiveInteger(url.searchParams.get("limit"), 200));
    const beforeId = positiveInteger(url.searchParams.get("beforeId"), 0);
    // A report event can contain its earlier draft, requested rows and review
    // comments even after that report has been approved. Filtering on the
    // current report status would therefore still reveal pending information.
    const hideReportEvents = !(["workers_report", "equipment_report"] as const).some(resource => hasReportStatusPermission(authUser.permissions, resource, "draft", "view") || hasReportStatusPermission(authUser.permissions, resource, "submitted", "view"));
    const conditions = [
      ...(scoped ? ["site_id = ANY(?::integer[])"] : []),
      ...(beforeId ? ["id < ?"] : []),
      ...(hideReportEvents ? [`NOT (category = 'reports'
        OR action_key LIKE 'personnel_report.%' OR action_key LIKE 'equipment_report.%'
        OR entity_type IN ('personnel_report', 'personnel_report_draft', 'equipment_report', 'equipment_report_draft', 'placement_entry', 'equipment_entry')
        OR entity_type = 'table_row_order' AND entity_id IN ('personnel-report-rows', 'equipment-report-rows'))`] : []),
    ];
    const result = await getDatabase().prepare(`SELECT id, actor_user_id AS "actorUserId", actor_name AS "actorName", actor_role AS "actorRole",
          category, action_key AS "actionKey", entity_type AS "entityType", entity_id AS "entityId", site_id AS "siteId",
          site_name AS "siteName", summary, before_data AS "beforeData", after_data AS "afterData", created_at AS "createdAt"
        FROM audit_events${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .bind(...(scoped ? [siteIds] : []), ...(beforeId ? [beforeId] : []), limit).all();
    return Response.json({ events: result.results, hasMore: result.results.length === limit });
  } catch (error) {
    console.error("Audit log request failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось загрузить журнал действий." }, { status: 500 });
  }
}
