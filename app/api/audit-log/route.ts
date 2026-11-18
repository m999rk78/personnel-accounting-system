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
    // Raw audit snapshots can mix earlier and later statuses, including arbitrary
    // legacy request fields. A current status alone cannot authorize the entire
    // snapshot, and access to one report kind must never grant the other kind.
    const reportKinds = [
      { resource: "workers_report", predicate: `(action_key LIKE 'personnel_report.%'
        OR entity_type IN ('personnel_report', 'personnel_report_draft', 'placement_entry')
        OR entity_type = 'table_row_order' AND entity_id = 'personnel-report-rows')` },
      { resource: "equipment_report", predicate: `(action_key LIKE 'equipment_report.%'
        OR entity_type IN ('equipment_report', 'equipment_report_draft', 'equipment_entry')
        OR entity_type = 'table_row_order' AND entity_id = 'equipment-report-rows')` },
    ] as const;
    const readableReports = reportKinds.filter(({ resource }) => (["draft", "submitted", "approved"] as const)
      .every(status => hasReportStatusPermission(authUser.permissions, resource, status, "view")));
    const hiddenReports = reportKinds.filter(kind => !readableReports.includes(kind));
    const conditions = [
      ...(scoped ? ["site_id = ANY(?::integer[])"] : []),
      ...(beforeId ? ["id < ?"] : []),
      ...(!readableReports.length ? [`NOT (category = 'reports'
        OR action_key LIKE 'personnel_report.%' OR action_key LIKE 'equipment_report.%'
        OR entity_type IN ('personnel_report', 'personnel_report_draft', 'equipment_report', 'equipment_report_draft', 'placement_entry', 'equipment_entry')
        OR entity_type = 'table_row_order' AND entity_id IN ('personnel-report-rows', 'equipment-report-rows'))`] : []),
      ...(readableReports.length === 1 ? [
        ...hiddenReports.map(kind => `NOT ${kind.predicate}`),
        `NOT (category = 'reports' AND NOT ${readableReports[0].predicate})`,
      ] : []),
    ];
    // Older catalog mutations accidentally looked up a report row with the
    // same numeric ID. Keep their history, but never return that unrelated data.
    const result = await getDatabase().prepare(`SELECT id, actor_user_id AS "actorUserId", actor_name AS "actorName", actor_role AS "actorRole",
          category, action_key AS "actionKey", entity_type AS "entityType", entity_id AS "entityId", site_id AS "siteId",
          site_name AS "siteName", summary,
          CASE WHEN request_path = '/api/data' AND action_key NOT LIKE 'personnel_report.%'
            OR request_path = '/api/equipment' AND action_key NOT LIKE 'equipment_report.%' AND action_key NOT LIKE 'equipment_timesheet.%'
            THEN NULL ELSE before_data END AS "beforeData",
          after_data AS "afterData", created_at AS "createdAt"
        FROM audit_events${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .bind(...(scoped ? [siteIds] : []), ...(beforeId ? [beforeId] : []), limit).all();
    return Response.json({ events: result.results, hasMore: result.results.length === limit });
  } catch (error) {
    console.error("Audit log request failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось загрузить журнал действий." }, { status: 500 });
  }
}
