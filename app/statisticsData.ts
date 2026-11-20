import type { PostgresDatabase } from "../db/client";
import type { StatisticsDayRow, StatisticsGrouping, StatisticsHours, StatisticsKind, StatisticsPersonnelCounts, StatisticsRow } from "./statisticsTypes";

type HoursByTitle = { title: string | null; hours: number; employeeIds?: number[] };
type ZoneHoursByTitle = HoursByTitle & { zoneId: number | null; zone: string | null };
type DayHoursByTitle = HoursByTitle & { workDate: string };
type StatisticsRange = [] | [from: string, to: string];

const groupings = {
  zone: {
    select: 'zone.id AS "zoneId", zone.name AS zone',
    groupBy: "zone.id, zone.name",
    join: "\n  LEFT JOIN zones zone ON zone.id = entry.zone_id AND zone.site_id = entry.site_id",
  },
  day: { select: 'entry.work_date AS "workDate"', groupBy: "entry.work_date", join: "" },
};

function statisticsHoursByTitle(kind: StatisticsKind, grouping: StatisticsGrouping, hasRange: boolean) {
  const { select, groupBy, join } = groupings[grouping];
  const datePredicate = hasRange ? " AND entry.work_date BETWEEN ? AND ?" : "";
  // Both views read the same published report entries, including older records.
  if (kind === "personnel") return `SELECT ${select}, entry.position_snapshot AS title, SUM(entry.hours) AS hours,
    JSON_AGG(DISTINCT entry.employee_id) AS "employeeIds"
  FROM placement_entries entry
  JOIN employees employee ON employee.id = entry.employee_id${join}
  WHERE entry.site_id = ?${datePredicate} AND entry.deleted_at IS NULL
    AND UPPER(TRIM(COALESCE(NULLIF(entry.employment_type_snapshot, ''), employee.employment_type))) = 'ОПР'
  GROUP BY ${groupBy}, entry.position_snapshot`;

  return `SELECT ${select}, subwork.name AS title, SUM(entry.hours) AS hours
  FROM equipment_entries entry${join}
  LEFT JOIN subwork_types subwork ON subwork.id = entry.subwork_type_id AND subwork.site_id = entry.site_id
  WHERE entry.site_id = ?${datePredicate} AND entry.deleted_at IS NULL
  GROUP BY ${groupBy}, subwork.name`;
}

function personnelGroup(title: string | null): "welders" | "installers" | "other" {
  const name = title?.toLocaleLowerCase("ru-RU") ?? "";
  if (name.includes("сварщик")) return "welders";
  if (name.includes("монтажник")) return "installers";
  return "other";
}

function hoursGroup(kind: StatisticsKind, title: string | null) {
  if (kind === "equipment") return title?.toLocaleLowerCase("ru-RU").includes("простой") ? "downtime" : "productive";
  return personnelGroup(title);
}

const emptyHours: StatisticsHours = { welders: 0, installers: 0, other: 0, productive: 0, downtime: 0, total: 0 };
type PersonnelSets = Record<keyof StatisticsPersonnelCounts, Set<number>>;

function addPersonnelCounts(row: StatisticsRow | StatisticsDayRow, source: HoursByTitle, people: Map<StatisticsRow | StatisticsDayRow, PersonnelSets>) {
  if (!source.employeeIds) return;
  let counts = people.get(row);
  if (!counts) {
    counts = { total: new Set(), welders: new Set(), installers: new Set(), other: new Set() };
    people.set(row, counts);
  }
  const group = personnelGroup(source.title);
  for (const employeeId of source.employeeIds) {
    counts.total.add(employeeId);
    counts[group].add(employeeId);
  }
  row.personnelCounts = { total: counts.total.size, welders: counts.welders.size, installers: counts.installers.size, other: counts.other.size };
}

export async function readStatisticsRows(db: Pick<PostgresDatabase, "prepare">, siteId: number, kind: StatisticsKind, ...range: StatisticsRange): Promise<StatisticsRow[]> {
  const sql = statisticsHoursByTitle(kind, "zone", range.length > 0);
  const { results } = await db.prepare(sql).bind(siteId, ...range).all<ZoneHoursByTitle>();
  const zones = new Map<number | null, StatisticsRow>();
  const people = new Map<StatisticsRow | StatisticsDayRow, PersonnelSets>();
  for (const source of results) {
    let row = zones.get(source.zoneId);
    if (!row) {
      row = { zoneId: source.zoneId, zone: source.zone?.trim() || "Без зоны", ...emptyHours };
      zones.set(source.zoneId, row);
    }
    row[hoursGroup(kind, source.title)] += source.hours;
    row.total += source.hours;
    if (kind === "personnel") addPersonnelCounts(row, source, people);
  }
  return [...zones.values()].sort((left, right) => right.total - left.total || left.zone.localeCompare(right.zone, "ru") || (left.zoneId ?? 0) - (right.zoneId ?? 0));
}

export async function readStatisticsByDay(db: Pick<PostgresDatabase, "prepare">, siteId: number, kind: StatisticsKind, ...range: StatisticsRange): Promise<StatisticsDayRow[]> {
  const sql = statisticsHoursByTitle(kind, "day", range.length > 0);
  const { results } = await db.prepare(sql).bind(siteId, ...range).all<DayHoursByTitle>();
  const days = new Map<string, StatisticsDayRow>();
  const people = new Map<StatisticsRow | StatisticsDayRow, PersonnelSets>();
  for (const source of results) {
    let row = days.get(source.workDate);
    if (!row) {
      row = { workDate: source.workDate, ...emptyHours };
      days.set(source.workDate, row);
    }
    row[hoursGroup(kind, source.title)] += source.hours;
    row.total += source.hours;
    if (kind === "personnel") addPersonnelCounts(row, source, people);
  }
  return [...days.values()].sort((left, right) => left.workDate.localeCompare(right.workDate));
}
