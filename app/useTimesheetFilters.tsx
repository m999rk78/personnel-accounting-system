"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi, IFilterParams, PostProcessPopupParams } from "ag-grid-community";
import { gridTheme } from "./gridTheme";
import { gridLocaleRu } from "./gridLocaleRu";
import { compareGridValues } from "./gridFilterModel";
import { enterpriseFilterParams } from "./GridEnterpriseFilters";
import type { TimesheetFiltersContextValue } from "./TimesheetColumnFilter";

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
export function useTimesheetFilters<T>({ rows, columns, getRowId, resetKey }: { rows: readonly T[]; columns: readonly TimesheetFilterColumn<T>[]; getRowId: (row: T) => string; resetKey: string }) {
  const apiRef = useRef<GridApi<T> | null>(null);
  const anchor = useRef<{ columnId: string; trigger: HTMLButtonElement } | null>(null);
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
  const definitions = useMemo<ColDef<T>[]>(() => columns.map(column => ({
    colId: column.colId, headerName: column.headerName, sortable: true, cellDataType: false,
    valueGetter: params => params.data ? column.getValue(params.data) : null,
    valueFormatter: params => column.valueFormatter?.(params.value) ?? (params.value == null || params.value === "" ? "(Пустые)" : String(params.value)),
    comparator: compareGridValues,
    filter: native ? "agMultiColumnFilter" : column.kind === "number" ? "agNumberColumnFilter" : column.kind === "date" ? "agDateColumnFilter" : "agTextColumnFilter",
    filterParams: native ? (params: IFilterParams) => enterpriseFilterParams(params, {
      kind: column.kind ?? "text",
      valueFormatter: ({ value }) => column.valueFormatter?.(value) ?? (value == null || value === "" ? "(Пустые)" : String(value)),
      ...(column.presets?.length ? { stateFilter: {
        values: column.presets.map(preset => ({ value: preset.value, label: preset.label })),
        getValue: (data: unknown) => data ? column.presets!.filter(preset => preset.matches(data as T)).map(preset => preset.value) : [],
      } } : {}),
    }) : { buttons: ["clear", "cancel", "apply"], closeOnApply: true, maxNumConditions: 4 },
  })), [columns, native]);
  const reset = useCallback(() => {
    const api = apiRef.current;
    if (!api || api.isDestroyed()) return;
    api.hideColumnFilter(); api.setFilterModel(null);
    api.applyColumnState({ defaultState: { sort: null, sortIndex: null } });
    anchor.current = null; popup.current = null;
    setOpenColumnId(null); publish(api);
  }, [publish]);
  const open = useCallback((columnId: string, trigger: HTMLButtonElement) => {
    const api = apiRef.current;
    if (!api || api.isDestroyed()) return;
    if (anchor.current?.columnId === columnId && popup.current?.isConnected) { api.hideColumnFilter(); setOpenColumnId(null); return; }
    api.hideColumnFilter(); anchor.current = { columnId, trigger };
    api.showColumnFilter(columnId);
  }, []);
  const positionPopup = useCallback(({ ePopup }: PostProcessPopupParams<T>) => {
    const target = anchor.current;
    if (!target || !ePopup.classList.contains("ag-filter-menu")) return;
    popup.current = ePopup;
    const rect = target.trigger.getBoundingClientRect();
    const width = Math.min(400, window.innerWidth - 24);
    ePopup.style.position = "fixed";
    ePopup.style.width = `${width}px`;
    ePopup.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    ePopup.style.top = `${rect.bottom + 6}px`;
    ePopup.style.zIndex = "1200";
    setOpenColumnId(target.columnId);
  }, []);
  useEffect(() => {
    if (!openColumnId) return;
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target) || event.target instanceof Element && event.target.closest(".timesheet-filter-engine,.ag-popup,.custom-select-menu")) return;
      const api = apiRef.current;
      if (api && !api.isDestroyed()) api.hideColumnFilter();
      setOpenColumnId(null);
    };
    window.addEventListener("scroll", closeOnScroll, true);
    return () => window.removeEventListener("scroll", closeOnScroll, true);
  }, [openColumnId]);
  const byId = useMemo(() => new Map(rows.map(row => [getRowId(row), row])), [rows, getRowId]);
  const visibleRows = snapshot.keys === null ? [...rows] : snapshot.keys.flatMap(key => { const row = byId.get(key); return row ? [row] : []; });
  const context = useMemo<TimesheetFiltersContextValue>(() => ({
    open, openColumnId, activeColumns: new Set(snapshot.filters),
    sorts: new Map(snapshot.sorts.map(sort => [sort.id, { direction: sort.direction, priority: sort.priority }])),
  }), [open, openColumnId, snapshot.filters, snapshot.sorts]);
  const controller = <div className="timesheet-filter-engine" aria-hidden="true"><AgGridReact<T> key={resetKey}
    theme={gridTheme} localeText={gridLocaleRu} rowData={rows as T[]} columnDefs={definitions} getRowId={({ data }) => getRowId(data)}
    headerHeight={0} rowHeight={1} rowBuffer={0} suppressCellFocus suppressHeaderFocus suppressColumnVirtualisation
    enableFilterHandlers animateRows={false} popupParent={typeof document === "undefined" ? undefined : document.body} postProcessPopup={positionPopup}
    onGridReady={({ api }) => { apiRef.current = api; setNative(api.isModuleRegistered("MultiFilterModule") && api.isModuleRegistered("SetFilterModule")); setSnapshot(EMPTY); setOpenColumnId(null); publish(api); }}
    onModelUpdated={({ api }) => publish(api)} onFilterChanged={({ api }) => publish(api)} onSortChanged={({ api }) => publish(api)}
    onColumnMenuVisibleChanged={({ visible, column }) => { if (!visible && column?.getColId() === anchor.current?.columnId) { setOpenColumnId(null); anchor.current?.trigger.focus({ preventScroll: true }); popup.current = null; } }}
    onGridPreDestroyed={() => { popup.current = null; anchor.current = null; apiRef.current = null; }}/></div>;
  return { rows: visibleRows, context, controller, activeCount: snapshot.filters.length + snapshot.sorts.length, isActive: snapshot.filters.length > 0 || snapshot.sorts.length > 0, reset };
}
