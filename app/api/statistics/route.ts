import { getDatabase } from "../../../db/client";
import { getAuthUser } from "../../auth";
import { hasPermission } from "../../permissionModel";
import { validPersonnelReportDate } from "../../personnelReportWorkflow";
import { canAccessProject } from "../../roles";
import { readStatisticsRows } from "../../statisticsData";
import { STATISTICS_MAX_RANGE_DAYS } from "../../statisticsTypes";

export async function GET(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) return Response.json({ error: "Требуется авторизация." }, { status: 401 });

    const params = new URL(request.url).searchParams;
    const siteId = Number(params.get("siteId"));
    const kind = params.get("kind");
    if (!Number.isSafeInteger(siteId) || siteId < 1 || siteId > 2_147_483_647 || (kind !== "personnel" && kind !== "equipment")) {
      return Response.json({ error: "Укажите проект и раздел статистики." }, { status: 400 });
    }
    const resource = kind === "personnel" ? "workers_statistics" : "equipment_statistics";
    if (!canAccessProject(user, siteId) || !hasPermission(user.permissions, resource, "view")) {
      return Response.json({ error: "Нет доступа к статистике этого проекта." }, { status: 403 });
    }

    const from = params.get("from");
    const to = params.get("to");
    if (!validPersonnelReportDate(from) || !validPersonnelReportDate(to) || from.startsWith("0000-") || to.startsWith("0000-") || from > to) {
      return Response.json({ error: "Укажите корректный период статистики." }, { status: 400 });
    }
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    if (days > STATISTICS_MAX_RANGE_DAYS) {
      return Response.json({ error: `Выберите период не длиннее ${STATISTICS_MAX_RANGE_DAYS} дней.` }, { status: 400 });
    }

    const db = getDatabase();
    const site = await db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(siteId).first();
    if (!site) return Response.json({ error: "Проект не найден." }, { status: 404 });
    const rows = await readStatisticsRows(db, siteId, kind, from, to);
    return Response.json({ rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Statistics request failed", error);
    return Response.json({ error: "Не удалось загрузить статистику." }, { status: 500 });
  }
}
