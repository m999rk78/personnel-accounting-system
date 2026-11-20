"use client";

import { useTimesheetClipboard, type TimesheetClipboardChange, type TimesheetClipboardSaveResult } from "./useTimesheetClipboard";

type Options = Parameters<typeof useTimesheetClipboard>[0];

/** Keep source dates/metadata indices stable while the spreadsheet selects,
 * copies and traverses columns in their displayed (pinned) order. */
export function useOrderedTimesheetClipboard(options: Options) {
  // Each callback retains this render's mapping for its entire async save.
  const order = [...new Set(options.columnIndexes ?? Array.from({ length: options.columnCount }, (_, index) => index))];
  const positions = new Map(order.map((column, index) => [column, index]));
  const canonical = (index: number) => order[index];
  const visual = (index: number) => positions.get(index);
  const toCanonical = <T extends { columnIndex: number }>(changes: readonly T[]): T[] => changes.flatMap(change => {
    const index = canonical(change.columnIndex);
    return index === undefined ? [] : [{ ...change, columnIndex: index }];
  });
  const toVisual = <T extends { columnIndex: number }>(changes: readonly T[]): T[] => changes.flatMap(change => {
    const index = visual(change.columnIndex);
    return index === undefined ? [] : [{ ...change, columnIndex: index }];
  });
  const resultToVisual = (result: number | TimesheetClipboardSaveResult): number | TimesheetClipboardSaveResult => typeof result === "number" ? result : {
    ...result,
    savedChanges: toVisual(result.savedChanges),
    failedChanges: toVisual(result.failedChanges),
    ...(result.undoableChanges ? { undoableChanges: toVisual(result.undoableChanges) } : {}),
    ...(result.revisions ? { revisions: toVisual(result.revisions) } : {}),
  };
  const editableColumn = (index: number) => {
    const source = canonical(index);
    return source !== undefined && source >= 0 && source < options.columnCount ? source : undefined;
  };
  const clipboard = useTimesheetClipboard({
    ...options,
    columnCount: order.length,
    columnIndexes: Array.from({ length: order.length }, (_, index) => index),
    // Selection/history coordinates from a previous arrangement must never be
    // interpreted against new dates. Pending batch saves own source coordinates.
    resetKey: JSON.stringify([options.resetKey, order]),
    getValue: (row, column) => canonical(column) === undefined ? "" : options.getValue(row, canonical(column)),
    getHeader: options.getHeader ? column => canonical(column) === undefined ? "" : options.getHeader!(canonical(column)) : undefined,
    getUndoValue: (row, column) => canonical(column) === undefined ? "" : (options.getUndoValue ?? options.getValue)(row, canonical(column)),
    getUndoNote: options.getUndoNote ? (row, column) => canonical(column) === undefined ? "" : options.getUndoNote!(row, canonical(column)) : undefined,
    canPaste: (row, column) => {
      const source = editableColumn(column);
      return source !== undefined && options.canPaste(row, source);
    },
    canDelete: options.canDelete ? (row, column) => {
      const source = editableColumn(column);
      return source !== undefined && options.canDelete!(row, source);
    } : undefined,
    onPaste: async (changes, context) => resultToVisual(await options.onPaste(toCanonical(changes), context)),
    onDelete: options.onDelete ? async (changes, context) => resultToVisual(await options.onDelete!(toCanonical(changes), context)) : undefined,
    onActivate: options.onActivate ? (row, column, anchor) => {
      const source = editableColumn(column);
      if (source !== undefined) options.onActivate!(row, source, anchor);
    } : undefined,
    onType: options.onType ? (row, column, anchor, value) => {
      const source = editableColumn(column);
      if (source !== undefined) options.onType!(row, source, anchor, value);
    } : undefined,
  });
  const active = clipboard.activeCell;
  return {
    ...clipboard,
    activeCell: active && canonical(active.columnIndex) !== undefined ? { ...active, columnIndex: canonical(active.columnIndex) } : null,
    focusCell: (row: number, column: number) => {
      const index = visual(column);
      if (index !== undefined) clipboard.focusCell(row, index);
    },
    cellClass: (row: number, column: number) => {
      const index = visual(column);
      return index === undefined ? "" : clipboard.cellClass(row, index);
    },
    headerClass: (column: number) => {
      const index = visual(column);
      return index === undefined ? "" : clipboard.headerClass(index);
    },
    cellHandlers: (row: number, column: number) => {
      const index = visual(column);
      return index === undefined ? {} : clipboard.cellHandlers(row, index);
    },
    rememberUndo: (changes: TimesheetClipboardChange[], historyId?: string) => clipboard.rememberUndo(toVisual(changes), historyId),
    forgetUndo: (historyId: string, changes: TimesheetClipboardChange[]) => clipboard.forgetUndo(historyId, toVisual(changes)),
    adjacentColumn: (column: number, delta: number) => {
      const index = visual(column);
      return index === undefined || !order.length ? column : order[Math.max(0, Math.min(order.length - 1, index + delta))];
    },
  };
}
