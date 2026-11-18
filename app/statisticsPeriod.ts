import { calendarDate, calendarKeyDate, parseCalendarDate, shiftCalendarDate, shiftCalendarMonth } from "./reportDateCalendar.ts";
import { STATISTICS_MAX_RANGE_DAYS } from "./statisticsTypes.ts";

export type StatisticsDateRange = { from: string; to: string };
export type StatisticsPeriodPreset = "all" | "week" | "month" | "previousMonth" | "custom";
export type StatisticsPeriodSelection = { preset: "all" } | { preset: Exclude<StatisticsPeriodPreset, "all">; range: StatisticsDateRange };

export function statisticsPresetRange(preset: "week" | "month" | "previousMonth", today: string): StatisticsDateRange {
  const monthStart = `${today.slice(0, 7)}-01`;
  if (preset === "week") return { from: calendarKeyDate(today, "Home") ?? today, to: today };
  if (preset === "previousMonth") return { from: shiftCalendarMonth(monthStart, -1) ?? monthStart, to: shiftCalendarDate(monthStart, -1) ?? today };
  return { from: monthStart, to: today };
}

export function formatStatisticsDate(date: string) {
  return date.split("-").reverse().join(".");
}

export function parseStatisticsDate(value: string) {
  const text = value.trim();
  if (parseCalendarDate(text)) return text;
  const parts = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/) ?? text.match(/^(\d{2})(\d{2})(\d{4})$/);
  return parts ? calendarDate(Number(parts[3]), Number(parts[2]), Number(parts[1])) : null;
}

export function validateStatisticsRange(draft: StatisticsDateRange) {
  const from = parseStatisticsDate(draft.from);
  const to = parseStatisticsDate(draft.to);
  if (!from || !to) return { error: "Введите обе даты в формате ДД.ММ.ГГГГ." } as const;
  if (from > to) return { error: "Дата окончания должна быть не раньше даты начала." } as const;
  const maxTo = shiftCalendarDate(from, STATISTICS_MAX_RANGE_DAYS - 1);
  if (maxTo && to > maxTo) return { error: `Выберите период не длиннее ${STATISTICS_MAX_RANGE_DAYS} дней.` } as const;
  return { range: { from, to } } as const;
}

export function statisticsPeriodQuery(selection: StatisticsPeriodSelection): Record<string, string> {
  return selection.preset === "all" ? { period: "all" } : selection.range;
}
