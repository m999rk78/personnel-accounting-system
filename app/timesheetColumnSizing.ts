export type TimesheetColumnKind = "workers" | "equipment";
export type TimesheetSizedColumn = { id: string; width: number; min: number; max: number; sticky?: boolean };
export type TimesheetColumnWidths = Record<string, number>;

export function timesheetSizingColumns(kind: TimesheetColumnKind, dayCount: number, showPosition = true, dayNumbers?: readonly number[]): TimesheetSizedColumn[] {
  const lastDay = Math.max(0, Math.min(31, Math.floor(dayCount)));
  const days = dayNumbers === undefined ? Array.from({ length: lastDay }, (_, index) => index + 1)
    : [...new Set(dayNumbers.filter(day => Number.isInteger(day) && day >= 1 && day <= lastDay))];
  const metadata: TimesheetSizedColumn[] = kind === "workers" ? [
    { id: "number", width: 44, min: 44, max: 120, sticky: true },
    { id: "employmentType", width: 58, min: 50, max: 180, sticky: true },
    { id: "department", width: 70, min: 60, max: 300, sticky: true },
    { id: "fullName", width: 190, min: 140, max: 900, sticky: true },
    ...(showPosition ? [{ id: "position", width: 140, min: 100, max: 600, sticky: true }] : []),
  ] : [
    { id: "number", width: 44, min: 44, max: 120, sticky: true },
    { id: "equipment", width: 288, min: 160, max: 1000, sticky: true },
    { id: "organization", width: 170, min: 100, max: 600, sticky: true },
  ];
  return [
    ...metadata,
    ...days.map(day => ({ id: `day-${day}`, width: 48, min: 40, max: 240 })),
    ...(kind === "workers" ? ["timesheet", "reports", "difference"] : ["productive", "downtime", "total"]).map(id => ({ id, width: 72, min: 64, max: 300 })),
  ];
}

export function boundedTimesheetWidth(column: TimesheetSizedColumn, value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(Math.max(column.min, Math.min(column.max, value))) : column.width;
}

/** Auto-filled day space is not a saved preference; do not add it a second time. */
export function timesheetResizeReferenceWidth(column: TimesheetSizedColumn, preferences: TimesheetColumnWidths, effectiveWidth: number) {
  return column.id.startsWith("day-") ? boundedTimesheetWidth(column, preferences[column.id]) : effectiveWidth;
}

export function readTimesheetColumnWidths(raw: string | null, kind: TimesheetColumnKind): TimesheetColumnWidths {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: TimesheetColumnWidths = {};
    for (const column of timesheetSizingColumns(kind, 31)) {
      if (!Object.hasOwn(parsed, column.id)) continue;
      const value = (parsed as Record<string, unknown>)[column.id];
      if (typeof value === "number" && Number.isFinite(value)) result[column.id] = boundedTimesheetWidth(column, value);
    }
    return result;
  } catch { return {}; }
}

/** One exact track plan for colgroup, sticky offsets, footer and table width. */
export function timesheetColumnLayout(columns: readonly TimesheetSizedColumn[], preferences: TimesheetColumnWidths, viewportWidth: number) {
  const widths: TimesheetColumnWidths = {};
  const lefts: TimesheetColumnWidths = {};
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, Math.floor(viewportWidth)) : 0;
  for (const column of columns) widths[column.id] = boundedTimesheetWidth(column, preferences[column.id]);
  const pinned = columns.filter(column => column.sticky);
  const minimumPinned = pinned.reduce((sum, column) => sum + column.min, 0);
  const pinnedBudget = viewport ? Math.max(minimumPinned, viewport - Math.min(120, Math.floor(viewport / 4))) : Infinity;
  let excess = Math.max(0, pinned.reduce((sum, column) => sum + widths[column.id], 0) - pinnedBudget);
  // Stored wide-screen preferences must not cover every day on a smaller screen.
  for (const column of [...pinned].reverse()) {
    const reduction = Math.min(excess, widths[column.id] - column.min);
    widths[column.id] -= reduction;
    excess -= reduction;
  }
  let totalWidth = columns.reduce((sum, column) => sum + widths[column.id], 0);
  // Never let CSS min-width silently distribute space independently of stickies.
  const flexible = columns.filter(column => column.id.startsWith("day-"));
  const spare = Math.max(0, viewport - totalWidth);
  if (spare && flexible.length) {
    const each = Math.floor(spare / flexible.length);
    for (const [index, column] of flexible.entries()) {
      const addition = each + (spare % flexible.length > index ? 1 : 0);
      widths[column.id] += addition;
    }
    totalWidth += spare;
  }
  let stickyWidth = 0;
  for (const column of pinned) { lefts[column.id] = stickyWidth; stickyWidth += widths[column.id]; }
  return { widths, lefts, totalWidth, stickyWidth, stickyCount: pinned.length };
}
