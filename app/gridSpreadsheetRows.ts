import type { GridApi } from "ag-grid-community";

type SpreadsheetRow<T> = { data?: T | null; id?: string; group?: boolean; detail?: boolean; footer?: boolean };
type SpreadsheetRowSource<T> = {
  getDisplayedRowCount: () => number;
  getDisplayedRowAtIndex: (index: number) => SpreadsheetRow<T> | null | undefined;
};

/** A hidden or removed record must never fall back to another row at its old index. */
export function spreadsheetPointRowIndex(grid: { getRowNode: (id: string) => { rowIndex: number | null } | undefined }, point: { rowId?: string; rowIndex: number }): number | null {
  return point.rowId ? grid.getRowNode(point.rowId)?.rowIndex ?? null : point.rowIndex;
}

/** Group headers are displayed rows, but are never spreadsheet records. */
export function isStructuralSpreadsheetRow<T>(row: SpreadsheetRow<T> | null | undefined): boolean {
  return Boolean(row && (!row.data || row.group || row.detail || row.footer));
}

/** Undefined rows after the grid are intentional append targets in flat tables. */
export function spreadsheetRangeHasStructuralRows<T>(grid: SpreadsheetRowSource<T>, start: number, end: number): boolean {
  for (let index = start; index <= end; index++) {
    if (isStructuralSpreadsheetRow(grid.getDisplayedRowAtIndex(index))) return true;
  }
  return false;
}

/** Walk past date headers without assigning a cell selection to them. */
export function findSpreadsheetDataRowIndex<T>(grid: SpreadsheetRowSource<T>, start: number, direction: 1 | -1): number | null {
  for (let index = start; index >= 0 && index < grid.getDisplayedRowCount(); index += direction) {
    const row = grid.getDisplayedRowAtIndex(index);
    if (row?.data && !isStructuralSpreadsheetRow(row)) return index;
  }
  return null;
}

/** Selection controls and action buttons are not spreadsheet data columns. */
export function spreadsheetDataColumns<TColumn extends { getColId: () => string }>(grid: { getAllDisplayedColumns: () => TColumn[] }) {
  return grid.getAllDisplayedColumns().filter(column => !["actions", "rowOrder", "ag-Grid-SelectionColumn"].includes(column.getColId()));
}

export function spreadsheetHeaderValues<T>(grid: Pick<GridApi<T>, "getDisplayNameForColumn">, columns: ReturnType<GridApi<T>["getAllDisplayedColumns"]>) {
  return columns.map(column => grid.getDisplayNameForColumn(column, "header"));
}

export function nativeSpreadsheetSelectionKey<T>(grid: Pick<GridApi<T>, "getCellRanges">) {
  return JSON.stringify((grid.getCellRanges() ?? []).map(range => [range.startRow?.rowIndex, range.startRow?.rowPinned, range.endRow?.rowIndex, range.endRow?.rowPinned, range.columns.map(column => column.getColId())]));
}

/** Uses the displayed model rather than mounted DOM rows, including virtual rows. */
export function allSpreadsheetCells<T, TColumn extends { getColId: () => string }>(grid: SpreadsheetRowSource<T>, columns: TColumn[]) {
  if (!columns.length) return null;
  const first = findSpreadsheetDataRowIndex(grid, 0, 1);
  const last = findSpreadsheetDataRowIndex(grid, grid.getDisplayedRowCount() - 1, -1);
  if (first === null || last === null) return null;
  return {
    start: { rowIndex: first, rowId: grid.getDisplayedRowAtIndex(first)?.id, columnId: columns[0].getColId() },
    end: { rowIndex: last, rowId: grid.getDisplayedRowAtIndex(last)?.id, columnId: columns.at(-1)!.getColId() },
  };
}

/** Native master/detail grids select contiguous data ranges without detail panels. */
export function spreadsheetDataRowRanges<T>(grid: SpreadsheetRowSource<T>) {
  const ranges: Array<{ rowStartIndex: number; rowEndIndex: number }> = [];
  for (let index = 0; index < grid.getDisplayedRowCount(); index++) {
    const row = grid.getDisplayedRowAtIndex(index);
    if (!row?.data || isStructuralSpreadsheetRow(row)) continue;
    const previous = ranges.at(-1);
    if (previous?.rowEndIndex === index - 1) previous.rowEndIndex = index;
    else ranges.push({ rowStartIndex: index, rowEndIndex: index });
  }
  return ranges;
}

/** Read native AG ranges using the model, not DOM text or clipboard permissions. */
export function nativeSpreadsheetSelectionValues<T>(grid: Pick<GridApi<T>, "getAllDisplayedColumns" | "getDisplayedRowCount" | "getDisplayedRowAtIndex" | "getCellRanges" | "getFocusedCell" | "getCellValue" | "getDisplayNameForColumn">, { includeHeaders = false }: { includeHeaders?: boolean } = {}) {
  const columns = spreadsheetDataColumns(grid);
  const allowedIds = new Set(columns.map(column => column.getColId()));
  const selected = new Map<number, Set<string>>();
  const ranges = grid.getCellRanges() ?? [];
  const last = grid.getDisplayedRowCount() - 1;
  for (const range of ranges) {
    if (range.startRow?.rowPinned || range.endRow?.rowPinned) continue;
    const start = Math.max(0, Math.min(range.startRow?.rowIndex ?? 0, range.endRow?.rowIndex ?? last));
    const end = Math.min(last, Math.max(range.startRow?.rowIndex ?? 0, range.endRow?.rowIndex ?? last));
    const ids = range.columns.map(column => column.getColId()).filter(id => allowedIds.has(id));
    if (!ids.length) continue;
    for (let index = start; index <= end; index++) {
      const row = grid.getDisplayedRowAtIndex(index);
      if (!row?.data || isStructuralSpreadsheetRow(row)) continue;
      const keys = selected.get(index) ?? new Set<string>();
      for (const id of ids) keys.add(id);
      selected.set(index, keys);
    }
  }
  if (!ranges.length) {
    const focused = grid.getFocusedCell();
    const row = focused && !focused.rowPinned ? grid.getDisplayedRowAtIndex(focused.rowIndex) : null;
    if (focused && row?.data && !isStructuralSpreadsheetRow(row) && allowedIds.has(focused.column.getColId())) selected.set(focused.rowIndex, new Set([focused.column.getColId()]));
  }
  if (!selected.size) return includeHeaders && columns.length ? [spreadsheetHeaderValues(grid, columns)] : null;
  const selectedIds = new Set([...selected.values()].flatMap(ids => [...ids]));
  const copiedColumns = columns.filter(column => selectedIds.has(column.getColId()));
  const values = [...selected].sort(([left], [right]) => left - right).map(([index, ids]) => {
    const rowNode = grid.getDisplayedRowAtIndex(index)!;
    return copiedColumns.map(column => ids.has(column.getColId()) ? String(grid.getCellValue({ rowNode, colKey: column, useFormatter: true }) ?? "") : "");
  });
  return includeHeaders ? [spreadsheetHeaderValues(grid, copiedColumns), ...values] : values;
}
