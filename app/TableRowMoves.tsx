"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { TableContextMenu, type TableContextMenuAction } from "./TableContextMenu";
import { orderRowsByIds, type RowMove, type RowOrderId } from "./tableRowOrder";
import "./tableRowOrder.css";
import { useWorkspaceAccess } from "./TableAccessContext";
import { personnelReportOrderScope } from "./personnelReportRowOrder";
import { equipmentReportOrderScope } from "./equipmentReportRowOrder";
import { nativeRowDragIds, nativeRowDropIds, nativeSelectedRowIds, toggleNativeRowSelection, type NativeRowSelection } from "./nativeRowSelection";

const EMPTY_ORDER: RowOrderId[] = [];
type OrderState = { key: string; ids: RowOrderId[]; canWrite: boolean; hasSavedOrder: boolean };
export function useTableRowOrder(scope: string | null, siteId: number, canReorder?: boolean) {
  const key = `${scope ?? ""}:${siteId}`;
  const [state, setState] = useState<OrderState>({ key: "", ids: [], canWrite: false, hasSavedOrder: false });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const activeKey = useRef(key);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    activeKey.current = key;
    if (!scope) return;
    const controller = new AbortController();
    fetch(`/api/table-order?scope=${encodeURIComponent(scope)}&siteId=${siteId}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error); return result as { ids: RowOrderId[]; canWrite: boolean; hasSavedOrder: boolean }; })
      .then((result) => { if (!controller.signal.aborted) { setState({ ...result, key }); setError(""); } })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Не удалось загрузить порядок строк."); });
    return () => controller.abort();
  }, [key, scope, siteId, canReorder]);

  const move = useCallback(async (operation: RowMove) => {
    if (!scope || state.key !== key || !state.canWrite || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/table-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, siteId, ...operation }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Не удалось переместить строки.");
      if (activeKey.current === key) { setState((current) => ({ ...current, ids: result.ids, hasSavedOrder: true })); setMessage(`Порядок сохранён · перемещено строк: ${operation.movingIds.length}`); }
      return true;
    } catch (failure) {
      if (activeKey.current === key) setError(failure instanceof Error ? failure.message : "Не удалось сохранить порядок строк.");
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }, [key, scope, siteId, state.canWrite, state.key]);
  const ids = state.key === key ? state.ids : EMPTY_ORDER;
  const canWrite = state.key === key && state.canWrite;
  const hasSavedOrder = state.key === key && state.hasSavedOrder;
  const remap = useCallback(async (aliases: Record<string, string>) => {
    if (!state.canWrite || state.key !== key || !Object.keys(aliases).length || busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/table-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, siteId, action: "remap", aliases }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить порядок строк.");
      if (activeKey.current === key) setState(current => ({ ...current, ids: result.ids }));
      return true;
    } catch (failure) {
      if (activeKey.current === key) setError(failure instanceof Error ? failure.message : "Не удалось сохранить порядок строк.");
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }, [state.canWrite, state.key, key, scope, siteId]);
  const order = useCallback(<T,>(rows: readonly T[], getId: (row: T) => RowOrderId | undefined) => orderRowsByIds(rows, ids, getId), [ids]);
  return useMemo(() => ({ ids, canWrite, hasSavedOrder, busy, error, message, move, remap, order, scope }), [ids, canWrite, hasSavedOrder, busy, error, message, move, remap, order, scope]);
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
    return actions;
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
  const trailingClick = useRef<{ key: string; id: number } | null>(null);
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
  const canSelect = Boolean(order?.canWrite) && access?.select !== false;
  const clearSelection = () => setSelection({ key, ids: [] });
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
  const rowProps = (id: number) => ({
    className: selected.includes(id) ? "table-row-move-selected" : undefined,
    onDragOver: (event: React.DragEvent) => { if (nativeRowDropIds(dragged.current, key, context.ids, id, blocked).length) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } },
    onDrop: (event: React.DragEvent) => {
      const movingIds = nativeRowDropIds(dragged.current, key, context.ids, id, blocked);
      if (!movingIds.length) return;
      event.preventDefault(); event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      dragged.current = { key, ids: [] };
      void order?.move({ movingIds, placement, targetId: id }).then(saved => {
        if (saved) setSelection(current => current.key === key ? { key, ids: movingIds } : current);
      });
    },
  });
  const handle = (id: number, label: string, number: number) => canSelect ? <button type="button" className="table-row-number-handle" aria-label={`Строка ${number}: ${label}`} aria-pressed={selected.includes(id)} title={blocked ? "Выбор строки. Для переноса завершите редактирование и сбросьте фильтры и сортировку" : "Перетащите номер для переноса. Ctrl/⌘ + клик — выбрать несколько строк. Правый клик — меню переноса"} draggable={!blocked}
      onClick={(event) => setSelection(current => event.ctrlKey || event.metaKey
        ? toggleNativeRowSelection(current, key, context.ids, id, !nativeSelectedRowIds(current, key, context.ids).includes(id))
        : { key, ids: [id] })}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") clearSelection(); }}
      onPointerDown={() => { trailingClick.current = null; }} onMouseDown={() => { trailingClick.current = null; }}
      onClickCapture={(event) => stopTrailingClick(event, id)} onContextMenu={(event) => openMenu(event, id)}
      onDragStart={(event) => {
        const movingIds = nativeRowDragIds(selected, id, blocked);
        if (!movingIds.length) { event.preventDefault(); return; }
        dragged.current = { key, ids: movingIds }; trailingClick.current = { key, id };
        event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", movingIds.join(","));
      }} onDragEnd={() => { dragged.current = { key, ids: [] }; }}>{number}</button> : number;
  return { rowProps, handle, headerCheckbox: "№", getActions: (id: number, close: () => void) => moves.getActions(id, selected, close), ui: <>{moves.feedback}{selected.length > 0 && <div className="table-order-feedback">Выделено строк: {selected.length}<button type="button" onClick={clearSelection}>Снять выделение</button></div>}{menu && <TableContextMenu {...menu} caption="Порядок строк" value="Сотрудники и техника проекта" onClose={closeMenu} actions={moves.getActions(menu.id, selected, closeMenu)} />}</> };
}
