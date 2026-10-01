"use client";

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from "react";

export type TimesheetClipboardChange = {
  rowIndex: number;
  columnIndex: number;
  value: string;
  note?: string;
};

type ClipboardPoint = { rowIndex: number; columnIndex: number };
type ClipboardSelection = { start: ClipboardPoint; end: ClipboardPoint };

function scrollCellIntoVisibleArea(shell: HTMLDivElement, point: ClipboardPoint) {
  const cell = shell.querySelector<HTMLElement>(`[data-timesheet-row="${point.rowIndex}"][data-timesheet-column="${point.columnIndex}"]`);
  if (!cell) return;
  cell.scrollIntoView({ block: "nearest", inline: "nearest" });

  const shellRect = shell.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  const lastHeaderCell = shell.querySelector<HTMLElement>(".timesheet-table thead tr:last-child th");
  const footerCell = shell.querySelector<HTMLElement>(".timesheet-table tfoot th, .timesheet-table tfoot td");
  const stickyCells = Array.from(shell.querySelectorAll<HTMLElement>(".timesheet-table tbody tr:first-child .timesheet-sticky"))
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
  const horizontalOffset = cellRect.left < visibleLeft
    ? cellRect.left - visibleLeft
    : cellRect.right > shellRect.right
      ? cellRect.right - shellRect.right
      : 0;

  if (verticalOffset || horizontalOffset) {
    shell.scrollBy({ top: verticalOffset, left: horizontalOffset });
  }
}

type TimesheetClipboardOptions = {
  rowCount: number;
  columnCount: number;
  resetKey: string;
  getValue: (rowIndex: number, columnIndex: number) => string;
  canPaste: (rowIndex: number, columnIndex: number) => boolean;
  onPaste: (changes: TimesheetClipboardChange[]) => Promise<number>;
  getUndoValue?: (rowIndex: number, columnIndex: number) => string;
  getUndoNote?: (rowIndex: number, columnIndex: number) => string;
  canDelete?: (rowIndex: number, columnIndex: number) => boolean;
  onDelete?: (changes: TimesheetClipboardChange[]) => Promise<number>;
  onActivate?: (rowIndex: number, columnIndex: number, anchor: HTMLElement) => void;
  onType?: (rowIndex: number, columnIndex: number, anchor: HTMLElement, value: string) => void;
};

function selectionBounds(selection: ClipboardSelection | null) {
  if (!selection) return null;
  return {
    rowStart: Math.min(selection.start.rowIndex, selection.end.rowIndex),
    rowEnd: Math.max(selection.start.rowIndex, selection.end.rowIndex),
    columnStart: Math.min(selection.start.columnIndex, selection.end.columnIndex),
    columnEnd: Math.max(selection.start.columnIndex, selection.end.columnIndex),
  };
}

export function useTimesheetClipboard({ rowCount, columnCount, resetKey, getValue, canPaste, onPaste, getUndoValue = getValue, getUndoNote, canDelete, onDelete, onActivate, onType }: TimesheetClipboardOptions) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<ClipboardSelection | null>(null);
  const [status, setStatus] = useState("");
  const selectionRef = useRef(selection);
  const dragging = useRef(false);
  const undoStack = useRef<TimesheetClipboardChange[][]>([]);
  const undoing = useRef(false);

  const rememberUndo = useCallback((changes: TimesheetClipboardChange[]) => {
    if (!changes.length) return;
    undoStack.current = [...undoStack.current.slice(-49), changes.map((change) => ({ ...change }))];
  }, []);

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
  }, []);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    const finishDrag = () => { dragging.current = false; };
    window.addEventListener("mouseup", finishDrag);
    return () => window.removeEventListener("mouseup", finishDrag);
  }, []);

  useEffect(() => {
    const clearOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".timesheet-cell-popover, .custom-select-menu")) return;
      if (!selectionRef.current || !(target instanceof Node) || shellRef.current?.contains(target)) return;
      clearSelection();
    };
    document.addEventListener("pointerdown", clearOutside);
    return () => document.removeEventListener("pointerdown", clearOutside);
  }, [clearSelection]);

  useEffect(() => {
    undoStack.current = [];
    const frame = requestAnimationFrame(clearSelection);
    return () => cancelAnimationFrame(frame);
  }, [clearSelection, resetKey]);

  useEffect(() => {
    if (!status) return;
    const timeout = window.setTimeout(() => setStatus(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const selectCell = useCallback((rowIndex: number, columnIndex: number, event: MouseEvent<HTMLTableCellElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = { rowIndex, columnIndex };
    const start = event.shiftKey && selectionRef.current ? selectionRef.current.start : point;
    const next = { start, end: point };
    dragging.current = true;
    selectionRef.current = next;
    setSelection(next);
    shellRef.current?.focus({ preventScroll: true });
  }, []);

  const extendSelection = useCallback((rowIndex: number, columnIndex: number) => {
    if (!dragging.current || !selectionRef.current) return;
    const next = { start: selectionRef.current.start, end: { rowIndex, columnIndex } };
    selectionRef.current = next;
    setSelection(next);
  }, []);

  const focusSelection = useCallback((point: ClipboardPoint, extend: boolean) => {
    if (rowCount <= 0 || columnCount <= 0) return;
    const nextPoint = {
      rowIndex: Math.max(0, Math.min(rowCount - 1, point.rowIndex)),
      columnIndex: Math.max(0, Math.min(columnCount - 1, point.columnIndex)),
    };
    const next = {
      start: extend && selectionRef.current ? selectionRef.current.start : nextPoint,
      end: nextPoint,
    };
    dragging.current = false;
    selectionRef.current = next;
    setSelection(next);
    requestAnimationFrame(() => {
      if (shellRef.current) scrollCellIntoVisibleArea(shellRef.current, nextPoint);
    });
  }, [columnCount, rowCount]);

  const onCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const bounds = selectionBounds(selectionRef.current);
    if (!bounds) return;
    const rows: string[] = [];
    for (let rowIndex = bounds.rowStart; rowIndex <= bounds.rowEnd; rowIndex++) {
      const values: string[] = [];
      for (let columnIndex = bounds.columnStart; columnIndex <= bounds.columnEnd; columnIndex++) {
        values.push(getValue(rowIndex, columnIndex).replaceAll("\t", " ").replaceAll(/\r?\n/g, " "));
      }
      rows.push(values.join("\t"));
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", rows.join("\n"));
    setStatus(`Скопировано: ${bounds.rowEnd - bounds.rowStart + 1} × ${bounds.columnEnd - bounds.columnStart + 1}`);
  }, [getValue]);

  const onClipboardPaste = useCallback(async (event: ClipboardEvent<HTMLDivElement>) => {
    const bounds = selectionBounds(selectionRef.current);
    if (!bounds) return;
    const lines = event.clipboardData.getData("text/plain").replace(/\r/g, "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const matrix = lines.map((line) => line.split("\t"));
    if (!matrix.length) return;
    event.preventDefault();

    const sourceRows = matrix.length;
    const sourceColumns = Math.max(...matrix.map((line) => line.length));
    const selectedRows = bounds.rowEnd - bounds.rowStart + 1;
    const selectedColumns = bounds.columnEnd - bounds.columnStart + 1;
    const targetRows = sourceRows === 1 ? selectedRows : sourceRows;
    const targetColumns = sourceColumns === 1 ? selectedColumns : sourceColumns;
    const changes: TimesheetClipboardChange[] = [];

    for (let rowOffset = 0; rowOffset < targetRows; rowOffset++) {
      const rowIndex = bounds.rowStart + rowOffset;
      if (rowIndex >= rowCount) break;
      for (let columnOffset = 0; columnOffset < targetColumns; columnOffset++) {
        const columnIndex = bounds.columnStart + columnOffset;
        if (columnIndex >= columnCount || !canPaste(rowIndex, columnIndex)) continue;
        changes.push({
          rowIndex,
          columnIndex,
          value: matrix[rowOffset % sourceRows]?.[columnOffset % sourceColumns] ?? "",
        });
      }
    }

    if (!changes.length) {
      setStatus("В выбранном диапазоне нет доступных для редактирования ячеек");
      return;
    }
    setStatus("Вставляем данные…");
    const undoChanges = previousValues(changes);
    try {
      const changed = await onPaste(changes);
      if (changed > 0) rememberUndo(undoChanges);
      setStatus(`Вставлено ячеек: ${changed}`);
    } catch (pasteError) {
      setStatus(pasteError instanceof Error ? pasteError.message : "Не удалось вставить данные");
    }
  }, [canPaste, columnCount, onPaste, previousValues, rememberUndo, rowCount]);

  const undoLastChange = useCallback(async () => {
    if (undoing.current) return;
    const changes = undoStack.current.pop();
    if (!changes?.length) {
      setStatus("Нет изменений для отмены");
      return;
    }
    undoing.current = true;
    setStatus("Отменяем последнее изменение…");
    try {
      const changed = await onPaste(changes);
      setStatus(`Отменено изменений: ${changed}`);
    } catch (undoError) {
      undoStack.current.push(changes);
      setStatus(undoError instanceof Error ? undoError.message : "Не удалось отменить изменение");
    } finally {
      undoing.current = false;
    }
  }, [onPaste]);

  useEffect(() => {
    const undoOutsideTable = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      const interactive = target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox']"));
      const undoShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && (event.code === "KeyZ" || event.key.toLocaleLowerCase("en-US") === "z");
      if (!undoShortcut || interactive || !undoStack.current.length || (target instanceof Node && shellRef.current?.contains(target))) return;
      event.preventDefault();
      void undoLastChange();
    };
    document.addEventListener("keydown", undoOutsideTable);
    return () => document.removeEventListener("keydown", undoOutsideTable);
  }, [undoLastChange]);

  const onKeyDown = useCallback(async (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      clearSelection();
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
      focusSelection({ rowIndex: current.rowIndex + movement.row, columnIndex: current.columnIndex + movement.column }, event.shiftKey);
      return;
    }
    if ((event.key === "Enter" || event.key === "F2") && onActivate) {
      const current = selectionRef.current?.end;
      if (!current) return;
      const anchor = shellRef.current?.querySelector<HTMLElement>(`[data-timesheet-row="${current.rowIndex}"][data-timesheet-column="${current.columnIndex}"]`);
      if (!anchor) return;
      event.preventDefault();
      onActivate(current.rowIndex, current.columnIndex, anchor);
      return;
    }
    if (event.key.length === 1 && event.key.trim() && !event.altKey && !event.ctrlKey && !event.metaKey && onType) {
      const current = selectionRef.current?.end;
      if (!current) return;
      const anchor = shellRef.current?.querySelector<HTMLElement>(`[data-timesheet-row="${current.rowIndex}"][data-timesheet-column="${current.columnIndex}"]`);
      if (!anchor) return;
      event.preventDefault();
      onType(current.rowIndex, current.columnIndex, anchor, event.key);
      return;
    }
    if ((event.key !== "Delete" && event.key !== "Backspace") || !canDelete || !onDelete) return;
    const bounds = selectionBounds(selectionRef.current);
    if (!bounds) return;
    event.preventDefault();
    const changes: TimesheetClipboardChange[] = [];
    for (let rowIndex = bounds.rowStart; rowIndex <= bounds.rowEnd; rowIndex++) {
      for (let columnIndex = bounds.columnStart; columnIndex <= bounds.columnEnd; columnIndex++) {
        if (rowIndex < rowCount && columnIndex < columnCount && canDelete(rowIndex, columnIndex)) {
          changes.push({ rowIndex, columnIndex, value: "" });
        }
      }
    }
    if (!changes.length) {
      setStatus("В выбранном диапазоне нет ручных значений");
      return;
    }
    setStatus("Удаляем ручные значения…");
    const undoChanges = previousValues(changes);
    try {
      const changed = await onDelete(changes);
      if (changed > 0) rememberUndo(undoChanges);
      setStatus(`Удалено ручных значений: ${changed}`);
    } catch (deleteError) {
      setStatus(deleteError instanceof Error ? deleteError.message : "Не удалось удалить ручные значения");
    }
  }, [canDelete, clearSelection, columnCount, focusSelection, onActivate, onDelete, onType, previousValues, rememberUndo, rowCount, undoLastChange]);

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
    focusCell: (rowIndex: number, columnIndex: number) => focusSelection({ rowIndex, columnIndex }, false),
    cellClass,
    cellHandlers: (rowIndex: number, columnIndex: number) => ({
      onMouseDown: (event: MouseEvent<HTMLTableCellElement>) => selectCell(rowIndex, columnIndex, event),
      onMouseEnter: () => extendSelection(rowIndex, columnIndex),
      "data-timesheet-row": rowIndex,
      "data-timesheet-column": columnIndex,
      "aria-selected": Boolean(cellClass(rowIndex, columnIndex)),
    }),
    shellHandlers: { onCopy, onPaste: onClipboardPaste, onKeyDown },
    rememberUndo,
  };
}
