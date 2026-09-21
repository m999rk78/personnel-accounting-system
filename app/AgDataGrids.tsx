"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  EventApiModule,
  NumberFilterModule,
  RenderApiModule,
  RowApiModule,
  RowStyleModule,
  ScrollApiModule,
  TextFilterModule,
  themeQuartz,
  type ColDef,
  type ColumnResizedEvent,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
} from "ag-grid-community";
import {
  AgGridProvider,
  AgGridReact,
  type CustomCellRendererProps,
  type CustomInnerHeaderProps,
} from "ag-grid-react";

export type GridOption = { id: number; name: string };
export type GridEmployee = {
  id: number;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
  siteId: number | null;
  siteName: string | null;
};
export type GridEmployeeDraft = { id?: number; fullName: string; employmentType: string; department: string; position: string; projectSiteId: string };
export type GridProjectEmployeeDraft = { employeeId: string; employeeQuery: string };
export type GridDirectoryDraft = { id?: number; name: string; employeeId?: string };
export type GridPosition = { id: number; employmentType: string; department: string; position: string };
export type GridPositionDraft = { id?: number; employmentType: string; department: string; position: string };
export type GridUser = { id: number; fullName: string; email: string; role: "foreman" | "office"; assignedSiteId: number | null; status?: "active" | "invited" };
export type GridUserDraft = { id?: number; fullName: string; email: string; role: "foreman" | "office"; assignedSiteId: string };
export type GridSite = GridOption & { code: string; timezone: string };
export type GridSiteDraft = { id?: number; name: string; code: string; timezone: string };
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
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  EventApiModule,
  NumberFilterModule,
  RenderApiModule,
  RowApiModule,
  RowStyleModule,
  CellStyleModule,
  ScrollApiModule,
  TextFilterModule,
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
  requestAnimationFrame(() => event.api.sizeColumnsToFit({
    columnLimits: [{ key: resizedColumn, minWidth: resizedWidth, maxWidth: resizedWidth }],
  }));
}

function GridIcon({ name }: { name: "pencil" | "trash" | "back" | "check" | "pin" | "filter" }) {
  return <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "pencil" && <><path d="M21.2 6.8 7.8 20.2a2 2 0 0 1-.8.5L2.6 22a.5.5 0 0 1-.6-.6L3.3 17a2 2 0 0 1 .5-.8L17.2 2.8a2.8 2.8 0 0 1 4 4Z"/><path d="m15 5 4 4"/></>}
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
      note: entry.note || "—",
    };
    return values[field] ?? "";
  }
  const draft = row.draft;
  const employee = options.employees.find((item) => item.id === Number(draft?.employeeId));
  const values: Record<string, string | number> = {
    employeeName: draft?.employeeQuery ?? "",
    employmentType: employee?.employmentType ?? "—",
    department: employee?.department ?? "—",
    position: employee?.position ?? "Заполнится автоматически",
    shift: optionName(options.shifts, draft?.shiftId ?? ""),
    zone: optionName(options.zones, draft?.zoneId ?? ""),
    mainWork: optionName(options.mainWorkTypes, draft?.mainWorkTypeId ?? ""),
    subwork: optionName(options.subworkTypes, draft?.subworkTypeId ?? ""),
    master: optionName(options.masters, draft?.masterId ?? ""),
    hours: Number(draft?.hours) || "",
    note: draft?.note ?? "",
  };
  return values[field] ?? "";
}

type PlacementGridProps = {
  entries: GridEntry[];
  draftRows: GridDraftRow[];
  editing: { id: number; row: GridDraftRow } | null;
  employees: GridEmployee[];
  shifts: GridOption[];
  zones: GridOption[];
  mainWorkTypes: GridOption[];
  subworkTypes: GridOption[];
  masters: GridOption[];
  loading: boolean;
  canEdit: boolean;
  pendingDeletes: number[];
  onEdit: (entry: GridEntry) => void;
  onToggleDelete: (id: number) => void;
  onPatchDraft: (key: string, changes: Partial<GridDraftRow>) => void;
  onPatchEditing: (changes: Partial<GridDraftRow>) => void;
  onRemoveDraft: (key: string) => void;
  onCancelEditing: () => void;
  onConfirmEditing: () => void;
  onVisibleEntryIdsChange: (ids: number[]) => void;
};

function DraftSelect({ value, options, placeholder, onChange }: { value: string; options: GridOption[]; placeholder: string; onChange: (value: string) => void }) {
  return <select className="ag-inline-control" value={value} onChange={(event) => onChange(event.target.value)}><option value="">{placeholder}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select>;
}

function DraftNameSelect({ value, options, placeholder, onChange }: { value: string; options: GridOption[]; placeholder: string; onChange: (value: string) => void }) {
  return <select className="ag-inline-control" value={value} onChange={(event) => onChange(event.target.value)}><option value="">{placeholder}</option>{options.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select>;
}

function DraftSuggestionInput({ value, options, placeholder, listId, onChange }: { value: string; options: GridOption[]; placeholder: string; listId: string; onChange: (value: string) => void }) {
  return <><input className="ag-inline-control" value={value} list={listId} placeholder={placeholder} autoComplete="off" onChange={(event) => onChange(event.target.value)} /><datalist id={listId}>{options.map((option) => <option key={option.id} value={option.name} />)}</datalist></>;
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
  const gridApi = useRef<GridApi<PlacementRow> | null>(null);
  const rowData = useMemo<PlacementRow[]>(() => [
    ...props.entries.map((entry, index) => props.editing?.id === entry.id
      ? { rowKey: `entry-${entry.id}`, kind: "edit" as const, number: index + 1, entry, draft: props.editing.row }
      : { rowKey: `entry-${entry.id}`, kind: "entry" as const, number: index + 1, entry }),
    ...props.draftRows.map((draft, index) => ({ rowKey: `draft-${draft.key}`, kind: "draft" as const, number: props.entries.length + index + 1, draft })),
  ], [props.entries, props.draftRows, props.editing]);

  useEffect(() => {
    if (gridApi.current && props.draftRows.length) {
      requestAnimationFrame(() => gridApi.current?.ensureIndexVisible(rowData.length - 1, "bottom"));
    }
  }, [props.draftRows.length, rowData]);

  const patchRow = useCallback((row: PlacementRow, changes: Partial<GridDraftRow>) => {
    if (row.kind === "edit") props.onPatchEditing(changes);
    if (row.kind === "draft" && row.draft) props.onPatchDraft(row.draft.key, changes);
  }, [props]);

  const editableRenderer = useCallback((params: CustomCellRendererProps<PlacementRow>) => {
    const row = params.data;
    if (!row) return null;
    if (row.kind === "entry") {
      return params.colDef.field === "hours" ? <strong>{params.value}</strong> : <span title={String(params.value ?? "")}>{params.value}</span>;
    }
    const draft = row.draft;
    if (!draft) return null;
    const field = params.colDef.field;
    if (field === "employeeName") return <EmployeeCombobox value={draft.employeeQuery} employees={props.employees} onChange={(employeeQuery, employeeId) => patchRow(row, { employeeQuery, employeeId })} />;
    if (field === "shift") return <DraftSelect value={draft.shiftId} options={props.shifts} placeholder="Смена" onChange={(shiftId) => patchRow(row, { shiftId })} />;
    if (field === "zone") return <DraftSelect value={draft.zoneId} options={props.zones} placeholder="Зона" onChange={(zoneId) => patchRow(row, { zoneId })} />;
    if (field === "mainWork") return <DraftSelect value={draft.mainWorkTypeId} options={props.mainWorkTypes} placeholder="Работа" onChange={(mainWorkTypeId) => patchRow(row, { mainWorkTypeId })} />;
    if (field === "subwork") return <DraftSelect value={draft.subworkTypeId} options={props.subworkTypes} placeholder="Вид подработ" onChange={(subworkTypeId) => patchRow(row, { subworkTypeId })} />;
    if (field === "master") return <DraftSelect value={draft.masterId} options={props.masters} placeholder="Мастер" onChange={(masterId) => patchRow(row, { masterId })} />;
    if (field === "hours") return <select className="ag-inline-control" value={draft.hours} onChange={(event) => patchRow(row, { hours: event.target.value })}><option value="">—</option>{Array.from({ length: 10 }, (_, index) => index + 1).map((hours) => <option key={hours} value={hours}>{hours}</option>)}</select>;
    if (field === "note") return <input className="ag-inline-control" value={draft.note} placeholder="Необязательно" onChange={(event) => patchRow(row, { note: event.target.value })} />;
    return <span className="ag-autofill-value">{params.value}</span>;
  }, [patchRow, props]);

  const actionRenderer = useCallback((params: CustomCellRendererProps<PlacementRow>) => {
    const row = params.data;
    if (!row) return null;
    if (row.kind === "edit") return <div className="row-actions"><button type="button" onClick={props.onCancelEditing} title="Назад без сохранения" aria-label="Назад без сохранения"><GridIcon name="back" /></button><button type="button" onClick={props.onConfirmEditing} title="Подтвердить изменения" aria-label="Подтвердить изменения"><GridIcon name="check" /></button></div>;
    if (row.kind === "draft" && row.draft) return <div className="row-actions"><button type="button" onClick={() => props.onRemoveDraft(row.draft!.key)} title="Удалить строку" aria-label="Удалить строку"><GridIcon name="trash" /></button></div>;
    const entry = row.entry!;
    const pending = props.pendingDeletes.includes(entry.id);
    if (pending) return <div className="row-actions"><button type="button" onClick={() => props.onToggleDelete(entry.id)} disabled={!props.canEdit} title="Отменить удаление" aria-label={`Отменить удаление ${entry.employeeName}`}><GridIcon name="back" /></button></div>;
    return <div className="row-actions"><button type="button" onClick={() => props.onEdit(entry)} disabled={!props.canEdit} title="Редактировать" aria-label={`Редактировать ${entry.employeeName}`}><GridIcon name="pencil" /></button><button type="button" onClick={() => props.onToggleDelete(entry.id)} disabled={!props.canEdit} title="Удалить" aria-label={`Удалить ${entry.employeeName}`}><GridIcon name="trash" /></button></div>;
  }, [props]);

  const valueGetter = useCallback((field: string) => (params: { data?: PlacementRow }) => params.data ? placementValue(params.data, field, props) : "", [props]);
  const columns = useMemo<ColDef<PlacementRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, lockPosition: "left", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "employeeName", headerName: "ФИО", minWidth: 220, flex: 2.2, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employeeName"), cellRenderer: editableRenderer },
    { field: "employmentType", headerName: "Тип", minWidth: 116, flex: .7, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer: editableRenderer },
    { field: "department", headerName: "Отдел", minWidth: 129, flex: .8, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer: editableRenderer },
    { field: "position", headerName: "Должность", minWidth: 162, flex: 1.8, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer: editableRenderer },
    { field: "shift", headerName: "Смена", minWidth: 129, flex: .8, headerComponentParams: pinnableHeader, valueGetter: valueGetter("shift"), cellRenderer: editableRenderer },
    { field: "zone", headerName: "Зона", minWidth: 121, flex: 1.1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("zone"), cellRenderer: editableRenderer },
    { field: "mainWork", headerName: "Работа", minWidth: 137, flex: 1.8, headerComponentParams: pinnableHeader, valueGetter: valueGetter("mainWork"), cellRenderer: editableRenderer },
    { field: "subwork", headerName: "Вид подработ", minWidth: 193, flex: 1.7, headerComponentParams: pinnableHeader, valueGetter: valueGetter("subwork"), cellRenderer: editableRenderer },
    { field: "master", headerName: "Мастер", minWidth: 137, flex: 1.5, headerComponentParams: pinnableHeader, valueGetter: valueGetter("master"), cellRenderer: editableRenderer },
    { field: "hours", headerName: "Часы", minWidth: 121, flex: .7, headerComponentParams: pinnableHeader, filter: "agNumberColumnFilter", valueGetter: valueGetter("hours"), cellRenderer: editableRenderer },
    { field: "note", headerName: "Примечание", minWidth: 169, flex: 1.3, headerComponentParams: pinnableHeader, valueGetter: valueGetter("note"), cellRenderer: editableRenderer },
    { colId: "actions", headerName: "", width: 72, minWidth: 64, pinned: "right", lockPinned: true, lockPosition: "right", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, cellClass: "actions-cell", cellRenderer: actionRenderer },
  ], [actionRenderer, editableRenderer, valueGetter]);

  const reportVisibleRows = useCallback((api: GridApi<PlacementRow>) => {
    const ids: number[] = [];
    api.forEachNodeAfterFilterAndSort((node) => {
      if (node.data?.entry?.id) ids.push(node.data.entry.id);
    });
    props.onVisibleEntryIdsChange(ids);
  }, [props]);

  const defaultColDef = useMemo<ColDef<PlacementRow>>(() => ({
    filter: "agTextColumnFilter",
    floatingFilter: false,
    resizable: true,
    sortable: true,
    suppressHeaderMenuButton: true,
    suppressHeaderFilterButton: true,
  }), []);

  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-placement-grid"><AgGridReact<PlacementRow>
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
      "delete-pending": (params) => Boolean(params.data?.entry && props.pendingDeletes.includes(params.data.entry.id)),
      "editable-row": (params) => params.data?.kind === "edit" || params.data?.kind === "draft",
    }}
    onGridReady={(event: GridReadyEvent<PlacementRow>) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }}
    onGridSizeChanged={(event) => event.api.sizeColumnsToFit()}
    onColumnResized={keepGridFilled}
    onModelUpdated={(event) => reportVisibleRows(event.api)}
    onFilterChanged={(event) => reportVisibleRows(event.api)}
    onSortChanged={(event) => reportVisibleRows(event.api)}
    suppressCellFocus
  /></div></AgGridProvider>;
}

type EmployeeTableRow = {
  rowKey: string;
  kind: "entry" | "edit" | "draft";
  number: number;
  employee?: GridEmployee;
  draft?: GridEmployeeDraft;
  pending?: boolean;
};

type EmployeeGridProps = {
  rows: GridEmployee[];
  draft: GridEmployeeDraft | null;
  employmentTypes: GridOption[];
  departments: GridOption[];
  positions: GridOption[];
  sites: GridOption[];
  pendingDeletes: number[];
  onEdit: (employee: GridEmployee) => void;
  onToggleDelete: (id: number) => void;
  onPatchDraft: (changes: Partial<GridEmployeeDraft>) => void;
  onCancelDraft: () => void;
  onSaveDraft: () => void;
  onVisibleIdsChange: (ids: number[]) => void;
};

export function EmployeeAgGrid(props: EmployeeGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<EmployeeTableRow> | null>(null);
  const draftKey = props.draft ? `employee-${props.draft.id ?? "new"}` : "idle";
  useEffect(() => { requestAnimationFrame(() => gridApi.current?.refreshCells({ force: true })); }, [draftKey]);
  const rowData = useMemo<EmployeeTableRow[]>(() => [
    ...props.rows.map((employee, index) => props.draft?.id === employee.id
      ? { rowKey: `employee-${employee.id}`, kind: "edit" as const, number: index + 1, employee, draft: props.draft, pending: false }
      : { rowKey: `employee-${employee.id}`, kind: "entry" as const, number: index + 1, employee, pending: props.pendingDeletes.includes(employee.id) }),
    ...(props.draft && !props.draft.id ? [{ rowKey: "employee-new", kind: "draft" as const, number: props.rows.length + 1, draft: props.draft }] : []),
  ], [props.draft, props.pendingDeletes, props.rows]);

  const editableRenderer = useCallback((params: CustomCellRendererProps<EmployeeTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const field = params.colDef.field;
    if (row.kind === "entry") {
      const value = field === "siteName" ? row.employee?.siteName || "Не назначен" : params.value;
      return <span title={String(value ?? "")}>{value}</span>;
    }
    const currentProps = propsRef.current;
    const draft = row.draft!;
    if (field === "fullName") return <input className="ag-inline-control" value={draft.fullName} placeholder="ФИО сотрудника" onChange={(event) => currentProps.onPatchDraft({ fullName: event.target.value })} />;
    if (field === "employmentType") return <DraftNameSelect value={draft.employmentType} options={currentProps.employmentTypes} placeholder="Тип" onChange={(employmentType) => currentProps.onPatchDraft({ employmentType })} />;
    if (field === "department") return <DraftNameSelect value={draft.department} options={currentProps.departments} placeholder="Отдел" onChange={(department) => currentProps.onPatchDraft({ department })} />;
    if (field === "position") return <DraftNameSelect value={draft.position} options={currentProps.positions} placeholder="Должность" onChange={(position) => currentProps.onPatchDraft({ position })} />;
    if (field === "siteName") return <DraftSelect value={draft.projectSiteId} options={currentProps.sites} placeholder="Проект" onChange={(projectSiteId) => currentProps.onPatchDraft({ projectSiteId })} />;
    return <span>{params.value}</span>;
  }, [propsRef]);

  const actionRenderer = useCallback((params: CustomCellRendererProps<EmployeeTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const currentProps = propsRef.current;
    if (row.kind === "edit" || row.kind === "draft") return <div className="row-actions"><button type="button" onClick={currentProps.onCancelDraft} title="Назад без сохранения" aria-label="Назад без сохранения"><GridIcon name="back" /></button><button type="button" onClick={currentProps.onSaveDraft} title="Подтвердить изменения" aria-label="Подтвердить изменения"><GridIcon name="check" /></button></div>;
    const employee = row.employee!;
    const pending = row.pending;
    if (pending) return <div className="row-actions"><button type="button" onClick={() => currentProps.onToggleDelete(employee.id)} title="Отменить удаление" aria-label={`Отменить удаление ${employee.fullName}`}><GridIcon name="back" /></button></div>;
    return <div className="row-actions"><button type="button" onClick={() => currentProps.onEdit(employee)} aria-label={`Редактировать ${employee.fullName}`}><GridIcon name="pencil" /></button><button type="button" onClick={() => currentProps.onToggleDelete(employee.id)} aria-label={`Удалить ${employee.fullName}`}><GridIcon name="trash" /></button></div>;
  }, [propsRef]);

  const valueGetter = useCallback((field: keyof GridEmployee | "number") => (params: { data?: EmployeeTableRow }) => {
    const row = params.data;
    if (!row) return "";
    if (field === "number") return row.number;
    if (row.kind === "entry") return row.employee?.[field] ?? "";
    if (field === "siteName") return propsRef.current.sites.find((site) => site.id === Number(row.draft?.projectSiteId))?.name ?? "";
    return row.draft?.[field as keyof GridEmployeeDraft] ?? "";
  }, [propsRef]);

  const columns = useMemo<ColDef<EmployeeTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, lockPosition: "left", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "fullName", headerName: "ФИО", minWidth: 230, flex: 1.4, headerComponentParams: pinnableHeader, valueGetter: valueGetter("fullName"), cellRenderer: editableRenderer },
    { field: "employmentType", headerName: "Тип", minWidth: 120, flex: .55, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer: editableRenderer },
    { field: "department", headerName: "Отдел", minWidth: 150, flex: .7, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer: editableRenderer },
    { field: "position", headerName: "Должность", minWidth: 220, flex: 1.4, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer: editableRenderer },
    { field: "siteName", headerName: "Проект", minWidth: 190, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("siteName"), cellRenderer: editableRenderer },
    { colId: "actions", headerName: "", width: 72, minWidth: 64, pinned: "right", lockPinned: true, lockPosition: "right", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, cellClass: "actions-cell", cellRenderer: actionRenderer },
  ], [actionRenderer, editableRenderer, valueGetter]);

  const reportVisibleRows = useCallback((api: GridApi<EmployeeTableRow>) => {
    const ids: number[] = [];
    api.forEachNodeAfterFilterAndSort((node) => { if (node.data?.employee?.id) ids.push(node.data.employee.id); });
    props.onVisibleIdsChange(ids);
  }, [props]);

  const defaultColDef = useMemo<ColDef<EmployeeTableRow>>(() => ({ filter: "agTextColumnFilter", floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-employee-grid"><AgGridReact<EmployeeTableRow>
    theme={gridTheme}
    rowData={rowData}
    columnDefs={columns}
    defaultColDef={defaultColDef}
    getRowId={(params) => params.data.rowKey}
    rowHeight={50}
    headerHeight={48}
    rowClassRules={{
      "delete-pending": (params) => Boolean(params.data?.employee && props.pendingDeletes.includes(params.data.employee.id)),
      "editable-row": (params) => params.data?.kind === "edit" || params.data?.kind === "draft",
    }}
    onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }}
    onGridSizeChanged={(event) => event.api.sizeColumnsToFit()}
    onColumnResized={keepGridFilled}
    onModelUpdated={(event) => reportVisibleRows(event.api)}
    onFilterChanged={(event) => reportVisibleRows(event.api)}
    onSortChanged={(event) => reportVisibleRows(event.api)}
    suppressCellFocus
  /></div></AgGridProvider>;
}

type ProjectEmployeeTableRow = { rowKey: string; kind: "entry" | "draft"; number: number; employee?: GridEmployee; draft?: GridProjectEmployeeDraft; pending?: boolean };
type ProjectEmployeeGridProps = {
  rows: GridEmployee[];
  allEmployees: GridEmployee[];
  draft: GridProjectEmployeeDraft | null;
  pendingDeletes: number[];
  onPatchDraft: (changes: Partial<GridProjectEmployeeDraft>) => void;
  onCancelDraft: () => void;
  onSaveDraft: () => void;
  onToggleDelete: (id: number) => void;
};

export function ProjectEmployeeAgGrid(props: ProjectEmployeeGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<ProjectEmployeeTableRow> | null>(null);
  const rowData = useMemo<ProjectEmployeeTableRow[]>(() => [
    ...props.rows.map((employee, index) => ({ rowKey: `project-employee-${employee.id}`, kind: "entry" as const, number: index + 1, employee, pending: props.pendingDeletes.includes(employee.id) })),
    ...(props.draft ? [{ rowKey: "project-employee-new", kind: "draft" as const, number: props.rows.length + 1, draft: props.draft }] : []),
  ], [props.draft, props.pendingDeletes, props.rows]);
  const draftEmployeeId = props.draft?.employeeId ?? "";
  useEffect(() => { requestAnimationFrame(() => gridApi.current?.refreshCells({ force: true })); }, [draftEmployeeId]);
  const availableEmployees = useMemo(() => {
    const assigned = new Set(props.rows.map((employee) => employee.id));
    return props.allEmployees.filter((employee) => !assigned.has(employee.id));
  }, [props.allEmployees, props.rows]);
  const valueGetter = useCallback((field: "number" | "fullName" | "employmentType" | "department" | "position") => (params: { data?: ProjectEmployeeTableRow }) => {
    const row = params.data;
    if (!row) return "";
    if (field === "number") return row.number;
    const employee = row.kind === "entry" ? row.employee : propsRef.current.allEmployees.find((item) => item.id === Number(row.draft?.employeeId));
    if (field === "fullName") return row.kind === "draft" ? row.draft?.employeeQuery ?? "" : employee?.fullName ?? "";
    return employee?.[field] ?? "—";
  }, [propsRef]);
  const cellRenderer = useCallback((params: CustomCellRendererProps<ProjectEmployeeTableRow>) => {
    const row = params.data;
    if (!row) return null;
    if (row.kind === "draft" && params.colDef.field === "fullName") return <EmployeeCombobox value={row.draft?.employeeQuery ?? ""} employees={availableEmployees} onChange={(employeeQuery, employeeId) => propsRef.current.onPatchDraft({ employeeQuery, employeeId })} />;
    return <span className={row.kind === "draft" ? "ag-autofill-value" : undefined} title={String(params.value ?? "")}>{params.value}</span>;
  }, [availableEmployees, propsRef]);
  const actionRenderer = useCallback((params: CustomCellRendererProps<ProjectEmployeeTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const currentProps = propsRef.current;
    if (row.kind === "draft") return <InlineDraftActions onCancel={currentProps.onCancelDraft} onSave={currentProps.onSaveDraft} />;
    const employee = row.employee!;
    if (row.pending) return <PendingDeleteAction label={employee.fullName} onUndo={() => currentProps.onToggleDelete(employee.id)} />;
    return <div className="row-actions"><button type="button" onClick={() => currentProps.onToggleDelete(employee.id)} aria-label={`Убрать ${employee.fullName} из проекта`} title="Убрать из проекта"><GridIcon name="trash" /></button></div>;
  }, [propsRef]);
  const columns = useMemo<ColDef<ProjectEmployeeTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "fullName", headerName: "ФИО", minWidth: 260, flex: 1.5, headerComponentParams: pinnableHeader, valueGetter: valueGetter("fullName"), cellRenderer },
    { field: "employmentType", headerName: "Тип", minWidth: 116, flex: .6, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer },
    { field: "department", headerName: "Отдел", minWidth: 129, flex: .75, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer },
    { field: "position", headerName: "Должность", minWidth: 220, flex: 1.35, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer },
    { colId: "actions", headerName: "", width: 64, minWidth: 58, pinned: "right", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, cellClass: "actions-cell", cellRenderer: actionRenderer },
  ], [actionRenderer, cellRenderer, valueGetter]);
  const defaultColDef = useMemo<ColDef<ProjectEmployeeTableRow>>(() => ({ filter: "agTextColumnFilter", floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><AgGridReact<ProjectEmployeeTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={50} headerHeight={48} rowClassRules={{ "delete-pending": (params) => Boolean(params.data?.employee && props.pendingDeletes.includes(params.data.employee.id)), "editable-row": (params) => params.data?.kind === "draft" }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} suppressCellFocus /></div></AgGridProvider>;
}

type DirectoryTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; item?: GridOption; draft?: GridDirectoryDraft; pending?: boolean };
type DirectoryGridProps = {
  title: string;
  rows: GridOption[];
  draft: GridDirectoryDraft | null;
  employees?: GridEmployee[];
  selectEmployee?: boolean;
  pendingDeletes: number[];
  onEdit: (item: GridOption) => void;
  onToggleDelete: (id: number) => void;
  onPatchDraft: (changes: Partial<GridDirectoryDraft>) => void;
  onCancelDraft: () => void;
  onSaveDraft: () => void;
};

export function DirectoryAgGrid(props: DirectoryGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<DirectoryTableRow> | null>(null);
  const draftKey = props.draft ? `directory-${props.draft.id ?? "new"}` : "idle";
  useEffect(() => { requestAnimationFrame(() => gridApi.current?.refreshCells({ force: true })); }, [draftKey]);
  const rowData = useMemo<DirectoryTableRow[]>(() => [
    ...props.rows.map((item, index) => props.draft?.id === item.id
      ? { rowKey: `directory-${item.id}`, kind: "edit" as const, number: index + 1, item, draft: props.draft, pending: false }
      : { rowKey: `directory-${item.id}`, kind: "entry" as const, number: index + 1, item, pending: props.pendingDeletes.includes(item.id) }),
    ...(props.draft && !props.draft.id ? [{ rowKey: "directory-new", kind: "draft" as const, number: props.rows.length + 1, draft: props.draft }] : []),
  // Keep the draft row object stable while a user types. Replacing rowData on every
  // keystroke makes AG Grid recreate the renderer and drops characters/focus.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [draftKey, props.pendingDeletes, props.rows]);
  const valueGetter = useCallback((field: "number" | "name" | "employmentType" | "department" | "position") => (params: { data?: DirectoryTableRow }) => {
    const row = params.data;
    if (!row) return "";
    if (field === "number") return row.number;
    const name = row.kind === "entry" ? row.item?.name ?? "" : propsRef.current.draft?.name ?? row.draft?.name ?? "";
    if (field === "name") return name;
    const employeeId = row.kind === "entry" ? undefined : propsRef.current.draft?.employeeId ?? row.draft?.employeeId;
    const employee = (propsRef.current.employees ?? []).find((candidate) => employeeId ? candidate.id === Number(employeeId) : normalizeSearch(candidate.fullName) === normalizeSearch(name));
    return employee?.[field] ?? "—";
  }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<DirectoryTableRow>) => {
    const row = params.data;
    if (!row) return null;
    if (row.kind === "entry") return <span title={String(params.value ?? "")}>{params.value}</span>;
    if (propsRef.current.selectEmployee && params.colDef.field === "name") return <EmployeeCombobox value={propsRef.current.draft?.name ?? row.draft?.name ?? ""} employees={propsRef.current.employees ?? []} onChange={(name, employeeId) => propsRef.current.onPatchDraft({ name, employeeId })} />;
    if (propsRef.current.selectEmployee) return <span className="ag-autofill-value" title={String(params.value ?? "")}>{params.value}</span>;
    return <input className="ag-inline-control" defaultValue={propsRef.current.draft?.name ?? row.draft?.name ?? ""} placeholder={`Название: ${propsRef.current.title.toLocaleLowerCase("ru-RU")}`} onChange={(event) => propsRef.current.onPatchDraft({ name: event.target.value })} />;
  }, [propsRef]);
  const actionRenderer = useCallback((params: CustomCellRendererProps<DirectoryTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const currentProps = propsRef.current;
    if (row.kind !== "entry") return <InlineDraftActions onCancel={currentProps.onCancelDraft} onSave={currentProps.onSaveDraft} />;
    const item = row.item!;
    if (row.pending) return <PendingDeleteAction label={item.name} onUndo={() => currentProps.onToggleDelete(item.id)} />;
    return <DefaultRowActions label={item.name} onEdit={() => currentProps.onEdit(item)} onDelete={() => currentProps.onToggleDelete(item.id)} />;
  }, [propsRef]);
  const columns = useMemo<ColDef<DirectoryTableRow>[]>(() => {
    const numberColumn: ColDef<DirectoryTableRow> = { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") };
    const actionColumn: ColDef<DirectoryTableRow> = { colId: "actions", headerName: "", width: 72, minWidth: 64, pinned: "right", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, cellClass: "actions-cell", cellRenderer: actionRenderer };
    if (props.selectEmployee) return [
      numberColumn,
      { field: "name", headerName: "ФИО", minWidth: 250, flex: 1.5, headerComponentParams: pinnableHeader, valueGetter: valueGetter("name"), cellRenderer: editableRenderer },
      { field: "employmentType", headerName: "Тип", minWidth: 116, flex: .65, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer: editableRenderer },
      { field: "department", headerName: "Отдел", minWidth: 129, flex: .75, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer: editableRenderer },
      { field: "position", headerName: "Должность", minWidth: 220, flex: 1.35, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer: editableRenderer },
      actionColumn,
    ];
    return [numberColumn, { field: "name", headerName: props.title, minWidth: 260, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("name"), cellRenderer: editableRenderer }, actionColumn];
  }, [actionRenderer, editableRenderer, props.selectEmployee, props.title, valueGetter]);
  const defaultColDef = useMemo<ColDef<DirectoryTableRow>>(() => ({ filter: "agTextColumnFilter", floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><AgGridReact<DirectoryTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={50} headerHeight={48} rowClassRules={{ "delete-pending": (params) => Boolean(params.data?.item && props.pendingDeletes.includes(params.data.item.id)), "editable-row": (params) => params.data?.kind !== "entry" }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} suppressCellFocus /></div></AgGridProvider>;
}

type PositionGridProps = {
  rows: GridPosition[];
  draft: GridPositionDraft | null;
  employmentTypes: GridOption[];
  departments: GridOption[];
  pendingDeletes: number[];
  onEdit: (position: GridPosition) => void;
  onToggleDelete: (id: number) => void;
  onPatchDraft: (changes: Partial<GridPositionDraft>) => void;
  onCancelDraft: () => void;
  onSaveDraft: () => void;
  onVisibleIdsChange: (ids: number[]) => void;
};

type PositionTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; record?: GridPosition; draft?: GridPositionDraft; pending?: boolean };

export function PositionAgGrid(props: PositionGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<PositionTableRow> | null>(null);
  const draftKey = props.draft ? `position-${props.draft.id ?? "new"}` : "idle";
  useEffect(() => { requestAnimationFrame(() => gridApi.current?.refreshCells({ force: true })); }, [draftKey]);
  const rowData = useMemo<PositionTableRow[]>(() => [
    ...props.rows.map((record, index) => props.draft?.id === record.id ? { rowKey: `position-${record.id}`, kind: "edit" as const, number: index + 1, record, draft: props.draft, pending: false } : { rowKey: `position-${record.id}`, kind: "entry" as const, number: index + 1, record, pending: props.pendingDeletes.includes(record.id) }),
    ...(props.draft && !props.draft.id ? [{ rowKey: "position-new", kind: "draft" as const, number: props.rows.length + 1, draft: props.draft }] : []),
  ], [props.draft, props.pendingDeletes, props.rows]);
  const valueGetter = useCallback((field: keyof GridPosition | "number") => (params: { data?: PositionTableRow }) => {
    if (!params.data) return "";
    if (field === "number") return params.data.number;
    return params.data.kind === "entry" ? params.data.record?.[field] ?? "" : params.data.draft?.[field] ?? "";
  }, []);
  const editableRenderer = useCallback((params: CustomCellRendererProps<PositionTableRow>) => {
    const row = params.data;
    if (!row) return null;
    if (row.kind === "entry") return <span title={String(params.value ?? "")}>{params.value}</span>;
    const currentProps = propsRef.current;
    const draft = row.draft!;
    if (params.colDef.field === "employmentType") return <DraftSuggestionInput value={draft.employmentType} options={currentProps.employmentTypes} placeholder="Выберите или введите тип" listId={`${row.rowKey}-employment-types`} onChange={(employmentType) => currentProps.onPatchDraft({ employmentType })} />;
    if (params.colDef.field === "department") return <DraftSuggestionInput value={draft.department} options={currentProps.departments} placeholder="Выберите или введите отдел" listId={`${row.rowKey}-departments`} onChange={(department) => currentProps.onPatchDraft({ department })} />;
    return <input className="ag-inline-control" value={draft.position} placeholder="Должность" onChange={(event) => currentProps.onPatchDraft({ position: event.target.value })} />;
  }, [propsRef]);
  const actionRenderer = useCallback((params: CustomCellRendererProps<PositionTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const currentProps = propsRef.current;
    if (row.kind !== "entry") return <InlineDraftActions onCancel={currentProps.onCancelDraft} onSave={currentProps.onSaveDraft} />;
    const record = row.record!;
    if (row.pending) return <PendingDeleteAction label={record.position} onUndo={() => currentProps.onToggleDelete(record.id)} />;
    return <DefaultRowActions label={record.position} onEdit={() => currentProps.onEdit(record)} onDelete={() => currentProps.onToggleDelete(record.id)} />;
  }, [propsRef]);
  const columns = useMemo<ColDef<PositionTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "employmentType", headerName: "Тип", minWidth: 116, flex: .7, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer: editableRenderer },
    { field: "department", headerName: "Отдел", minWidth: 129, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer: editableRenderer },
    { field: "position", headerName: "Должность", minWidth: 162, flex: 2.2, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer: editableRenderer },
    { colId: "actions", headerName: "", width: 72, minWidth: 64, pinned: "right", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, cellClass: "actions-cell", cellRenderer: actionRenderer },
  ], [actionRenderer, editableRenderer, valueGetter]);
  const reportVisibleRows = useCallback((api: GridApi<PositionTableRow>) => { const ids: number[] = []; api.forEachNodeAfterFilterAndSort((node) => { if (node.data?.record?.id) ids.push(node.data.record.id); }); props.onVisibleIdsChange(ids); }, [props]);
  const defaultColDef = useMemo<ColDef<PositionTableRow>>(() => ({ filter: "agTextColumnFilter", floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><AgGridReact<PositionTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={50} headerHeight={48} rowClassRules={{ "delete-pending": (params) => Boolean(params.data?.record && props.pendingDeletes.includes(params.data.record.id)), "editable-row": (params) => params.data?.kind !== "entry" }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onModelUpdated={(event) => reportVisibleRows(event.api)} onFilterChanged={(event) => reportVisibleRows(event.api)} onSortChanged={(event) => reportVisibleRows(event.api)} suppressCellFocus /></div></AgGridProvider>;
}

function InlineDraftActions({ onCancel, onSave }: { onCancel: () => void; onSave: () => void }) {
  return <div className="row-actions"><button type="button" onClick={onCancel} title="Назад без сохранения" aria-label="Назад без сохранения"><GridIcon name="back" /></button><button type="button" onClick={onSave} title="Подтвердить изменения" aria-label="Подтвердить изменения"><GridIcon name="check" /></button></div>;
}
function PendingDeleteAction({ label, onUndo }: { label: string; onUndo: () => void }) {
  return <div className="row-actions"><button type="button" onClick={onUndo} title="Отменить удаление" aria-label={`Отменить удаление ${label}`}><GridIcon name="back" /></button></div>;
}
function DefaultRowActions({ label, onEdit, onDelete }: { label: string; onEdit: () => void; onDelete: () => void }) {
  return <div className="row-actions"><button type="button" onClick={onEdit} aria-label={`Редактировать ${label}`}><GridIcon name="pencil" /></button><button type="button" onClick={onDelete} aria-label={`Удалить ${label}`}><GridIcon name="trash" /></button></div>;
}

type UserTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; user?: GridUser; draft?: GridUserDraft; pending?: boolean };
type UserGridProps = { rows: GridUser[]; draft: GridUserDraft | null; sites: GridOption[]; pendingDeletes: number[]; onEdit: (user: GridUser) => void; onToggleDelete: (id: number) => void; onPatchDraft: (changes: Partial<GridUserDraft>) => void; onCancelDraft: () => void; onSaveDraft: () => void };

export function UserAgGrid(props: UserGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<UserTableRow> | null>(null);
  const draftKey = props.draft ? `user-${props.draft.id ?? "new"}` : "idle";
  useEffect(() => { requestAnimationFrame(() => gridApi.current?.refreshCells({ force: true })); }, [draftKey]);
  const rowData = useMemo<UserTableRow[]>(() => [
    ...props.rows.map((user, index) => props.draft?.id === user.id ? { rowKey: `user-${user.id}`, kind: "edit" as const, number: index + 1, user, draft: props.draft, pending: false } : { rowKey: `user-${user.id}`, kind: "entry" as const, number: index + 1, user, pending: props.pendingDeletes.includes(user.id) }),
    ...(props.draft && !props.draft.id ? [{ rowKey: "user-new", kind: "draft" as const, number: props.rows.length + 1, draft: props.draft }] : []),
  ], [props.draft, props.pendingDeletes, props.rows]);
  const valueGetter = useCallback((field: "number" | "fullName" | "email" | "role" | "site" | "status") => (params: { data?: UserTableRow }) => {
    const row = params.data; if (!row) return ""; if (field === "number") return row.number;
    if (field === "status") return row.kind === "entry" ? row.user?.status === "active" ? "Активен" : "Приглашён" : "После сохранения";
    const source = row.kind === "entry" ? row.user : row.draft; if (!source) return "";
    if (field === "role") return source.role === "foreman" ? "Прораб" : "Офис";
    if (field === "site") { const assigned = row.kind === "entry" ? row.user?.assignedSiteId : Number(row.draft?.assignedSiteId); return source.role === "office" ? "Все проекты" : propsRef.current.sites.find((site) => site.id === assigned)?.name ?? "Не назначен"; }
    return source[field] ?? "";
  }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<UserTableRow>) => {
    const row = params.data; if (!row) return null; if (row.kind === "entry") return <span title={String(params.value ?? "")}>{params.value}</span>;
    const currentProps = propsRef.current;
    const draft = row.draft!; const field = params.colDef.field;
    if (field === "fullName") return <input className="ag-inline-control" value={draft.fullName} placeholder="ФИО" onChange={(event) => currentProps.onPatchDraft({ fullName: event.target.value })} />;
    if (field === "email") return <input className="ag-inline-control" type="email" value={draft.email} placeholder="email@company.ru" onChange={(event) => currentProps.onPatchDraft({ email: event.target.value })} />;
    if (field === "status") return <span className="ag-autofill-value">{draft.id ? "Без изменений" : "Приглашение"}</span>;
    if (field === "role") return <select className="ag-inline-control" value={draft.role} onChange={(event) => currentProps.onPatchDraft({ role: event.target.value as "foreman" | "office", assignedSiteId: event.target.value === "office" ? "" : draft.assignedSiteId })}><option value="foreman">Прораб</option><option value="office">Офис</option></select>;
    if (draft.role === "office") return <span className="ag-autofill-value">Все проекты</span>;
    return <DraftSelect value={draft.assignedSiteId} options={currentProps.sites} placeholder="Проект" onChange={(assignedSiteId) => currentProps.onPatchDraft({ assignedSiteId })} />;
  }, [propsRef]);
  const actionRenderer = useCallback((params: CustomCellRendererProps<UserTableRow>) => { const row = params.data; if (!row) return null; const currentProps = propsRef.current; if (row.kind !== "entry") return <InlineDraftActions onCancel={currentProps.onCancelDraft} onSave={currentProps.onSaveDraft} />; const user = row.user!; if (row.pending) return <PendingDeleteAction label={user.fullName} onUndo={() => currentProps.onToggleDelete(user.id)} />; return <DefaultRowActions label={user.fullName} onEdit={() => currentProps.onEdit(user)} onDelete={() => currentProps.onToggleDelete(user.id)} />; }, [propsRef]);
  const columns = useMemo<ColDef<UserTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "fullName", headerName: "ФИО", minWidth: 260, flex: 1.2, headerComponentParams: pinnableHeader, valueGetter: valueGetter("fullName"), cellRenderer: editableRenderer },
    { field: "email", headerName: "Email", minWidth: 230, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("email"), cellRenderer: editableRenderer },
    { field: "status", headerName: "Статус", minWidth: 125, flex: .55, headerComponentParams: pinnableHeader, valueGetter: valueGetter("status"), cellRenderer: editableRenderer },
    { field: "role", headerName: "Роль", minWidth: 121, flex: .65, headerComponentParams: pinnableHeader, valueGetter: valueGetter("role"), cellRenderer: editableRenderer },
    { field: "site", headerName: "Доступ к проекту", minWidth: 220, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("site"), cellRenderer: editableRenderer },
    { colId: "actions", headerName: "", width: 72, minWidth: 64, pinned: "right", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, cellClass: "actions-cell", cellRenderer: actionRenderer },
  ], [actionRenderer, editableRenderer, valueGetter]);
  const defaultColDef = useMemo<ColDef<UserTableRow>>(() => ({ filter: "agTextColumnFilter", floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><AgGridReact<UserTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={50} headerHeight={48} rowClassRules={{ "delete-pending": (params) => Boolean(params.data?.user && props.pendingDeletes.includes(params.data.user.id)), "editable-row": (params) => params.data?.kind !== "entry" }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} suppressCellFocus /></div></AgGridProvider>;
}

type SiteTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; site?: GridSite; draft?: GridSiteDraft; pending?: boolean };
type ProjectGridProps = { rows: GridSite[]; draft: GridSiteDraft | null; pendingDeletes: number[]; onEdit: (site: GridSite) => void; onToggleDelete: (id: number) => void; onPatchDraft: (changes: Partial<GridSiteDraft>) => void; onCancelDraft: () => void; onSaveDraft: () => void };

export function ProjectAgGrid(props: ProjectGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<SiteTableRow> | null>(null);
  const draftKey = props.draft ? `site-${props.draft.id ?? "new"}` : "idle";
  useEffect(() => { requestAnimationFrame(() => gridApi.current?.refreshCells({ force: true })); }, [draftKey]);
  const rowData = useMemo<SiteTableRow[]>(() => [...props.rows.map((site, index) => props.draft?.id === site.id ? { rowKey: `site-${site.id}`, kind: "edit" as const, number: index + 1, site, draft: props.draft, pending: false } : { rowKey: `site-${site.id}`, kind: "entry" as const, number: index + 1, site, pending: props.pendingDeletes.includes(site.id) }), ...(props.draft && !props.draft.id ? [{ rowKey: "site-new", kind: "draft" as const, number: props.rows.length + 1, draft: props.draft }] : [])], [props.draft, props.pendingDeletes, props.rows]);
  const valueGetter = useCallback((field: "number" | "name") => (params: { data?: SiteTableRow }) => { const row = params.data; if (!row) return ""; if (field === "number") return row.number; return row.kind === "entry" ? row.site?.name ?? "" : row.draft?.name ?? ""; }, []);
  const editableRenderer = useCallback((params: CustomCellRendererProps<SiteTableRow>) => { const row = params.data; if (!row) return null; if (row.kind === "entry") return <span title={String(params.value ?? "")}>{params.value}</span>; const currentProps = propsRef.current; return <input className="ag-inline-control" value={row.draft?.name ?? ""} placeholder="Название проекта" onChange={(event) => currentProps.onPatchDraft({ name: event.target.value })} />; }, [propsRef]);
  const actionRenderer = useCallback((params: CustomCellRendererProps<SiteTableRow>) => { const row = params.data; if (!row) return null; const currentProps = propsRef.current; if (row.kind !== "entry") return <InlineDraftActions onCancel={currentProps.onCancelDraft} onSave={currentProps.onSaveDraft} />; const site = row.site!; if (row.pending) return <PendingDeleteAction label={site.name} onUndo={() => currentProps.onToggleDelete(site.id)} />; return <DefaultRowActions label={site.name} onEdit={() => currentProps.onEdit(site)} onDelete={() => currentProps.onToggleDelete(site.id)} />; }, [propsRef]);
  const columns = useMemo<ColDef<SiteTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "name", headerName: "Проект", minWidth: 300, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("name"), cellRenderer: editableRenderer },
    { colId: "actions", headerName: "", width: 72, minWidth: 64, pinned: "right", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, cellClass: "actions-cell", cellRenderer: actionRenderer },
  ], [actionRenderer, editableRenderer, valueGetter]);
  const defaultColDef = useMemo<ColDef<SiteTableRow>>(() => ({ filter: "agTextColumnFilter", floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true }), []);
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><AgGridReact<SiteTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={50} headerHeight={48} rowClassRules={{ "delete-pending": (params) => Boolean(params.data?.site && props.pendingDeletes.includes(params.data.site.id)), "editable-row": (params) => params.data?.kind !== "entry" }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} suppressCellFocus /></div></AgGridProvider>;
}
