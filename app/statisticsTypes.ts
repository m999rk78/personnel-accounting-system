export const STATISTICS_MAX_RANGE_DAYS = 366;

export type StatisticsKind = "personnel" | "equipment";

export type StatisticsRow = {
  zoneId: number | null;
  zone: string;
  welders: number;
  installers: number;
  other: number;
  productive: number;
  downtime: number;
  total: number;
};
