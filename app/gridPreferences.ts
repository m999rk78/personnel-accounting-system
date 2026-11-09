import type { Column, ColumnResizedEvent, ColumnState, GridApi } from "ag-grid-community";

export type GridPreferences = {
  version: 1;
  widths: Record<string, number>;
  sorts?: { colId: string; sort: "asc" | "desc" }[];
};

export type PreferenceGridApi = Pick<GridApi, "isDestroyed" | "getColumn" | "getColumnState" | "applyColumnState"> & Partial<Pick<GridApi, "resetColumnState">>;
export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const columnResetters = new WeakMap<object, () => void>();
const reservedColumns = new Set(["ag-Grid-SelectionColumn", "rowOrder", "number", "actions", "reportDateGroup"]);
const validColumnId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 160 && !reservedColumns.has(value);
const defaultPreferences = (): GridPreferences => ({ version: 1, widths: {} });

/** The column menu must clear browser preferences as well as the live columns. */
export function resetGridColumnPreferences(api: Pick<GridApi, "resetColumnState"> & Partial<Pick<GridApi, "isDestroyed">>): void {
  if (api.isDestroyed?.()) return;
  const reset = columnResetters.get(api);
  if (reset) reset(); else api.resetColumnState();
}

/** Only widths and sorts are accepted; stored browser data cannot hide columns or restore selections. */
export function parseGridPreferences(raw: string | null): GridPreferences {
  if (!raw) return defaultPreferences();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || !("version" in value) || value.version !== 1 || !("widths" in value)
      || !value.widths || typeof value.widths !== "object" || Array.isArray(value.widths)) return defaultPreferences();
    const widths = Object.fromEntries(Object.entries(value.widths).slice(0, 256).filter(([id, width]) => validColumnId(id) && typeof width === "number" && Number.isFinite(width) && width >= 20 && width <= 20_000).map(([id, width]) => [id, Math.round(Number(width))]));
    if (!("sorts" in value)) return { version: 1, widths };
    if (!Array.isArray(value.sorts) || value.sorts.length > 256) return { version: 1, widths };
    const seen = new Set<string>();
    const sorts = value.sorts.flatMap(sort => {
      if (!sort || typeof sort !== "object" || !validColumnId(sort.colId) || seen.has(sort.colId) || sort.sort !== "asc" && sort.sort !== "desc") return [];
      seen.add(sort.colId);
      return [{ colId: sort.colId, sort: sort.sort as "asc" | "desc" }];
    });
    return { version: 1, widths, sorts };
  } catch { return defaultPreferences(); }
}

function resizableContentColumn(column: Column) {
  const definition = column.getColDef();
  return validColumnId(column.getColId()) && column.isVisible() && definition.resizable !== false;
}

/** A caller supplies an explicit resource/user key; untouched flex columns remain responsive. */
export function createGridPreferences({ storageKey, active, storage, ready = true }: {
  storageKey: string; active: boolean; storage?: PreferenceStorage; ready?: boolean;
}) {
  const scoped = active && typeof storageKey === "string" && storageKey.length > 0 && storageKey.length <= 512;
  let preferences = defaultPreferences();
  if (scoped) try { preferences = parseGridPreferences(storage?.getItem(storageKey) ?? null); } catch { /* Use initial sizing if browser storage is unavailable. */ }
  let api: PreferenceGridApi | null = null;
  let restoring = false;
  let resetSortBaseline: string | null = null;
  let orderReady = ready;
  let snapshot = preferences.sorts !== undefined;
  const defaultSized = new Set<string>();
  const manuallySized = new Set<string>();
  const listeners = new Set<() => void>();
  const currentSorts = () => !api || api.isDestroyed() ? [] : api.getColumnState()
    .filter(column => validColumnId(column.colId) && (column.sort === "asc" || column.sort === "desc"))
    .sort((left, right) => (left.sortIndex ?? 0) - (right.sortIndex ?? 0)).map(column => ({ colId: column.colId, sort: column.sort as "asc" | "desc" }));
  const persist = () => {
    try { storage?.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Editing and resizing must remain available. */ }
    const next = preferences.sorts !== undefined;
    if (next !== snapshot) { snapshot = next; listeners.forEach(listener => listener()); }
  };
  const restoreSort = () => {
    if (!scoped || !orderReady || !api || api.isDestroyed() || preferences.sorts === undefined) return;
    const sorts = preferences.sorts.filter(item => {
      const column = api?.getColumn(item.colId);
      return column && column.getColDef().sortable !== false;
    });
    // A removed column must not erase the new table version's default sorting.
    if (preferences.sorts.length && !sorts.length) return;
    restoring = true;
    try { api.applyColumnState({ state: sorts.map((item, sortIndex) => ({ ...item, sortIndex })), defaultState: { sort: null, sortIndex: null } }); }
    finally { restoring = false; }
  };
  const resetColumns = () => {
    if (!api || api.isDestroyed()) return;
    preferences = defaultPreferences();
    resetSortBaseline = null;
    defaultSized.clear();
    manuallySized.clear();
    restoring = true;
    try {
      api.resetColumnState?.();
      // AG Grid dispatches option callbacks asynchronously. A late reset event
      // must not turn the restored defaults back into a saved user sort.
      resetSortBaseline = JSON.stringify(currentSorts());
    }
    finally {
      restoring = false;
      if (scoped) persist();
    }
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    attach(grid: PreferenceGridApi) {
      if (api && api !== grid) {
        if (columnResetters.get(api) === resetColumns) columnResetters.delete(api);
        defaultSized.clear(); manuallySized.clear();
        resetSortBaseline = null;
      }
      api = grid;
      if (api.isDestroyed()) return;
      columnResetters.set(api, resetColumns);
      if (!scoped) return;
      const widths: ColumnState[] = Object.entries(preferences.widths).flatMap(([colId, width]) => {
        const column = grid.getColumn(colId);
        if (!column || !resizableContentColumn(column)) return [];
        return [{ colId, width: Math.min(column.getMaxWidth(), Math.max(column.getMinWidth(), width)), flex: null }];
      });
      restoring = true;
      try { if (widths.length) grid.applyColumnState({ state: widths }); }
      finally { restoring = false; }
      restoreSort();
    },
    applyDefaultWidths(widths: Record<string, number> | undefined) {
      if (!widths || !api || api.isDestroyed()) return;
      const state: ColumnState[] = Object.entries(widths).flatMap(([colId, width]) => {
        if (typeof width !== "number" || !Number.isFinite(width) || width <= 0 || Object.hasOwn(preferences.widths, colId) || manuallySized.has(colId) || defaultSized.has(colId)) return [];
        const column = api?.getColumn(colId);
        if (!column || !resizableContentColumn(column)) return [];
        return [{ colId, width: Math.min(column.getMaxWidth(), Math.max(column.getMinWidth(), Math.round(width))), flex: null }];
      });
      if (!state.length) return;
      restoring = true;
      try {
        if (api.applyColumnState({ state }) !== false) for (const column of state) defaultSized.add(column.colId);
      } finally { restoring = false; }
    },
    setReady(value: boolean) {
      const becameReady = !orderReady && value;
      orderReady = value;
      if (becameReady) restoreSort();
    },
    onColumnResized(event: Pick<ColumnResizedEvent, "column" | "columns" | "source" | "finished">) {
      if (restoring || !event.finished || event.source !== "uiColumnResized" && event.source !== "autosizeColumns") return;
      const columns = event.columns ?? (event.column ? [event.column] : []);
      const widths = Object.fromEntries(columns.filter(resizableContentColumn).map(column => [column.getColId(), column.getActualWidth()]));
      if (!Object.keys(widths).length) return;
      for (const id of Object.keys(widths)) manuallySized.add(id);
      if (!scoped) return;
      preferences = { ...preferences, widths: { ...preferences.widths, ...widths } };
      persist();
    },
    onSortChanged() {
      if (!scoped || restoring || !orderReady || !api || api.isDestroyed()) return;
      const sorts = currentSorts();
      const serialized = JSON.stringify(sorts);
      if (resetSortBaseline !== null) {
        if (serialized === resetSortBaseline) return;
        resetSortBaseline = null;
      }
      if (serialized === JSON.stringify(preferences.sorts)) return;
      preferences = { ...preferences, sorts };
      persist();
    },
  };
}
