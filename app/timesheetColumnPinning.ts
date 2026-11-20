import { timesheetSizingColumns, type TimesheetColumnKind, type TimesheetSizedColumn } from "./timesheetColumnSizing.ts";

export type TimesheetColumnPin = "left" | "right" | null;
export type TimesheetColumnPins = Record<string, TimesheetColumnPin>;

export function getTimesheetColumnPin(column: TimesheetSizedColumn, preferences: TimesheetColumnPins): TimesheetColumnPin {
  if (Object.hasOwn(preferences, column.id)) {
    const pin = preferences[column.id];
    if (pin === "left" || pin === "right" || pin === null) return pin;
  }
  return column.pinSide ?? (column.sticky ? "left" : null);
}

/** Keep preferences for hidden positions and dates absent from this month. */
export function readTimesheetColumnPins(raw: string | null, kind: TimesheetColumnKind): TimesheetColumnPins {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: TimesheetColumnPins = {};
    for (const { id } of timesheetSizingColumns(kind, 31)) {
      if (!Object.hasOwn(parsed, id)) continue;
      const pin = (parsed as Record<string, unknown>)[id];
      if (pin === "left" || pin === "right" || pin === null) result[id] = pin;
    }
    return result;
  } catch { return {}; }
}

/** Saved pins are preferences, not a requirement to hide the scrolling region.
 * Narrow windows temporarily release trailing user pins before default metadata;
 * widening the window restores them without rewriting the saved preferences. */
export function applyTimesheetColumnPins(columns: readonly TimesheetSizedColumn[], preferences: TimesheetColumnPins, viewportWidth = 0): TimesheetSizedColumn[] {
  const sides = columns.map(column => getTimesheetColumnPin(column, preferences));
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, Math.floor(viewportWidth)) : 0;
  if (viewport) {
    const budget = viewport - Math.min(120, Math.floor(viewport / 4));
    let pinnedWidth = columns.reduce((sum, column, index) => sum + (sides[index] ? column.min : 0), 0);
    let pinnedCount = sides.filter(Boolean).length;
    const userPin = (index: number) => !columns[index].sticky && !columns[index].pinSide;
    const trailing = columns.map((_, index) => index).reverse().filter(index => sides[index]);
    for (const index of [...trailing.filter(userPin), ...trailing.filter(index => !userPin(index))]) {
      if (pinnedWidth <= budget && pinnedCount < columns.length) break;
      sides[index] = null;
      pinnedWidth -= columns[index].min;
      pinnedCount--;
    }
  }
  // Stable order within each region keeps dates and totals predictable.
  const regions: Record<"left" | "center" | "right", TimesheetSizedColumn[]> = { left: [], center: [], right: [] };
  for (const [index, column] of columns.entries()) {
    const pinSide = sides[index];
    const { pinSide: _previousSide, ...base } = column;
    void _previousSide;
    regions[pinSide ?? "center"].push({ ...base, sticky: Boolean(pinSide), ...(pinSide ? { pinSide } : {}) });
  }
  return [...regions.left, ...regions.center, ...regions.right];
}

/** New pins may not cover the scrolling region on a narrow viewport. */
export function canPinTimesheetColumn(columns: readonly TimesheetSizedColumn[], preferences: TimesheetColumnPins, id: string, side: TimesheetColumnPin, viewportWidth: number): boolean {
  const column = columns.find(column => column.id === id);
  if (!column) return false;
  if (side === null) return true;
  if (side !== "left" && side !== "right") return false;
  const current = applyTimesheetColumnPins(columns, preferences, viewportWidth);
  const currentPin = current.find(column => column.id === id)?.pinSide;
  if (currentPin === side) return true;
  const next = applyTimesheetColumnPins(columns, { ...preferences, [id]: side }, viewportWidth);
  if (next.find(column => column.id === id)?.pinSide !== side) return false;
  // Moving a currently visible pin between sides consumes no additional space.
  if (currentPin) return true;
  const pinned = current.filter(column => column.sticky);
  if (pinned.length + 1 === next.length) return false;
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, Math.floor(viewportWidth)) : 0;
  if (!viewport) return true;
  const centerSpace = Math.min(120, Math.floor(viewport / 4));
  return pinned.reduce((sum, column) => sum + column.min, 0) + column.min <= viewport - centerSpace;
}
