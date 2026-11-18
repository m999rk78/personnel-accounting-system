import type { Column, GridApi } from "ag-grid-community";
import { isStructuralSpreadsheetRow } from "./gridSpreadsheetRows.ts";

export type SpreadsheetSelectionSummary = { count: number; sum: number };
type SelectionBounds = {
  columns: Column[];
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
};

/** Sum raw values in the same displayed range used for highlighting and copying. */
export function summarizeSpreadsheetSelection<T>(grid: Pick<GridApi<T>, "getDisplayedRowAtIndex" | "getCellValue">, bounds: SelectionBounds | null): SpreadsheetSelectionSummary | null {
  if (!bounds) return null;
  const columns = bounds.columns.slice(bounds.columnStart, bounds.columnEnd + 1);
  let count = 0, sum = 0;
  for (let index = bounds.rowStart; index <= bounds.rowEnd; index++) {
    const rowNode = grid.getDisplayedRowAtIndex(index);
    if (!rowNode?.data || isStructuralSpreadsheetRow(rowNode)) continue;
    for (const column of columns) {
      const value = grid.getCellValue({ rowNode, colKey: column, useFormatter: false });
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      count++;
      sum += value;
    }
  }
  return count ? { count, sum } : null;
}
