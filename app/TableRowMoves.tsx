"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { TableContextMenu, type TableContextMenuAction } from "./TableContextMenu";
import { orderRowsByIds, type RowMove, type RowOrderId } from "./tableRowOrder";
import "./tableRowOrder.css";
import { useWorkspaceAccess } from "./TableAccessContext";
import { personnelReportOrderScope } from "./personnelReportRowOrder";
import { equipmentReportOrderScope } from "./equipmentReportRowOrder";
import { nativeRowDragIds, nativeRowDropIds, nativeSelectedRowIds, selectNativeRow, type NativeRowSelection } from "./nativeRowSelection";
import { startRowDragAutoScroll } from "./rowDragAutoScroll";
import { createRowDropIndicator, rowDropPlacement } from "./rowDropIndicator";

const EMPTY_ORDER: RowOrderId[] = [];
const EMPTY_IMPORT_ORDER: number[] = [];
const IMPORT_ORDER_EVENT = "personnel-table-import-order";
/** Notify the currently displayed table after an import without exposing its provider to the caller. */
export function notifyTableImportOrder(scope: string, siteId: number) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(IMPORT_ORDER_EVENT, { detail: { scope, siteId } }));
}
type OrderState = { key: string; ids: RowOrderId[]; canWrite: boolean; hasSavedOrder: boolean; importIds: number[]; hasImportOrder: boolean };
export function useTableRowOrder(scope: string | null, siteId: number, canReorder?: boolean) {
  const key = `${scope ?? ""}:${siteId}`;
  const [state, setState] = useState<OrderState>({ key: "", ids: [], canWrite: false, hasSavedOrder: false, importIds: [], hasImportOrder: false });
  const [importOrderRevision, setImportOrderRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const activeKey = useRef(key);
  const refreshRequest = useRef<AbortController | null>(null);
  const refreshEpoch = useRef(0);
  const requestedBaseline = useRef("");
  const invalidateRefresh = useCallback(() => {
    refreshEpoch.current++;
    refreshRequest.current?.abort();
    refreshRequest.current = null;
  }, []);
  useEffect(() => () => invalidateRefresh(), [invalidateRefresh]);
  const activateImportOrder = useCallback(() => setImportOrderRevision(value => value + 1), []);
  const refresh = useCallback(async () => {
    if (!scope || busyRef.current || activeKey.current !== key) return false;
    invalidateRefresh();
    const epoch = refreshEpoch.current;
    const controller = new AbortController(); refreshRequest.current = controller;
    const isCurrent = () => !controller.signal.aborted && refreshEpoch.current === epoch && !busyRef.current && activeKey.current === key;
    try {
      const response = await fetch(`/api/table-order?scope=${encodeURIComponent(scope)}&siteId=${siteId}`, { signal: controller.signal, cache: "no-store" });
      const result = await response.json() as Partial<OrderState> & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось загрузить порядок строк.");
      if (isCurrent()) {
        setState({ key, ids: result.ids ?? [], canWrite: Boolean(result.canWrite), hasSavedOrder: Boolean(result.hasSavedOrder), importIds: result.importIds ?? [], hasImportOrder: Boolean(result.hasImportOrder) });
        setError("");
        return true;
      }
      return false;
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : "Не удалось загрузить порядок строк.");
      return false;
    } finally {
      if (refreshRequest.current === controller) refreshRequest.current = null;
    }
  }, [scope, siteId, key, invalidateRefresh]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    activeKey.current = key;
    // A scope opened while a mutation was pending still needs its baseline
    // once that mutation finishes. An already loaded table needs no extra GET.
    const baseline = `${key}:${String(canReorder)}`;
    if (busyRef.current || requestedBaseline.current === baseline && state.key === key) return;
    requestedBaseline.current = baseline;
    const frame = requestAnimationFrame(() => void refresh());
    return () => { cancelAnimationFrame(frame); invalidateRefresh(); };
  }, [key, refresh, canReorder, busy, state.key, invalidateRefresh]);
  useEffect(() => {
    const imported = (event: Event) => {
      const detail = (event as CustomEvent<{ scope: string; siteId: number }>).detail;
      if (detail?.scope !== scope || detail.siteId !== siteId) return;
      void refresh().then(loaded => { if (loaded && activeKey.current === key) activateImportOrder(); });
    };
    window.addEventListener(IMPORT_ORDER_EVENT, imported);
    return () => window.removeEventListener(IMPORT_ORDER_EVENT, imported);
  }, [scope, siteId, key, refresh, activateImportOrder]);

  const move = useCallback(async (operation: RowMove) => {
    if (!scope || state.key !== key || activeKey.current !== key || !state.canWrite || busyRef.current) return false;
    busyRef.current = true;
    invalidateRefresh();
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/table-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, siteId, ...operation }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Не удалось переместить строки.");
      if (activeKey.current === key) { setState((current) => current.key === key ? { ...current, ids: result.ids, hasSavedOrder: true } : current); setMessage(`Порядок сохранён · перемещено строк: ${operation.movingIds.length}`); }
      return true;
    } catch (failure) {
      if (activeKey.current === key) setError(failure instanceof Error ? failure.message : "Не удалось сохранить порядок строк.");
      return false;
    } finally { invalidateRefresh(); busyRef.current = false; setBusy(false); }
  }, [key, scope, siteId, state.canWrite, state.key, invalidateRefresh]);
  const ids = state.key === key ? state.ids : EMPTY_ORDER;
  const canWrite = state.key === key && state.canWrite;
  const hasSavedOrder = state.key === key && state.hasSavedOrder;
  const importIds = state.key === key ? state.importIds : EMPTY_IMPORT_ORDER;
  const hasImportOrder = state.key === key && state.hasImportOrder;
  const ready = state.key === key;
  const remap = useCallback(async (aliases: Record<string, string>) => {
    if (!state.canWrite || state.key !== key || activeKey.current !== key || !Object.keys(aliases).length || busyRef.current) return false;
    busyRef.current = true; invalidateRefresh(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/table-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, siteId, action: "remap", aliases }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить порядок строк.");
      if (activeKey.current === key) setState(current => current.key === key ? { ...current, ids: result.ids } : current);
      return true;
    } catch (failure) {
      if (activeKey.current === key) setError(failure instanceof Error ? failure.message : "Не удалось сохранить порядок строк.");
      return false;
    } finally { invalidateRefresh(); busyRef.current = false; setBusy(false); }
  }, [state.canWrite, state.key, key, scope, siteId, invalidateRefresh]);
  const order = useCallback(<T,>(rows: readonly T[], getId: (row: T) => RowOrderId | undefined) => orderRowsByIds(rows, ids, getId), [ids]);
  return useMemo(() => ({ ids, canWrite, hasSavedOrder, importIds, hasImportOrder, importOrderRevision, ready, refresh, activateImportOrder, busy, error, message, move, remap, order, scope }), [ids, canWrite, hasSavedOrder, importIds, hasImportOrder, importOrderRevision, ready, refresh, activateImportOrder, busy, error, message, move, remap, order, scope]);
}

const TableOrderContext = createContext<ReturnType<typeof useTableRowOrder> | null>(null);
export function TableOrderProvider({ scope, siteId, children }: { scope: string | null; siteId: number; children: React.ReactNode }) {
  const access = useWorkspaceAccess();
  const order = useTableRowOrder(scope, siteId, access?.reorder);
  const canWrite = order.canWrite && (access?.reorder ?? true);
  const performMove = order.move;
  const move = useCallback((operation: RowMove) => canWrite ? performMove(operation) : Promise.resolve(false), [canWrite, performMove]);
  const value = useMemo(() => ({ ...order, canWrite, move }), [order, canWrite, move]);
  return <TableOrderContext.Provider value={value}>{children}</TableOrderContext.Provider>;
}
export const useWorkspaceTableOrder = () => useContext(TableOrderContext);

export function useRowMoveActions(order: ReturnType<typeof useTableRowOrder> | null, disabled: boolean, contextKey = order?.scope ?? "") {
  const [pendingState, setPendingState] = useState<{ key: string; ids: RowOrderId[] }>({ key: "", ids: [] });
  if (pendingState.key !== contextKey) setPendingState({ key: contextKey, ids: [] });
  const pending = pendingState.key === contextKey ? pendingState.ids : [];
  const setPending = (ids: RowOrderId[]) => setPendingState({ key: contextKey, ids });
  const scope = order?.scope;
  const datedReport = scope === personnelReportOrderScope || scope === equipmentReportOrderScope;
  const getActions = (clickedId: RowOrderId, selectedIds: RowOrderId[], close: () => void): TableContextMenuAction[] => {
    if (!order?.canWrite) return [];
    const movingIds = [...new Set(selectedIds.includes(clickedId) ? selectedIds : [clickedId])];
    const blocked = disabled || order.busy;
    const reason = disabled ? "Завершите редактирование и сбросьте фильтры и сортировку." : undefined;
    const run = async (operation: RowMove) => { close(); if (await order.move(operation)) setPending([]); };
    const count = movingIds.length > 1 ? ` (${movingIds.length})` : "";
    const actions: TableContextMenuAction[] = [
      { label: `Переместить в начало${datedReport ? " этой даты" : ""}${count}`, separatorBefore: true, disabled: blocked, title: reason, onSelect: () => run({ movingIds, placement: "start" }) },
      { label: `Переместить в конец${datedReport ? " этой даты" : ""}${count}`, disabled: blocked, title: reason, onSelect: () => run({ movingIds, placement: "end" }) },
      { label: `Выбрать для переноса${count}`, disabled: blocked, title: reason, onSelect: () => { setPending(movingIds); close(); } },
    ];
    if (pending.length) actions.push(
      { label: `Вставить выше этой строки (${pending.length})`, separatorBefore: true, disabled: blocked || pending.includes(clickedId), onSelect: () => run({ movingIds: pending, placement: "before", targetId: clickedId }) },
      { label: `Вставить ниже этой строки (${pending.length})`, disabled: blocked || pending.includes(clickedId), onSelect: () => run({ movingIds: pending, placement: "after", targetId: clickedId }) },
      { label: "Отменить перенос", onSelect: () => { setPending([]); close(); } },
    );
    return [{ label: "Перемещение", separatorBefore: true, onSelect: () => {}, children: actions.map((action, index) => index === 0 ? { ...action, separatorBefore: false } : action) }];
  };
  // The provider key resets pending moves when switching tables or projects.
  return { getActions, feedback: <>{order?.error && <p className="table-order-feedback error" role="alert">{order.error}</p>}{pending.length > 0 && <div className="table-order-feedback" key={scope}>Для переноса выбрано: {pending.length}. Откройте меню нужной строки и выберите «Вставить выше/ниже».<button type="button" onClick={() => setPending([])}>Отменить</button></div>}{order?.busy && <span className="sr-only" role="status">Сохраняем порядок строк…</span>}{order?.message && <span className="table-order-toast" role="status">{order.message}</span>}</> };
}

/** Native timesheets use the existing row number for selection and dragging. */
export function useNativeRowMoves(order: ReturnType<typeof useTableRowOrder> | null, disabled: boolean, editing: boolean, context: { key: string; ids: readonly number[] }) {
  const access = useWorkspaceAccess();
  const key = `${order?.scope ?? ""}:${context.key}`;
  const [selection, setSelection] = useState<NativeRowSelection>({ key: "", ids: [] });
  const selected = nativeSelectedRowIds(selection, key, context.ids);
  const dragged = useRef<NativeRowSelection>({ key: "", ids: [] });
  const dragScroll = useRef<ReturnType<typeof startRowDragAutoScroll>>(null);
  const dropIndicator = useRef<ReturnType<typeof createRowDropIndicator>>(null);
  const dropPreviewCleanup = useRef<(() => void) | null>(null);
  const clearDropPreview = useCallback(() => {
    dropPreviewCleanup.current?.(); dropPreviewCleanup.current = null;
    dropIndicator.current?.destroy(); dropIndicator.current = null;
  }, []);
  const stopDragScroll = useCallback(() => { dragScroll.current?.stop(); dragScroll.current = null; clearDropPreview(); }, [clearDropPreview]);
  const trailingClick = useRef<{ key: string; id: number } | null>(null);
  const selectionRevision = useRef(0);
  const [menuState, setMenu] = useState<{ key: string; id: number; x: number; y: number } | null>(null);
  if (selection.key !== key) {
    setSelection({ key, ids: [] });
    if (menuState) setMenu(null);
  }
  useEffect(() => {
    dragged.current = { key, ids: [] };
    trailingClick.current = null;
  }, [key]);
  const menu = menuState?.key === key && context.ids.includes(menuState.id) ? menuState : null;
  const moves = useRowMoveActions(order, disabled || editing, key);
  const blocked = disabled || editing || !order?.canWrite || order.busy || access?.select === false;
  const availableRowsKey = context.ids.join(",");
  useEffect(() => {
    dragged.current = { key, ids: [] };
    return stopDragScroll;
  }, [key, blocked, availableRowsKey, stopDragScroll]);
  const canSelect = Boolean(order?.canWrite) && access?.select !== false;
  const clearSelection = () => {
    stopDragScroll();
    selectionRevision.current += 1;
    dragged.current = { key, ids: [] };
    trailingClick.current = null;
    setSelection({ key, ids: [] });
    // Escape should leave neither a selected row nor a selection-like focus ring
    // on its number. Keep keyboard focus in the table, away from any editor.
    const activeHandle = typeof document === "undefined" ? null : document.activeElement;
    if (activeHandle && activeHandle instanceof HTMLElement && activeHandle.matches(".table-row-number-handle")) {
      activeHandle.closest<HTMLElement>(".timesheet-grid-shell")?.focus({ preventScroll: true });
    }
  };
  const closeMenu = () => setMenu(null);
  const openMenu = (event: React.MouseEvent, id: number) => {
    event.preventDefault(); event.stopPropagation();
    setMenu({ key, id, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 290)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 380)) });
  };
  const stopTrailingClick = (event: React.MouseEvent, id: number) => {
    if (event.detail === 0) { trailingClick.current = null; return; }
    if (trailingClick.current?.key !== key || trailingClick.current.id !== id) return;
    trailingClick.current = null;
    event.preventDefault(); event.stopPropagation();
  };
  const previewRowDrop = (event: React.DragEvent, id: number) => {
    const movingIds = nativeRowDropIds(dragged.current, key, context.ids, id, blocked);
    if (!movingIds.length) { dropIndicator.current?.clear(); return; }
    event.preventDefault(); event.dataTransfer.dropEffect = "move";
    const row = event.currentTarget as HTMLElement;
    dropIndicator.current?.show({ row, placement: rowDropPlacement(event.clientY, row.getBoundingClientRect()), count: movingIds.length, rowNumber: context.ids.indexOf(id) + 1 });
  };
  const rowProps = (id: number) => ({
    "data-row-drop-id": id,
    className: selected.includes(id) ? "table-row-move-selected" : undefined,
    onDragEnter: (event: React.DragEvent) => previewRowDrop(event, id),
    onDragOver: (event: React.DragEvent) => previewRowDrop(event, id),
    onDrop: (event: React.DragEvent) => {
      stopDragScroll();
      const movingIds = nativeRowDropIds(dragged.current, key, context.ids, id, blocked);
      if (!movingIds.length) return;
      event.preventDefault(); event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const placement = rowDropPlacement(event.clientY, rect);
      dragged.current = { key, ids: [] };
      const revision = selectionRevision.current;
      void order?.move({ movingIds, placement, targetId: id }).then(saved => {
        if (saved && selectionRevision.current === revision) setSelection(current => current.key === key ? { key, ids: movingIds } : current);
      });
    },
  });
  const handle = (id: number, label: string, number: number) => canSelect ? <button type="button" className="table-row-number-handle" aria-label={`Строка ${number}: ${label}`} aria-pressed={selected.includes(id)} title={`Shift + клик — выбрать диапазон. Ctrl/⌘ + клик — выбрать отдельные строки. Escape — снять выделение. ${blocked ? "Для переноса завершите редактирование и сбросьте фильтры и сортировку" : "Перетащите номер для переноса. Правый клик — меню переноса"}`} draggable={!blocked}
      onClick={(event) => {
        const modifiers = { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey };
        event.currentTarget.focus({ preventScroll: true });
        setSelection(current => selectNativeRow(current, key, context.ids, id, modifiers));
      }}
      onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}
      onPointerDown={() => { trailingClick.current = null; }} onMouseDown={(event) => { trailingClick.current = null; if (event.shiftKey) event.preventDefault(); }}
      onClickCapture={(event) => stopTrailingClick(event, id)} onContextMenu={(event) => openMenu(event, id)}
      onDragStart={(event) => {
        const movingIds = nativeRowDragIds(selected, id, blocked);
        if (!movingIds.length) { event.preventDefault(); return; }
        dragged.current = { key, ids: movingIds }; trailingClick.current = { key, id };
        event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", movingIds.join(","));
        stopDragScroll();
        const shell = event.currentTarget.closest<HTMLElement>(".timesheet-grid-shell");
        const owner = shell ?? event.currentTarget.closest<HTMLElement>("table");
        if (owner) {
          const doc = owner.ownerDocument;
          const view = doc.defaultView;
          const indicator = createRowDropIndicator(owner);
          dropIndicator.current = indicator;
          let point = { clientX: event.clientX, clientY: event.clientY };
          let frame: number | null = null;
          const update = () => {
            frame = null;
            const hit = doc.elementFromPoint(point.clientX, point.clientY);
            const row = hit?.closest<HTMLElement>("tr[data-row-drop-id]");
            const targetId = Number(row?.dataset.rowDropId);
            const ids = nativeRowDropIds(dragged.current, key, context.ids, targetId, blocked);
            if (!row || !owner.contains(row) || !ids.length || hit?.closest("thead, tfoot")) { indicator.clear(); return; }
            indicator.show({ row, placement: rowDropPlacement(point.clientY, row.getBoundingClientRect()), count: ids.length, rowNumber: context.ids.indexOf(targetId) + 1 });
          };
          const over = (next: DragEvent) => { point = { clientX: next.clientX, clientY: next.clientY }; update(); };
          const scroll = () => { if (view && frame === null) frame = view.requestAnimationFrame(update); };
          const leave = (next: DragEvent) => { if (!next.relatedTarget || !owner.contains(next.relatedTarget as Node)) indicator.clear(); };
          const escape = (next: KeyboardEvent) => { if (next.key === "Escape") { dragged.current = { key, ids: [] }; clearDropPreview(); } };
          doc.addEventListener("dragover", over, true);
          doc.addEventListener("scroll", scroll, true);
          doc.addEventListener("keydown", escape, true);
          doc.addEventListener("drop", clearDropPreview, true);
          doc.addEventListener("dragend", clearDropPreview, true);
          owner.addEventListener("dragleave", leave);
          view?.addEventListener("blur", clearDropPreview);
          dropPreviewCleanup.current = () => {
            if (frame !== null) view?.cancelAnimationFrame(frame);
            doc.removeEventListener("dragover", over, true);
            doc.removeEventListener("scroll", scroll, true);
            doc.removeEventListener("keydown", escape, true);
            doc.removeEventListener("drop", clearDropPreview, true);
            doc.removeEventListener("dragend", clearDropPreview, true);
            owner.removeEventListener("dragleave", leave);
            view?.removeEventListener("blur", clearDropPreview);
          };
        }
        if (shell) {
          const snapshot = dragged.current;
          let session: ReturnType<typeof startRowDragAutoScroll> = null;
          session = startRowDragAutoScroll(shell, event, "native", () => {
            if (dragScroll.current === session) { dragScroll.current = null; clearDropPreview(); }
            if (dragged.current === snapshot) dragged.current = { key, ids: [] };
          });
          dragScroll.current = session;
        }
      }} onDragEnd={() => { stopDragScroll(); dragged.current = { key, ids: [] }; }}>{number}</button> : number;
  return { rowProps, handle, clearSelection, hasSelection: selected.length > 0, headerCheckbox: "№", getActions: (id: number, close: () => void) => moves.getActions(id, selected, close), ui: <>{moves.feedback}{selected.length > 0 && <div className="table-order-feedback">Выделено строк: {selected.length}<button type="button" onClick={clearSelection}>Снять выделение</button></div>}{menu && <TableContextMenu {...menu} caption="Порядок строк" value="Сотрудники и техника проекта" onClose={closeMenu} actions={moves.getActions(menu.id, selected, closeMenu)} />}</> };
}
