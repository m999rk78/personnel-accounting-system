type SpreadsheetRow<T> = { data?: T | null };
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
  return Boolean(row && !row.data);
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
    if (grid.getDisplayedRowAtIndex(index)?.data) return index;
  }
  return null;
}
