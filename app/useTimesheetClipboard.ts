"use client";

import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { TableContextMenu, type TableContextMenuAction } from "./TableContextMenu";
import { useWorkspaceAccess } from "./TableAccessContext";
import { useTableEscapeSelection } from "./useTableEscapeSelection";
import { isTableSelectAllShortcut } from "./tableSelectAllShortcut";
import { tableColumnSelectionIntent, tableRowSelectionIntent } from "./tableRowSelectionShortcut";
import { useTablePageSelectAll } from "./useTablePageSelectAll";
import { dispatchUndoShortcut, useUndoShortcut } from "./useUndoShortcut";
import { historyShortcut } from "./undoShortcut";
import "./timesheetSelection.css";

export type TimesheetClipboardChange = {
  rowIndex: number;
  columnIndex: number;
  value: string;
  note?: string;
  expectedRevision?: string | null;
  previousRevision?: string | null;
};

export type TimesheetClipboardSaveResult = {
  savedChanges: TimesheetClipboardChange[];
  failedChanges: TimesheetClipboardChange[];
  undoableChanges?: TimesheetClipboardChange[];
  revisions?: Array<Pick<TimesheetClipboardChange, "rowIndex" | "columnIndex" | "expectedRevision" | "previousRevision">>;
  cancelled?: boolean;
};

export type TimesheetClipboardSaveContext = { operation: "paste" | "delete" | "undo"; historyId: string };

function matchingClipboardChanges(changes: TimesheetClipboardChange[], matching: TimesheetClipboardChange[]) {
  const keys = new Set(matching.map(change => `${change.rowIndex}:${change.columnIndex}`));
  return changes.filter(change => keys.has(`${change.rowIndex}:${change.columnIndex}`));
}

function clipboardSaveResult(result: number | TimesheetClipboardSaveResult, changes: TimesheetClipboardChange[]) {
  if (typeof result === "number") return { undoableChanges: result > 0 ? changes : [], failedChanges: [], count: result, cancelled: false };
  const savedChanges = matchingClipboardChanges(changes, result.savedChanges);
  const savedKeys = new Set(savedChanges.map(change => `${change.rowIndex}:${change.columnIndex}`));
  const failedChanges = matchingClipboardChanges(changes, result.failedChanges).filter(change => !savedKeys.has(`${change.rowIndex}:${change.columnIndex}`));
  const undoableChanges = result.undoableChanges ? matchingClipboardChanges(savedChanges, result.undoableChanges) : savedChanges;
  return { undoableChanges, failedChanges, count: savedChanges.length, cancelled: result.cancelled ?? false, revisions: result.revisions };
}

function clipboardUndoChanges(previous: TimesheetClipboardChange[], result: ReturnType<typeof clipboardSaveResult>) {
  const revisions = new Map(result.revisions?.map(change => [`${change.rowIndex}:${change.columnIndex}`, change]));
  return matchingClipboardChanges(previous, result.undoableChanges).map(change => {
    const revision = revisions.get(`${change.rowIndex}:${change.columnIndex}`);
    return revision ? { ...change, expectedRevision: revision.expectedRevision, previousRevision: revision.previousRevision } : change;
  });
}

function rebaseClipboardUndoHistory(history: ClipboardUndoEntry[], undone: TimesheetClipboardChange[], revisions: TimesheetClipboardSaveResult["revisions"]) {
  if (!revisions?.length) return;
  const originals = new Map(undone.map(change => [`${change.rowIndex}:${change.columnIndex}`, change]));
  for (const { rowIndex, columnIndex, expectedRevision } of revisions) {
    const original = originals.get(`${rowIndex}:${columnIndex}`);
    if (original?.previousRevision === undefined) continue;
    for (let index = history.length - 1; index >= 0; index--) {
      const change = history[index].changes.find(item => item.rowIndex === rowIndex && item.columnIndex === columnIndex);
      if (!change) continue;
      if (change.expectedRevision === original.previousRevision) change.expectedRevision = expectedRevision;
      break;
    }
  }
}

function partialClipboardStatus(saved: number, failed: number) {
  return `Сохранено ячеек: ${saved} из ${saved + failed}. Не сохранено: ${failed}.`;
}

type ClipboardPoint = { rowIndex: number; columnIndex: number };
type ClipboardRange = { start: ClipboardPoint; end: ClipboardPoint };
type ClipboardSelection = { start: ClipboardPoint | null; end: ClipboardPoint | null; additionalRanges?: ClipboardRange[]; includeHeaders?: boolean; rowModeColumn?: number; columnModeRow?: number };
type ClipboardUndoEntry = { id: string; changes: TimesheetClipboardChange[] };

function isTimesheetInputTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox']"));
}

function scrollCellIntoVisibleArea(shell: HTMLDivElement, point: ClipboardPoint) {
  const cell = shell.querySelector<HTMLElement>(`[data-timesheet-row="${point.rowIndex}"][data-timesheet-column="${point.columnIndex}"]`);
  if (!cell) return;
  cell.scrollIntoView({ block: "nearest", inline: "nearest" });

  const shellRect = shell.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  const lastHeaderCell = shell.querySelector<HTMLElement>(".timesheet-table thead tr:last-child th");
  const footerCell = shell.querySelector<HTMLElement>(".timesheet-table tfoot th, .timesheet-table tfoot td");
  const stickyCells = Array.from(cell.closest("tr")?.querySelectorAll<HTMLElement>(".timesheet-sticky") ?? [])
    .map(stickyCell => ({ rect: stickyCell.getBoundingClientRect(), right: stickyCell.dataset.timesheetPin === "right" }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0);
  const visibleTop = Math.max(shellRect.top, lastHeaderCell?.getBoundingClientRect().bottom ?? shellRect.top);
  const visibleBottom = Math.min(shellRect.bottom, footerCell?.getBoundingClientRect().top ?? shellRect.bottom);
  const visibleLeft = Math.max(shellRect.left, ...stickyCells.filter(cell => !cell.right).map(({ rect }) => rect.right));
  const visibleRight = Math.min(shellRect.right, ...stickyCells.filter(cell => cell.right).map(({ rect }) => rect.left));
  const verticalOffset = cellRect.top < visibleTop
    ? cellRect.top - visibleTop
    : cellRect.bottom > visibleBottom
      ? cellRect.bottom - visibleBottom
      : 0;
  const horizontalOffset = cell.classList.contains("timesheet-sticky") ? 0 : cellRect.left < visibleLeft
    ? cellRect.left - visibleLeft
    : cellRect.right > visibleRight
      ? cellRect.right - visibleRight
      : 0;

  if (verticalOffset || horizontalOffset) {
    shell.scrollBy({ top: verticalOffset, left: horizontalOffset });
  }
}

type TimesheetClipboardOptions = {
  hasSelectedRows?: boolean;
  onClearRowSelection?: () => void;
  escapeBlocked?: boolean;
  getContextActions?: (rowIndex: number, close: () => void) => TableContextMenuAction[];
  shellRef?: RefObject<HTMLDivElement | null>;
  ensureRowVisible?: (rowIndex: number) => void;
  rowCount: number;
  columnCount: number;
  /** Day columns keep indices 0..columnCount-1. Read-only columns may use signed or trailing indices. */
  columnIndexes?: readonly number[];
  resetKey: string;
  getValue: (rowIndex: number, columnIndex: number) => string;
  getHeader?: (columnIndex: number) => string;
  canPaste: (rowIndex: number, columnIndex: number) => boolean;
  onPaste: (changes: TimesheetClipboardChange[], context?: TimesheetClipboardSaveContext) => Promise<number | TimesheetClipboardSaveResult>;
  getUndoValue?: (rowIndex: number, columnIndex: number) => string;
  getUndoNote?: (rowIndex: number, columnIndex: number) => string;
  canDelete?: (rowIndex: number, columnIndex: number) => boolean;
  onDelete?: (changes: TimesheetClipboardChange[], context?: TimesheetClipboardSaveContext) => Promise<number | TimesheetClipboardSaveResult>;
  onActivate?: (rowIndex: number, columnIndex: number, anchor: HTMLElement) => void;
  onType?: (rowIndex: number, columnIndex: number, anchor: HTMLElement, value: string) => void;
};

function selectionBounds(selection: ClipboardSelection | null) {
  if (!selection?.start || !selection.end) return null;
  return {
    rowStart: Math.min(selection.start.rowIndex, selection.end.rowIndex),
    rowEnd: Math.max(selection.start.rowIndex, selection.end.rowIndex),
    columnStart: Math.min(selection.start.columnIndex, selection.end.columnIndex),
    columnEnd: Math.max(selection.start.columnIndex, selection.end.columnIndex),
  };
}

function selectionRanges(selection: ClipboardSelection | null): ClipboardRange[] {
  if (!selection?.start || !selection.end) return [];
  return [...(selection.additionalRanges ?? []), { start: selection.start, end: selection.end }];
}

function selectionHasCell(selection: ClipboardSelection | null, rowIndex: number, columnIndex: number) {
  return selectionRanges(selection).some(range => {
    const bounds = selectionBounds(range)!;
    return rowIndex >= bounds.rowStart && rowIndex <= bounds.rowEnd && columnIndex >= bounds.columnStart && columnIndex <= bounds.columnEnd;
  });
}

function selectionAxes(selection: ClipboardSelection | null, columns: readonly number[]) {
  const bounds = selectionRanges(selection).map(range => selectionBounds(range)!);
  const rows = new Set<number>();
  for (const range of bounds) {
    for (let rowIndex = range.rowStart; rowIndex <= range.rowEnd; rowIndex++) rows.add(rowIndex);
  }
  return {
    rows: [...rows].sort((left, right) => left - right),
    columns: columns.filter(columnIndex => bounds.some(range => columnIndex >= range.columnStart && columnIndex <= range.columnEnd)),
  };
}

function removeSelectionCell(selection: ClipboardSelection, point: ClipboardPoint, columns: readonly number[]): ClipboardSelection | null {
  const ranges: ClipboardRange[] = [];
  for (const range of selectionRanges(selection)) {
    const bounds = selectionBounds(range)!;
    if (point.rowIndex < bounds.rowStart || point.rowIndex > bounds.rowEnd || point.columnIndex < bounds.columnStart || point.columnIndex > bounds.columnEnd) {
      ranges.push(range);
      continue;
    }
    // Split rectangles instead of storing every selected cell in large tabular ranges.
    if (point.rowIndex > bounds.rowStart) ranges.push({ start: { rowIndex: bounds.rowStart, columnIndex: bounds.columnStart }, end: { rowIndex: point.rowIndex - 1, columnIndex: bounds.columnEnd } });
    if (point.rowIndex < bounds.rowEnd) ranges.push({ start: { rowIndex: point.rowIndex + 1, columnIndex: bounds.columnStart }, end: { rowIndex: bounds.rowEnd, columnIndex: bounds.columnEnd } });
    if (point.columnIndex > bounds.columnStart) ranges.push({ start: { rowIndex: point.rowIndex, columnIndex: bounds.columnStart }, end: { rowIndex: point.rowIndex, columnIndex: point.columnIndex - 1 } });
    if (point.columnIndex < bounds.columnEnd) ranges.push({ start: { rowIndex: point.rowIndex, columnIndex: point.columnIndex + 1 }, end: { rowIndex: point.rowIndex, columnIndex: bounds.columnEnd } });
  }
  const visibleRanges = ranges.flatMap(range => {
    const bounds = selectionBounds(range)!;
    const visibleColumns = columns.filter(column => column >= bounds.columnStart && column <= bounds.columnEnd);
    return visibleColumns.length ? [{ start: { ...range.start, columnIndex: visibleColumns[0] }, end: { ...range.end, columnIndex: visibleColumns.at(-1)! } }] : [];
  });
  const active = visibleRanges.pop();
  return active ? visibleRanges.length ? { ...active, additionalRanges: visibleRanges } : active : null;
}

export function useTimesheetClipboard({ hasSelectedRows = false, onClearRowSelection, escapeBlocked = false, getContextActions, shellRef: suppliedShellRef, ensureRowVisible, rowCount, columnCount, columnIndexes, resetKey, getValue, getHeader, canPaste, onPaste, getUndoValue = getValue, getUndoNote, canDelete, onDelete, onActivate, onType }: TimesheetClipboardOptions) {
  const access = useWorkspaceAccess();
  const defaultShellRef = useRef<HTMLDivElement>(null);
  const shellRef = suppliedShellRef ?? defaultShellRef;
  const [selection, setSelection] = useState<ClipboardSelection | null>(null);
  const [status, setStatus] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; rowIndex: number; columnIndex: number; error: string } | null>(null);
  const selectionRef = useRef(selection);
  const dragging = useRef(false);
  const undoStack = useRef<ClipboardUndoEntry[]>([]);
  const undoing = useRef(false);
  const mutation = useRef<symbol | null>(null);
  const scopeVersion = useRef(0);
  const historySequence = useRef(0);
  const lastHeaderCopy = useRef<string | null>(null);
  const selectionColumns = columnIndexes ?? Array.from({ length: columnCount }, (_, index) => index);

  const createHistoryId = useCallback(() => `${scopeVersion.current}:${++historySequence.current}`, []);

  const rememberUndo = useCallback((changes: TimesheetClipboardChange[], historyId?: string) => {
    if (!changes.length) return;
    const id = historyId ?? createHistoryId();
    const previous = undoStack.current.find(entry => entry.id === id);
    if (previous) {
      const existingKeys = new Set(previous.changes.map(change => `${change.rowIndex}:${change.columnIndex}`));
      previous.changes.push(...changes.filter(change => !existingKeys.has(`${change.rowIndex}:${change.columnIndex}`)).map(change => ({ ...change })));
      return;
    }
    undoStack.current = [...undoStack.current.slice(-49), { id, changes: changes.map(change => ({ ...change })) }];
  }, [createHistoryId]);

  const forgetUndo = useCallback((historyId: string, changes: TimesheetClipboardChange[]) => {
    const entry = undoStack.current.find(item => item.id === historyId);
    const revisions = changes.filter(change => change.expectedRevision !== undefined);
    if (entry && revisions.length) rebaseClipboardUndoHistory(undoStack.current.filter(item => item !== entry), entry.changes, revisions);
    const keys = new Set(changes.map(change => `${change.rowIndex}:${change.columnIndex}`));
    undoStack.current = undoStack.current.flatMap(entry => {
      if (entry.id !== historyId) return [entry];
      const remaining = entry.changes.filter(change => !keys.has(`${change.rowIndex}:${change.columnIndex}`));
      return remaining.length ? [{ id: entry.id, changes: remaining }] : [];
    });
  }, []);

  const notify = useCallback((message: string) => setStatus(message), []);

  const previousValues = useCallback((changes: TimesheetClipboardChange[]) => changes.map((change) => ({
    rowIndex: change.rowIndex,
    columnIndex: change.columnIndex,
    value: getUndoValue(change.rowIndex, change.columnIndex),
    ...(getUndoNote ? { note: getUndoNote(change.rowIndex, change.columnIndex) } : {}),
  })), [getUndoNote, getUndoValue]);

  const clearSelection = useCallback(() => {
    dragging.current = false;
    selectionRef.current = null;
    setSelection(null);
    setStatus("");
    setContextMenu(null);
  }, []);

  useTableEscapeSelection({
    hasSelection: () => Boolean(selectionRef.current || hasSelectedRows),
    clearSelection: () => {
      clearSelection();
      onClearRowSelection?.();
    },
    isEditing: () => Boolean(escapeBlocked || contextMenu || !shellRef.current),
  });

  useEffect(() => {
    const finishDrag = () => { dragging.current = false; };
    window.addEventListener("mouseup", finishDrag);
    return () => window.removeEventListener("mouseup", finishDrag);
  }, []);

  useEffect(() => {
    const clearOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".timesheet-cell-popover, .custom-select-menu, .table-context-menu, .app-confirmation-dialog")) return;
      if (target instanceof Element && target.closest("[data-table-page-horizontal]") && target.closest(".table-page-scroll-stage") === shellRef.current?.closest(".table-page-scroll-stage")) return;
      if (!selectionRef.current || !(target instanceof Node) || shellRef.current?.contains(target)) return;
      clearSelection();
    };
    document.addEventListener("pointerdown", clearOutside);
    return () => document.removeEventListener("pointerdown", clearOutside);
  }, [clearSelection, shellRef]);

  useLayoutEffect(() => {
    scopeVersion.current += 1;
    undoStack.current = [];
    mutation.current = null;
    undoing.current = false;
    // Event handlers may run before the visual reset frame. Invalidate their
    // coordinates now, before the new view's value getters can be used.
    selectionRef.current = null;
    dragging.current = false;
    const frame = requestAnimationFrame(clearSelection);
    return () => {
      scopeVersion.current += 1;
      mutation.current = null;
      cancelAnimationFrame(frame);
    };
  }, [clearSelection, resetKey]);

  useEffect(() => {
    if (!status) return;
    const timeout = window.setTimeout(() => setStatus(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const selectCell = useCallback((rowIndex: number, columnIndex: number, event: MouseEvent<HTMLTableCellElement>) => {
    if (event.button !== 0) return;
    if (typeof Element !== "undefined" && event.target instanceof Element && event.target.closest("button, input, textarea, select, [contenteditable='true'], [role='combobox']")) return;
    event.preventDefault();
    const point = { rowIndex, columnIndex };
    const additive = (event.ctrlKey || event.metaKey) && !event.shiftKey;
    if (additive && selectionHasCell(selectionRef.current, rowIndex, columnIndex)) {
      const next = removeSelectionCell(selectionRef.current!, point, selectionColumns);
      dragging.current = false;
      selectionRef.current = next;
      setSelection(next);
      setContextMenu(null);
      shellRef.current?.focus({ preventScroll: true });
      return;
    }
    const start = event.shiftKey && selectionRef.current?.start ? selectionRef.current.start : point;
    const rowModeColumn = event.shiftKey ? selectionRef.current?.rowModeColumn : undefined;
    const columnModeRow = event.shiftKey ? selectionRef.current?.columnModeRow : undefined;
    const range = columnModeRow !== undefined ? {
      start: { rowIndex: 0, columnIndex: start.columnIndex },
      end: { rowIndex: rowCount - 1, columnIndex }, columnModeRow, includeHeaders: true,
    } : rowModeColumn === undefined ? { start, end: point } : {
      start: { rowIndex: start.rowIndex, columnIndex: selectionColumns[0] },
      end: { rowIndex, columnIndex: selectionColumns.at(-1)! }, rowModeColumn,
    };
    const additionalRanges = additive ? selectionRanges(selectionRef.current) : event.shiftKey ? selectionRef.current?.additionalRanges : undefined;
    const next = additionalRanges?.length ? { ...range, additionalRanges } : range;
    dragging.current = true;
    selectionRef.current = next;
    setSelection(next);
    setContextMenu(null);
    shellRef.current?.focus({ preventScroll: true });
  }, [rowCount, selectionColumns, shellRef]);

  const extendSelection = useCallback((rowIndex: number, columnIndex: number) => {
    if (!dragging.current || !selectionRef.current?.start) return;
    const current = selectionRef.current;
    const next = current.columnModeRow !== undefined
      ? { ...current, end: { rowIndex: rowCount - 1, columnIndex } }
      : current.rowModeColumn === undefined
      ? { ...current, start: current.start, end: { rowIndex, columnIndex } }
      : { ...current, end: { rowIndex, columnIndex: selectionColumns.at(-1)! } };
    selectionRef.current = next;
    setSelection(next);
  }, [rowCount, selectionColumns]);

  const selectWholeRows = useCallback((anchorRow: number, endRow: number, activeColumn: number) => {
    if (!rowCount || !selectionColumns.length || escapeBlocked || contextMenu) return false;
    const rowIndex = Math.max(0, Math.min(rowCount - 1, endRow));
    const next = {
      start: { rowIndex: Math.max(0, Math.min(rowCount - 1, anchorRow)), columnIndex: selectionColumns[0] },
      end: { rowIndex, columnIndex: selectionColumns.at(-1)! }, rowModeColumn: activeColumn,
    };
    dragging.current = false;
    selectionRef.current = next;
    setSelection(next);
    setContextMenu(null);
    ensureRowVisible?.(rowIndex);
    requestAnimationFrame(() => {
      if (shellRef.current) scrollCellIntoVisibleArea(shellRef.current, { rowIndex, columnIndex: activeColumn });
    });
    return true;
  }, [contextMenu, ensureRowVisible, escapeBlocked, rowCount, selectionColumns, shellRef]);

  const selectWholeColumns = useCallback((anchorColumn: number, endColumn: number, activeRow: number) => {
    if (!rowCount || !selectionColumns.length || escapeBlocked || contextMenu) return false;
    if (!selectionColumns.includes(anchorColumn) || !selectionColumns.includes(endColumn)) return false;
    const rowIndex = Math.max(0, Math.min(rowCount - 1, activeRow));
    const next = {
      start: { rowIndex: 0, columnIndex: anchorColumn },
      end: { rowIndex: rowCount - 1, columnIndex: endColumn }, columnModeRow: rowIndex, includeHeaders: true,
    };
    dragging.current = false;
    selectionRef.current = next;
    setSelection(next);
    setContextMenu(null);
    ensureRowVisible?.(rowIndex);
    requestAnimationFrame(() => {
      if (shellRef.current) scrollCellIntoVisibleArea(shellRef.current, { rowIndex, columnIndex: endColumn });
    });
    return true;
  }, [contextMenu, ensureRowVisible, escapeBlocked, rowCount, selectionColumns, shellRef]);

  const focusSelection = useCallback((point: ClipboardPoint, extend: boolean) => {
    if (rowCount <= 0 || !selectionColumns.length) return;
    const columnIndex = selectionColumns.reduce((nearest, index) => Math.abs(index - point.columnIndex) < Math.abs(nearest - point.columnIndex) ? index : nearest, selectionColumns[0]);
    const nextPoint = {
      rowIndex: Math.max(0, Math.min(rowCount - 1, point.rowIndex)),
      columnIndex,
    };
    const next = {
      start: extend && selectionRef.current?.start && selectionRef.current.rowModeColumn === undefined && selectionRef.current.columnModeRow === undefined ? selectionRef.current.start : nextPoint,
      end: nextPoint,
      ...(extend && selectionRef.current?.additionalRanges?.length ? { additionalRanges: selectionRef.current.additionalRanges } : {}),
    };
    dragging.current = false;
    selectionRef.current = next;
    setSelection(next);
    ensureRowVisible?.(nextPoint.rowIndex);
    requestAnimationFrame(() => {
      if (shellRef.current) scrollCellIntoVisibleArea(shellRef.current, nextPoint);
    });
  }, [selectionColumns, ensureRowVisible, rowCount, shellRef]);

  const selectAllCells = useCallback(() => {
    if (!selectionColumns.length || escapeBlocked || !rowCount && !getHeader) return false;
    const next = { start: rowCount ? { rowIndex: 0, columnIndex: selectionColumns[0] } : null, end: rowCount ? { rowIndex: rowCount - 1, columnIndex: selectionColumns.at(-1)! } : null, includeHeaders: true };
    dragging.current = false;
    selectionRef.current = next;
    setSelection(next);
    setContextMenu(null);
    setStatus(`Выделено: ${rowCount} × ${selectionColumns.length}`);
    return true;
  }, [escapeBlocked, getHeader, rowCount, selectionColumns]);

  useTablePageSelectAll({ rootRef: shellRef, selectAll: selectAllCells, enabled: !escapeBlocked });

  const selectedText = useCallback(() => {
    const bounds = selectionBounds(selectionRef.current);
    if (!bounds && !(selectionRef.current?.includeHeaders && getHeader)) return undefined;
    const axes = selectionAxes(selectionRef.current, selectionColumns);
    const columns = bounds ? axes.columns : selectionColumns;
    const rows: string[] = [];
    if (selectionRef.current?.includeHeaders && getHeader) {
      rows.push(columns
        .map(index => getHeader(index).replaceAll("\t", " ").replaceAll(/\r?\n/g, " ")).join("\t"));
    }
    for (const rowIndex of axes.rows) {
      const values: string[] = [];
      for (const columnIndex of columns) {
        values.push(selectionHasCell(selectionRef.current, rowIndex, columnIndex) ? getValue(rowIndex, columnIndex).replaceAll("\t", " ").replaceAll(/\r?\n/g, " ") : "");
      }
      rows.push(values.join("\t"));
    }
    return rows.join("\n");
  }, [getHeader, getValue, selectionColumns]);

  const onCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    if (isTimesheetInputTarget(event.target)) return;
    const text = selectedText();
    if (text === undefined) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    const headerRows = selectionRef.current?.includeHeaders && getHeader ? 1 : 0;
    lastHeaderCopy.current = headerRows ? text : null;
    setStatus(`Скопировано: ${text.split("\n").length} × ${text.split("\n", 1)[0].split("\t").length}`);
  }, [getHeader, selectedText]);

  const pasteText = useCallback(async (text: string) => {
    if (mutation.current) return 0;
    const bounds = selectionBounds(selectionRef.current);
    if (!bounds) return 0;
    const clipboardText = text.replace(/\r/g, "");
    const lines = clipboardText.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const matrix = lines.map((line) => line.split("\t"));
    if ((selectionRef.current?.includeHeaders || lastHeaderCopy.current === clipboardText) && getHeader && matrix.length) {
      const headers = selectionColumns.slice(selectionColumns.indexOf(bounds.columnStart), selectionColumns.indexOf(bounds.columnStart) + matrix[0].length)
        .map(index => getHeader(index).replaceAll("\t", " ").replaceAll(/\r?\n/g, " "));
      // A select-all copy can be pasted back into the same table without treating
      // its exact visible header row as employee data, even after choosing a target.
      if (matrix[0].length === headers.length && matrix[0].every((value, index) => value === headers[index])) matrix.shift();
      else if (lastHeaderCopy.current === clipboardText) {
        setStatus("Столбцы скопированной таблицы не совпадают с местом вставки. Выберите первую ячейку исходного диапазона.");
        return 0;
      }
    }
    if (!matrix.length) return 0;

    const sourceRows = matrix.length;
    const sourceColumns = Math.max(...matrix.map((line) => line.length));
    const disjoint = Boolean(selectionRef.current?.additionalRanges?.length);
    if (disjoint && (sourceRows !== 1 || sourceColumns !== 1)) {
      setStatus("Для вставки таблицы выберите один непрерывный диапазон.");
      return 0;
    }
    const axes = selectionAxes(selectionRef.current, selectionColumns);
    const selectedRows = disjoint ? axes.rows.length : bounds.rowEnd - bounds.rowStart + 1;
    const selectedColumns = disjoint ? axes.columns.length : selectionColumns.filter(index => index >= bounds.columnStart && index <= bounds.columnEnd).length;
    const targetColumnStart = selectionColumns.indexOf(bounds.columnStart);
    const targetRows = sourceRows === 1 ? selectedRows : sourceRows;
    const targetColumns = sourceColumns === 1 ? selectedColumns : sourceColumns;
    const changes: TimesheetClipboardChange[] = [];

    for (let rowOffset = 0; rowOffset < targetRows; rowOffset++) {
      const rowIndex = disjoint ? axes.rows[rowOffset] : bounds.rowStart + rowOffset;
      if (rowIndex >= rowCount) break;
      for (let columnOffset = 0; columnOffset < targetColumns; columnOffset++) {
        const columnIndex = disjoint ? axes.columns[columnOffset] : selectionColumns[targetColumnStart + columnOffset];
        if (disjoint && !selectionHasCell(selectionRef.current, rowIndex, columnIndex)) continue;
        if (columnIndex === undefined || columnIndex < 0 || columnIndex >= columnCount || !canPaste(rowIndex, columnIndex)) continue;
        const value = matrix[rowOffset % sourceRows]?.[columnOffset % sourceColumns];
        if (value === undefined) continue;
        changes.push({
          rowIndex,
          columnIndex,
          value,
        });
      }
    }

    if (!changes.length) {
      setStatus("В выбранном диапазоне нет доступных для редактирования ячеек");
      return 0;
    }
    setStatus("Вставляем данные…");
    const undoChanges = previousValues(changes);
    const token = Symbol("paste");
    const version = scopeVersion.current;
    const historyId = createHistoryId();
    mutation.current = token;
    try {
      const result = clipboardSaveResult(await onPaste(changes, { operation: "paste", historyId }), changes);
      if (scopeVersion.current !== version) return 0;
      if (result.cancelled) { setStatus(""); return null; }
      rememberUndo(clipboardUndoChanges(undoChanges, result), historyId);
      setStatus(result.failedChanges.length ? partialClipboardStatus(result.count, result.failedChanges.length) : `Вставлено ячеек: ${result.count}`);
      return result.count;
    } catch (pasteError) {
      if (scopeVersion.current === version) setStatus(pasteError instanceof Error ? pasteError.message : "Не удалось вставить данные");
      return 0;
    } finally {
      if (mutation.current === token) mutation.current = null;
    }
  }, [canPaste, columnCount, createHistoryId, getHeader, onPaste, previousValues, rememberUndo, rowCount, selectionColumns]);

  const onClipboardPaste = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    if (isTimesheetInputTarget(event.target)) return;
    if (!selectionBounds(selectionRef.current)) return;
    event.preventDefault();
    void pasteText(event.clipboardData.getData("text/plain"));
  }, [pasteText]);

  const deleteSelection = useCallback(async () => {
    if (mutation.current) return 0;
    if (!canDelete || !onDelete) return 0;
    const bounds = selectionBounds(selectionRef.current);
    if (!bounds) return 0;
    const changes: TimesheetClipboardChange[] = [];
    const axes = selectionAxes(selectionRef.current, selectionColumns);
    for (const rowIndex of axes.rows) {
      for (const columnIndex of axes.columns) {
        if (!selectionHasCell(selectionRef.current, rowIndex, columnIndex)) continue;
        if (rowIndex < rowCount && columnIndex >= 0 && columnIndex < columnCount && canDelete(rowIndex, columnIndex)) {
          changes.push({ rowIndex, columnIndex, value: "" });
        }
      }
    }
    if (!changes.length) {
      setStatus("В выбранном диапазоне нет ручных значений");
      return 0;
    }
    setStatus("Удаляем ручные значения…");
    const undoChanges = previousValues(changes);
    const token = Symbol("delete");
    const version = scopeVersion.current;
    const historyId = createHistoryId();
    mutation.current = token;
    try {
      const result = clipboardSaveResult(await onDelete(changes, { operation: "delete", historyId }), changes);
      if (scopeVersion.current !== version) return 0;
      if (result.cancelled) { setStatus(""); return null; }
      rememberUndo(clipboardUndoChanges(undoChanges, result), historyId);
      setStatus(result.failedChanges.length ? partialClipboardStatus(result.count, result.failedChanges.length) : `Удалено ручных значений: ${result.count}`);
      return result.count;
    } catch (deleteError) {
      if (scopeVersion.current === version) setStatus(deleteError instanceof Error ? deleteError.message : "Не удалось удалить ручные значения");
      return 0;
    } finally {
      if (mutation.current === token) mutation.current = null;
    }
  }, [canDelete, columnCount, createHistoryId, onDelete, previousValues, rememberUndo, rowCount, selectionColumns]);

  const openContextMenu = useCallback((rowIndex: number, columnIndex: number, event: MouseEvent<HTMLTableCellElement>) => {
    const cell = event.currentTarget;
    const shell = shellRef.current;
    if (!shell?.contains(cell) || cell.closest(".timesheet-grid-shell") !== shell || !["TD", "TH"].includes(cell.tagName)) return;
    event.preventDefault();
    event.stopPropagation();
    const point = { rowIndex, columnIndex };
    const insideSelection = selectionHasCell(selectionRef.current, rowIndex, columnIndex);
    const next = insideSelection ? selectionRef.current! : { start: point, end: point };
    selectionRef.current = next;
    setSelection(next);
    shellRef.current?.focus({ preventScroll: true });
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 256)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 480)),
      rowIndex,
      columnIndex,
      error: "",
    });
  }, [shellRef]);

  const undoLastChange = useCallback(async () => {
    if (undoing.current || mutation.current) return;
    const entry = undoStack.current.pop();
    if (!entry?.changes.length) {
      setStatus("Нет изменений для отмены");
      return;
    }
    const changes = entry.changes;
    undoing.current = true;
    const token = Symbol("undo");
    const version = scopeVersion.current;
    mutation.current = token;
    setStatus("Отменяем последнее изменение…");
    try {
      const result = clipboardSaveResult(await onPaste(changes, { operation: "undo", historyId: entry.id }), changes);
      if (scopeVersion.current !== version) return;
      if (result.cancelled) { undoStack.current.push(entry); setStatus(""); return; }
      rebaseClipboardUndoHistory(undoStack.current, changes, result.revisions);
      if (result.failedChanges.length) undoStack.current.push({ id: entry.id, changes: result.failedChanges });
      setStatus(result.failedChanges.length ? `Отменено изменений: ${result.count}. Не удалось отменить: ${result.failedChanges.length}.` : `Отменено изменений: ${result.count}`);
    } catch (undoError) {
      if (scopeVersion.current !== version) return;
      undoStack.current.push(entry);
      setStatus(undoError instanceof Error ? undoError.message : "Не удалось отменить изменение");
    } finally {
      if (mutation.current === token) {
        mutation.current = null;
        undoing.current = false;
      }
    }
  }, [onPaste]);

  // Register the existing revision-aware persisted history with the same
  // single-owner keyboard routing as every other editable table.
  useUndoShortcut({ rootRef: shellRef, undo: undoLastChange, disabled: escapeBlocked });

  const onKeyDown = useCallback(async (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTimesheetInputTarget(event.target)) return;
    if (event.key === "Escape") {
      return;
    }
    const selected = selectionRef.current;
    const activePoint = selected?.end ? { rowIndex: selected.columnModeRow ?? selected.end.rowIndex, columnIndex: selected.rowModeColumn ?? selected.end.columnIndex } : null;
    if (historyShortcut(event.nativeEvent ?? event)) {
      dispatchUndoShortcut(event.nativeEvent ?? event);
      return;
    }
    const movement = {
      ArrowLeft: { row: 0, column: -1 },
      ArrowRight: { row: 0, column: 1 },
      ArrowUp: { row: -1, column: 0 },
      ArrowDown: { row: 1, column: 0 },
    }[event.key];
    if (movement && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const current = activePoint ?? { rowIndex: 0, columnIndex: 0 };
      const currentColumn = selectionColumns.indexOf(current.columnIndex);
      const nextColumn = selectionColumns[Math.max(0, Math.min(selectionColumns.length - 1, currentColumn + movement.column))] ?? current.columnIndex;
      focusSelection({ rowIndex: current.rowIndex + movement.row, columnIndex: nextColumn }, event.shiftKey);
      return;
    }
    if ((event.key === "Enter" || event.key === "F2") && onActivate) {
      const current = activePoint;
      if (!current) return;
      if (current.columnIndex < 0 || current.columnIndex >= columnCount) return;
      const anchor = shellRef.current?.querySelector<HTMLElement>(`[data-timesheet-row="${current.rowIndex}"][data-timesheet-column="${current.columnIndex}"]`);
      if (!anchor) return;
      event.preventDefault();
      if (selected?.rowModeColumn !== undefined || selected?.columnModeRow !== undefined || selected?.additionalRanges?.length) focusSelection(current, false);
      onActivate(current.rowIndex, current.columnIndex, anchor);
      return;
    }
    if (event.key.length === 1 && event.key.trim() && !event.altKey && !event.ctrlKey && !event.metaKey && onType) {
      const current = activePoint;
      if (!current) return;
      if (current.columnIndex < 0 || current.columnIndex >= columnCount) return;
      const anchor = shellRef.current?.querySelector<HTMLElement>(`[data-timesheet-row="${current.rowIndex}"][data-timesheet-column="${current.columnIndex}"]`);
      if (!anchor) return;
      event.preventDefault();
      if (selected?.rowModeColumn !== undefined || selected?.columnModeRow !== undefined || selected?.additionalRanges?.length) focusSelection(current, false);
      onType(current.rowIndex, current.columnIndex, anchor, event.key);
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    await deleteSelection();
  }, [columnCount, deleteSelection, focusSelection, onActivate, onType, selectionColumns, shellRef]);

  const onKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const intent = tableRowSelectionIntent(event.nativeEvent ?? event);
    const current = selectionRef.current;
    if (intent === "row" || intent && current?.rowModeColumn !== undefined) {
      const end = current?.end ?? { rowIndex: 0, columnIndex: selectionColumns[0] };
      const activeRow = current?.columnModeRow ?? end.rowIndex;
      const anchor = current?.columnModeRow ?? current?.start?.rowIndex ?? activeRow;
      if (!selectWholeRows(anchor, activeRow + (intent === "up" ? -1 : intent === "down" ? 1 : 0), current?.rowModeColumn ?? end.columnIndex)) return;
      event.preventDefault(); event.stopPropagation();
      shellRef.current?.focus({ preventScroll: true });
      return;
    }
    const columnIntent = tableColumnSelectionIntent(event.nativeEvent ?? event);
    if (columnIntent === "column" || columnIntent && current?.columnModeRow !== undefined) {
      const end = current?.end ?? { rowIndex: 0, columnIndex: selectionColumns[0] };
      const activeColumn = current?.rowModeColumn ?? end.columnIndex;
      const anchorColumn = current?.rowModeColumn ?? current?.start?.columnIndex ?? activeColumn;
      const step = columnIntent === "left" ? -1 : columnIntent === "right" ? 1 : 0;
      const column = selectionColumns[Math.max(0, Math.min(selectionColumns.length - 1, selectionColumns.indexOf(activeColumn) + step))];
      if (!selectWholeColumns(anchorColumn, column, current?.columnModeRow ?? end.rowIndex)) return;
      event.preventDefault(); event.stopPropagation();
      shellRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!isTableSelectAllShortcut(event)) return;
    if (!selectAllCells()) return;
    event.preventDefault();
    event.stopPropagation();
    shellRef.current?.focus({ preventScroll: true });
  }, [selectAllCells, selectWholeColumns, selectWholeRows, selectionColumns, shellRef]);

  const cellClass = useCallback((rowIndex: number, columnIndex: number) => {
    if (!selectionHasCell(selection, rowIndex, columnIndex)) return "";
    const columnPosition = selectionColumns.indexOf(columnIndex);
    return [
      "timesheet-cell-selected",
      !selectionHasCell(selection, rowIndex - 1, columnIndex) ? "timesheet-cell-selection-top" : "",
      !selectionHasCell(selection, rowIndex + 1, columnIndex) ? "timesheet-cell-selection-bottom" : "",
      columnPosition <= 0 || !selectionHasCell(selection, rowIndex, selectionColumns[columnPosition - 1]) ? "timesheet-cell-selection-left" : "",
      columnPosition === selectionColumns.length - 1 || !selectionHasCell(selection, rowIndex, selectionColumns[columnPosition + 1]) ? "timesheet-cell-selection-right" : "",
    ].filter(Boolean).join(" ");
  }, [selection, selectionColumns]);

  const headerClass = useCallback((columnIndex: number) => {
    if (!selection?.includeHeaders) return "";
    const bounds = selectionBounds(selection);
    return !bounds || columnIndex >= bounds.columnStart && columnIndex <= bounds.columnEnd ? "timesheet-column-header-selected" : "";
  }, [selection]);

  return {
    shellRef,
    status,
    activeCell: selection?.end ? { rowIndex: selection.columnModeRow ?? selection.end.rowIndex, columnIndex: selection.rowModeColumn ?? selection.end.columnIndex } : null,
    headersSelected: Boolean(selection?.includeHeaders && getHeader && selection.columnModeRow === undefined),
    focusCell: (rowIndex: number, columnIndex: number) => focusSelection({ rowIndex, columnIndex }, false),
    cellClass,
    headerClass,
    cellHandlers: (rowIndex: number, columnIndex: number) => ({
      onMouseDown: (event: MouseEvent<HTMLTableCellElement>) => selectCell(rowIndex, columnIndex, event),
      onMouseEnter: () => extendSelection(rowIndex, columnIndex),
      onContextMenu: (event: MouseEvent<HTMLTableCellElement>) => openContextMenu(rowIndex, columnIndex, event),
      "data-timesheet-row": rowIndex,
      "data-timesheet-column": columnIndex,
      "aria-selected": Boolean(cellClass(rowIndex, columnIndex)),
    }),
    shellHandlers: { onCopy, onPaste: onClipboardPaste, onKeyDown, onKeyDownCapture },
    // Menu callbacks read the current selection only after the user chooses an action.
    // eslint-disable-next-line react-hooks/refs
    contextMenu: contextMenu ? createElement(TableContextMenu, {
      x: contextMenu.x,
      y: contextMenu.y,
      caption: "Ячейка табеля",
      value: getValue(contextMenu.rowIndex, contextMenu.columnIndex),
      error: contextMenu.error,
      onClose: () => setContextMenu(null),
      actions: [
        ...(getContextActions?.(contextMenu.rowIndex, () => setContextMenu(null)) ?? []),
        { label: "Копировать / вставить", section: "Работа с таблицей", onSelect: () => {}, children: [
        { label: "Копировать ячейку", shortcut: "Ctrl+C", onSelect: async () => { try { const text = selectedText() ?? ""; await navigator.clipboard.writeText(text); lastHeaderCopy.current = selectionRef.current?.includeHeaders && getHeader ? text : null; setStatus("Ячейка скопирована"); setContextMenu(null); } catch { setContextMenu((current) => current ? { ...current, error: "Не удалось скопировать. Разрешите доступ к буферу обмена." } : current); } } },
        ...(access?.edit !== false ? [{ label: "Вставить в ячейку", shortcut: "Ctrl+V", disabled: !canPaste(contextMenu.rowIndex, contextMenu.columnIndex), title: canPaste(contextMenu.rowIndex, contextMenu.columnIndex) ? undefined : "Нет права редактирования этой ячейки", onSelect: async () => { try { const changed = await pasteText(await navigator.clipboard.readText()); if (changed) setContextMenu(null); else if (changed !== null) setContextMenu((current) => current ? { ...current, error: "Значение не вставлено." } : current); } catch { setContextMenu((current) => current ? { ...current, error: "Не удалось прочитать буфер обмена. Разрешите доступ в браузере." } : current); } } }] satisfies TableContextMenuAction[] : []),
        ] },
        ...(access?.edit !== false ? [{ label: "Редактировать ячейку", shortcut: "Enter", separatorBefore: true, disabled: !onActivate || !canPaste(contextMenu.rowIndex, contextMenu.columnIndex), title: onActivate && canPaste(contextMenu.rowIndex, contextMenu.columnIndex) ? undefined : "Нет права редактирования этой ячейки", onSelect: () => { const anchor = document.querySelector<HTMLElement>(`[data-timesheet-row="${contextMenu.rowIndex}"][data-timesheet-column="${contextMenu.columnIndex}"]`); if (anchor) onActivate?.(contextMenu.rowIndex, contextMenu.columnIndex, anchor); setContextMenu(null); } }] satisfies TableContextMenuAction[] : []),
        ...(access?.delete !== false ? [{ label: "Удалить ручное значение", shortcut: "Delete", danger: true, section: "Удаление", separatorBefore: true, disabled: !canDelete?.(contextMenu.rowIndex, contextMenu.columnIndex), title: canDelete?.(contextMenu.rowIndex, contextMenu.columnIndex) ? undefined : "Удалить можно только ручное значение при наличии права", onSelect: async () => { const changed = await deleteSelection(); if (changed) setContextMenu(null); else if (changed !== null) setContextMenu((current) => current ? { ...current, error: "В ячейке нет доступного для удаления ручного значения." } : current); } }] satisfies TableContextMenuAction[] : []),
      ],
    }) : null,
    rememberUndo,
    forgetUndo,
    notify,
  };
}
