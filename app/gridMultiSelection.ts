import type { Column, GridApi } from "ag-grid-community";
import { isStructuralSpreadsheetRow, spreadsheetDataColumns, spreadsheetHeaderValues, spreadsheetPointRowIndex } from "./gridSpreadsheetRows.ts";

export type SpreadsheetPoint = { rowIndex: number; columnId: string; rowId?: string };
type SpreadsheetArea = { start: SpreadsheetPoint; end: SpreadsheetPoint };
export type SpreadsheetSelection = SpreadsheetArea & {
  ranges?: SpreadsheetArea[];
  rowModeColumnId?: string;
  columnModeRow?: Pick<SpreadsheetPoint, "rowIndex" | "rowId">;
};
export type SpreadsheetAreaBounds = { columns: Column[]; rowStart: number; rowEnd: number; columnStart: number; columnEnd: number };
type SelectionGrid<T> = Pick<GridApi<T>, "getAllDisplayedColumns" | "getRowNode" | "getDisplayedRowAtIndex">;

/** Keep ranges compact; Ctrl-clicking a cell never expands a whole table into objects. */
export function selectedSpreadsheetAreas<T>(grid: SelectionGrid<T>, current: SpreadsheetSelection | null): SpreadsheetAreaBounds[] {
  if (!current) return [];
  const columns = spreadsheetDataColumns(grid);
  return [...current.ranges ?? [], current].flatMap(area => {
    const start = spreadsheetPointRowIndex(grid, area.start), end = spreadsheetPointRowIndex(grid, area.end);
    const left = columns.findIndex(column => column.getColId() === area.start.columnId), right = columns.findIndex(column => column.getColId() === area.end.columnId);
    if (start === null || end === null || left < 0 || right < 0) return [];
    return [{ columns, rowStart: Math.min(start, end), rowEnd: Math.max(start, end), columnStart: Math.min(left, right), columnEnd: Math.max(left, right) }];
  });
}

export function spreadsheetAreaContains(area: SpreadsheetAreaBounds, rowIndex: number, columnIndex: number) {
  return rowIndex >= area.rowStart && rowIndex <= area.rowEnd && columnIndex >= area.columnStart && columnIndex <= area.columnEnd;
}

export function spreadsheetSelectionContains<T>(grid: SelectionGrid<T>, current: SpreadsheetSelection | null, point: SpreadsheetPoint) {
  const rowIndex = spreadsheetPointRowIndex(grid, point);
  if (rowIndex === null) return false;
  return selectedSpreadsheetAreas(grid, current).some(area => spreadsheetAreaContains(area, rowIndex, area.columns.findIndex(column => column.getColId() === point.columnId)));
}

/** Removing a cell splits a rectangle into at most four ranges; no hidden holes. */
export function toggleSpreadsheetCell<T>(grid: SelectionGrid<T>, current: SpreadsheetSelection | null, point: SpreadsheetPoint): SpreadsheetSelection | null {
  const areas = selectedSpreadsheetAreas(grid, current);
  const rowIndex = spreadsheetPointRowIndex(grid, point);
  if (rowIndex === null || isStructuralSpreadsheetRow(grid.getDisplayedRowAtIndex(rowIndex))) return current;
  const columns = spreadsheetDataColumns(grid);
  const columnIndex = columns.findIndex(column => column.getColId() === point.columnId);
  if (columnIndex < 0) return current;
  const selected = areas.some(area => spreadsheetAreaContains(area, rowIndex, columnIndex));
  const ranges: SpreadsheetArea[] = [];
  const append = (top: number, bottom: number, left: number, right: number) => {
    if (top > bottom || left > right) return;
    ranges.push({
      start: { rowIndex: top, rowId: grid.getDisplayedRowAtIndex(top)?.id, columnId: columns[left].getColId() },
      end: { rowIndex: bottom, rowId: grid.getDisplayedRowAtIndex(bottom)?.id, columnId: columns[right].getColId() },
    });
  };
  for (const area of areas) {
    if (!selected || !spreadsheetAreaContains(area, rowIndex, columnIndex)) { append(area.rowStart, area.rowEnd, area.columnStart, area.columnEnd); continue; }
    append(area.rowStart, rowIndex - 1, area.columnStart, area.columnEnd);
    append(rowIndex + 1, area.rowEnd, area.columnStart, area.columnEnd);
    append(rowIndex, rowIndex, area.columnStart, columnIndex - 1);
    append(rowIndex, rowIndex, columnIndex + 1, area.columnEnd);
  }
  if (!selected) ranges.push({ start: point, end: point });
  const active = ranges.pop();
  return active ? { ...active, ...(ranges.length ? { ranges } : {}) } : null;
}

/** Display order, deduplicated intersections, excluding headers/details and filtered records. */
export function selectedSpreadsheetCells<T>(grid: SelectionGrid<T>, current: SpreadsheetSelection | null) {
  const selected = new Map<number, Set<string>>();
  for (const area of selectedSpreadsheetAreas(grid, current)) {
    for (let index = area.rowStart; index <= area.rowEnd; index++) {
      const row = grid.getDisplayedRowAtIndex(index);
      if (!row?.data || isStructuralSpreadsheetRow(row)) continue;
      const ids = selected.get(index) ?? new Set<string>();
      for (let column = area.columnStart; column <= area.columnEnd; column++) ids.add(area.columns[column].getColId());
      selected.set(index, ids);
    }
  }
  return new Map([...selected].sort(([left], [right]) => left - right));
}

/** Clipboard is a matrix of selected axes. Unselected intersections must stay empty. */
export function spreadsheetSelectionValues<T>(grid: SelectionGrid<T> & Pick<GridApi<T>, "getCellValue" | "getDisplayNameForColumn">, current: SpreadsheetSelection | null, includeHeaders = false) {
  const selected = selectedSpreadsheetCells(grid, current);
  const ids = new Set([...selected.values()].flatMap(columns => [...columns]));
  const columns = spreadsheetDataColumns(grid).filter(column => ids.has(column.getColId()));
  const values = [...selected].map(([index, ids]) => {
    const rowNode = grid.getDisplayedRowAtIndex(index)!;
    return columns.map(column => ids.has(column.getColId()) ? String(grid.getCellValue({ rowNode, colKey: column, useFormatter: true }) ?? "") : "");
  });
  return includeHeaders && columns.length ? [spreadsheetHeaderValues(grid, columns), ...values] : values;
}
