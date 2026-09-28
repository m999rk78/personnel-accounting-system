"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CellStyleModule,
  CellApiModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  EventApiModule,
  LocaleModule,
  CustomFilterModule,
  RenderApiModule,
  RowApiModule,
  RowSelectionModule,
  RowStyleModule,
  ScrollApiModule,
  themeQuartz,
  type ColDef,
  type ColumnResizedEvent,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
} from "ag-grid-community";
import {
  AgGridProvider,
  type CustomCellRendererProps,
  type CustomInnerHeaderProps,
} from "ag-grid-react";
import { CustomSelect } from "./CustomSelect";
import type { UserRole } from "./roles";

// LocalizedGrid wraps AgGridReact with shared Russian filters and their summary.
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams, type SpreadsheetPastePayload } from "./GridFilters";

export type GridOption = { id: number; name: string };
export type GridEmployee = {
  id: number;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
  source: string;
  bitrix24Stage: string;
  availabilityStatus?: string;
  syncError?: string | null;
  siteId: number | null;
  siteName: string | null;
};
export type GridEmployeeDraft = { key: string; id?: number; fullName: string; employmentType: string; department: string; position: string; projectSiteId: string };
export type GridProjectEmployeeDraft = { key: string; employeeId: string; employeeQuery: string };
export type GridDirectoryDraft = { key: string; id?: number; name: string; employeeId?: string };
export type GridPosition = { id: number; employmentType: string; department: string; position: string };
export type GridPositionDraft = { key: string; id?: number; employmentType: string; department: string; position: string };
export type GridUser = { id: number; fullName: string; email: string; role: UserRole; assignedSiteId: number | null; status?: "active" | "invited" };
export type GridUserDraft = { key: string; id?: number; fullName: string; email: string; role: UserRole; assignedSiteId: string };
export type GridSite = GridOption & { code: string; timezone: string };
export type GridSiteDraft = { key: string; id?: number; name: string; code: string; timezone: string };
export type GridEntry = {
  id: number;
  employeeId: number;
  shiftId: number;
  zoneId: number;
  mainWorkTypeId: number;
  subworkTypeId: number;
  masterId: number;
  hours: number;
  note: string;
  employeeName: string;
  employmentType: string;
  department: string;
  positionSnapshot: string;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  masterName: string;
};
export type GridDraftRow = {
  key: string;
  roster?: boolean;
  lockedEmployee?: boolean;
  carriedFromPreviousDay?: boolean;
  employeeId: string;
  employeeQuery: string;
  shiftId: string;
  zoneId: string;
  mainWorkTypeId: string;
  subworkTypeId: string;
  masterId: string;
  hours: string;
  note: string;
};

type PlacementRow = {
  rowKey: string;
  kind: "entry" | "edit" | "draft";
  number: string | number;
  entry?: GridEntry;
  draft?: GridDraftRow;
};

const gridTheme = themeQuartz.withParams({
  accentColor: "#f2aa00",
  backgroundColor: "#ffffff",
  borderColor: "#dedede",
  browserColorScheme: "light",
  cellHorizontalPadding: 12,
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  fontSize: 13,
  foregroundColor: "#27272a",
  headerBackgroundColor: "#fafafa",
  headerFontSize: 13,
  headerFontWeight: 650,
  headerTextColor: "#27272a",
  rowBorder: { color: "#dedede", width: 1 },
  rowHoverColor: "#f8fbff",
  selectedRowBackgroundColor: "#fff7df",
  spacing: 6,
});

const modules = [
  CellApiModule,
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  EventApiModule,
  LocaleModule,
  CustomFilterModule,
  RenderApiModule,
  RowApiModule,
  RowSelectionModule,
  RowStyleModule,
  CellStyleModule,
  ScrollApiModule,
];

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; }, [value]);
  return ref;
}

function keepGridFilled<TData>(event: ColumnResizedEvent<TData>) {
  if (!event.finished || event.source !== "uiColumnResized" || !event.column) return;
  const resizedColumn = event.column;
  const resizedWidth = resizedColumn.getActualWidth();
  const hasFlexibleSibling = (event.api.getColumns() ?? []).some((column) => column !== resizedColumn && column.isVisible() && !column.getPinned() && !column.getColDef().suppressSizeToFit);
  requestAnimationFrame(() => {
    if (event.api.isDestroyed()) return;
    if (!hasFlexibleSibling) {
      event.api.sizeColumnsToFit();
      return;
    }
    event.api.sizeColumnsToFit({
      columnLimits: [{ key: resizedColumn, minWidth: resizedWidth, maxWidth: resizedWidth }],
    });
  });
}

function GridIcon({ name }: { name: "trash" | "back" | "check" | "pin" | "filter" }) {
  return <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "trash" && <><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></>}
    {name === "back" && <><path d="m9 14-5-5 5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></>}
    {name === "check" && <path d="m20 6-11 11-5-5"/>}
    {name === "pin" && <><path d="M12 17v5M5 8.5l4-4V2h6v2.5l4 4V11H5Z"/><path d="M8 11v3h8v-3"/></>}
    {name === "filter" && <><path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/></>}
  </svg>;
}

function PinnableInnerHeader(props: CustomInnerHeaderProps<PlacementRow>) {
  const [pinned, setPinned] = useState(() => props.column.getPinned() === "left");
  const [filterActive, setFilterActive] = useState(() => props.column.isFilterActive());
  useEffect(() => {
    const updatePinned = () => setPinned(props.column.getPinned() === "left");
    const updateFilter = () => setFilterActive(props.column.isFilterActive());
    props.api.addEventListener("columnPinned", updatePinned);
    props.api.addEventListener("filterChanged", updateFilter);
    return () => {
      props.api.removeEventListener("columnPinned", updatePinned);
      props.api.removeEventListener("filterChanged", updateFilter);
    };
  }, [props.api, props.column]);
  return <span className="ag-pinnable-header"><span>{props.displayName}</span><span className="ag-header-tools"><button type="button" className={pinned ? "ag-column-pin active" : "ag-column-pin"} onClick={(event) => { event.stopPropagation(); props.api.setColumnsPinned([props.column], pinned ? null : "left"); }} title={pinned ? `Открепить ${props.displayName}` : `Закрепить ${props.displayName}`} aria-label={pinned ? `Открепить ${props.displayName}` : `Закрепить ${props.displayName}`}><GridIcon name="pin" /></button><button type="button" className={filterActive ? "ag-column-filter active" : "ag-column-filter"} onClick={(event) => { event.stopPropagation(); props.api.showColumnFilter(props.column); }} title={`Фильтр: ${props.displayName}`} aria-label={`Фильтр: ${props.displayName}`}><GridIcon name="filter" /></button></span></span>;
}

const pinnableHeader = { innerHeaderComponent: PinnableInnerHeader };

function optionName(options: GridOption[], id: string) {
  return options.find((option) => option.id === Number(id))?.name ?? "";
}

function pastedOptionId(options: GridOption[], value: string) {
  const normalized = normalizeSearch(value);
  return String(options.find((option) => String(option.id) === value.trim() || normalizeSearch(option.name) === normalized)?.id ?? "");
}

function pastedOptionName(options: GridOption[], value: string) {
  const normalized = normalizeSearch(value);
  return options.find((option) => normalizeSearch(option.name) === normalized)?.name ?? null;
}

function isInteractiveGridTarget(event?: Event | null) {
  const target = event?.target;
  return target instanceof Element && Boolean(target.closest("button, input, textarea, select, [role='combobox'], .actions-cell"));
}

function canOpenRowEditor(event?: Event | null) {
  return !isInteractiveGridTarget(event);
}

function placementValue(row: PlacementRow, field: string, options: PlacementGridProps) {
  if (field === "number") return row.number;
  if (row.kind === "entry" && row.entry) {
    const entry = row.entry;
    const values: Record<string, string | number> = {
      employeeName: entry.employeeName,
      employmentType: entry.employmentType,
      department: entry.department,
      position: entry.positionSnapshot,
      shift: entry.shiftName,
      zone: entry.zoneName,
      mainWork: entry.mainWorkTypeName,
      subwork: entry.subworkTypeName,
      master: entry.masterName,
      hours: entry.hours,
      note: entry.note || "",
    };
    return values[field] ?? "";
  }
  const draft = row.draft;
  const employee = options.employees.find((item) => item.id === Number(draft?.employeeId));
  const entry = row.entry;
  const values: Record<string, string | number> = {
    employeeName: draft?.employeeQuery || entry?.employeeName || "",
    employmentType: employee?.employmentType ?? entry?.employmentType ?? "—",
    department: employee?.department ?? entry?.department ?? "—",
    position: employee?.position ?? entry?.positionSnapshot ?? "Заполнится автоматически",
    shift: optionName(options.shifts, draft?.shiftId ?? "") || entry?.shiftName || "",
    zone: optionName(options.zones, draft?.zoneId ?? "") || entry?.zoneName || "",
    mainWork: optionName(options.mainWorkTypes, draft?.mainWorkTypeId ?? "") || entry?.mainWorkTypeName || "",
    subwork: optionName(options.subworkTypes, draft?.subworkTypeId ?? "") || entry?.subworkTypeName || "",
    master: optionName(options.masters, draft?.masterId ?? "") || entry?.masterName || "",
    hours: Number(draft?.hours) || entry?.hours || "",
    note: draft?.note ?? entry?.note ?? "",
  };
  return values[field] ?? "";
}

type PlacementGridProps = {
  entries: GridEntry[];
  draftRows: GridDraftRow[];
  editing: { id: number; row: GridDraftRow }[];
  employees: GridEmployee[];
  shifts: GridOption[];
  zones: GridOption[];
  mainWorkTypes: GridOption[];
  subworkTypes: GridOption[];
  masters: GridOption[];
  loading: boolean;
  canEdit: boolean;
  rosterMode?: boolean;
  pendingDeletes: number[];
  onEdit: (entry: GridEntry, changes?: Partial<GridDraftRow>) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridDraftRow>) => void;
  onPatchEditing: (id: number, changes: Partial<GridDraftRow>) => void;
  onVisibleEntryIdsChange: (ids: number[]) => void;
};

function DraftSelect({ value, options, placeholder, onChange, autoOpen = false }: { value: string; options: GridOption[]; placeholder: string; onChange: (value: string) => void; autoOpen?: boolean }) {
  return <CustomSelect className="ag-custom-select" value={value} ariaLabel={placeholder} onChange={onChange} autoOpen={autoOpen} options={[{ value: "", label: placeholder }, ...options.map((option) => ({ value: String(option.id), label: option.name }))]} />;
}

function DraftNameSelect({ value, options, placeholder, onChange, autoOpen = false }: { value: string; options: GridOption[]; placeholder: string; onChange: (value: string) => void; autoOpen?: boolean }) {
  return <CustomSelect className="ag-custom-select" value={value} ariaLabel={placeholder} onChange={onChange} autoOpen={autoOpen} options={[{ value: "", label: placeholder }, ...options.map((option) => ({ value: option.name, label: option.name }))]} />;
}

function EmployeeTextEditor({ value, onChange, focusOnMount = true, placeholder = "ФИО сотрудника" }: { value: string; onChange: (value: string) => void; focusOnMount?: boolean; placeholder?: string }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusOnMount) { input.current?.focus(); input.current?.select(); } }, [focusOnMount]);
  return <input ref={input} className="ag-inline-control" defaultValue={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />;
}

function normalizeSearch(value: string) {
  return value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim().replace(/\s+/g, " ");
}

function EmployeeCombobox({ value, employees, onChange }: { value: string; employees: GridEmployee[]; onChange: (employeeQuery: string, employeeId: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 360 });
  const query = normalizeSearch(inputValue);
  const filtered = useMemo(() => employees.filter((employee) => normalizeSearch(`${employee.fullName} ${employee.employmentType} ${employee.department} ${employee.position}`).includes(query)).slice(0, 50), [employees, query]);

  const updatePosition = useCallback(() => {
    const input = root.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    const menuHeight = Math.min(292, 46 + filtered.length * 52);
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow >= Math.min(menuHeight, 190) ? rect.bottom + 5 : Math.max(8, rect.top - menuHeight - 5);
    setPosition({ top, left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(360, rect.width) - 8)), width: Math.max(360, rect.width) });
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", close);
    };
  }, [open, updatePosition]);

  function select(employee: GridEmployee) {
    setInputValue(employee.fullName);
    onChange(employee.fullName, String(employee.id));
    setOpen(false);
  }

  return <div className="ag-employee-combobox" ref={root}>
    <input
      className="ag-inline-control"
      value={inputValue}
      placeholder="Начните вводить ФИО"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls="employee-search-options"
      onFocus={() => setOpen(true)}
      onClick={() => setOpen(true)}
      onChange={(event) => {
        const employeeQuery = event.target.value;
        setInputValue(employeeQuery);
        setActiveIndex(0);
        setOpen(true);
      }}
      onBlur={() => {
        if (inputValue === value) return;
        const exact = employees.find((employee) => normalizeSearch(employee.fullName) === normalizeSearch(inputValue));
        onChange(inputValue, exact ? String(exact.id) : "");
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.min(index + 1, filtered.length - 1)); }
        if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
        if (event.key === "Enter" && open && filtered[activeIndex]) { event.preventDefault(); select(filtered[activeIndex]); }
        if (event.key === "Escape") setOpen(false);
      }}
    />
    <span className="ag-combobox-chevron" aria-hidden="true">⌄</span>
    {open && typeof document !== "undefined" && createPortal(<div id="employee-search-options" ref={menu} className="ag-employee-menu" role="listbox" style={position}>
      <div className="ag-employee-menu-caption">{query ? `Найдено: ${filtered.length}` : "Начните вводить имя или выберите сотрудника"}</div>
      <div className="ag-employee-options">
        {filtered.map((employee, index) => <button key={employee.id} type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "active" : ""} onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => select(employee)}><strong>{employee.fullName}</strong><span>{employee.employmentType} · {employee.department} · {employee.position}</span></button>)}
        {!filtered.length && <p>Сотрудники не найдены</p>}
      </div>
    </div>, document.body)}
  </div>;
}

export function PlacementAgGrid(props: PlacementGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<PlacementRow> | null>(null);
  const selectedIdsKey = props.pendingDeletes.join("|");
  const editingStructureKey = props.editing.map((item) => item.id).join("|");
  const manualDraftCount = props.draftRows.filter((row) => !row.lockedEmployee).length;
  const previousManualDraftCount = useRef(manualDraftCount);
  const editingById = useMemo(() => new Map(props.editing.map((item) => [item.id, item.row])), [props.editing]);
  const rowData = useMemo<PlacementRow[]>(() => {
    const rows: PlacementRow[] = [
      ...props.entries.map((entry, index) => {
      const edited = editingById.get(entry.id);
      return edited
        ? { rowKey: `entry-${entry.id}`, kind: "edit" as const, number: index + 1, entry, draft: edited }
        : { rowKey: `entry-${entry.id}`, kind: "entry" as const, number: index + 1, entry };
      }),
      ...props.draftRows.map((draft, index) => ({ rowKey: `draft-${draft.key}`, kind: "draft" as const, number: props.entries.length + index + 1, draft })),
    ];
    if (!props.rosterMode) return rows;
    return rows
      .sort((left, right) => {
        const leftIsExtra = left.kind === "draft" && !left.draft?.lockedEmployee;
        const rightIsExtra = right.kind === "draft" && !right.draft?.lockedEmployee;
        if (leftIsExtra !== rightIsExtra) return leftIsExtra ? 1 : -1;
        return String(placementValue(left, "employeeName", props)).localeCompare(String(placementValue(right, "employeeName", props)), "ru");
      })
      .map((row, index) => ({ ...row, number: index + 1 }));
  }, [editingById, props]);

  useEffect(() => {
    if (gridApi.current && props.draftRows.length && !props.rosterMode) {
      requestAnimationFrame(() => {
        const api = gridApi.current;
        if (api && !api.isDestroyed() && api.getDisplayedRowCount() > 0) api.ensureIndexVisible(api.getDisplayedRowCount() - 1, "bottom");
      });
    }
  }, [props.draftRows.length, props.rosterMode, rowData]);

  useEffect(() => {
    if (!props.rosterMode) return;
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.ensureColumnVisible("employeeName", "start");
    });
  }, [props.rosterMode]);

  useEffect(() => {
    const addedManualRow = manualDraftCount > previousManualDraftCount.current;
    previousManualDraftCount.current = manualDraftCount;
    if (!props.rosterMode || !addedManualRow) return;
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (api && !api.isDestroyed() && api.getDisplayedRowCount() > 0) api.ensureIndexVisible(api.getDisplayedRowCount() - 1, "bottom");
    });
  }, [manualDraftCount, props.rosterMode, rowData]);

  useEffect(() => {
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.refreshClientSideRowModel("everything");
      api.refreshCells({ force: true });
      api.redrawRows();
    });
  }, [editingStructureKey, props.draftRows.length]);

  useEffect(() => {
    const selected = new Set(props.pendingDeletes);
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(node.data?.entry && node.data.kind === "entry" && selected.has(node.data.entry.id))));
    });
    // selectedIdsKey intentionally tracks changes without depending on a newly created array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdsKey]);

  const patchRow = useCallback((row: PlacementRow, changes: Partial<GridDraftRow>) => {
    if (row.kind === "edit" && row.entry) props.onPatchEditing(row.entry.id, changes);
    if (row.kind === "draft" && row.draft) props.onPatchDraft(row.draft.key, changes);
  }, [props]);

  const editableRenderer = useCallback((params: CustomCellRendererProps<PlacementRow>) => {
    const row = params.data;
    if (!row) return null;
    if (row.kind === "entry") {
      return params.colDef.field === "hours" ? <strong>{params.value}</strong> : <span title={String(params.value ?? "")}>{params.value || "—"}</span>;
    }
    const draft = row.draft;
    if (!draft) return null;
    const field = params.colDef.field;
    if (field === "employeeName") return draft.lockedEmployee
      ? <span className="ag-roster-employee" title={draft.employeeQuery}>{draft.employeeQuery}</span>
      : <EmployeeCombobox value={draft.employeeQuery} employees={props.employees} onChange={(employeeQuery, employeeId) => patchRow(row, { employeeQuery, employeeId })} />;
    if (field === "shift") return <DraftSelect value={draft.shiftId} options={props.shifts} placeholder="Смена" onChange={(shiftId) => patchRow(row, { shiftId })} />;
    if (field === "zone") return <DraftSelect value={draft.zoneId} options={props.zones} placeholder="Зона" onChange={(zoneId) => patchRow(row, { zoneId })} />;
    if (field === "mainWork") return <DraftSelect value={draft.mainWorkTypeId} options={props.mainWorkTypes} placeholder="Работа" onChange={(mainWorkTypeId) => patchRow(row, { mainWorkTypeId })} />;
    if (field === "subwork") return <DraftSelect value={draft.subworkTypeId} options={props.subworkTypes} placeholder="Вид подработ" onChange={(subworkTypeId) => patchRow(row, { subworkTypeId })} />;
    if (field === "master") return <DraftSelect value={draft.masterId} options={props.masters} placeholder="Мастер" onChange={(masterId) => patchRow(row, { masterId })} />;
    if (field === "hours") return <CustomSelect className="ag-custom-select" value={draft.hours} ariaLabel="Часы" onChange={(hours) => patchRow(row, { hours })} options={[{ value: "", label: "—" }, ...Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))]} />;
    if (field === "note") return <input className="ag-inline-control" value={draft.note} placeholder="Необязательно" onChange={(event) => patchRow(row, { note: event.target.value })} />;
    return <span className="ag-autofill-value">{params.value}</span>;
  }, [patchRow, props]);

  const { employees, shifts, zones, mainWorkTypes, subworkTypes, masters, onEdit } = props;
  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<PlacementRow>) => {
    if (row.kind !== "entry" && !row.draft) return false;
    if (row.kind === "entry" && propsRef.current.draftRows.length) return false;
    const changes: Partial<GridDraftRow> = {};
    if (values.employeeName !== undefined && !row.draft?.lockedEmployee) {
      const employee = employees.find((item) => normalizeSearch(item.fullName) === normalizeSearch(values.employeeName));
      changes.employeeQuery = values.employeeName;
      changes.employeeId = employee ? String(employee.id) : "";
    }
    if (values.shift !== undefined) changes.shiftId = pastedOptionId(shifts, values.shift);
    if (values.zone !== undefined) changes.zoneId = pastedOptionId(zones, values.zone);
    if (values.mainWork !== undefined) changes.mainWorkTypeId = pastedOptionId(mainWorkTypes, values.mainWork);
    if (values.subwork !== undefined) changes.subworkTypeId = pastedOptionId(subworkTypes, values.subwork);
    if (values.master !== undefined) changes.masterId = pastedOptionId(masters, values.master);
    if (values.hours !== undefined) changes.hours = values.hours.trim();
    if (values.note !== undefined) changes.note = values.note;
    if (!Object.keys(changes).length) return false;
    if (row.kind === "entry" && row.entry) onEdit(row.entry, changes);
    else patchRow(row, changes);
    return true;
  }, [employees, mainWorkTypes, masters, onEdit, patchRow, propsRef, shifts, subworkTypes, zones]);

  const valueGetter = useCallback((field: string) => (params: { data?: PlacementRow }) => params.data ? placementValue(params.data, field, props) : "", [props]);
  const columns = useMemo<ColDef<PlacementRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, lockPosition: "left", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "employeeName", headerName: "ФИО", minWidth: 220, flex: 2.2, pinned: props.rosterMode ? "left" : undefined, lockPinned: props.rosterMode, lockPosition: props.rosterMode ? "left" : undefined, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employeeName"), cellRenderer: editableRenderer },
    { field: "employmentType", headerName: "Тип", minWidth: 116, flex: .7, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer: editableRenderer },
    { field: "department", headerName: "Отдел", minWidth: 129, flex: .8, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer: editableRenderer },
    { field: "position", headerName: "Должность", minWidth: 162, flex: 1.8, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer: editableRenderer },
    { field: "shift", headerName: "Смена", minWidth: 129, flex: .8, headerComponentParams: pinnableHeader, valueGetter: valueGetter("shift"), cellRenderer: editableRenderer },
    { field: "zone", headerName: "Зона", minWidth: 121, flex: 1.1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("zone"), cellRenderer: editableRenderer },
    { field: "mainWork", headerName: "Работа", minWidth: 137, flex: 1.8, headerComponentParams: pinnableHeader, valueGetter: valueGetter("mainWork"), cellRenderer: editableRenderer },
    { field: "subwork", headerName: "Вид подработ", minWidth: 193, flex: 1.7, headerComponentParams: pinnableHeader, valueGetter: valueGetter("subwork"), cellRenderer: editableRenderer },
    { field: "master", headerName: "Мастер", minWidth: 137, flex: 1.5, headerComponentParams: pinnableHeader, valueGetter: valueGetter("master"), cellRenderer: editableRenderer },
    { field: "hours", headerName: "Часы", minWidth: 121, flex: .7, headerComponentParams: pinnableHeader, filter: personnelColumnFilter, filterParams: { ...personnelFilterParams, kind: "number" }, valueGetter: valueGetter("hours"), cellRenderer: editableRenderer },
    { field: "note", headerName: "Примечание", minWidth: 169, flex: 1.3, headerComponentParams: pinnableHeader, valueGetter: valueGetter("note"), cellRenderer: editableRenderer },
  ], [editableRenderer, props.rosterMode, valueGetter]);

  const reportVisibleRows = useCallback((api: GridApi<PlacementRow>) => {
    const ids: number[] = [];
    api.forEachNodeAfterFilterAndSort((node) => {
      if (node.data?.entry?.id) ids.push(node.data.entry.id);
    });
    props.onVisibleEntryIdsChange(ids);
  }, [props]);

  const defaultColDef = useMemo<ColDef<PlacementRow>>(() => ({
    filter: personnelColumnFilter, filterParams: personnelFilterParams,
    floatingFilter: false,
    resizable: true,
    sortable: true,
    suppressHeaderMenuButton: true,
    suppressHeaderFilterButton: true,
    suppressMovable: true,
  }), []);

  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-placement-grid"><LocalizedGrid<PlacementRow>
    theme={gridTheme}
    rowData={rowData}
    columnDefs={columns}
    defaultColDef={defaultColDef}
    getRowId={(params: GetRowIdParams<PlacementRow>) => params.data.rowKey}
    rowHeight={50}
    headerHeight={48}
    loading={props.loading}
    loadingOverlayComponent={() => <span className="ag-overlay-message">Загружаем отчёт…</span>}
    noRowsOverlayComponent={() => <span className="ag-overlay-message">Записей пока нет</span>}
    rowClassRules={{
      "editable-row": (params) => params.data?.kind === "edit" || params.data?.kind === "draft",
      "carried-row": (params) => Boolean(params.data?.draft?.carriedFromPreviousDay),
    }}
    rowSelection={{ mode: "multiRow", checkboxes: (params) => !propsRef.current.rosterMode && propsRef.current.canEdit && propsRef.current.draftRows.length === 0 && propsRef.current.editing.length === 0 && params.data?.kind === "entry", headerCheckbox: !props.rosterMode && props.draftRows.length === 0 && props.editing.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => !propsRef.current.rosterMode && propsRef.current.canEdit && propsRef.current.draftRows.length === 0 && propsRef.current.editing.length === 0 && node.data?.kind === "entry" }}
    selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }}
    onGridReady={(event: GridReadyEvent<PlacementRow>) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }}
    onGridSizeChanged={(event) => event.api.sizeColumnsToFit()}
    onColumnResized={keepGridFilled}
    onModelUpdated={(event) => reportVisibleRows(event.api)}
    onFilterChanged={(event) => reportVisibleRows(event.api)}
    onSortChanged={(event) => reportVisibleRows(event.api)}
    onSelectionChanged={(event) => propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.entry?.id ? [row.entry.id] : []))}
    onRowDoubleClicked={(event) => { const row = event.data; if (!props.rosterMode && props.canEdit && props.draftRows.length === 0 && row?.kind === "entry" && row.entry && !props.pendingDeletes.includes(row.entry.id) && canOpenRowEditor(event.event)) props.onEdit(row.entry); }}
    onSpreadsheetPaste={pasteIntoRow}
    suppressCellFocus
  /></div></AgGridProvider>;
}

type EmployeeTableRow = {
  rowKey: string;
  kind: "entry" | "edit" | "draft";
  number: number;
  employee?: GridEmployee;
  draft?: GridEmployeeDraft;
};

type EmployeeGridProps = {
  rows: GridEmployee[];
  drafts: GridEmployeeDraft[];
  employmentTypes: GridOption[];
  departments: GridOption[];
  positions: GridOption[];
  sites: GridOption[];
  selectedIds: number[];
  fullRowEditIds: number[];
  onEdit: (employee: GridEmployee, changes?: Partial<GridEmployeeDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridEmployeeDraft>) => void;
  onCancelDraft: (key: string) => void;
  onVisibleIdsChange: (ids: number[]) => void;
  onValidationError: (message: string) => void;
};

// Kept as a reversible switch in case per-row cancellation is needed again.
const showEmployeeRowCancelActions = false;

export function EmployeeAgGrid(props: EmployeeGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<EmployeeTableRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<{ rowKey: string; field: string } | null>(null);
  const draftStructureKey = props.drafts.map((draft) => draft.id ? `edit-${draft.id}` : draft.key).join("|");
  const draftValuesKey = props.drafts.map((draft) => `${draft.key}:${draft.employmentType}:${draft.department}:${draft.position}:${draft.projectSiteId}`).join("|");
  const selectedIdsKey = props.selectedIds.join("|");
  const newDraftCount = props.drafts.filter((draft) => !draft.id).length;
  useEffect(() => { requestAnimationFrame(() => {
    const api = gridApi.current;
    if (!api || api.isDestroyed()) return;
    api.refreshClientSideRowModel("everything");
    api.refreshCells({ force: true });
    api.redrawRows();
  }); }, [draftStructureKey, draftValuesKey]);
  const rowData = useMemo<EmployeeTableRow[]>(() => [
    ...props.rows.map((employee, index) => {
      const draft = props.drafts.find((candidate) => candidate.id === employee.id);
      return draft
        ? { rowKey: `employee-${employee.id}`, kind: "edit" as const, number: index + 1, employee, draft }
        : { rowKey: `employee-${employee.id}`, kind: "entry" as const, number: index + 1, employee };
    }),
    ...props.drafts.filter((draft) => !draft.id).map((draft, index) => ({ rowKey: `employee-new-${draft.key}`, kind: "draft" as const, number: props.rows.length + index + 1, draft })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [draftStructureKey, props.rows]);
  useEffect(() => {
    if (!newDraftCount) return;
    requestAnimationFrame(() => { const api = gridApi.current; if (api && !api.isDestroyed() && api.getDisplayedRowCount()) api.ensureIndexVisible(api.getDisplayedRowCount() - 1, "bottom"); });
  }, [draftStructureKey, newDraftCount]);
  useEffect(() => {
    if (props.drafts.length) return;
    const frame = requestAnimationFrame(() => setActiveEditor(null));
    return () => cancelAnimationFrame(frame);
  }, [props.drafts.length]);
  useEffect(() => {
    const selected = new Set(props.selectedIds);
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(node.data?.employee && selected.has(node.data.employee.id))));
    });
    // selectedIdsKey intentionally tracks changes without depending on a newly created array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdsKey]);

  const editableRenderer = useCallback((params: CustomCellRendererProps<EmployeeTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const field = params.colDef.field;
    const currentProps = propsRef.current;
    const activeCellEditor = Boolean(field && activeEditor?.rowKey === row.rowKey && activeEditor.field === field && row.draft);
    const fullRowEditor = Boolean(row.draft && (row.kind === "draft" || (row.draft.id && currentProps.fullRowEditIds.includes(row.draft.id))));
    const editorOpen = activeCellEditor || fullRowEditor;
    if (!editorOpen) {
      const value = field === "siteName" ? params.value || "Не назначен" : params.value;
      return <span title={String(value ?? "")}>{value}</span>;
    }
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft!;
    if (field === "fullName") return <div className="ag-cell-editor-host"><EmployeeTextEditor focusOnMount={activeCellEditor} value={draft.fullName} onChange={(fullName) => currentProps.onPatchDraft(draft.key, { fullName })} /></div>;
    if (field === "employmentType") return <div className="ag-cell-editor-host"><DraftNameSelect autoOpen={activeCellEditor} value={draft.employmentType} options={currentProps.employmentTypes} placeholder="Тип" onChange={(employmentType) => currentProps.onPatchDraft(draft.key, { employmentType })} /></div>;
    if (field === "department") return <div className="ag-cell-editor-host"><DraftNameSelect autoOpen={activeCellEditor} value={draft.department} options={currentProps.departments} placeholder="Отдел" onChange={(department) => currentProps.onPatchDraft(draft.key, { department })} /></div>;
    if (field === "position") return <div className="ag-cell-editor-host"><DraftNameSelect autoOpen={activeCellEditor} value={draft.position} options={currentProps.positions} placeholder="Должность" onChange={(position) => currentProps.onPatchDraft(draft.key, { position })} /></div>;
    if (field === "siteName") return <div className="ag-cell-editor-host"><DraftSelect autoOpen={activeCellEditor} value={draft.projectSiteId} options={currentProps.sites} placeholder="Проект" onChange={(projectSiteId) => currentProps.onPatchDraft(draft.key, { projectSiteId })} /></div>;
    return <span>{params.value}</span>;
  }, [activeEditor, propsRef]);

  const editActionRenderer = useCallback((params: CustomCellRendererProps<EmployeeTableRow>) => {
    const row = params.data;
    if (!row || row.kind === "entry") return null;
    return <div className="row-actions"><button type="button" onClick={() => propsRef.current.onCancelDraft(row.draft!.key)} title={row.draft?.id ? "Отменить изменения строки" : "Удалить несохранённую строку"} aria-label={row.draft?.id ? `Отменить изменения ${row.employee?.fullName ?? row.draft.fullName}` : "Удалить несохранённую строку"}><GridIcon name={row.draft?.id ? "back" : "trash"} /></button></div>;
  }, [propsRef]);

  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<EmployeeTableRow>) => {
    const currentProps = propsRef.current;
    if (row.employee?.source === "bitrix24") { currentProps.onValidationError("Данные сотрудника из Битрикс24 изменяются только через актуализацию."); return false; }
    if (row.kind === "entry" && currentProps.drafts.some((draft) => !draft.id)) return false;
    const changes: Partial<GridEmployeeDraft> = {};
    if (values.fullName !== undefined) {
      const fullName = values.fullName.trim();
      if (!fullName) { currentProps.onValidationError("ФИО сотрудника не может быть пустым."); return false; }
      changes.fullName = fullName;
    }
    if (values.employmentType !== undefined) {
      const employmentType = pastedOptionName(currentProps.employmentTypes, values.employmentType);
      if (!employmentType) { currentProps.onValidationError(`Значение «${values.employmentType}» нельзя вставить в столбец «Тип». Выберите существующий тип.`); return false; }
      changes.employmentType = employmentType;
    }
    if (values.department !== undefined) {
      const department = pastedOptionName(currentProps.departments, values.department);
      if (!department) { currentProps.onValidationError(`Значение «${values.department}» нельзя вставить в столбец «Отдел». Выберите существующий отдел.`); return false; }
      changes.department = department;
    }
    if (values.position !== undefined) {
      const position = pastedOptionName(currentProps.positions, values.position);
      if (!position) { currentProps.onValidationError(`Значение «${values.position}» нельзя вставить в столбец «Должность». Выберите существующую должность.`); return false; }
      changes.position = position;
    }
    if (values.siteName !== undefined) {
      const projectSiteId = pastedOptionId(currentProps.sites, values.siteName);
      if (!projectSiteId) { currentProps.onValidationError(`Значение «${values.siteName}» нельзя вставить в столбец «Проект». Выберите существующий проект.`); return false; }
      changes.projectSiteId = projectSiteId;
    }
    if (!Object.keys(changes).length) return false;
    if (row.kind === "entry" && row.employee) currentProps.onEdit(row.employee, changes);
    else if (row.draft) {
      const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
      currentProps.onPatchDraft(draft.key, changes);
    } else return false;
    return true;
  }, [propsRef]);

  const valueGetter = useCallback((field: keyof GridEmployee | "number") => (params: { data?: EmployeeTableRow }) => {
    const row = params.data;
    if (!row) return "";
    if (field === "number") return row.number;
    if (row.kind === "entry" || field === "bitrix24Stage" || field === "availabilityStatus" || field === "syncError") return row.employee?.[field] ?? "";
    const draft = propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    if (field === "siteName") return propsRef.current.sites.find((site) => site.id === Number(draft?.projectSiteId))?.name ?? "";
    return draft?.[field as keyof GridEmployeeDraft] ?? "";
  }, [propsRef]);

  const columns = useMemo<ColDef<EmployeeTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, lockPosition: "left", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "fullName", headerName: "ФИО", minWidth: 230, flex: 1.4, headerComponentParams: pinnableHeader, valueGetter: valueGetter("fullName"), cellRenderer: editableRenderer },
    { field: "employmentType", headerName: "Тип", minWidth: 120, flex: .55, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer: editableRenderer },
    { field: "department", headerName: "Отдел", minWidth: 150, flex: .7, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer: editableRenderer },
    { field: "position", headerName: "Должность", minWidth: 220, flex: 1.4, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer: editableRenderer },
    { field: "siteName", headerName: "Проект", minWidth: 190, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("siteName"), cellRenderer: editableRenderer },
    { field: "bitrix24Stage", headerName: "Стадия в Битрикс24", minWidth: 210, flex: 1.15, headerComponentParams: pinnableHeader, valueGetter: valueGetter("bitrix24Stage"),
      cellRenderer: (params: CustomCellRendererProps<EmployeeTableRow>) => <span title={params.data?.employee?.syncError ?? String(params.value ?? "")}>{params.value}{params.data?.employee?.syncError ? " ⚠" : ""}</span> },
    ...(showEmployeeRowCancelActions && props.drafts.length ? [{ colId: "actions", headerName: "", width: 52, minWidth: 52, maxWidth: 52, pinned: "right" as const, lockPinned: true, lockPosition: "right" as const, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, floatingFilter: false, cellClass: "actions-cell", cellRenderer: editActionRenderer }] : []),
  ], [editActionRenderer, editableRenderer, props.drafts.length, valueGetter]);

  const reportVisibleRows = useCallback((api: GridApi<EmployeeTableRow>) => {
    const ids: number[] = [];
    api.forEachNodeAfterFilterAndSort((node) => { if (node.data?.employee?.id) ids.push(node.data.employee.id); });
    propsRef.current.onVisibleIdsChange(ids);
  }, [propsRef]);

  const defaultColDef = useMemo<ColDef<EmployeeTableRow>>(() => ({ filter: personnelColumnFilter, filterParams: personnelFilterParams, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true }), []);
  return <AgGridProvider modules={modules}><div className="employee-performance-frame">
    <div className="employee-performance-main">
      <div className="ag-grid-shell ag-admin-grid ag-employee-grid"><LocalizedGrid<EmployeeTableRow>
        theme={gridTheme}
        rowData={rowData}
        columnDefs={columns}
        defaultColDef={defaultColDef}
        getRowId={(params) => params.data.rowKey}
        rowHeight={46}
        headerHeight={44}
        animateRows
        rowClassRules={{ "editable-row": (params) => Boolean(params.data?.draft && (params.data.kind === "draft" || (params.data.draft.id && propsRef.current.fullRowEditIds.includes(params.data.draft.id)))) }}
        rowSelection={{ mode: "multiRow", checkboxes: (params) => propsRef.current.drafts.length === 0 && params.data?.kind === "entry" && params.data.employee?.source !== "bitrix24", headerCheckbox: props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => propsRef.current.drafts.length === 0 && node.data?.kind === "entry" && node.data.employee?.source !== "bitrix24" }}
        selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }}
        onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }}
        onGridSizeChanged={(event) => event.api.sizeColumnsToFit()}
        onColumnResized={keepGridFilled}
        onModelUpdated={(event) => reportVisibleRows(event.api)}
        onFilterChanged={(event) => reportVisibleRows(event.api)}
        onSortChanged={(event) => reportVisibleRows(event.api)}
        onSelectionChanged={(event) => propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.employee?.id ? [row.employee.id] : []))}
        onCellMouseDown={(event) => {
          if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return;
          const rowKey = event.data?.rowKey;
          const field = event.column.getColDef().field;
          if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null);
        }}
        onCellDoubleClicked={(event) => {
          const row = event.data;
          const field = event.column.getColDef().field;
          if (newDraftCount > 0 || !row || row.employee?.source === "bitrix24" || !field || !["fullName", "employmentType", "department", "position", "siteName"].includes(field) || isInteractiveGridTarget(event.event)) return;
          if (row.kind === "entry" && row.employee) propsRef.current.onEdit(row.employee);
          setActiveEditor({ rowKey: row.rowKey, field });
        }}
        onSpreadsheetPaste={pasteIntoRow}
        spreadsheetSelectionResetKey={`${draftStructureKey}:${props.fullRowEditIds.join("|")}:${activeEditor?.rowKey ?? ""}:${activeEditor?.field ?? ""}`}
        suppressCellFocus
      /></div>
    </div>
  </div></AgGridProvider>;
}

type ProjectEmployeeTableRow = { rowKey: string; kind: "entry" | "draft"; number: number; employee?: GridEmployee; draft?: GridProjectEmployeeDraft; pending?: boolean };
type ProjectEmployeeGridProps = {
  rows: GridEmployee[];
  allEmployees: GridEmployee[];
  drafts: GridProjectEmployeeDraft[];
  pendingDeletes: number[];
  readOnly?: boolean;
  onPatchDraft: (key: string, changes: Partial<GridProjectEmployeeDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
};

export function ProjectEmployeeAgGrid(props: ProjectEmployeeGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<ProjectEmployeeTableRow> | null>(null);
  const draftStructureKey = props.drafts.map((draft) => draft.key).join("|");
  const draftEmployeeIds = props.drafts.map((draft) => `${draft.key}:${draft.employeeId}`).join("|");
  const selectedIdsKey = props.pendingDeletes.join("|");
  const rowData = useMemo<ProjectEmployeeTableRow[]>(() => [
    ...props.rows.map((employee, index) => ({ rowKey: `project-employee-${employee.id}`, kind: "entry" as const, number: index + 1, employee, pending: props.pendingDeletes.includes(employee.id) })),
    ...props.drafts.map((draft, index) => ({ rowKey: `project-employee-new-${draft.key}`, kind: "draft" as const, number: props.rows.length + index + 1, draft })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [draftStructureKey, props.pendingDeletes, props.rows]);
  useEffect(() => { requestAnimationFrame(() => {
    const api = gridApi.current;
    if (!api || api.isDestroyed()) return;
    api.refreshClientSideRowModel("everything");
    api.refreshCells({ force: true });
    api.redrawRows();
  }); }, [draftEmployeeIds, draftStructureKey]);
  useEffect(() => {
    if (!props.drafts.length) return;
    requestAnimationFrame(() => { const api = gridApi.current; if (api && !api.isDestroyed() && api.getDisplayedRowCount()) api.ensureIndexVisible(api.getDisplayedRowCount() - 1, "bottom"); });
  }, [draftStructureKey, props.drafts.length]);
  useEffect(() => {
    const selected = new Set(props.pendingDeletes);
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(node.data?.employee && selected.has(node.data.employee.id))));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdsKey]);
  const availableEmployeesFor = useCallback((draftKey: string) => {
    const assigned = new Set(propsRef.current.rows.map((employee) => employee.id));
    propsRef.current.drafts.forEach((draft) => { if (draft.key !== draftKey && draft.employeeId) assigned.add(Number(draft.employeeId)); });
    return propsRef.current.allEmployees.filter((employee) => !assigned.has(employee.id));
  }, [propsRef]);
  const valueGetter = useCallback((field: "number" | "fullName" | "employmentType" | "department" | "position") => (params: { data?: ProjectEmployeeTableRow }) => {
    const row = params.data;
    if (!row) return "";
    if (field === "number") return row.number;
    const draft = row.kind === "draft" ? propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft : undefined;
    const employee = row.kind === "entry" ? row.employee : propsRef.current.allEmployees.find((item) => item.id === Number(draft?.employeeId));
    if (field === "fullName") return row.kind === "draft" ? draft?.employeeQuery ?? "" : employee?.fullName ?? "";
    return employee?.[field] ?? "—";
  }, [propsRef]);
  const cellRenderer = useCallback((params: CustomCellRendererProps<ProjectEmployeeTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const draft = row.kind === "draft" ? propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft : undefined;
    if (draft && params.colDef.field === "fullName") return <EmployeeCombobox value={draft.employeeQuery} employees={availableEmployeesFor(draft.key)} onChange={(employeeQuery, employeeId) => propsRef.current.onPatchDraft(draft.key, { employeeQuery, employeeId })} />;
    return <span className={row.kind === "draft" ? "ag-autofill-value" : undefined} title={String(params.value ?? "")}>{params.value}</span>;
  }, [availableEmployeesFor, propsRef]);
  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<ProjectEmployeeTableRow>) => {
    if (propsRef.current.readOnly) return false;
    if (row.kind !== "draft" || values.fullName === undefined) return false;
    const currentProps = propsRef.current;
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    const employee = availableEmployeesFor(draft.key).find((item) => normalizeSearch(item.fullName) === normalizeSearch(values.fullName));
    currentProps.onPatchDraft(draft.key, { employeeQuery: values.fullName, employeeId: employee ? String(employee.id) : "" });
    return true;
  }, [availableEmployeesFor, propsRef]);
  const columns = useMemo<ColDef<ProjectEmployeeTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "fullName", headerName: "ФИО", minWidth: 260, flex: 1.5, headerComponentParams: pinnableHeader, valueGetter: valueGetter("fullName"), cellRenderer },
    { field: "employmentType", headerName: "Тип", minWidth: 116, flex: .6, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer },
    { field: "department", headerName: "Отдел", minWidth: 129, flex: .75, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer },
    { field: "position", headerName: "Должность", minWidth: 220, flex: 1.35, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer },
  ], [cellRenderer, valueGetter]);
  const defaultColDef = useMemo<ColDef<ProjectEmployeeTableRow>>(() => ({ filter: personnelColumnFilter, filterParams: personnelFilterParams, floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><LocalizedGrid<ProjectEmployeeTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={50} headerHeight={48} rowClassRules={{ "editable-row": (params) => params.data?.kind === "draft" }} rowSelection={{ mode: "multiRow", checkboxes: (params) => !propsRef.current.readOnly && propsRef.current.drafts.length === 0 && params.data?.kind === "entry" && params.data.employee?.source !== "bitrix24", headerCheckbox: !props.readOnly && props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => !propsRef.current.readOnly && propsRef.current.drafts.length === 0 && node.data?.kind === "entry" && node.data.employee?.source !== "bitrix24" }} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onSelectionChanged={(event) => { if (!propsRef.current.readOnly) propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.employee?.id ? [row.employee.id] : [])); }} onSpreadsheetPaste={pasteIntoRow} suppressCellFocus /></div></AgGridProvider>;
}

type DirectoryTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; item?: GridOption; draft?: GridDirectoryDraft; pending?: boolean };
type DirectoryGridProps = {
  title: string;
  rows: GridOption[];
  drafts: GridDirectoryDraft[];
  employees?: GridEmployee[];
  selectEmployee?: boolean;
  pendingDeletes: number[];
  readOnly?: boolean;
  onEdit: (item: GridOption) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridDirectoryDraft>) => void;
};

export function DirectoryAgGrid(props: DirectoryGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<DirectoryTableRow> | null>(null);
  const draftStructureKey = props.drafts.map((draft) => draft.id ? `edit-${draft.id}` : draft.key).join("|");
  const draftEmployeeIds = props.drafts.map((draft) => `${draft.key}:${draft.employeeId ?? ""}`).join("|");
  const newDraftCount = props.drafts.filter((draft) => !draft.id).length;
  const selectedIdsKey = props.pendingDeletes.join("|");
  useEffect(() => { requestAnimationFrame(() => {
    const api = gridApi.current;
    if (!api || api.isDestroyed()) return;
    api.refreshClientSideRowModel("everything");
    api.refreshCells({ force: true });
    api.redrawRows();
  }); }, [draftEmployeeIds, draftStructureKey]);
  const rowData = useMemo<DirectoryTableRow[]>(() => [
    ...props.rows.map((item, index) => {
      const draft = props.drafts.find((candidate) => candidate.id === item.id);
      return draft
      ? { rowKey: `directory-${item.id}`, kind: "edit" as const, number: index + 1, item, draft, pending: false }
      : { rowKey: `directory-${item.id}`, kind: "entry" as const, number: index + 1, item, pending: props.pendingDeletes.includes(item.id) };
    }),
    ...props.drafts.filter((draft) => !draft.id).map((draft, index) => ({ rowKey: `directory-new-${draft.key}`, kind: "draft" as const, number: props.rows.length + index + 1, draft })),
  // Keep the draft row object stable while a user types. Replacing rowData on every
  // keystroke makes AG Grid recreate the renderer and drops characters/focus.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [draftStructureKey, props.pendingDeletes, props.rows]);
  useEffect(() => {
    if (!newDraftCount) return;
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (api && !api.isDestroyed() && api.getDisplayedRowCount()) api.ensureIndexVisible(api.getDisplayedRowCount() - 1, "bottom");
    });
  }, [draftStructureKey, newDraftCount]);
  useEffect(() => {
    const selected = new Set(props.pendingDeletes);
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(node.data?.item && node.data.kind === "entry" && selected.has(node.data.item.id))));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdsKey]);
  const valueGetter = useCallback((field: "number" | "name" | "employmentType" | "department" | "position") => (params: { data?: DirectoryTableRow }) => {
    const row = params.data;
    if (!row) return "";
    if (field === "number") return row.number;
    const draft = row.kind === "entry" ? undefined : propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    const name = row.kind === "entry" ? row.item?.name ?? "" : draft?.name ?? "";
    if (field === "name") return name;
    const employeeId = draft?.employeeId;
    const employee = (propsRef.current.employees ?? []).find((candidate) => employeeId ? candidate.id === Number(employeeId) : normalizeSearch(candidate.fullName) === normalizeSearch(name));
    return employee?.[field] ?? "—";
  }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<DirectoryTableRow>) => {
    const row = params.data;
    if (!row) return null;
    if (row.kind === "entry") return <span title={String(params.value ?? "")}>{params.value}</span>;
    const draft = propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    if (!draft) return null;
    if (propsRef.current.selectEmployee && params.colDef.field === "name") return <EmployeeCombobox value={draft.name} employees={propsRef.current.employees ?? []} onChange={(name, employeeId) => propsRef.current.onPatchDraft(draft.key, { name, employeeId })} />;
    if (propsRef.current.selectEmployee) return <span className="ag-autofill-value" title={String(params.value ?? "")}>{params.value}</span>;
    return <input className="ag-inline-control" defaultValue={draft.name} placeholder={`Название: ${propsRef.current.title.toLocaleLowerCase("ru-RU")}`} onChange={(event) => propsRef.current.onPatchDraft(draft.key, { name: event.target.value })} />;
  }, [propsRef]);
  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<DirectoryTableRow>) => {
    if (propsRef.current.readOnly) return false;
    if (row.kind === "entry" || !row.draft || values.name === undefined) return false;
    const currentProps = propsRef.current;
    if (currentProps.selectEmployee) {
      const employee = (currentProps.employees ?? []).find((item) => normalizeSearch(item.fullName) === normalizeSearch(values.name));
      currentProps.onPatchDraft(row.draft.key, { name: values.name, employeeId: employee ? String(employee.id) : "" });
    } else currentProps.onPatchDraft(row.draft.key, { name: values.name });
    return true;
  }, [propsRef]);
  const columns = useMemo<ColDef<DirectoryTableRow>[]>(() => {
    const numberColumn: ColDef<DirectoryTableRow> = { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") };
    if (props.selectEmployee) return [
      numberColumn,
      { field: "name", headerName: "ФИО", minWidth: 250, flex: 1.5, headerComponentParams: pinnableHeader, valueGetter: valueGetter("name"), cellRenderer: editableRenderer },
      { field: "employmentType", headerName: "Тип", minWidth: 116, flex: .65, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer: editableRenderer },
      { field: "department", headerName: "Отдел", minWidth: 129, flex: .75, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer: editableRenderer },
      { field: "position", headerName: "Должность", minWidth: 220, flex: 1.35, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer: editableRenderer },
    ];
    return [numberColumn, { field: "name", headerName: props.title, minWidth: 260, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("name"), cellRenderer: editableRenderer }];
  }, [editableRenderer, props.selectEmployee, props.title, valueGetter]);
  const defaultColDef = useMemo<ColDef<DirectoryTableRow>>(() => ({ filter: personnelColumnFilter, filterParams: personnelFilterParams, floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><LocalizedGrid<DirectoryTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={50} headerHeight={48} rowClassRules={{ "editable-row": (params) => params.data?.kind !== "entry" }} rowSelection={{ mode: "multiRow", checkboxes: (params) => !propsRef.current.readOnly && propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: !props.readOnly && props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => !propsRef.current.readOnly && propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onSelectionChanged={(event) => { if (!propsRef.current.readOnly) propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.item?.id ? [row.item.id] : [])); }} onRowDoubleClicked={(event) => { const row = event.data; if (!propsRef.current.readOnly && newDraftCount === 0 && row?.kind === "entry" && row.item && !row.pending && canOpenRowEditor(event.event)) propsRef.current.onEdit(row.item); }} onSpreadsheetPaste={pasteIntoRow} suppressCellFocus /></div></AgGridProvider>;
}

type PositionGridProps = {
  rows: GridPosition[];
  drafts: GridPositionDraft[];
  employmentTypes: GridOption[];
  departments: GridOption[];
  pendingDeletes: number[];
  fullRowEditIds: number[];
  readOnly?: boolean;
  onEdit: (position: GridPosition, changes?: Partial<GridPositionDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridPositionDraft>) => void;
  onVisibleIdsChange: (ids: number[]) => void;
};

type PositionTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; record?: GridPosition; draft?: GridPositionDraft; pending?: boolean };

export function PositionAgGrid(props: PositionGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<PositionTableRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<{ rowKey: string; field: string } | null>(null);
  const draftStructureKey = props.drafts.map((draft) => draft.id ? `edit-${draft.id}` : draft.key).join("|");
  const draftValuesKey = props.drafts.map((draft) => `${draft.key}:${draft.employmentType}:${draft.department}`).join("|");
  const selectedIdsKey = props.pendingDeletes.join("|");
  const newDraftCount = props.drafts.filter((draft) => !draft.id).length;
  useEffect(() => { requestAnimationFrame(() => {
    const api = gridApi.current;
    if (!api || api.isDestroyed()) return;
    api.refreshClientSideRowModel("everything");
    api.refreshCells({ force: true });
    api.redrawRows();
  }); }, [draftStructureKey, draftValuesKey]);
  const rowData = useMemo<PositionTableRow[]>(() => [
    ...props.rows.map((record, index) => { const draft = props.drafts.find((candidate) => candidate.id === record.id); return draft ? { rowKey: `position-${record.id}`, kind: "edit" as const, number: index + 1, record, draft, pending: false } : { rowKey: `position-${record.id}`, kind: "entry" as const, number: index + 1, record, pending: props.pendingDeletes.includes(record.id) }; }),
    ...props.drafts.filter((draft) => !draft.id).map((draft, index) => ({ rowKey: `position-new-${draft.key}`, kind: "draft" as const, number: props.rows.length + index + 1, draft })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [draftStructureKey, props.pendingDeletes, props.rows]);
  useEffect(() => { if (newDraftCount) requestAnimationFrame(() => { const api = gridApi.current; if (api && !api.isDestroyed() && api.getDisplayedRowCount()) api.ensureIndexVisible(api.getDisplayedRowCount() - 1, "bottom"); }); }, [draftStructureKey, newDraftCount]);
  useEffect(() => {
    const selected = new Set(props.pendingDeletes);
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(node.data?.record && selected.has(node.data.record.id))));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdsKey]);
  useEffect(() => { if (!props.drafts.length) requestAnimationFrame(() => setActiveEditor(null)); }, [props.drafts.length]);
  const valueGetter = useCallback((field: keyof GridPosition | "number") => (params: { data?: PositionTableRow }) => {
    if (!params.data) return "";
    if (field === "number") return params.data.number;
    const draft = propsRef.current.drafts.find((candidate) => candidate.key === params.data?.draft?.key) ?? params.data.draft;
    return params.data.kind === "entry" ? params.data.record?.[field] ?? "" : draft?.[field] ?? "";
  }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<PositionTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const currentProps = propsRef.current;
    const field = params.colDef.field;
    const activeCellEditor = Boolean(field && activeEditor?.rowKey === row.rowKey && activeEditor.field === field && row.draft);
    const fullRowEditor = Boolean(row.draft && (row.kind === "draft" || (row.draft.id && currentProps.fullRowEditIds.includes(row.draft.id))));
    if (!activeCellEditor && !fullRowEditor) return <span title={String(params.value ?? "")}>{params.value}</span>;
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft!;
    if (field === "employmentType") return <DraftNameSelect autoOpen={activeCellEditor} value={draft.employmentType} options={currentProps.employmentTypes} placeholder="Тип" onChange={(employmentType) => currentProps.onPatchDraft(draft.key, { employmentType })} />;
    if (field === "department") return <DraftNameSelect autoOpen={activeCellEditor} value={draft.department} options={currentProps.departments} placeholder="Отдел" onChange={(department) => currentProps.onPatchDraft(draft.key, { department })} />;
    return <EmployeeTextEditor focusOnMount={activeCellEditor} value={draft.position} placeholder="Должность" onChange={(position) => currentProps.onPatchDraft(draft.key, { position })} />;
  }, [activeEditor, propsRef]);
  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<PositionTableRow>) => {
    if (propsRef.current.readOnly) return false;
    if (row.kind === "entry" && propsRef.current.drafts.some((draft) => !draft.id)) return false;
    const changes: Partial<GridPositionDraft> = {};
    if (values.employmentType !== undefined) changes.employmentType = values.employmentType;
    if (values.department !== undefined) changes.department = values.department;
    if (values.position !== undefined) changes.position = values.position;
    if (!Object.keys(changes).length) return false;
    if (row.kind === "entry" && row.record) propsRef.current.onEdit(row.record, changes);
    else if (row.draft) propsRef.current.onPatchDraft(row.draft.key, changes);
    else return false;
    return true;
  }, [propsRef]);
  const columns = useMemo<ColDef<PositionTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "employmentType", headerName: "Тип", minWidth: 116, flex: .7, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer: editableRenderer },
    { field: "department", headerName: "Отдел", minWidth: 129, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer: editableRenderer },
    { field: "position", headerName: "Должность", minWidth: 162, flex: 2.2, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer: editableRenderer },
  ], [editableRenderer, valueGetter]);
  const reportVisibleRows = useCallback((api: GridApi<PositionTableRow>) => { const ids: number[] = []; api.forEachNodeAfterFilterAndSort((node) => { if (node.data?.record?.id) ids.push(node.data.record.id); }); props.onVisibleIdsChange(ids); }, [props]);
  const defaultColDef = useMemo<ColDef<PositionTableRow>>(() => ({ filter: personnelColumnFilter, filterParams: personnelFilterParams, floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><LocalizedGrid<PositionTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={50} headerHeight={48} rowClassRules={{ "editable-row": (params) => Boolean(params.data?.draft && (params.data.kind === "draft" || (params.data.draft.id && propsRef.current.fullRowEditIds.includes(params.data.draft.id)))) }} rowSelection={{ mode: "multiRow", checkboxes: (params) => !propsRef.current.readOnly && propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: !props.readOnly && props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => !propsRef.current.readOnly && propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onModelUpdated={(event) => reportVisibleRows(event.api)} onFilterChanged={(event) => reportVisibleRows(event.api)} onSortChanged={(event) => reportVisibleRows(event.api)} onSelectionChanged={(event) => { if (!propsRef.current.readOnly) propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.record?.id ? [row.record.id] : [])); }} onCellMouseDown={(event) => { if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return; const rowKey = event.data?.rowKey; const field = event.column.getColDef().field; if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null); }} onCellDoubleClicked={(event) => { const row = event.data; const field = event.column.getColDef().field; if (propsRef.current.readOnly || newDraftCount > 0 || !row || !field || !["employmentType", "department", "position"].includes(field) || isInteractiveGridTarget(event.event)) return; if (row.kind === "entry" && row.record) propsRef.current.onEdit(row.record); setActiveEditor({ rowKey: row.rowKey, field }); }} onSpreadsheetPaste={pasteIntoRow} spreadsheetSelectionResetKey={`${draftStructureKey}:${props.fullRowEditIds.join("|")}:${activeEditor?.rowKey ?? ""}:${activeEditor?.field ?? ""}`} suppressCellFocus /></div></AgGridProvider>;
}

type UserTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; user?: GridUser; draft?: GridUserDraft };
type UserGridProps = { rows: GridUser[]; drafts: GridUserDraft[]; sites: GridOption[]; pendingDeletes: number[]; fullRowEditIds: number[]; onEdit: (user: GridUser, changes?: Partial<GridUserDraft>) => void; onSelectionChange: (ids: number[]) => void; onPatchDraft: (key: string, changes: Partial<GridUserDraft>) => void };

export function UserAgGrid(props: UserGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<UserTableRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<{ rowKey: string; field: string } | null>(null);
  const draftStructureKey = props.drafts.map((draft) => draft.id ? `edit-${draft.id}` : draft.key).join("|");
  const draftValuesKey = props.drafts.map((draft) => `${draft.key}:${draft.role}:${draft.assignedSiteId}`).join("|");
  const selectedIdsKey = props.pendingDeletes.join("|");
  const newDraftCount = props.drafts.filter((draft) => !draft.id).length;
  useEffect(() => { requestAnimationFrame(() => {
    const api = gridApi.current;
    if (!api || api.isDestroyed()) return;
    api.refreshClientSideRowModel("everything");
    api.refreshCells({ force: true });
    api.redrawRows();
  }); }, [draftStructureKey, draftValuesKey]);
  const rowData = useMemo<UserTableRow[]>(() => [
    ...props.rows.map((user, index) => { const draft = props.drafts.find((candidate) => candidate.id === user.id); return draft ? { rowKey: `user-${user.id}`, kind: "edit" as const, number: index + 1, user, draft } : { rowKey: `user-${user.id}`, kind: "entry" as const, number: index + 1, user }; }),
    ...props.drafts.filter((draft) => !draft.id).map((draft, index) => ({ rowKey: `user-new-${draft.key}`, kind: "draft" as const, number: props.rows.length + index + 1, draft })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [draftStructureKey, props.pendingDeletes, props.rows]);
  useEffect(() => { if (newDraftCount) requestAnimationFrame(() => { const api = gridApi.current; if (api && !api.isDestroyed() && api.getDisplayedRowCount()) api.ensureIndexVisible(api.getDisplayedRowCount() - 1, "bottom"); }); }, [draftStructureKey, newDraftCount]);
  useEffect(() => {
    const selected = new Set(props.pendingDeletes);
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(node.data?.user && selected.has(node.data.user.id))));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdsKey]);
  useEffect(() => { if (!props.drafts.length) requestAnimationFrame(() => setActiveEditor(null)); }, [props.drafts.length]);
  const valueGetter = useCallback((field: "number" | "fullName" | "email" | "role" | "site" | "status") => (params: { data?: UserTableRow }) => {
    const row = params.data; if (!row) return ""; if (field === "number") return row.number;
    if (field === "status") return row.kind === "entry" ? row.user?.status === "active" ? "Активен" : "Приглашён" : "После сохранения";
    const source = row.kind === "entry" ? row.user : propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft; if (!source) return "";
    if (field === "role") return source.role === "foreman" ? "Прораб" : source.role === "engineer" ? "Инженер" : "Супер-админ";
    if (field === "site") { const assigned = row.kind === "entry" ? row.user?.assignedSiteId : Number(source.assignedSiteId); return source.role !== "foreman" ? "Все проекты" : propsRef.current.sites.find((site) => site.id === assigned)?.name ?? "Не назначен"; }
    return source[field] ?? "";
  }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<UserTableRow>) => {
    const row = params.data; if (!row) return null;
    const currentProps = propsRef.current;
    const field = params.colDef.field;
    const activeCellEditor = Boolean(field && activeEditor?.rowKey === row.rowKey && activeEditor.field === field && row.draft);
    const fullRowEditor = Boolean(row.draft && (row.kind === "draft" || (row.draft.id && currentProps.fullRowEditIds.includes(row.draft.id))));
    if (!activeCellEditor && !fullRowEditor) return <span title={String(params.value ?? "")}>{params.value}</span>;
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft!;
    if (field === "fullName") return <EmployeeTextEditor focusOnMount={activeCellEditor} value={draft.fullName} placeholder="ФИО" onChange={(fullName) => currentProps.onPatchDraft(draft.key, { fullName })} />;
    if (field === "email") return <EmployeeTextEditor focusOnMount={activeCellEditor} value={draft.email} placeholder="email@company.ru" onChange={(email) => currentProps.onPatchDraft(draft.key, { email })} />;
    if (field === "status") return <span className="ag-autofill-value">{draft.id ? "Без изменений" : "Приглашение"}</span>;
    if (field === "role") return <CustomSelect className="ag-custom-select" value={draft.role} ariaLabel="Роль" autoOpen={activeCellEditor} onChange={(role) => currentProps.onPatchDraft(draft.key, { role: role as UserRole, assignedSiteId: role !== "foreman" ? "" : draft.assignedSiteId })} options={[{ value: "foreman", label: "Прораб" }, { value: "engineer", label: "Инженер" }, { value: "superadmin", label: "Супер-админ" }]} />;
    if (draft.role !== "foreman") return <span className="ag-autofill-value">Все проекты</span>;
    return <DraftSelect autoOpen={activeCellEditor} value={draft.assignedSiteId} options={currentProps.sites} placeholder="Проект" onChange={(assignedSiteId) => currentProps.onPatchDraft(draft.key, { assignedSiteId })} />;
  }, [activeEditor, propsRef]);
  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<UserTableRow>) => {
    const currentProps = propsRef.current;
    if (row.kind === "entry" && currentProps.drafts.some((draft) => !draft.id)) return false;
    const changes: Partial<GridUserDraft> = {};
    if (values.fullName !== undefined) changes.fullName = values.fullName;
    if (values.email !== undefined) changes.email = values.email;
    if (values.role !== undefined) {
      const pastedRole = normalizeSearch(values.role);
      const role: UserRole | null = pastedRole === "прораб" || pastedRole === "foreman" ? "foreman" : pastedRole === "инженер" || pastedRole === "engineer" ? "engineer" : pastedRole === "супер-админ" || pastedRole === "superadmin" || pastedRole === "администратор" ? "superadmin" : null;
      if (!role) return false;
      changes.role = role;
      if (role !== "foreman") changes.assignedSiteId = "";
    }
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    const currentRole = changes.role ?? draft?.role ?? row.user?.role;
    if (values.site !== undefined && currentRole === "foreman") changes.assignedSiteId = pastedOptionId(currentProps.sites, values.site);
    if (!Object.keys(changes).length) return false;
    if (row.kind === "entry" && row.user) currentProps.onEdit(row.user, changes);
    else if (draft) currentProps.onPatchDraft(draft.key, changes);
    else return false;
    return true;
  }, [propsRef]);
  const columns = useMemo<ColDef<UserTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "fullName", headerName: "ФИО", minWidth: 260, flex: 1.2, headerComponentParams: pinnableHeader, valueGetter: valueGetter("fullName"), cellRenderer: editableRenderer },
    { field: "email", headerName: "Email", minWidth: 230, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("email"), cellRenderer: editableRenderer },
    { field: "status", headerName: "Статус", minWidth: 125, flex: .55, headerComponentParams: pinnableHeader, valueGetter: valueGetter("status"), cellRenderer: editableRenderer },
    { field: "role", headerName: "Роль", minWidth: 121, flex: .65, headerComponentParams: pinnableHeader, valueGetter: valueGetter("role"), cellRenderer: editableRenderer },
    { field: "site", headerName: "Доступ к проекту", minWidth: 220, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("site"), cellRenderer: editableRenderer },
  ], [editableRenderer, valueGetter]);
  const defaultColDef = useMemo<ColDef<UserTableRow>>(() => ({ filter: personnelColumnFilter, filterParams: personnelFilterParams, floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><LocalizedGrid<UserTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={50} headerHeight={48} rowClassRules={{ "editable-row": (params) => Boolean(params.data?.draft && (params.data.kind === "draft" || (params.data.draft.id && propsRef.current.fullRowEditIds.includes(params.data.draft.id)))) }} rowSelection={{ mode: "multiRow", checkboxes: (params) => propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onSelectionChanged={(event) => propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.user?.id ? [row.user.id] : []))} onCellMouseDown={(event) => { if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return; const rowKey = event.data?.rowKey; const field = event.column.getColDef().field; if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null); }} onCellDoubleClicked={(event) => { const row = event.data; const field = event.column.getColDef().field; if (newDraftCount > 0 || !row || !field || !["fullName", "email", "role", "site"].includes(field) || isInteractiveGridTarget(event.event)) return; if (row.kind === "entry" && row.user) propsRef.current.onEdit(row.user); setActiveEditor({ rowKey: row.rowKey, field }); }} onSpreadsheetPaste={pasteIntoRow} spreadsheetSelectionResetKey={`${draftStructureKey}:${props.fullRowEditIds.join("|")}:${activeEditor?.rowKey ?? ""}:${activeEditor?.field ?? ""}`} suppressCellFocus /></div></AgGridProvider>;
}

type SiteTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; site?: GridSite; draft?: GridSiteDraft };
type ProjectGridProps = { rows: GridSite[]; drafts: GridSiteDraft[]; pendingDeletes: number[]; fullRowEditIds: number[]; onEdit: (site: GridSite, changes?: Partial<GridSiteDraft>) => void; onSelectionChange: (ids: number[]) => void; onPatchDraft: (key: string, changes: Partial<GridSiteDraft>) => void };

export function ProjectAgGrid(props: ProjectGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<SiteTableRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<{ rowKey: string; field: string } | null>(null);
  const draftStructureKey = props.drafts.map((draft) => draft.id ? `edit-${draft.id}` : draft.key).join("|");
  const selectedIdsKey = props.pendingDeletes.join("|");
  const newDraftCount = props.drafts.filter((draft) => !draft.id).length;
  useEffect(() => { requestAnimationFrame(() => {
    const api = gridApi.current;
    if (!api || api.isDestroyed()) return;
    api.refreshClientSideRowModel("everything");
    api.refreshCells({ force: true });
    api.redrawRows();
  }); }, [draftStructureKey]);
  const rowData = useMemo<SiteTableRow[]>(() => [
    ...props.rows.map((site, index) => { const draft = props.drafts.find((candidate) => candidate.id === site.id); return draft ? { rowKey: `site-${site.id}`, kind: "edit" as const, number: index + 1, site, draft } : { rowKey: `site-${site.id}`, kind: "entry" as const, number: index + 1, site }; }),
    ...props.drafts.filter((draft) => !draft.id).map((draft, index) => ({ rowKey: `site-new-${draft.key}`, kind: "draft" as const, number: props.rows.length + index + 1, draft })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [draftStructureKey, props.pendingDeletes, props.rows]);
  useEffect(() => { if (newDraftCount) requestAnimationFrame(() => { const api = gridApi.current; if (api && !api.isDestroyed() && api.getDisplayedRowCount()) api.ensureIndexVisible(api.getDisplayedRowCount() - 1, "bottom"); }); }, [draftStructureKey, newDraftCount]);
  useEffect(() => {
    const selected = new Set(props.pendingDeletes);
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(node.data?.site && selected.has(node.data.site.id))));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdsKey]);
  useEffect(() => { if (!props.drafts.length) requestAnimationFrame(() => setActiveEditor(null)); }, [props.drafts.length]);
  const valueGetter = useCallback((field: "number" | "name") => (params: { data?: SiteTableRow }) => { const row = params.data; if (!row) return ""; if (field === "number") return row.number; const draft = propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft; return row.kind === "entry" ? row.site?.name ?? "" : draft?.name ?? ""; }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<SiteTableRow>) => {
    const row = params.data; if (!row) return null;
    const currentProps = propsRef.current;
    const field = params.colDef.field;
    const activeCellEditor = Boolean(field && activeEditor?.rowKey === row.rowKey && activeEditor.field === field && row.draft);
    const fullRowEditor = Boolean(row.draft && (row.kind === "draft" || (row.draft.id && currentProps.fullRowEditIds.includes(row.draft.id))));
    if (!activeCellEditor && !fullRowEditor) return <span title={String(params.value ?? "")}>{params.value}</span>;
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft!;
    return <EmployeeTextEditor focusOnMount={activeCellEditor} value={draft.name} placeholder="Название проекта" onChange={(name) => currentProps.onPatchDraft(draft.key, { name })} />;
  }, [activeEditor, propsRef]);
  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<SiteTableRow>) => {
    if (row.kind === "entry" && propsRef.current.drafts.some((draft) => !draft.id)) return false;
    if (values.name === undefined) return false;
    if (row.kind === "entry" && row.site) propsRef.current.onEdit(row.site, { name: values.name });
    else if (row.draft) propsRef.current.onPatchDraft(row.draft.key, { name: values.name });
    else return false;
    return true;
  }, [propsRef]);
  const columns = useMemo<ColDef<SiteTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "name", headerName: "Проект", minWidth: 300, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("name"), cellRenderer: editableRenderer },
  ], [editableRenderer, valueGetter]);
  const defaultColDef = useMemo<ColDef<SiteTableRow>>(() => ({ filter: personnelColumnFilter, filterParams: personnelFilterParams, floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><LocalizedGrid<SiteTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={50} headerHeight={48} rowClassRules={{ "editable-row": (params) => Boolean(params.data?.draft && (params.data.kind === "draft" || (params.data.draft.id && propsRef.current.fullRowEditIds.includes(params.data.draft.id)))) }} rowSelection={{ mode: "multiRow", checkboxes: (params) => propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onSelectionChanged={(event) => propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.site?.id ? [row.site.id] : []))} onCellMouseDown={(event) => { if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return; const rowKey = event.data?.rowKey; const field = event.column.getColDef().field; if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null); }} onCellDoubleClicked={(event) => { const row = event.data; const field = event.column.getColDef().field; if (newDraftCount > 0 || !row || field !== "name" || isInteractiveGridTarget(event.event)) return; if (row.kind === "entry" && row.site) propsRef.current.onEdit(row.site); setActiveEditor({ rowKey: row.rowKey, field }); }} onSpreadsheetPaste={pasteIntoRow} spreadsheetSelectionResetKey={`${draftStructureKey}:${props.fullRowEditIds.join("|")}:${activeEditor?.rowKey ?? ""}:${activeEditor?.field ?? ""}`} suppressCellFocus /></div></AgGridProvider>;
}
