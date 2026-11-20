export const STATISTICS_MAX_RANGE_DAYS = 366;

export type StatisticsKind = "personnel" | "equipment";
export type StatisticsGrouping = "zone" | "day";

export type StatisticsHours = {
  welders: number;
  installers: number;
  other: number;
  productive: number;
  downtime: number;
  total: number;
};

export type StatisticsPersonnelCounts = { total: number; welders: number; installers: number; other: number };
export type StatisticsRow = StatisticsHours & { zoneId: number | null; zone: string; personnelCounts?: StatisticsPersonnelCounts };
export type StatisticsDayRow = StatisticsHours & { workDate: string; personnelCounts?: StatisticsPersonnelCounts };
export type StatisticsBreakdownRow = StatisticsRow | StatisticsDayRow;
