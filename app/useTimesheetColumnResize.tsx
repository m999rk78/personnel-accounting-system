"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { boundedTimesheetWidth, readTimesheetColumnWidths, timesheetColumnLayout, timesheetResizeReferenceWidth, timesheetSizingColumns, type TimesheetColumnKind, type TimesheetColumnWidths } from "./timesheetColumnSizing";
import "./timesheetColumnResize.css";

type Drag = { id: string; pointerId: number; startX: number; startWidth: number; previous: TimesheetColumnWidths; handle: HTMLButtonElement };
type Options = { kind: TimesheetColumnKind; dayCount: number; dayNumbers?: readonly number[]; enabled?: boolean };
const storageKey = (kind: TimesheetColumnKind) => `resource-report.timesheet-column-widths.${kind}.v1`;
const columnLabels: Record<string, string> = { number: "№", employmentType: "Тип", department: "Отдел", fullName: "Сотрудник", position: "Должность", equipment: "Техника", organization: "Организация", timesheet: "Табель", reports: "Отчёты", difference: "Разница", productive: "Работа", downtime: "Простой", total: "Всего" };
const resizeColumnLabel = (id: string) => columnLabels[id] ?? `${id.slice(4)}-й день`;
type Layout = ReturnType<typeof timesheetColumnLayout>;
function layoutStyle(layout: Layout): CSSProperties {
  const style: Record<string, string> = { "--timesheet-columns-width": `${layout.totalWidth}px`, "--timesheet-sticky-width": `${layout.stickyWidth}px` };
  for (const [id, width] of Object.entries(layout.widths)) style[`--timesheet-width-${id}`] = `${width}px`;
  for (const [id, left] of Object.entries(layout.lefts)) style[`--timesheet-left-${id}`] = `${left}px`;
  return style as CSSProperties;
}

export function useTimesheetColumnResize(rootRef: RefObject<HTMLElement | null>, { kind, dayCount, dayNumbers, enabled = true }: Options) {
  const [sizing, setSizing] = useState<{ widths: TimesheetColumnWidths; viewportWidth: number }>({ widths: {}, viewportWidth: 0 });
  const [showPosition, setShowPosition] = useState(true);
  const preferences = useRef<TimesheetColumnWidths>({});
  const viewport = useRef(0);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const columns = useMemo(() => timesheetSizingColumns(kind, dayCount, showPosition, dayNumbers), [kind, dayCount, showPosition, dayNumbers]);
  const columnsRef = useRef(columns);
  useLayoutEffect(() => { columnsRef.current = columns; }, [columns]);
  const layout = useMemo(() => timesheetColumnLayout(columns, sizing.widths, sizing.viewportWidth), [columns, sizing]);
  const paint = useCallback(() => {
    frame.current = null;
    const table = rootRef.current?.querySelector<HTMLTableElement>(".timesheet-resizable");
    if (!table) return;
    const plan = timesheetColumnLayout(columnsRef.current, preferences.current, viewport.current);
    for (const [property, value] of Object.entries(layoutStyle(plan))) table.style.setProperty(property, String(value));
    for (const handle of table.querySelectorAll<HTMLElement>(".timesheet-column-resize-handle")) {
      const id = handle.dataset.columnId!;
      const column = columnsRef.current.find(column => column.id === id);
      handle.setAttribute("aria-valuenow", String(plan.widths[id]));
      if (column) handle.setAttribute("aria-valuemax", String(Math.max(column.max, plan.widths[id])));
    }
  }, [rootRef]);
  const schedule = useCallback(() => { if (frame.current === null) frame.current = requestAnimationFrame(paint); }, [paint]);
  const persist = useCallback(() => {
    try { localStorage.setItem(storageKey(kind), JSON.stringify(preferences.current)); } catch { /* Layout remains usable when storage is disabled/full. */ }
  }, [kind]);
  const finish = useCallback((cancel: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (cancel) preferences.current = active.previous;
    if (active.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
    document.body.classList.remove("timesheet-column-resizing");
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    paint();
    if (!cancel) persist();
    setSizing({ widths: { ...preferences.current }, viewportWidth: viewport.current });
  }, [paint, persist]);

  useLayoutEffect(() => {
    preferences.current = readTimesheetColumnWidths(localStorageValue(storageKey(kind)), kind);
    // Browser-only preferences must be restored after the matching SSR render.
    setSizing({ widths: { ...preferences.current }, viewportWidth: viewport.current });
  }, [kind]);
  useLayoutEffect(() => {
    if (!enabled || !rootRef.current) return;
    const root = rootRef.current;
    const media = window.matchMedia("(min-width: 1051px)");
    const refresh = () => {
      const width = root.clientWidth;
      if (width !== viewport.current) { finish(true); viewport.current = width; setSizing({ widths: { ...preferences.current }, viewportWidth: width }); }
      setShowPosition(media.matches);
      schedule();
    };
    const observer = new ResizeObserver(refresh);
    observer.observe(root);
    media.addEventListener("change", refresh);
    const cancel = () => finish(true);
    const escape = (event: KeyboardEvent) => {
      if (drag.current && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(true); }
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("keydown", escape, true);
    refresh();
    return () => {
      observer.disconnect(); media.removeEventListener("change", refresh);
      window.removeEventListener("blur", cancel); document.removeEventListener("keydown", escape, true);
      finish(true);
      if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    };
  }, [enabled, rootRef, finish, schedule]);
  useLayoutEffect(() => { if (enabled) paint(); }, [enabled, columns, sizing, paint]);

  const change = (id: string, width: number) => {
    const column = columnsRef.current.find(column => column.id === id);
    if (!column) return;
    preferences.current = { ...preferences.current, [id]: boundedTimesheetWidth(column, width) };
    schedule();
  };
  const commitHeaderWidths = useCallback((next: TimesheetColumnWidths) => {
    finish(true);
    preferences.current = next;
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    paint(); persist();
    setSizing({ widths: { ...next }, viewportWidth: viewport.current });
  }, [finish, paint, persist]);
  const autoSize = useCallback((columnId?: string) => {
    const table = rootRef.current?.querySelector<HTMLTableElement>(".timesheet-resizable");
    if (!table) return;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    const activeColumns = columnsRef.current;
    const rows = [...table.querySelectorAll<HTMLTableRowElement>("tbody tr[data-virtual-row]")].slice(0, 64);
    rows.push(...table.querySelectorAll<HTMLTableRowElement>("tfoot tr"));
    const samples = new Map<number, HTMLTableCellElement[]>();
    for (const row of rows) {
      let index = 0;
      for (const cell of [...row.cells].filter(cell => getComputedStyle(cell).display !== "none")) {
        if (cell.colSpan === 1) samples.set(index, [...samples.get(index) ?? [], cell]);
        index += cell.colSpan;
      }
    }
    const headers = new Map([...table.querySelectorAll<HTMLElement>('thead [data-resize-edge="right"]')].map(handle => [handle.dataset.resizeOwner, handle.closest<HTMLTableCellElement>("th")]));
    const next = { ...preferences.current };
    for (const [index, column] of activeColumns.entries()) {
      if (columnId && column.id !== columnId) continue;
      const header = headers.get(column.id);
      const cells = [...samples.get(index) ?? []];
      if (header) cells.unshift(header);
      let width = column.min;
      for (const cell of cells) {
        const style = getComputedStyle(cell);
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const label = cell.matches("thead th") ? cell.querySelector<HTMLElement>(".timesheet-filterable-heading-label") ?? cell : cell;
        const text = label.innerText || label.textContent || "";
        const lineWidth = Math.max(0, ...text.split(/\n/).map(line => context.measureText(line.trim()).width));
        width = Math.max(width, lineWidth + parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0") + 10);
      }
      next[column.id] = boundedTimesheetWidth(column, Math.ceil(width));
    }
    commitHeaderWidths(next);
  }, [rootRef, commitHeaderWidths]);
  const resetWidths = useCallback(() => commitHeaderWidths({}), [commitHeaderWidths]);
  const headerActions = useMemo(() => ({ autoSize, resetWidths }), [autoSize, resetWidths]);
  const renderHandle = (id: string, label: string, side: "left" | "right", owner: string) => {
    const column = columns.find(column => column.id === id);
    if (!column) return null;
    // An adjustable separator is keyboard-operable, with the ARIA range below.
    // eslint-disable-next-line jsx-a11y/no-interactive-element-to-noninteractive-role
    return <button type="button" role="separator" aria-orientation="vertical" className={`timesheet-column-resize-handle${side === "left" ? " timesheet-column-resize-handle-left" : ""}`} data-column-id={id} data-resize-edge={side} data-resize-owner={owner} tabIndex={side === "left" ? -1 : 0}
      aria-label={`Изменить ширину: ${label}`} aria-valuemin={column.min} aria-valuemax={Math.max(column.max, layout.widths[id])} aria-valuenow={layout.widths[id]}
      title="Потяните границу, чтобы изменить ширину. Двойной щелчок — сбросить."
      onClick={event => { event.preventDefault(); event.stopPropagation(); }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); change(id, column.width); paint(); persist(); setSizing({ widths: { ...preferences.current }, viewportWidth: viewport.current }); }}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault(); event.stopPropagation();
        const current = timesheetColumnLayout(columnsRef.current, preferences.current, viewport.current);
        drag.current = { id, pointerId: event.pointerId, startX: event.clientX, startWidth: timesheetResizeReferenceWidth(column, preferences.current, current.widths[id]), previous: { ...preferences.current }, handle: event.currentTarget };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        document.body.classList.add("timesheet-column-resizing");
      }}
      onPointerMove={event => { const active = drag.current; if (active?.pointerId === event.pointerId) { event.stopPropagation(); change(active.id, active.startWidth + event.clientX - active.startX); } }}
      onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { event.preventDefault(); event.stopPropagation(); finish(false); } }}
      onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) { event.stopPropagation(); finish(true); } }}
      onLostPointerCapture={() => finish(true)}
      onKeyDown={event => {
        event.stopPropagation();
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        const effective = timesheetColumnLayout(columnsRef.current, preferences.current, viewport.current).widths[id];
        const width = timesheetResizeReferenceWidth(column, preferences.current, effective);
        change(id, event.key === "Home" ? column.width : width + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 32 : 8));
        paint(); persist(); setSizing({ widths: { ...preferences.current }, viewportWidth: viewport.current });
      }} />;
  };
  const handle = (id: string, label: string) => {
    const index = columns.findIndex(column => column.id === id);
    if (index < 0) return null;
    const previous = columns[index - 1];
    // Both sides of a divider resize the preceding column, as in a spreadsheet.
    // The left proxy lives above rowspan/sticky cells that can hide that grip.
    return <>
      {previous && renderHandle(previous.id, `${resizeColumnLabel(previous.id)} (левая граница «${label}»)`, "left", id)}
      {renderHandle(id, label, "right", id)}
    </>;
  };
  return {
    tableStyle: layoutStyle(layout),
    colGroup: <colgroup>{columns.map(column => <col key={column.id} data-column-id={column.id} style={{ width: `var(--timesheet-width-${column.id})` }} />)}</colgroup>,
    handle,
    columnCount: columns.length,
    columnIds: columns.map(column => column.id),
    stickyCount: layout.stickyCount,
    headerActions,
  };
}

function localStorageValue(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
