"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi, IFilterParams, PostProcessPopupParams } from "ag-grid-community";
import { gridTheme } from "./gridTheme";
import { gridLocaleRu } from "./gridLocaleRu";
import { compareGridValues } from "./gridFilterModel";
import { enterpriseFilterParams, type EnterpriseFilterOptions } from "./GridEnterpriseFilters";
import type { TimesheetFiltersContextValue } from "./TimesheetColumnFilter";
import { IMPORT_ORDER_COLUMN, importOrderColumnState, shouldApplyImportOrder } from "./importOrderSorting";

export type TimesheetFilterColumn<T> = {
  colId: string;
  headerName: string;
  kind?: "text" | "number" | "date";
  getValue: (row: T) => unknown;
  valueFormatter?: (value: unknown) => string;
  presets?: readonly { value: string; label: string; matches: (row: T) => boolean }[];
};
type Snapshot = { keys: string[] | null; filters: string[]; sorts: { id: string; direction: "asc" | "desc"; priority: number }[] };
const EMPTY: Snapshot = { keys: null, filters: [], sorts: [] };

/** One native AG row model supplies filters/sorts to the existing spreadsheet cells. */
export function useTimesheetFilters<T>({ rows, columns, getRowId, resetKey, importOrder, presentation = "full", includeConditions = true }: { rows: readonly T[]; columns: readonly TimesheetFilterColumn<T>[]; getRowId: (row: T) => string; resetKey: string; importOrder?: { rank: (row: T) => number; activation: number; ready: boolean; defaultSort: boolean }; presentation?: EnterpriseFilterOptions["presentation"]; includeConditions?: boolean }) {
  const apiRef = useRef<GridApi<T> | null>(null);
  const [api, setApi] = useState<GridApi<T> | null>(null);
  const anchor = useRef<{ columnId: string; trigger: HTMLElement } | null>(null);
  const popup = useRef<HTMLElement | null>(null);
  const [native, setNative] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [openColumnId, setOpenColumnId] = useState<string | null>(null);
  const publish = useCallback((api: GridApi<T>) => {
    if (api.isDestroyed()) return;
    const keys: string[] = [];
    api.forEachNodeAfterFilterAndSort(node => { if (node.id != null && node.data) keys.push(node.id); });
    const filters = Object.keys(api.getFilterModel());
    const sorts = api.getColumnState().filter(state => state.sort === "asc" || state.sort === "desc")
      .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0)).map((state, index) => ({ id: state.colId, direction: state.sort as "asc" | "desc", priority: index + 1 }));
    const next = { keys, filters, sorts };
    setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);
  const importRank = importOrder?.rank;
  const definitions = useMemo<ColDef<T>[]>(() => [...columns.map((column): ColDef<T> => ({
    colId: column.colId, headerName: column.headerName, sortable: true, cellDataType: false,
    valueGetter: params => params.data ? column.getValue(params.data) : null,
    valueFormatter: params => column.valueFormatter?.(params.value) ?? (params.value == null || params.value === "" ? "(Пустые)" : String(params.value)),
    comparator: compareGridValues,
    filter: native ? "agMultiColumnFilter" : column.kind === "number" ? "agNumberColumnFilter" : column.kind === "date" ? "agDateColumnFilter" : "agTextColumnFilter",
    filterParams: native ? (params: IFilterParams) => enterpriseFilterParams(params, {
      presentation,
      includeConditions,
      kind: column.kind ?? "text",
      valueFormatter: ({ value }) => column.valueFormatter?.(value) ?? (value == null || value === "" ? "(Пустые)" : String(value)),
      ...(column.presets?.length ? { stateFilter: {
        values: column.presets.map(preset => ({ value: preset.value, label: preset.label })),
        getValue: (data: unknown) => data ? column.presets!.filter(preset => preset.matches(data as T)).map(preset => preset.value) : [],
      } } : {}),
    }) : { buttons: ["clear", "cancel", "apply"], closeOnApply: true, maxNumConditions: 4 },
  })), ...(importRank ? [{
    colId: IMPORT_ORDER_COLUMN, headerName: "Порядок импорта", hide: true, lockVisible: true, suppressColumnsToolPanel: true,
    sortable: true, filter: false, valueGetter: (params: { data?: T }) => params.data ? importRank(params.data) : null,
    comparator: (left: number, right: number) => left - right,
  }] : [])], [columns, native, importRank, presentation, includeConditions]);
  const previousImportActivation = useRef(0);
  const defaultImportApplied = useRef<GridApi<T> | null>(null);
  const importActivation = importOrder?.activation ?? 0;
  const importReady = importOrder?.ready ?? false;
  const importDefault = importOrder?.defaultSort ?? false;
  useEffect(() => {
    if (!api || api.isDestroyed() || !api.getColumn(IMPORT_ORDER_COLUMN)) return;
    const activated = previousImportActivation.current !== importActivation;
    previousImportActivation.current = importActivation;
    const firstLoad = importReady && defaultImportApplied.current !== api;
    if (firstLoad) defaultImportApplied.current = api;
    if (shouldApplyImportOrder({ activated, firstLoad, defaultImport: importDefault, sorted: api.getColumnState().some(column => Boolean(column.sort)) })) api.applyColumnState(importOrderColumnState());
  }, [api, importActivation, importReady, importDefault, definitions]);
  const reset = useCallback(() => {
    const api = apiRef.current;
    if (!api || api.isDestroyed()) return;
    api.hideColumnFilter(); api.setFilterModel(null);
    api.applyColumnState({ defaultState: { sort: null, sortIndex: null } });
    anchor.current = null; popup.current = null;
    setOpenColumnId(null); publish(api);
  }, [publish]);
  const open = useCallback((columnId: string, trigger: HTMLElement, wasOpen?: boolean) => {
    const api = apiRef.current;
    if (!api || api.isDestroyed()) return;
    if (wasOpen ?? (anchor.current?.columnId === columnId && popup.current?.isConnected)) { api.hideColumnFilter(); setOpenColumnId(null); return; }
    api.hideColumnFilter(); anchor.current = { columnId, trigger }; popup.current = null;
    api.showColumnFilter(columnId);
  }, []);
  const updatePopupPosition = useCallback(() => {
    const target = anchor.current;
    const ePopup = popup.current;
    if (!target || !ePopup) return;
    const rect = target.trigger.getBoundingClientRect();
    const width = Math.max(0, Math.min(presentation === "checklist" ? 334 : presentation === "compact" ? 286 : 400, window.innerWidth - 24));
    if (ePopup.style.position !== "fixed") ePopup.style.position = "fixed";
    if (ePopup.style.width !== `${width}px`) ePopup.style.width = `${width}px`;
    const below = Math.max(0, window.innerHeight - rect.bottom - 18);
    const above = Math.max(0, rect.top - 18);
    // Keep the trigger accessible, including when the selected-day bar moves
    // the header lower. Clamping a tall popup to the viewport would cover it.
    const preferredHeight = Math.min(presentation === "checklist" ? 540 : presentation === "compact" ? 430 : 700, window.innerHeight - 24);
    const placeBelow = below >= preferredHeight || below >= above;
    const maxHeight = `${Math.floor(Math.min(preferredHeight, placeBelow ? below : above))}px`;
    if (ePopup.style.maxHeight !== maxHeight) ePopup.style.maxHeight = maxHeight;
    const height = ePopup.getBoundingClientRect().height;
    const left = `${Math.round(Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)))}px`;
    const top = `${Math.round(Math.max(12, placeBelow ? rect.bottom + 6 : rect.top - height - 6))}px`;
    if (ePopup.style.left !== left) ePopup.style.left = left;
    if (ePopup.style.top !== top) ePopup.style.top = top;
    if (ePopup.style.zIndex !== "1200") ePopup.style.zIndex = "1200";
  }, [presentation]);
  const positionPopup = useCallback(({ ePopup }: PostProcessPopupParams<T>) => {
    const target = anchor.current;
    if (!target || !ePopup.classList.contains("ag-filter-menu")) return;
    popup.current = ePopup;
    updatePopupPosition();
    setOpenColumnId(target.columnId);
  }, [updatePopupPosition]);
  useEffect(() => {
    if (!openColumnId) return;
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; updatePopupPosition(); });
    };
    const repositionOnScroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target) || event.target instanceof Element && event.target.closest(".timesheet-filter-engine,.ag-popup,.custom-select-menu")) return;
      schedule();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest(".custom-select-menu")) return;
      const api = apiRef.current;
      if (!api || api.isDestroyed()) return;
      api.doFilterAction({ colId: openColumnId, action: "cancel" });
      api.hideColumnFilter();
    };
    // AG Grid also repositions menus after scrolling/rendering; keep the external
    // table header as the anchor, including when new conditions change the height.
    const positioning = new MutationObserver(schedule);
    const resize = new ResizeObserver(schedule);
    if (popup.current) {
      positioning.observe(popup.current, { attributes: true, attributeFilter: ["style"] });
      resize.observe(popup.current);
    }
    schedule();
    window.addEventListener("scroll", repositionOnScroll, true);
    window.addEventListener("resize", schedule);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(frame);
      positioning.disconnect();
      resize.disconnect();
      window.removeEventListener("scroll", repositionOnScroll, true);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openColumnId, updatePopupPosition, snapshot.filters]);
  const byId = useMemo(() => new Map(rows.map(row => [getRowId(row), row])), [rows, getRowId]);
  const dayColumnIds = useMemo(() => new Set(columns.flatMap(column => /^\d{4}-\d{2}-\d{2}$/.test(column.colId) ? [column.colId] : [])), [columns]);
  const dayFilterIds = useMemo(() => snapshot.filters.filter(id => dayColumnIds.has(id)), [snapshot.filters, dayColumnIds]);
  const clearDayFilters = useCallback(async () => {
    const api = apiRef.current;
    if (!api || api.isDestroyed()) return;
    api.hideColumnFilter();
    for (const id of Object.keys(api.getFilterModel()).filter(id => dayColumnIds.has(id))) {
      if (api.isDestroyed()) return;
      await api.setColumnFilterModel(id, null);
    }
    if (!api.isDestroyed()) { api.onFilterChanged(); publish(api); }
  }, [dayColumnIds, publish]);
  const visibleRows = snapshot.keys === null ? [...rows] : snapshot.keys.flatMap(key => { const row = byId.get(key); return row ? [row] : []; });
  const context = useMemo<TimesheetFiltersContextValue>(() => ({
    open, openColumnId, presentation, activeColumns: new Set(snapshot.filters),
    sorts: new Map(snapshot.sorts.map(sort => [sort.id, { direction: sort.direction, priority: sort.priority }])),
  }), [open, openColumnId, presentation, snapshot.filters, snapshot.sorts]);
  const columnActions = useMemo(() => ({
    canSort: (columnId: string) => Boolean(api && columns.some(column => column.colId === columnId)),
    getSort: (columnId: string) => snapshot.sorts.find(sort => sort.id === columnId)?.direction ?? null,
    sort: (columnId: string, direction: "asc" | "desc" | null) => {
      const grid = apiRef.current;
      if (!grid || grid.isDestroyed() || !grid.getColumn(columnId)?.isSortable()) return;
      grid.hideColumnFilter();
      grid.applyColumnState({ state: [{ colId: columnId, sort: direction, sortIndex: direction ? 0 : null }],
        ...(direction ? { defaultState: { sort: null, sortIndex: null } } : {}) });
      publish(grid);
    },
    openFilter: (columnId: string, trigger: HTMLElement) => open(columnId, trigger, false),
  }), [api, columns, snapshot.sorts, open, publish]);
  const controller = <div className="timesheet-filter-engine" aria-hidden="true"><AgGridReact<T> key={resetKey}
    theme={gridTheme} localeText={gridLocaleRu} rowData={rows as T[]} columnDefs={definitions} getRowId={({ data }) => getRowId(data)}
    headerHeight={0} rowHeight={1} rowBuffer={0} suppressCellFocus suppressHeaderFocus suppressColumnVirtualisation
    enableFilterHandlers animateRows={false} popupParent={typeof document === "undefined" ? undefined : document.body} postProcessPopup={positionPopup}
    onGridReady={({ api }) => { apiRef.current = api; setApi(api); setNative(api.isModuleRegistered("MultiFilterModule") && api.isModuleRegistered("SetFilterModule")); setSnapshot(EMPTY); setOpenColumnId(null); publish(api); }}
    onModelUpdated={({ api }) => publish(api)} onFilterChanged={({ api }) => publish(api)} onSortChanged={({ api }) => publish(api)}
    onColumnMenuVisibleChanged={({ visible, column, key }) => {
      if (key !== "columnFilter" || column?.getColId() !== anchor.current?.columnId) return;
      if (!visible && !popup.current?.isConnected) {
        setOpenColumnId(null);
        if (document.activeElement === document.body) anchor.current?.trigger.focus({ preventScroll: true });
        popup.current = null;
      }
    }}
    onGridPreDestroyed={() => { popup.current = null; anchor.current = null; apiRef.current = null; }}/></div>;
  return { rows: visibleRows, context, controller, columnActions, dayFilterIds, clearDayFilters, activeCount: snapshot.filters.length + snapshot.sorts.length, isActive: snapshot.filters.length > 0 || snapshot.sorts.length > 0, reset };
}
