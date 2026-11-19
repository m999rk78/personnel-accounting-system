"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FocusEvent, type KeyboardEvent, type PointerEvent, type RefObject, type SyntheticEvent } from "react";
import { serializeSpreadsheetText } from "./spreadsheetClipboard";
import { isTableSelectAllShortcut, isTableTextEntryTarget } from "./tableSelectAllShortcut";
import { isTableRowSelectionBlocked, tableColumnSelectionIntent, tableRowSelectionIntent } from "./tableRowSelectionShortcut";
import { useTableCopyToast } from "./useTableCopyToast";
import "./nativeTableSelectAll.css";

type ClipboardRows = readonly (readonly (string | number | null | undefined)[])[];
type RowRange = { anchor: number; end: number };
type CellPoint = { row: number; column: number };
type NativeSelection = { scope: string; range: RowRange | null; columns?: RowRange; cells?: CellPoint[] };

/** Select the column headings and displayed data, independently of row-action checkboxes. */
export function useNativeTableSelectAll<T extends HTMLElement = HTMLDivElement>({ rows, headers, columnGroups, resetKey = "", enabled = true, rootRef }: {
  rows: ClipboardRows;
  headers?: ClipboardRows[number];
  /** One displayed column can contain several clipboard fields (e.g. name/email). */
  columnGroups?: readonly (readonly number[])[];
  resetKey?: string;
  enabled?: boolean;
  rootRef?: RefObject<T | null>;
}) {
  const localRef = useRef<T>(null);
  const ref = rootRef ?? localRef;
  const { showCopyToast, copyToast } = useTableCopyToast(ref);
  const text = useMemo(() => serializeSpreadsheetText([...(headers?.length ? [headers] : []), ...rows].map(row => row.map(value => value == null ? "" : String(value)))), [headers, rows]);
  const copiedRowCount = rows.length + (headers?.length ? 1 : 0);
  const copiedColumnCount = Math.max(headers?.length ?? 0, rows.reduce((count, row) => Math.max(count, row.length), 0));
  const columns = columnGroups ?? Array.from({ length: copiedColumnCount }, (_, index) => [index]);
  const scope = `${enabled ? "enabled" : "disabled"}\u0000${resetKey}\u0000${text}\u0000${JSON.stringify(columns)}`;
  const [state, setState] = useState<{ scope: string; selection: NativeSelection | null }>({ scope, selection: null });
  if (state.scope !== scope) setState({ scope, selection: null });
  const selection = useRef<NativeSelection | null>(null);
  const activeRow = useRef<{ scope: string; index: number } | null>(null);
  const activeColumn = useRef<{ scope: string; index: number } | null>(null);
  const suppressClick = useRef(false);
  const hasCells = rows.length > 0 || Boolean(headers?.length);
  const currentSelection = enabled && hasCells && state.scope === scope ? state.selection : null;
  const selected = Boolean(currentSelection);

  const clear = useCallback(() => { selection.current = null; setState(current => ({ ...current, selection: null })); }, []);
  useLayoutEffect(() => {
    if (selection.current?.scope !== scope) selection.current = null;
    if (activeRow.current?.scope !== scope) activeRow.current = null;
    if (activeColumn.current?.scope !== scope) activeColumn.current = null;
  }, [scope]);
  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => {
      if (selection.current && event.target instanceof Node && !ref.current?.contains(event.target)) clear();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [clear, ref]);

  const targetRow = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return null;
    const element = target.closest<HTMLElement>("[data-native-table-row]");
    if (!element || !ref.current?.contains(element) || element.closest("[role='grid']") !== ref.current) return null;
    const index = Number(element.dataset.nativeTableRow);
    return Number.isInteger(index) && index >= 0 && index < rows.length ? index : null;
  };
  const targetColumn = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return null;
    const element = target.closest<HTMLElement>("[data-native-table-column]");
    if (!element || !ref.current?.contains(element) || element.closest("[role='grid']") !== ref.current) return null;
    const index = Number(element.dataset.nativeTableColumn);
    return Number.isInteger(index) && index >= 0 && index < columns.length ? index : null;
  };
  const selectRows = (anchor: number, end: number) => {
    if (!rows.length) return;
    const clamp = (index: number) => Math.max(0, Math.min(rows.length - 1, index));
    const next = { scope, range: { anchor: clamp(anchor), end: clamp(end) } };
    selection.current = next; activeRow.current = { scope, index: next.range.end };
    setState({ scope, selection: next });
    ref.current?.focus({ preventScroll: true });
    ref.current?.querySelector<HTMLElement>(`[data-native-table-row="${next.range.end}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const selectColumns = (anchor: number, end: number) => {
    if (!columns.length) return;
    const clamp = (index: number) => Math.max(0, Math.min(columns.length - 1, index));
    const next = { scope, range: null, columns: { anchor: clamp(anchor), end: clamp(end) } };
    selection.current = next; activeColumn.current = { scope, index: next.columns.end };
    setState({ scope, selection: next });
    ref.current?.focus({ preventScroll: true });
    const row = activeRow.current?.scope === scope ? activeRow.current.index : 0;
    ref.current?.querySelector<HTMLElement>(`[data-native-table-row="${row}"] [data-native-table-column="${next.columns.end}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const onKeyDownCapture = (event: KeyboardEvent<T>) => {
    suppressClick.current = false;
    if (!enabled || isTableTextEntryTarget(event.target)) return;
    if (event.key === "Escape" && selection.current?.scope === scope) {
      event.preventDefault(); event.stopPropagation(); clear(); return;
    }
    const current = selection.current?.scope === scope ? selection.current : null;
    const columnIntent = tableColumnSelectionIntent(event.nativeEvent);
    if (columnIntent === "column" || current?.columns && (columnIntent === "left" || columnIntent === "right")) {
      event.preventDefault(); event.stopPropagation();
      if (!columns.length) return;
      const target = targetColumn(event.target);
      // Action controls and merged template decorations are not data columns.
      if (target === null && event.target instanceof Element && event.target.closest("input,button,th,td")) return;
      const index = target ?? (activeColumn.current?.scope === scope ? activeColumn.current.index : 0);
      if (columnIntent === "column") {
        const row = targetRow(event.target);
        if (row !== null) activeRow.current = { scope, index: row };
      }
      const range = columnIntent === "column" && target !== null ? { anchor: target, end: target } : current?.columns ?? { anchor: index, end: index };
      selectColumns(range.anchor, range.end + (columnIntent === "left" ? -1 : columnIntent === "right" ? 1 : 0));
      return;
    }
    const intent = tableRowSelectionIntent(event.nativeEvent);
    if (intent === "row" || current?.range && (intent === "up" || intent === "down")) {
      event.preventDefault(); event.stopPropagation();
      if (!rows.length) return;
      const index = targetRow(event.target) ?? (activeRow.current?.scope === scope ? activeRow.current.index : 0);
      if (intent === "row") {
        const column = targetColumn(event.target);
        if (column !== null) activeColumn.current = { scope, index: column };
      }
      const range = current?.range ?? (current && !current.columns && !current.cells ? { anchor: 0, end: rows.length - 1 } : { anchor: index, end: index });
      selectRows(range.anchor, range.end + (intent === "up" ? -1 : intent === "down" ? 1 : 0));
      return;
    }
    if ((current?.range || current?.columns || current?.cells) && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !isTableRowSelectionBlocked(event.target)
      && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Tab"].includes(event.key)) {
      const row = current.range?.end ?? (activeRow.current?.scope === scope ? activeRow.current.index : 0);
      const column = current.columns?.end ?? (activeColumn.current?.scope === scope ? activeColumn.current.index : 0);
      activeRow.current = { scope, index: Math.max(0, Math.min(rows.length - 1, row + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0))) };
      activeColumn.current = { scope, index: Math.max(0, Math.min(columns.length - 1, column + (event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0))) };
      clear();
    }
    if (!isTableSelectAllShortcut(event.nativeEvent)) return;
    event.preventDefault(); event.stopPropagation();
    if (!hasCells) { clear(); return; }
    const next = { scope, range: null };
    selection.current = next; setState({ scope, selection: next });
  };
  const onCopyCapture = (event: ClipboardEvent<T>) => {
    if (!enabled || selection.current?.scope !== scope || !hasCells || isTableTextEntryTarget(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    const range = selection.current.range, columnRange = selection.current.columns;
    const selectedRows = range ? rows.slice(Math.min(range.anchor, range.end), Math.max(range.anchor, range.end) + 1) : null;
    const selectedColumns = columnRange ? columns.slice(Math.min(columnRange.anchor, columnRange.end), Math.max(columnRange.anchor, columnRange.end) + 1).flat() : null;
    let matrix = selectedColumns ? [...(headers?.length ? [headers] : []), ...rows].map(row => selectedColumns.map(index => row[index])) : selectedRows;
    if (selection.current.cells) {
      const cells = selection.current.cells;
      const selectedRowIndexes = [...new Set(cells.map(cell => cell.row))].sort((left, right) => left - right);
      const selectedColumnIndexes = [...new Set(cells.map(cell => cell.column))].sort((left, right) => left - right);
      const keys = new Set(cells.map(cell => `${cell.row}:${cell.column}`));
      matrix = selectedRowIndexes.map(row => selectedColumnIndexes.flatMap(column => columns[column].map(index => keys.has(`${row}:${column}`) ? rows[row][index] : "")));
    }
    event.clipboardData.setData("text/plain", matrix ? serializeSpreadsheetText(matrix.map(row => row.map(value => value == null ? "" : String(value)))) : text);
    showCopyToast(`Скопировано: ${matrix?.length ?? copiedRowCount} × ${matrix?.[0]?.length ?? copiedColumnCount}`);
  };
  const onPointerDownCapture = (event: PointerEvent<T>) => {
    suppressClick.current = false;
    if (event.button !== 0) return;
    const index = targetRow(event.target);
    const column = targetColumn(event.target);
    const current = selection.current?.scope === scope ? selection.current : null;
    const range = current?.range;
    if (enabled && index !== null && column !== null && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && !isTableRowSelectionBlocked(event.target)) {
      event.preventDefault(); event.stopPropagation(); suppressClick.current = true;
      // Convert whole-row/column selections before toggling a cell, preserving
      // everything already selected without copying the holes between cells.
      const cells = current?.cells ? [...current.cells] : current ? rows.flatMap((_, row) => {
        if (current.range && (row < Math.min(current.range.anchor, current.range.end) || row > Math.max(current.range.anchor, current.range.end))) return [];
        return columns.flatMap((_, cellColumn) => current.columns && (cellColumn < Math.min(current.columns.anchor, current.columns.end) || cellColumn > Math.max(current.columns.anchor, current.columns.end)) ? [] : [{ row, column: cellColumn }]);
      }) : [];
      const existing = cells.findIndex(cell => cell.row === index && cell.column === column);
      if (existing < 0) cells.push({ row: index, column });
      else cells.splice(existing, 1);
      const next: NativeSelection | null = cells.length ? { scope, range: null, cells } : null;
      selection.current = next; setState({ scope, selection: next });
      activeRow.current = { scope, index }; activeColumn.current = { scope, index: column };
      ref.current?.focus({ preventScroll: true });
      return;
    }
    if (enabled && column !== null && current?.columns && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !isTableRowSelectionBlocked(event.target)) {
      event.preventDefault(); event.stopPropagation(); suppressClick.current = true;
      selectColumns(current.columns.anchor, column);
      return;
    }
    if (enabled && index !== null && range && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !isTableRowSelectionBlocked(event.target)) {
      event.preventDefault(); event.stopPropagation();
      suppressClick.current = true;
      selectRows(range.anchor, index);
      return;
    }
    if (selection.current) clear();
    if (index !== null) activeRow.current = { scope, index };
    if (column !== null) activeColumn.current = { scope, index: column };
    if (!enabled || !(event.target instanceof Element) || event.target.closest("input,textarea,select,button,a,label,[role='button'],[contenteditable]:not([contenteditable='false']),[role='combobox']")) return;
    if (index !== null && column !== null && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const next: NativeSelection = { scope, range: null, cells: [{ row: index, column }] };
      selection.current = next; setState({ scope, selection: next });
    }
    ref.current?.focus({ preventScroll: true });
  };
  const onBlurCapture = (event: FocusEvent<T>) => {
    if (event.relatedTarget instanceof Node && !ref.current?.contains(event.relatedTarget)) clear();
  };
  const stopSelectionClick = (event: SyntheticEvent<T>) => {
    if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); }
  };
  const rowProps = (index: number) => ({
    "data-native-table-row": index,
    "data-native-row-selected": Boolean(currentSelection?.range && index >= Math.min(currentSelection.range.anchor, currentSelection.range.end) && index <= Math.max(currentSelection.range.anchor, currentSelection.range.end)),
  });
  const columnProps = (index: number) => ({
    "data-native-table-column": index,
    "data-native-column-selected": Boolean(currentSelection?.columns && index >= Math.min(currentSelection.columns.anchor, currentSelection.columns.end) && index <= Math.max(currentSelection.columns.anchor, currentSelection.columns.end)),
  });
  const selectedCellKeys = new Set(currentSelection?.cells?.map(cell => `${cell.row}:${cell.column}`));
  const cellProps = (row: number, column: number) => ({
    ...columnProps(column),
    "data-native-cell-selected": selectedCellKeys.has(`${row}:${column}`),
  });

  return {
    ref, selected, copyToast, rowProps, columnProps, cellProps,
    className: currentSelection ? currentSelection.cells ? "native-table-cell-selection" : currentSelection.columns ? "native-table-column-selection" : currentSelection.range ? "native-table-row-selection" : "native-table-select-all" : "",
    handlers: { onKeyDownCapture, onCopyCapture, onPointerDownCapture, onBlurCapture, onClickCapture: stopSelectionClick, onChangeCapture: stopSelectionClick },
  };
}
