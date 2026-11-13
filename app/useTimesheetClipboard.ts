"use client";

import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { TableContextMenu, type TableContextMenuAction } from "./TableContextMenu";
import { useWorkspaceAccess } from "./TableAccessContext";
import { useTableEscapeSelection } from "./useTableEscapeSelection";
import { isTableSelectAllShortcut } from "./tableSelectAllShortcut";
import { useTablePageSelectAll } from "./useTablePageSelectAll";
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
type ClipboardSelection = { start: ClipboardPoint | null; end: ClipboardPoint | null; includeHeaders?: boolean };
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
    .map((stickyCell) => stickyCell.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  const visibleTop = Math.max(shellRect.top, lastHeaderCell?.getBoundingClientRect().bottom ?? shellRect.top);
  const visibleBottom = Math.min(shellRect.bottom, footerCell?.getBoundingClientRect().top ?? shellRect.bottom);
  const visibleLeft = Math.max(shellRect.left, ...stickyCells.map((rect) => rect.right));
  const verticalOffset = cellRect.top < visibleTop
    ? cellRect.top - visibleTop
    : cellRect.bottom > visibleBottom
      ? cellRect.bottom - visibleBottom
      : 0;
  const horizontalOffset = cell.classList.contains("timesheet-sticky") ? 0 : cellRect.left < visibleLeft
    ? cellRect.left - visibleLeft
    : cellRect.right > shellRect.right
      ? cellRect.right - shellRect.right
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
    const start = event.shiftKey && selectionRef.current?.start ? selectionRef.current.start : point;
    const next = { start, end: point };
    dragging.current = true;
    selectionRef.current = next;
    setSelection(next);
    setContextMenu(null);
    shellRef.current?.focus({ preventScroll: true });
  }, [shellRef]);

  const extendSelection = useCallback((rowIndex: number, columnIndex: number) => {
    if (!dragging.current || !selectionRef.current?.start) return;
    const next = { start: selectionRef.current.start, end: { rowIndex, columnIndex } };
    selectionRef.current = next;
    setSelection(next);
  }, []);

  const focusSelection = useCallback((point: ClipboardPoint, extend: boolean) => {
    if (rowCount <= 0 || !selectionColumns.length) return;
    const columnIndex = selectionColumns.reduce((nearest, index) => Math.abs(index - point.columnIndex) < Math.abs(nearest - point.columnIndex) ? index : nearest, selectionColumns[0]);
    const nextPoint = {
      rowIndex: Math.max(0, Math.min(rowCount - 1, point.rowIndex)),
      columnIndex,
    };
    const next = {
      start: extend && selectionRef.current?.start ? selectionRef.current.start : nextPoint,
      end: nextPoint,
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
    const rows: string[] = [];
    if (selectionRef.current?.includeHeaders && getHeader) {
      rows.push(selectionColumns.filter(index => !bounds || index >= bounds.columnStart && index <= bounds.columnEnd)
        .map(index => getHeader(index).replaceAll("\t", " ").replaceAll(/\r?\n/g, " ")).join("\t"));
    }
    for (let rowIndex = bounds?.rowStart ?? 0; bounds && rowIndex <= bounds.rowEnd; rowIndex++) {
      const values: string[] = [];
      for (const columnIndex of selectionColumns.filter(index => index >= bounds.columnStart && index <= bounds.columnEnd)) {
        values.push(getValue(rowIndex, columnIndex).replaceAll("\t", " ").replaceAll(/\r?\n/g, " "));
      }
      rows.push(values.join("\t"));
    }
    return rows.join("\n");
  }, [getHeader, getValue, selectionColumns]);

  const onCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    if (isTimesheetInputTarget(event.target)) return;
    const bounds = selectionBounds(selectionRef.current);
    const text = selectedText();
    if (text === undefined) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    const headerRows = selectionRef.current?.includeHeaders && getHeader ? 1 : 0;
    lastHeaderCopy.current = headerRows ? text : null;
    setStatus(`Скопировано: ${(bounds ? bounds.rowEnd - bounds.rowStart + 1 : 0) + headerRows} × ${selectionColumns.filter(index => !bounds || index >= bounds.columnStart && index <= bounds.columnEnd).length}`);
  }, [getHeader, selectedText, selectionColumns]);

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
    const selectedRows = bounds.rowEnd - bounds.rowStart + 1;
    const selectedColumns = selectionColumns.filter(index => index >= bounds.columnStart && index <= bounds.columnEnd).length;
    const targetColumnStart = selectionColumns.indexOf(bounds.columnStart);
    const targetRows = sourceRows === 1 ? selectedRows : sourceRows;
    const targetColumns = sourceColumns === 1 ? selectedColumns : sourceColumns;
    const changes: TimesheetClipboardChange[] = [];

    for (let rowOffset = 0; rowOffset < targetRows; rowOffset++) {
      const rowIndex = bounds.rowStart + rowOffset;
      if (rowIndex >= rowCount) break;
      for (let columnOffset = 0; columnOffset < targetColumns; columnOffset++) {
        const columnIndex = selectionColumns[targetColumnStart + columnOffset];
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
    for (let rowIndex = bounds.rowStart; rowIndex <= bounds.rowEnd; rowIndex++) {
      for (const columnIndex of selectionColumns.filter(index => index >= bounds.columnStart && index <= bounds.columnEnd)) {
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
    const bounds = selectionBounds(selectionRef.current);
    const insideSelection = bounds && rowIndex >= bounds.rowStart && rowIndex <= bounds.rowEnd && columnIndex >= bounds.columnStart && columnIndex <= bounds.columnEnd;
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

  useEffect(() => {
    const undoOutsideTable = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      const interactive = isTimesheetInputTarget(target);
      const undoShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && (event.code === "KeyZ" || event.key.toLocaleLowerCase("en-US") === "z");
      if (!undoShortcut || interactive || !undoStack.current.length || (target instanceof Node && shellRef.current?.contains(target))) return;
      event.preventDefault();
      void undoLastChange();
    };
    document.addEventListener("keydown", undoOutsideTable);
    return () => document.removeEventListener("keydown", undoOutsideTable);
  }, [shellRef, undoLastChange]);

  const onKeyDown = useCallback(async (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTimesheetInputTarget(event.target)) return;
    if (event.key === "Escape") {
      return;
    }
    const undoShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && (event.code === "KeyZ" || event.key.toLocaleLowerCase("en-US") === "z");
    if (undoShortcut) {
      event.preventDefault();
      await undoLastChange();
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
      const current = selectionRef.current?.end ?? { rowIndex: 0, columnIndex: 0 };
      const currentColumn = selectionColumns.indexOf(current.columnIndex);
      const nextColumn = selectionColumns[Math.max(0, Math.min(selectionColumns.length - 1, currentColumn + movement.column))] ?? current.columnIndex;
      focusSelection({ rowIndex: current.rowIndex + movement.row, columnIndex: nextColumn }, event.shiftKey);
      return;
    }
    if ((event.key === "Enter" || event.key === "F2") && onActivate) {
      const current = selectionRef.current?.end;
      if (!current) return;
      if (current.columnIndex < 0 || current.columnIndex >= columnCount) return;
      const anchor = shellRef.current?.querySelector<HTMLElement>(`[data-timesheet-row="${current.rowIndex}"][data-timesheet-column="${current.columnIndex}"]`);
      if (!anchor) return;
      event.preventDefault();
      onActivate(current.rowIndex, current.columnIndex, anchor);
      return;
    }
    if (event.key.length === 1 && event.key.trim() && !event.altKey && !event.ctrlKey && !event.metaKey && onType) {
      const current = selectionRef.current?.end;
      if (!current) return;
      if (current.columnIndex < 0 || current.columnIndex >= columnCount) return;
      const anchor = shellRef.current?.querySelector<HTMLElement>(`[data-timesheet-row="${current.rowIndex}"][data-timesheet-column="${current.columnIndex}"]`);
      if (!anchor) return;
      event.preventDefault();
      onType(current.rowIndex, current.columnIndex, anchor, event.key);
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    await deleteSelection();
  }, [columnCount, deleteSelection, focusSelection, onActivate, onType, selectionColumns, shellRef, undoLastChange]);

  const onKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!isTableSelectAllShortcut(event)) return;
    if (!selectAllCells()) return;
    event.preventDefault();
    event.stopPropagation();
    shellRef.current?.focus({ preventScroll: true });
  }, [selectAllCells, shellRef]);

  const cellClass = useCallback((rowIndex: number, columnIndex: number) => {
    const bounds = selectionBounds(selection);
    if (!bounds || rowIndex < bounds.rowStart || rowIndex > bounds.rowEnd || columnIndex < bounds.columnStart || columnIndex > bounds.columnEnd) return "";
    return [
      "timesheet-cell-selected",
      rowIndex === bounds.rowStart ? "timesheet-cell-selection-top" : "",
      rowIndex === bounds.rowEnd ? "timesheet-cell-selection-bottom" : "",
      columnIndex === bounds.columnStart ? "timesheet-cell-selection-left" : "",
      columnIndex === bounds.columnEnd ? "timesheet-cell-selection-right" : "",
    ].filter(Boolean).join(" ");
  }, [selection]);

  return {
    shellRef,
    status,
    activeCell: selection?.end ?? null,
    headersSelected: Boolean(selection?.includeHeaders && getHeader),
    focusCell: (rowIndex: number, columnIndex: number) => focusSelection({ rowIndex, columnIndex }, false),
    cellClass,
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
        { label: "Копировать ячейку", shortcut: "Ctrl+C", onSelect: async () => { try { const text = selectedText() ?? ""; await navigator.clipboard.writeText(text); lastHeaderCopy.current = selectionRef.current?.includeHeaders && getHeader ? text : null; setStatus("Ячейка скопирована"); setContextMenu(null); } catch { setContextMenu((current) => current ? { ...current, error: "Не удалось скопировать. Разрешите доступ к буферу обмена." } : current); } } },
        ...(access?.edit !== false ? [{ label: "Вставить в ячейку", shortcut: "Ctrl+V", disabled: !canPaste(contextMenu.rowIndex, contextMenu.columnIndex), title: canPaste(contextMenu.rowIndex, contextMenu.columnIndex) ? undefined : "Нет права редактирования этой ячейки", onSelect: async () => { try { const changed = await pasteText(await navigator.clipboard.readText()); if (changed) setContextMenu(null); else if (changed !== null) setContextMenu((current) => current ? { ...current, error: "Значение не вставлено." } : current); } catch { setContextMenu((current) => current ? { ...current, error: "Не удалось прочитать буфер обмена. Разрешите доступ в браузере." } : current); } } }] satisfies TableContextMenuAction[] : []),
        ...(access?.edit !== false ? [{ label: "Редактировать ячейку", shortcut: "Enter", separatorBefore: true, disabled: !onActivate || !canPaste(contextMenu.rowIndex, contextMenu.columnIndex), title: onActivate && canPaste(contextMenu.rowIndex, contextMenu.columnIndex) ? undefined : "Нет права редактирования этой ячейки", onSelect: () => { const anchor = document.querySelector<HTMLElement>(`[data-timesheet-row="${contextMenu.rowIndex}"][data-timesheet-column="${contextMenu.columnIndex}"]`); if (anchor) onActivate?.(contextMenu.rowIndex, contextMenu.columnIndex, anchor); setContextMenu(null); } }] satisfies TableContextMenuAction[] : []),
        ...(access?.delete !== false ? [{ label: "Удалить ручное значение", shortcut: "Delete", danger: true, separatorBefore: true, disabled: !canDelete?.(contextMenu.rowIndex, contextMenu.columnIndex), title: canDelete?.(contextMenu.rowIndex, contextMenu.columnIndex) ? undefined : "Удалить можно только ручное значение при наличии права", onSelect: async () => { const changed = await deleteSelection(); if (changed) setContextMenu(null); else if (changed !== null) setContextMenu((current) => current ? { ...current, error: "В ячейке нет доступного для удаления ручного значения." } : current); } }] satisfies TableContextMenuAction[] : []),
      ],
    }) : null,
    rememberUndo,
    forgetUndo,
    notify,
  };
}
