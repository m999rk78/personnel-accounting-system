import type { PostgresDatabase } from "../db/client";
import type { StatisticsKind, StatisticsRow } from "./statisticsTypes";

type HoursByTitle = { zoneId: number | null; zone: string | null; title: string | null; hours: number };

const personnelHoursByZone = `SELECT zone.id AS "zoneId", zone.name AS zone, entry.position_snapshot AS title, SUM(entry.hours) AS hours
  FROM placement_entries entry
  JOIN employees employee ON employee.id = entry.employee_id
  LEFT JOIN zones zone ON zone.id = entry.zone_id AND zone.site_id = entry.site_id
  WHERE entry.site_id = ? AND entry.work_date BETWEEN ? AND ? AND entry.deleted_at IS NULL
    AND UPPER(TRIM(COALESCE(NULLIF(entry.employment_type_snapshot, ''), employee.employment_type))) = 'ОПР'
  GROUP BY zone.id, zone.name, entry.position_snapshot`;

const equipmentHoursByZone = `SELECT zone.id AS "zoneId", zone.name AS zone, subwork.name AS title, SUM(entry.hours) AS hours
  FROM equipment_entries entry
  LEFT JOIN zones zone ON zone.id = entry.zone_id AND zone.site_id = entry.site_id
  LEFT JOIN subwork_types subwork ON subwork.id = entry.subwork_type_id AND subwork.site_id = entry.site_id
  WHERE entry.site_id = ? AND entry.work_date BETWEEN ? AND ? AND entry.deleted_at IS NULL
  GROUP BY zone.id, zone.name, subwork.name`;

function hoursGroup(kind: StatisticsKind, title: string | null): "welders" | "installers" | "other" | "productive" | "downtime" {
  const name = title?.toLocaleLowerCase("ru-RU") ?? "";
  if (kind === "equipment") return name.includes("простой") ? "downtime" : "productive";
  if (name.includes("сварщик")) return "welders";
  if (name.includes("монтажник")) return "installers";
  return "other";
}

export async function readStatisticsRows(db: Pick<PostgresDatabase, "prepare">, siteId: number, kind: StatisticsKind, from: string, to: string): Promise<StatisticsRow[]> {
  // The entry tables contain the hours published by approved reports, including older records.
  const sql = kind === "personnel" ? personnelHoursByZone : equipmentHoursByZone;
  const { results } = await db.prepare(sql).bind(siteId, from, to).all<HoursByTitle>();
  const zones = new Map<number | null, StatisticsRow>();
  for (const source of results) {
    let row = zones.get(source.zoneId);
    if (!row) {
      row = { zoneId: source.zoneId, zone: source.zone?.trim() || "Без зоны", welders: 0, installers: 0, other: 0, productive: 0, downtime: 0, total: 0 };
      zones.set(source.zoneId, row);
    }
    row[hoursGroup(kind, source.title)] += source.hours;
    row.total += source.hours;
  }
  return [...zones.values()].sort((left, right) => right.total - left.total || left.zone.localeCompare(right.zone, "ru") || (left.zoneId ?? 0) - (right.zoneId ?? 0));
}
