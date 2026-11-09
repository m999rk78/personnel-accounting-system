import type { ColumnMenuVisibleChangedEvent, GridApi } from "ag-grid-community";

type VisibilityApi = Pick<GridApi, "addEventListener" | "removeEventListener" | "isDestroyed">;
type Press = { button: number; preventDefault: () => void; stopPropagation: () => void };
type Click = { stopPropagation: () => void; currentTarget: HTMLElement };
type Key = { key: string; stopPropagation: () => void };
const filterMenuKeys = new Set(["columnFilter", "floatingFilter", "filterMenuTab"]);

/** Filter ownership is separate from the column menu and column chooser. */
export function createColumnFilterVisibility(api: VisibilityApi) {
  let columnId: string | null = null, attached = false;
  let anchor: { columnId: string; button: HTMLElement } | null = null;
  const listeners = new Set<() => void>();
  const setOpen = (next: string | null) => {
    if (columnId === next) return;
    columnId = next;
    listeners.forEach(listener => listener());
  };
  const visibleChanged = (event: ColumnMenuVisibleChangedEvent) => {
    if (!filterMenuKeys.has(event.key)) return;
    const id = event.column?.getColId() ?? null;
    if (event.visible) setOpen(id);
    else if (columnId === id) setOpen(null);
  };
  const destroy = () => {
    if (!api.isDestroyed()) {
      api.removeEventListener("columnMenuVisibleChanged", visibleChanged);
      api.removeEventListener("gridPreDestroyed", destroy);
    }
    attached = false;
    anchor = null;
    setOpen(null);
  };
  return {
    getSnapshot: () => columnId,
    getAnchor: (id: string) => anchor?.columnId === id && anchor.button.isConnected ? anchor.button : null,
    setAnchor: (id: string, button: HTMLElement) => { anchor = { columnId: id, button }; },
    setOpen,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!attached && !api.isDestroyed()) {
        attached = true;
        api.addEventListener("columnMenuVisibleChanged", visibleChanged);
        api.addEventListener("gridPreDestroyed", destroy);
      }
      // Keep tracking while the live grid virtualizes/remounts its headers.
      // The grid's destroy event releases the single native subscription.
      return () => { listeners.delete(listener); };
    },
  };
}
export type ColumnFilterVisibility = ReturnType<typeof createColumnFilterVisibility>;
const visibilityByApi = new WeakMap<VisibilityApi, ColumnFilterVisibility>();
export function columnFilterVisibility(api: VisibilityApi) {
  let visibility = visibilityByApi.get(api);
  if (!visibility) { visibility = createColumnFilterVisibility(api); visibilityByApi.set(api, visibility); }
  return visibility;
}

/** Match AG's native button: toggle before document mousedown dismisses popups. */
export function columnFilterToggleHandlers(api: Pick<GridApi, "isDestroyed" | "hideColumnFilter" | "hidePopupMenu">, columnId: string, showFilter: (button: HTMLElement) => void, visibility: ColumnFilterVisibility, pressHandled = { current: false }) {
  const toggle = (button: HTMLElement) => {
    if (api.isDestroyed()) return false;
    if (visibility.getSnapshot() === columnId) {
      api.hideColumnFilter(); visibility.setOpen(null); return false;
    }
    api.hidePopupMenu();
    api.hideColumnFilter();
    // Unlike showColumnFilter(column), this public header callback opens at
    // the actual button synchronously and protects it from outside dismissal.
    visibility.setAnchor(columnId, button);
    showFilter(button);
    visibility.setOpen(columnId);
    return true;
  };
  return {
    onMouseDownCapture(event: Press & { currentTarget: HTMLElement }) {
      if (event.button !== 0) return;
      pressHandled.current = true;
      event.stopPropagation();
      if (toggle(event.currentTarget)) event.preventDefault();
    },
    onClickCapture(event: Click) {
      event.stopPropagation();
      if (pressHandled.current) { pressHandled.current = false; return; }
      // Keyboard/assistive activation, or touch browsers without a mouse pair.
      toggle(event.currentTarget);
    },
    onKeyDownCapture(event: Key) {
      if (event.key === "Enter" || event.key === " ") { pressHandled.current = false; event.stopPropagation(); }
    },
    onPointerCancel() { pressHandled.current = false; },
  };
}
