import type { GridApi } from "ag-grid-community";
import { spreadsheetDataColumns, spreadsheetHeaderValues } from "./gridSpreadsheetRows.ts";
import { serializeSpreadsheetText, spreadsheetClipboardHtml } from "./spreadsheetClipboard.ts";

export type StatisticsCopyTarget = { kind: "table" } | { kind: "row"; rowId: string } | { kind: "column"; columnId: string };
type ClipboardGrid<T> = Pick<GridApi<T>, "getAllDisplayedColumns" | "getDisplayNameForColumn" | "getDisplayedRowCount" | "getDisplayedRowAtIndex" | "getRowNode" | "getCellValue">;

const numberFormatter = new Intl.NumberFormat("ru-RU", { useGrouping: false, maximumFractionDigits: 20 });
export function statisticsClipboardNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? numberFormatter.format(value) : "";
}

export function statisticsClipboardHtml<T>(grid: ClipboardGrid<T>, target: StatisticsCopyTarget, text: string) {
  const columns = spreadsheetDataColumns(grid).filter(column => target.kind !== "column" || column.getColId() === target.columnId);
  return spreadsheetClipboardHtml(text, columns.map(column => !["zone", "workDate"].includes(column.getColId())));
}

/** Copy the displayed model, including rows outside the viewport, in its current order. */
export function statisticsClipboardText<T>(grid: ClipboardGrid<T>, target: StatisticsCopyTarget): string | null {
  const columns = spreadsheetDataColumns(grid).filter(column => target.kind !== "column" || column.getColId() === target.columnId);
  if (!columns.length) return null;
  const values: string[][] = [];
  const selectedRow = target.kind === "row" ? grid.getRowNode(target.rowId) : null;
  if (target.kind === "row" && (!selectedRow?.data || selectedRow.rowIndex == null)) return null;
  const start = selectedRow?.rowIndex ?? 0;
  const end = selectedRow?.rowIndex ?? grid.getDisplayedRowCount() - 1;
  for (let index = start; index <= end; index++) {
    const node = grid.getDisplayedRowAtIndex(index);
    if (!node?.data || node.group || node.footer || node.detail) continue;
    values.push(columns.map(column => String(grid.getCellValue({ rowNode: node, colKey: column, useFormatter: true }) ?? "")));
  }
  if (!values.length) return null;
  if (target.kind !== "row") values.unshift(spreadsheetHeaderValues(grid, columns));
  return serializeSpreadsheetText(values);
}
