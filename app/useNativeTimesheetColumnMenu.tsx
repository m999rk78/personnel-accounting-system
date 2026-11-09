"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { TableContextMenu, type TableContextMenuAction } from "./TableContextMenu";

type ColumnActions = {
  canSort: (id: string) => boolean;
  getSort: (id: string) => "asc" | "desc" | null;
  sort: (id: string, direction: "asc" | "desc" | null) => void;
  openFilter: (id: string, trigger: HTMLElement) => void;
};
type WidthActions = { autoSize: (id?: string) => void; resetWidths: () => void };
type MenuState = { scope: string; id: string; label: string; anchor: HTMLTableCellElement; x: number; y: number };

/** Header actions operate on the visible native table, never its hidden AG engine. */
export function useNativeTimesheetColumnMenu(rootRef: RefObject<HTMLElement | null>, { month, scope, enabled = true, columns, widths }: {
  month: string; scope: string; enabled?: boolean; columns: ColumnActions; widths: WidthActions;
}) {
  const [state, setState] = useState<MenuState | null>(null);
  const close = useCallback(() => setState(null), []);
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    const open = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const header = target.closest<HTMLTableCellElement>("thead th");
      const table = root.querySelector<HTMLTableElement>("table.timesheet-resizable");
      if (!header || !table || header.closest("table") !== table || !root.contains(header)) return;
      const handle = header.querySelector<HTMLElement>('[data-resize-edge="right"][data-resize-owner]');
      const id = handle?.dataset.resizeOwner;
      if (!id) return; // A grouped heading has no single data-column action.
      event.preventDefault(); event.stopPropagation();
      const label = header.querySelector<HTMLElement>(".timesheet-filterable-heading-label")?.innerText.replace(/\s+/g, " ").trim() || "№";
      const bounds = header.getBoundingClientRect();
      const keyboard = event.clientX === 0 && event.clientY === 0;
      setState({ scope, id, label, anchor: header,
        x: Math.max(8, Math.min(keyboard ? bounds.left + Math.min(30, bounds.width / 2) : event.clientX, window.innerWidth - 256)),
        y: Math.max(8, Math.min(keyboard ? bounds.bottom : event.clientY, window.innerHeight - 360)) });
    };
    // Capture gets the event before the resize grip's own browser-menu guard.
    root.addEventListener("contextmenu", open, true);
    return () => { root.removeEventListener("contextmenu", open, true); close(); };
  }, [enabled, rootRef, scope, close]);
  const menu = enabled && state?.scope === scope && state.anchor.isConnected ? state : null;
  if (!menu) return null;
  const filterId = menu.id.startsWith("day-") ? `${month}-${menu.id.slice(4).padStart(2, "0")}` : menu.id;
  const sortable = columns.canSort(filterId);
  const sort = columns.getSort(filterId);
  const run = (action: () => void) => () => { close(); action(); };
  const actions: TableContextMenuAction[] = [
    ...(sortable ? [
      { label: "По возрастанию", disabled: sort === "asc", onSelect: run(() => columns.sort(filterId, "asc")) },
      { label: "По убыванию", disabled: sort === "desc", onSelect: run(() => columns.sort(filterId, "desc")) },
      { label: "Сбросить сортировку", disabled: !sort, onSelect: run(() => columns.sort(filterId, null)) },
      { label: "Фильтр…", separatorBefore: true, onSelect: run(() => columns.openFilter(filterId, menu.anchor.querySelector<HTMLElement>(".timesheet-header-filter") ?? menu.anchor)) },
    ] satisfies TableContextMenuAction[] : []),
    { label: "Ширина по содержимому", separatorBefore: sortable, onSelect: run(() => widths.autoSize(menu.id)) },
    { label: "Подобрать ширину всех", onSelect: run(() => widths.autoSize()) },
    { label: "Сбросить ширину столбцов", separatorBefore: true, onSelect: run(widths.resetWidths) },
  ];
  return <TableContextMenu x={menu.x} y={menu.y} caption="Столбец" value={menu.label} ariaLabel="Действия со столбцом" actions={actions} onClose={close}/>;
}
