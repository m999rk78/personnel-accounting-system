import { isReportWorkDate } from "./reportDateChanges.ts";

export type CalendarDay = { year: number; month: number; day: number };
export type CalendarCell = { date: string | null; day: number | null; inMonth: boolean };

function utcDate(year: number, month: number, day: number) {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, day);
  return value;
}

export function parseCalendarDate(value: string): CalendarDay | null {
  if (!isReportWorkDate(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

export function calendarDate(year: number, month: number, day: number): string | null {
  if (![year, month, day].every(Number.isInteger) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isReportWorkDate(value) ? value : null;
}

export function calendarMonthDays(year: number, month: number): number {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) return 0;
  return utcDate(year, month + 1, 0).getUTCDate();
}

export function shiftCalendarDate(value: string, days: number): string | null {
  const parts = parseCalendarDate(value);
  if (!parts || !Number.isInteger(days)) return null;
  const next = utcDate(parts.year, parts.month, parts.day);
  next.setUTCDate(next.getUTCDate() + days);
  const year = next.getUTCFullYear();
  return year >= 1 && year <= 9999 ? next.toISOString().slice(0, 10) : null;
}

export function shiftCalendarMonth(value: string, months: number): string | null {
  const parts = parseCalendarDate(value);
  if (!parts || !Number.isInteger(months)) return null;
  const index = (parts.year - 1) * 12 + parts.month - 1 + months;
  if (index < 0 || index >= 9999 * 12) return null;
  const year = Math.floor(index / 12) + 1;
  const month = index % 12 + 1;
  return calendarDate(year, month, Math.min(parts.day, calendarMonthDays(year, month)));
}

/** A fixed six-week grid prevents the picker from jumping as months change. */
export function calendarMonthGrid(year: number, month: number): CalendarCell[] {
  const first = calendarDate(year, month, 1);
  if (!first) return [];
  const offset = (utcDate(year, month, 1).getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = shiftCalendarDate(first, index - offset);
    const parts = date ? parseCalendarDate(date) : null;
    return { date, day: parts?.day ?? null, inMonth: parts?.year === year && parts.month === month };
  });
}

export function calendarKeyDate(value: string, key: string, shiftKey = false): string | null {
  const parts = parseCalendarDate(value);
  if (!parts) return null;
  const weekday = (utcDate(parts.year, parts.month, parts.day).getUTCDay() + 6) % 7;
  switch (key) {
    case "ArrowLeft": return shiftCalendarDate(value, -1);
    case "ArrowRight": return shiftCalendarDate(value, 1);
    case "ArrowUp": return shiftCalendarDate(value, -7);
    case "ArrowDown": return shiftCalendarDate(value, 7);
    case "Home": return shiftCalendarDate(value, -weekday);
    case "End": return shiftCalendarDate(value, 6 - weekday);
    case "PageUp": return shiftCalendarMonth(value, shiftKey ? -12 : -1);
    case "PageDown": return shiftCalendarMonth(value, shiftKey ? 12 : 1);
    default: return null;
  }
}
