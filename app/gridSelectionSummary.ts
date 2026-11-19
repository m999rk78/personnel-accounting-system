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
export function summarizeSpreadsheetSelection<T>(grid: Pick<GridApi<T>, "getDisplayedRowAtIndex" | "getCellValue">, bounds: SelectionBounds | SelectionBounds[] | null): SpreadsheetSelectionSummary | null {
  if (!bounds) return null;
  const seen = new Map<number, Set<string>>();
  let count = 0, sum = 0;
  for (const area of Array.isArray(bounds) ? bounds : [bounds]) {
    const columns = area.columns.slice(area.columnStart, area.columnEnd + 1);
    for (let index = area.rowStart; index <= area.rowEnd; index++) {
      const rowNode = grid.getDisplayedRowAtIndex(index);
      if (!rowNode?.data || isStructuralSpreadsheetRow(rowNode)) continue;
      const ids = seen.get(index) ?? new Set<string>();
      seen.set(index, ids);
      for (const column of columns) {
        const id = column.getColId();
        if (ids.has(id)) continue;
        ids.add(id);
        const value = grid.getCellValue({ rowNode, colKey: column, useFormatter: false });
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        count++;
        sum += value;
      }
    }
  }
  return count ? { count, sum } : null;
}
