"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { equipmentUnavailableReason, isEquipmentUnavailable } from "./equipmentAvailability";
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
  siteId: number | null;
  siteName: string | null;
};
export type GridEmployeeUsage = {
  employeeId: number;
  responsibleUserId: number | null;
  responsibleUserName: string;
  hours: number;
};
export type GridTimesheetMark = {
  employeeId: number;
  hours: number | null;
  code: string | null;
  note: string;
};
const EMPTY_EMPLOYEE_USAGE: GridEmployeeUsage[] = [];
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
  responsibleUserId?: number | null;
  responsibleUserName?: string;
  revision?: number;
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

type GridDisplayFields<Fields extends string> = {
  [Field in Fields]?: string | number;
};

type PlacementRow = {
  rowKey: string;
  kind: "entry" | "edit" | "draft";
  number: string | number;
  entry?: GridEntry;
  draft?: GridDraftRow;
  timesheetConflict?: { summary: string; details: string };
} & GridDisplayFields<"employeeName" | "responsibleUserName" | "employmentType" | "department" | "position" | "shift" | "zone" | "mainWork" | "subwork" | "master" | "hours" | "note">;

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

const TABLE_ROW_HEIGHT = 54;
const TABLE_HEADER_HEIGHT = 52;

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

function PinnableInnerHeader(props: CustomInnerHeaderProps) {
  const [pinned, setPinned] = useState(() => props.column.getPinned() === "left");
  const [filterActive, setFilterActive] = useState(() => props.column.isFilterActive());
  useEffect(() => {
    const updatePinned = () => setPinned(props.column.getPinned() === "left");
    const updateFilter = () => setFilterActive(props.column.isFilterActive());
    props.api.addEventListener("columnPinned", updatePinned);
    props.api.addEventListener("filterChanged", updateFilter);
    return () => {
      if (!props.api.isDestroyed()) {
        props.api.removeEventListener("columnPinned", updatePinned);
        props.api.removeEventListener("filterChanged", updateFilter);
      }
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
      responsibleUserName: entry.responsibleUserName || "Не назначен",
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
    responsibleUserName: entry?.responsibleUserName || (options.showResponsibleUser ? "Не назначен" : options.currentUserName || "Не назначен"),
  };
  return values[field] ?? "";
}

type PlacementGridProps = {
  entries: GridEntry[];
  draftRows: GridDraftRow[];
  editing: { id: number; row: GridDraftRow }[];
  employees: GridEmployee[];
  employeeUsage?: GridEmployeeUsage[];
  timesheetMarks?: GridTimesheetMark[];
  shifts: GridOption[];
  zones: GridOption[];
  mainWorkTypes: GridOption[];
  subworkTypes: GridOption[];
  masters: GridOption[];
  loading: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  rosterMode?: boolean;
  showResponsibleUser?: boolean;
  currentUserName?: string;
  pendingDeletes: number[];
  selectedDraftKeys: string[];
  onEdit: (entry: GridEntry, changes?: Partial<GridDraftRow>) => void;
  onSelectionChange: (ids: number[]) => void;
  onDraftSelectionChange: (keys: string[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridDraftRow>) => void;
  onPatchEditing: (id: number, changes: Partial<GridDraftRow>) => void;
  onVisibleEntryIdsChange: (ids: number[]) => void;
};

const placementEditableFields = ["employeeName", "shift", "zone", "mainWork", "subwork", "master", "hours", "note"] as const;
type PlacementEditableField = typeof placementEditableFields[number];

const TIMESHEET_CODE_LABELS: Record<string, string> = {
  "В": "Выходной",
  "ДО": "Дополнительный отпуск",
  "МО": "Межвахтовый отдых",
  "ПЕ": "ПЕ",
  "УВ": "УВ",
  "ПР": "Прогул",
};

function DraftSelect({ value, options, placeholder, onChange, autoOpen = false }: { value: string; options: GridOption[]; placeholder: string; onChange: (value: string) => void; autoOpen?: boolean }) {
  return <CustomSelect className="ag-custom-select" value={value} ariaLabel={placeholder} onChange={onChange} autoOpen={autoOpen} searchable options={[{ value: "", label: placeholder }, ...options.map((option) => ({ value: String(option.id), label: option.name }))]} />;
}

function DraftNameSelect({ value, options, placeholder, onChange, autoOpen = false }: { value: string; options: GridOption[]; placeholder: string; onChange: (value: string) => void; autoOpen?: boolean }) {
  return <CustomSelect className="ag-custom-select" value={value} ariaLabel={placeholder} onChange={onChange} autoOpen={autoOpen} searchable options={[{ value: "", label: placeholder }, ...options.map((option) => ({ value: option.name, label: option.name }))]} />;
}

function EditableCellDisplay({ value, menuLabel, onOpen }: { value: string | number; menuLabel?: string; onOpen?: () => void }) {
  return <span className="ag-editable-cell-display" title={String(value)}>
    <span>{value}</span>
    {onOpen && <button type="button" className="ag-editable-cell-menu" title={`Открыть список: ${menuLabel ?? "значение"}`} aria-label={`Открыть список: ${menuLabel ?? "значение"}`} onClick={(event) => { event.stopPropagation(); onOpen(); }}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg></button>}
  </span>;
}

function EmployeeTextEditor({ value, onChange, onBlur, onEnter, deferChangeUntilBlur = false, focusOnMount = true, placeholder = "ФИО сотрудника" }: { value: string; onChange: (value: string) => void; onBlur?: () => void; onEnter?: () => void; deferChangeUntilBlur?: boolean; focusOnMount?: boolean; placeholder?: string }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusOnMount) { input.current?.focus(); input.current?.select(); } }, [focusOnMount]);
  const commit = () => {
    const nextValue = input.current?.value ?? value;
    if (deferChangeUntilBlur && nextValue !== value) onChange(nextValue);
  };
  return <input ref={input} className="ag-inline-control" defaultValue={value} placeholder={placeholder} onBlur={() => { commit(); onBlur?.(); }} onChange={(event) => { if (!deferChangeUntilBlur) onChange(event.target.value); }} onKeyDown={(event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    commit();
    onEnter?.();
  }} />;
}

function normalizeSearch(value: string) {
  return value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim().replace(/\s+/g, " ");
}

function EmployeeCombobox({ value, employees, usage = EMPTY_EMPLOYEE_USAGE, onChange, autoOpen = false }: { value: string; employees: GridEmployee[]; usage?: GridEmployeeUsage[]; onChange: (employeeQuery: string, employeeId: string) => void; autoOpen?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState(value);
  const [searchQuery, setSearchQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 360 });
  const query = normalizeSearch(searchQuery);
  const filtered = useMemo(() => employees.filter((employee) => normalizeSearch(`${employee.fullName} ${employee.employmentType} ${employee.department} ${employee.position}`).includes(query)).slice(0, 50), [employees, query]);
  const usageByEmployee = useMemo(() => {
    const grouped = new Map<number, GridEmployeeUsage[]>();
    for (const item of usage) grouped.set(item.employeeId, [...(grouped.get(item.employeeId) ?? []), item]);
    return grouped;
  }, [usage]);

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

  useEffect(() => {
    if (!autoOpen) return;
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
      setOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [autoOpen]);

  function select(employee: GridEmployee) {
    const used = (usageByEmployee.get(employee.id) ?? []).reduce((sum, item) => sum + Number(item.hours), 0);
    if (used >= 10) return;
    setInputValue(employee.fullName);
    setSearchQuery("");
    onChange(employee.fullName, String(employee.id));
    setOpen(false);
  }

  return <div className="ag-employee-combobox" ref={root}>
    <input
      ref={input}
      className="ag-inline-control"
      value={inputValue}
      placeholder="Начните вводить ФИО"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls="employee-search-options"
      onFocus={(event) => {
        const input = event.currentTarget;
        setSearchQuery("");
        setActiveIndex(0);
        setOpen(true);
        requestAnimationFrame(() => input.select());
      }}
      onClick={() => setOpen(true)}
      onChange={(event) => {
        const employeeQuery = event.target.value;
        setInputValue(employeeQuery);
        setSearchQuery(employeeQuery);
        setActiveIndex(0);
        setOpen(true);
      }}
      onBlur={() => {
        if (inputValue === value) return;
        const exact = employees.find((employee) => normalizeSearch(employee.fullName) === normalizeSearch(inputValue));
        onChange(inputValue, exact ? String(exact.id) : "");
        setSearchQuery("");
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); setOpen(true); setActiveIndex((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0))); }
        if (event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); setOpen(true); setActiveIndex((index) => Math.max(index - 1, 0)); }
        if (event.key === "Enter" && open && filtered[activeIndex]) { event.preventDefault(); event.stopPropagation(); select(filtered[activeIndex]); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        if (event.key === "Tab") setOpen(false);
      }}
    />
    <span className="ag-combobox-chevron" aria-hidden="true">⌄</span>
    {open && typeof document !== "undefined" && createPortal(<div id="employee-search-options" ref={menu} className="ag-employee-menu" role="listbox" style={position}>
      <div className="ag-employee-menu-caption">{query ? `Найдено: ${filtered.length}` : "Начните вводить имя или выберите сотрудника"}</div>
      <div className="ag-employee-options">
        {filtered.map((employee, index) => {
          const employeeUsage = usageByEmployee.get(employee.id) ?? [];
          const used = employeeUsage.reduce((sum, item) => sum + Number(item.hours), 0);
          const contributors = employeeUsage.map((item) => `${item.responsibleUserName} — ${item.hours} ч.`).join("; ");
          const exhausted = used >= 10;
          return <button key={employee.id} type="button" role="option" aria-selected={index === activeIndex} aria-disabled={exhausted} disabled={exhausted} className={[index === activeIndex ? "active" : "", exhausted ? "hours-exhausted" : ""].filter(Boolean).join(" ")} title={exhausted ? "Лимит 10 часов за день уже исчерпан" : undefined} onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => select(employee)}><strong>{employee.fullName}</strong><span>{employee.employmentType} · {employee.department} · {employee.position}</span>{used > 0 && <span className="ag-employee-usage">Учтено {used} ч. · доступно {Math.max(0, 10 - used)} ч.{contributors ? ` · ${contributors}` : ""}{exhausted ? " · лимит исчерпан" : ""}</span>}</button>;
        })}
        {!filtered.length && <p>Сотрудники не найдены</p>}
      </div>
    </div>, document.body)}
  </div>;
}

export function PlacementAgGrid(props: PlacementGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<PlacementRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<{ rowKey: string; field: PlacementEditableField } | null>(null);
  const [spreadsheetFocusRequestKey, setSpreadsheetFocusRequestKey] = useState(0);
  const selectedIdsKey = props.pendingDeletes.join("|");
  const selectedDraftKeysKey = props.selectedDraftKeys.join("|");
  const editingStructureKey = props.editing.map((item) => item.id).join("|");
  const manualDraftCount = props.draftRows.filter((row) => !row.lockedEmployee).length;
  const previousManualDraftCount = useRef(manualDraftCount);
  const editingById = useMemo(() => new Map(props.editing.map((item) => [item.id, item.row])), [props.editing]);
  const rowData = useMemo<PlacementRow[]>(() => {
    const reportHoursByEmployee = new Map<number, number>();
    const addReportHours = (employeeId: number, hours: number) => {
      if (!employeeId || !Number.isFinite(hours)) return;
      reportHoursByEmployee.set(employeeId, (reportHoursByEmployee.get(employeeId) ?? 0) + hours);
    };
    if (props.employeeUsage?.length) {
      for (const usage of props.employeeUsage) addReportHours(usage.employeeId, Number(usage.hours));
    } else {
      for (const entry of props.entries) addReportHours(entry.employeeId, Number(entry.hours));
    }
    for (const entry of props.entries) {
      const edited = editingById.get(entry.id);
      if (!edited) continue;
      addReportHours(entry.employeeId, -Number(entry.hours));
      addReportHours(Number(edited.employeeId || entry.employeeId), Number(edited.hours || entry.hours));
    }
    for (const draft of props.draftRows) addReportHours(Number(draft.employeeId), Number(draft.hours));
    const timesheetMarkByEmployee = new Map((props.timesheetMarks ?? []).map((mark) => [mark.employeeId, mark]));
    const timesheetConflict = (employeeId: number) => {
      const mark = timesheetMarkByEmployee.get(employeeId);
      if (!mark) return undefined;
      const reportHours = reportHoursByEmployee.get(employeeId) ?? 0;
      if (mark.code) {
        const label = TIMESHEET_CODE_LABELS[mark.code] ?? mark.code;
        return {
          summary: `Табель: ${mark.code} — ${label}`,
          details: `Несовпадение с табелем: ${mark.code} — ${label}${mark.note ? `. ${mark.note}` : ""}. В отчёте указана работа: ${reportHours} ч.`,
        };
      }
      if (mark.hours !== null && Number(mark.hours) !== reportHours) {
        return {
          summary: `Табель: ${mark.hours} ч. · отчёт: ${reportHours} ч.`,
          details: `Несовпадение с табелем: в табеле ${mark.hours} ч., в отчёте ${reportHours} ч.${mark.note ? ` ${mark.note}` : ""}`,
        };
      }
      return undefined;
    };
    const rows: PlacementRow[] = [
      ...props.entries.map((entry, index) => {
      const edited = editingById.get(entry.id);
      const employeeId = Number(edited?.employeeId || entry.employeeId);
      return edited
        ? { rowKey: `entry-${entry.id}`, kind: "edit" as const, number: index + 1, entry, draft: edited, timesheetConflict: timesheetConflict(employeeId) }
        : { rowKey: `entry-${entry.id}`, kind: "entry" as const, number: index + 1, entry, timesheetConflict: timesheetConflict(employeeId) };
      }),
      ...props.draftRows.map((draft, index) => ({ rowKey: `draft-${draft.key}`, kind: "draft" as const, number: props.entries.length + index + 1, draft, timesheetConflict: timesheetConflict(Number(draft.employeeId)) })),
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
  const rowStructureKey = rowData.map((row) => row.rowKey).sort().join("|");

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
    const selectedDrafts = new Set(props.selectedDraftKeys);
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(
        (node.data?.entry && selected.has(node.data.entry.id))
        || (node.data?.draft && node.data.kind === "draft" && selectedDrafts.has(node.data.draft.key)),
      )));
    });
    // String keys intentionally track changes without depending on newly created arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDraftKeysKey, selectedIdsKey]);

  const patchRow = useCallback((row: PlacementRow, changes: Partial<GridDraftRow>) => {
    if (row.kind === "edit" && row.entry) props.onPatchEditing(row.entry.id, changes);
    if (row.kind === "draft" && row.draft) props.onPatchDraft(row.draft.key, changes);
  }, [props]);

  const openCellEditor = useCallback((row: PlacementRow, columnId: string) => {
    const current = propsRef.current;
    const canEditRow = row.kind === "draft" ? current.canCreate : current.canUpdate;
    if (!canEditRow || !placementEditableFields.includes(columnId as PlacementEditableField)) return false;
    if (columnId === "employeeName" && row.draft?.lockedEmployee) return false;
    if (row.kind === "entry") {
      if (!row.entry || (!current.rosterMode && current.draftRows.length > 0) || current.pendingDeletes.includes(row.entry.id)) return false;
      current.onEdit(row.entry);
    } else if (!row.draft) return false;
    setActiveEditor({ rowKey: row.rowKey, field: columnId as PlacementEditableField });
    return true;
  }, [propsRef]);

  const editableRenderer = useCallback((params: CustomCellRendererProps<PlacementRow>) => {
    const row = params.data;
    if (!row) return null;
    const field = params.colDef?.field as PlacementEditableField | undefined;
    const warning = field === "employeeName" && row.timesheetConflict
      ? <small className="ag-timesheet-conflict" title={row.timesheetConflict.details}>⚠ {row.timesheetConflict.summary}</small>
      : null;
    if (row.kind === "entry") {
      if (field === "employeeName") return <div className="ag-roster-employee-wrap"><span className="ag-roster-employee" title={String(params.value ?? "")}>{params.value || "—"}</span>{warning}</div>;
      return field === "hours" ? <strong>{params.value}</strong> : <span title={String(params.value ?? "")}>{params.value || "—"}</span>;
    }
    const draft = row.draft;
    if (!draft) return null;
    if (field === "employeeName") {
      if (draft.lockedEmployee) {
        const employeeUsage = (props.employeeUsage ?? []).filter((item) => item.employeeId === Number(draft.employeeId));
        const used = employeeUsage.reduce((sum, item) => sum + Number(item.hours), 0);
        return <div className="ag-roster-employee-wrap"><span className="ag-roster-employee" title={draft.employeeQuery}>{draft.employeeQuery}</span>{warning ?? (used > 0 && <small>Сегодня учтено {used} ч. · доступно {Math.max(0, 10 - used)} ч.</small>)}</div>;
      }
    }
    const activeCellEditor = Boolean(field && activeEditor?.rowKey === row.rowKey && activeEditor.field === field);
    if (!activeCellEditor) {
      const editable = Boolean(field && placementEditableFields.includes(field));
      const value = params.value || (editable ? "Не заполнено" : "—");
      const hasMenu = editable && field !== "note";
      return editable
        ? field === "employeeName" && warning
          ? <div className="ag-roster-employee-wrap"><EditableCellDisplay value={value} menuLabel={params.colDef?.headerName} onOpen={hasMenu && field ? () => openCellEditor(row, field) : undefined} />{warning}</div>
          : <EditableCellDisplay value={value} menuLabel={params.colDef?.headerName} onOpen={hasMenu && field ? () => openCellEditor(row, field) : undefined} />
        : <span className="ag-autofill-value" title={String(value)}>{value}</span>;
    }
    const patchAndClose = (changes: Partial<GridDraftRow>) => { patchRow(row, changes); setActiveEditor(null); setSpreadsheetFocusRequestKey((key) => key + 1); };
    if (field === "employeeName") {
        const usage = row.kind === "edit" && row.entry
          ? (props.employeeUsage ?? []).flatMap((item) => {
              const sameEntryBucket = item.employeeId === row.entry!.employeeId && item.responsibleUserId === (row.entry!.responsibleUserId ?? null);
              if (!sameEntryBucket) return [item];
              const hours = Math.max(0, Number(item.hours) - Number(row.entry!.hours));
              return hours > 0 ? [{ ...item, hours }] : [];
            })
          : props.employeeUsage ?? [];
        return <div className="ag-cell-editor-host"><EmployeeCombobox autoOpen value={draft.employeeQuery} employees={props.employees} usage={usage} onChange={(employeeQuery, employeeId) => patchAndClose({ employeeQuery, employeeId })} /></div>;
    }
    if (field === "shift") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.shiftId} options={props.shifts} placeholder="Смена" onChange={(shiftId) => patchAndClose({ shiftId })} /></div>;
    if (field === "zone") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.zoneId} options={props.zones} placeholder="Зона" onChange={(zoneId) => patchAndClose({ zoneId })} /></div>;
    if (field === "mainWork") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.mainWorkTypeId} options={props.mainWorkTypes} placeholder="Работа" onChange={(mainWorkTypeId) => patchAndClose({ mainWorkTypeId })} /></div>;
    if (field === "subwork") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.subworkTypeId} options={props.subworkTypes} placeholder="Вид подработ" onChange={(subworkTypeId) => patchAndClose({ subworkTypeId })} /></div>;
    if (field === "master") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.masterId} options={props.masters} placeholder="Мастер" onChange={(masterId) => patchAndClose({ masterId })} /></div>;
    if (field === "hours") return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" value={draft.hours} ariaLabel="Часы" autoOpen onChange={(hours) => patchAndClose({ hours })} options={[{ value: "", label: "—" }, ...Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))]} /></div>;
    if (field === "note") return <div className="ag-cell-editor-host"><EmployeeTextEditor deferChangeUntilBlur value={draft.note} placeholder="Необязательно" onBlur={() => setActiveEditor(null)} onEnter={() => { setActiveEditor(null); setSpreadsheetFocusRequestKey((key) => key + 1); }} onChange={(note) => patchRow(row, { note })} /></div>;
    return <span className="ag-autofill-value">{params.value}</span>;
  }, [activeEditor, openCellEditor, patchRow, props]);

  const { employees, shifts, zones, mainWorkTypes, subworkTypes, masters, onEdit } = props;
  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<PlacementRow>) => {
    const current = propsRef.current;
    if (row.kind === "draft" ? !current.canCreate : !current.canUpdate) return false;
    if (row.kind !== "entry" && !row.draft) return false;
    if (row.kind === "entry" && current.draftRows.length) return false;
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
  const columns = useMemo<ColDef<PlacementRow>[]>(() => {
    const result: ColDef<PlacementRow>[] = [
      { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, lockPosition: "left", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
      { field: "employeeName", headerName: "ФИО", minWidth: 220, flex: 2.2, pinned: props.rosterMode ? "left" : undefined, lockPinned: props.rosterMode, lockPosition: props.rosterMode ? "left" : undefined, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employeeName"), cellRenderer: editableRenderer },
    ];
    if (props.showResponsibleUser) result.push({ field: "responsibleUserName", headerName: "Ответственный прораб", minWidth: 180, flex: 1.3, headerComponentParams: pinnableHeader, valueGetter: valueGetter("responsibleUserName"), cellRenderer: editableRenderer });
    result.push(
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
    );
    return result;
  }, [editableRenderer, props.rosterMode, props.showResponsibleUser, valueGetter]);

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
    rowHeight={TABLE_ROW_HEIGHT}
    headerHeight={TABLE_HEADER_HEIGHT}
    loading={props.loading}
    loadingOverlayComponent={() => <span className="ag-overlay-message">Загружаем отчёт…</span>}
    noRowsOverlayComponent={() => <span className="ag-overlay-message">Записей пока нет</span>}
    rowClassRules={{
      "editable-row": (params) => params.data?.kind === "edit" || params.data?.kind === "draft",
      "carried-row": (params) => Boolean(params.data?.draft?.carriedFromPreviousDay),
      "timesheet-conflict-row": (params) => Boolean(params.data?.timesheetConflict),
    }}
    rowSelection={{ mode: "multiRow", checkboxes: (params) => {
      const current = propsRef.current;
      const allowed = params.data?.kind === "draft" ? current.canCreate : Boolean(params.data?.entry) && (current.canUpdate || current.canDelete);
      return Boolean(allowed && (current.rosterMode || current.draftRows.length === 0 && current.editing.length === 0 && params.data?.kind === "entry"));
    }, headerCheckbox: props.rosterMode ? props.canCreate || props.canUpdate || props.canDelete : (props.canUpdate || props.canDelete) && props.draftRows.length === 0 && props.editing.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => {
      const current = propsRef.current;
      const allowed = node.data?.kind === "draft" ? current.canCreate : Boolean(node.data?.entry) && (current.canUpdate || current.canDelete);
      return Boolean(allowed && (current.rosterMode || current.draftRows.length === 0 && current.editing.length === 0 && node.data?.kind === "entry"));
    } }}
    selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }}
    onGridReady={(event: GridReadyEvent<PlacementRow>) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }}
    onGridSizeChanged={(event) => event.api.sizeColumnsToFit()}
    onColumnResized={keepGridFilled}
    onModelUpdated={(event) => reportVisibleRows(event.api)}
    onFilterChanged={(event) => reportVisibleRows(event.api)}
    onSortChanged={(event) => reportVisibleRows(event.api)}
    onSelectionChanged={(event) => {
      const selected = event.api.getSelectedRows();
      propsRef.current.onSelectionChange(selected.flatMap((row) => row.entry?.id ? [row.entry.id] : []));
      propsRef.current.onDraftSelectionChange(selected.flatMap((row) => row.kind === "draft" && row.draft ? [row.draft.key] : []));
    }}
    onCellMouseDown={(event) => { if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return; const rowKey = event.data?.rowKey; const field = event.column.getColId(); if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null); }}
    onCellDoubleClicked={(event) => { const row = event.data; if (row && !isInteractiveGridTarget(event.event)) openCellEditor(row, event.column.getColId()); }}
    onSpreadsheetPaste={pasteIntoRow}
    onSpreadsheetEdit={({ row, columnId }) => openCellEditor(row, columnId)}
    onSpreadsheetCancelEdit={() => setActiveEditor(null)}
    spreadsheetFocusRequestKey={spreadsheetFocusRequestKey}
    spreadsheetSelectionResetKey={rowStructureKey}
    suppressCellFocus
  /></div></AgGridProvider>;
}

export type GridEquipmentUnit = {
  id: number;
  organization: string;
  equipmentType: string;
  brand: string;
  model: string;
  registrationNumber: string;
  note: string;
  assignedSiteId?: number | null;
  assignedSiteName?: string | null;
};

export type GridEquipmentTimesheetMark = {
  equipmentId: number;
  workDate: string;
  productiveHours: number;
  downtimeHours: number;
  note: string;
  updatedBy: string;
};

export type GridEquipmentRegistryDraft = {
  key: string;
  id?: number;
  organization: string;
  equipmentType: string;
  brand: string;
  model: string;
  registrationNumber: string;
  note: string;
  projectSiteId: string;
};

export type GridProjectEquipmentDraft = {
  key: string;
  equipmentId: string;
};

export type GridEquipmentEntry = GridEquipmentUnit & {
  id: number;
  workDate: string;
  equipmentId: number;
  shiftId: number;
  zoneId: number;
  mainWorkTypeId: number;
  subworkTypeId: number;
  hours: number;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  responsibleUserId: number | null;
  responsibleUserName: string;
  revision: number;
};

export type GridEquipmentDraft = {
  key: string;
  id?: number;
  carriedFromPreviousDay?: boolean;
  equipmentId: string;
  shiftId: string;
  zoneId: string;
  mainWorkTypeId: string;
  subworkTypeId: string;
  hours: string;
  note: string;
  revision?: number;
};

type EquipmentTableRow = {
  rowKey: string;
  kind: "entry" | "edit" | "draft";
  number: number;
  entry?: GridEquipmentEntry;
  draft?: GridEquipmentDraft;
  timesheetConflict?: { summary: string; details: string };
} & GridDisplayFields<"equipment" | "organization" | "responsibleUserName" | "shift" | "zone" | "mainWork" | "subwork" | "note" | "hours">;

const equipmentEditableFields = ["equipment", "shift", "zone", "mainWork", "subwork", "note", "hours"] as const;
type EquipmentEditableField = typeof equipmentEditableFields[number];

type EquipmentGridProps = {
  entries: GridEquipmentEntry[];
  drafts: GridEquipmentDraft[];
  units: GridEquipmentUnit[];
  dailyTimesheetMarks: GridEquipmentTimesheetMark[];
  shifts: GridOption[];
  zones: GridOption[];
  mainWorkTypes: GridOption[];
  subworkTypes: GridOption[];
  loading: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  showResponsibleUser?: boolean;
  currentUserName?: string;
  selectedIds: number[];
  selectedDraftKeys: string[];
  onEdit: (entry: GridEquipmentEntry, changes?: Partial<GridEquipmentDraft>) => void;
  onPatchDraft: (key: string, changes: Partial<GridEquipmentDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
  onDraftSelectionChange: (keys: string[]) => void;
};

function equipmentGridTitle(unit: GridEquipmentUnit | undefined) {
  if (!unit) return "";
  return [unit.equipmentType, unit.brand, unit.model, unit.registrationNumber && unit.registrationNumber !== "-" ? `• ${unit.registrationNumber}` : ""].filter(Boolean).join(" ");
}

const EMPTY_BLOCKED_EQUIPMENT = new Map<number, string>();

function EquipmentCombobox({ value, units, blockedEquipment = EMPTY_BLOCKED_EQUIPMENT, onChange, autoOpen = false }: { value: string; units: GridEquipmentUnit[]; blockedEquipment?: Map<number, string>; onChange: (equipmentId: string) => void; autoOpen?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedUnit = units.find((unit) => String(unit.id) === value);
  const selectedTitle = equipmentGridTitle(selectedUnit);
  const [inputValue, setInputValue] = useState(selectedTitle);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 420 });
  const query = normalizeSearch(inputValue);
  const filtered = useMemo(() => units.filter((unit) => normalizeSearch([
    equipmentGridTitle(unit),
    unit.organization,
    unit.equipmentType,
    unit.brand,
    unit.model,
    unit.registrationNumber,
    unit.note,
  ].join(" ")).includes(query)).slice(0, 50), [query, units]);

  const selectableIndex = useCallback((start: number, direction: 1 | -1) => {
    if (!filtered.length) return 0;
    let index = Math.max(0, Math.min(start, filtered.length - 1));
    for (let attempts = 0; attempts < filtered.length; attempts += 1) {
      if (!blockedEquipment.has(filtered[index].id)) return index;
      index = (index + direction + filtered.length) % filtered.length;
    }
    return Math.max(0, Math.min(start, filtered.length - 1));
  }, [blockedEquipment, filtered]);

  const updatePosition = useCallback(() => {
    const input = root.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    const menuHeight = Math.min(292, 46 + filtered.length * 52);
    const spaceBelow = window.innerHeight - rect.bottom;
    const width = Math.min(Math.max(420, rect.width), window.innerWidth - 16);
    const top = spaceBelow >= Math.min(menuHeight, 190) ? rect.bottom + 5 : Math.max(8, rect.top - menuHeight - 5);
    setPosition({ top, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width });
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

  useEffect(() => {
    if (!autoOpen) return;
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
      setOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [autoOpen]);

  function select(unit: GridEquipmentUnit) {
    if (blockedEquipment.has(unit.id)) return;
    setInputValue(equipmentGridTitle(unit));
    onChange(String(unit.id));
    setOpen(false);
  }

  return <div className="ag-employee-combobox ag-equipment-combobox" ref={root}>
    <input
      ref={input}
      className="ag-inline-control"
      value={inputValue}
      placeholder="Начните вводить название техники"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listboxId}
      onFocus={() => setOpen(true)}
      onClick={() => setOpen(true)}
      onChange={(event) => {
        setInputValue(event.target.value);
        setActiveIndex(selectableIndex(0, 1));
        setOpen(true);
      }}
      onBlur={() => {
        if (normalizeSearch(inputValue) === normalizeSearch(selectedTitle)) return;
        const exact = units.find((unit) => normalizeSearch(equipmentGridTitle(unit)) === normalizeSearch(inputValue));
        onChange(exact ? String(exact.id) : "");
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActiveIndex((index) => selectableIndex(index + 1, 1)); }
        if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => selectableIndex(index - 1, -1)); }
        if (event.key === "Enter" && open && filtered[activeIndex] && !blockedEquipment.has(filtered[activeIndex].id)) { event.preventDefault(); select(filtered[activeIndex]); }
        if (event.key === "Escape") setOpen(false);
      }}
    />
    <span className="ag-combobox-chevron" aria-hidden="true">⌄</span>
    {open && typeof document !== "undefined" && createPortal(<div id={listboxId} ref={menu} className="ag-employee-menu ag-equipment-menu" role="listbox" style={position}>
      <div className="ag-employee-menu-caption">{query ? `Найдено: ${filtered.length}` : "Начните вводить название или выберите технику"}</div>
      <div className="ag-employee-options">
        {filtered.map((unit, index) => {
          const blockedReason = blockedEquipment.get(unit.id);
          return <button key={unit.id} type="button" role="option" aria-selected={index === activeIndex} aria-disabled={Boolean(blockedReason)} disabled={Boolean(blockedReason)} className={[index === activeIndex ? "active" : "", blockedReason ? "hours-exhausted equipment-plan-blocked" : ""].filter(Boolean).join(" ")} title={blockedReason} onMouseEnter={() => { if (!blockedReason) setActiveIndex(index); }} onMouseDown={(event) => event.preventDefault()} onClick={() => select(unit)}><strong>{equipmentGridTitle(unit)}</strong><span>{unit.organization}{"assignedSiteId" in unit ? ` · ${unit.assignedSiteName ? `проект: ${unit.assignedSiteName}` : "не назначена"}` : ""}{unit.note ? ` · ${unit.note}` : ""}</span>{blockedReason && <span className="ag-employee-usage">Недоступна по табелю · {blockedReason}</span>}</button>;
        })}
        {!filtered.length && <p>Техника не найдена</p>}
      </div>
    </div>, document.body)}
  </div>;
}

export function EquipmentDailyAgGrid(props: EquipmentGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<EquipmentTableRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<{ rowKey: string; field: EquipmentEditableField } | null>(null);
  const [spreadsheetFocusRequestKey, setSpreadsheetFocusRequestKey] = useState(0);
  const draftStructureKey = props.drafts.map((draft) => draft.id ? `edit-${draft.id}` : draft.key).join("|");
  const draftValuesKey = props.drafts.map((draft) => `${draft.key}:${draft.equipmentId}:${draft.shiftId}:${draft.zoneId}:${draft.mainWorkTypeId}:${draft.subworkTypeId}:${draft.hours}:${draft.note}`).join("|");
  const selectedIdsKey = props.selectedIds.join("|");
  const selectedDraftKeysKey = props.selectedDraftKeys.join("|");
  const editingById = useMemo(() => new Map(props.drafts.flatMap((draft) => draft.id ? [[draft.id, draft] as const] : [])), [props.drafts]);
  const blockedEquipment = useMemo(() => new Map(props.dailyTimesheetMarks
    .filter(isEquipmentUnavailable)
    .map((mark) => [mark.equipmentId, equipmentUnavailableReason(mark)])), [props.dailyTimesheetMarks]);
  const timesheetConflict = useCallback((equipmentId: number) => {
    const mark = props.dailyTimesheetMarks.find((candidate) => candidate.equipmentId === equipmentId
      && isEquipmentUnavailable(candidate));
    if (!mark) return undefined;
    const reason = equipmentUnavailableReason(mark);
    return {
      summary: `Недоступна: ${reason}`,
      details: `Техника недоступна по табелю: ${reason}. Удалите её из отчёта или исправьте отметку в табеле техники.`,
    };
  }, [props.dailyTimesheetMarks]);
  const rowData = useMemo<EquipmentTableRow[]>(() => [
    ...props.entries.map((entry, index) => {
      const draft = editingById.get(entry.id);
      return draft
        ? { rowKey: `equipment-${entry.id}`, kind: "edit" as const, number: index + 1, entry, draft, timesheetConflict: timesheetConflict(Number(draft.equipmentId || entry.equipmentId)) }
        : { rowKey: `equipment-${entry.id}`, kind: "entry" as const, number: index + 1, entry, timesheetConflict: timesheetConflict(entry.equipmentId) };
    }),
    ...props.drafts.filter((draft) => !draft.id).map((draft, index) => ({ rowKey: `equipment-new-${draft.key}`, kind: "draft" as const, number: props.entries.length + index + 1, draft, timesheetConflict: timesheetConflict(Number(draft.equipmentId)) })),
  ], [editingById, props.drafts, props.entries, timesheetConflict]);

  useEffect(() => {
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.refreshClientSideRowModel("everything");
      api.refreshCells({ force: true });
      api.redrawRows();
    });
  }, [draftStructureKey, draftValuesKey]);

  useEffect(() => {
    const selected = new Set(props.selectedIds);
    const selectedDrafts = new Set(props.selectedDraftKeys);
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(
        (node.data?.entry && selected.has(node.data.entry.id))
        || (node.data?.kind === "draft" && node.data.draft && selectedDrafts.has(node.data.draft.key)),
      )));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDraftKeysKey, selectedIdsKey]);

  useEffect(() => {
    if (activeEditor && rowData.some((row) => row.rowKey === activeEditor.rowKey && row.draft)) return;
    if (!activeEditor) return;
    const frame = requestAnimationFrame(() => setActiveEditor(null));
    return () => cancelAnimationFrame(frame);
  }, [activeEditor, rowData]);

  const unitOptions = useMemo(() => props.units.map((unit) => ({ id: unit.id, name: equipmentGridTitle(unit) })), [props.units]);
  const patchRow = useCallback((row: EquipmentTableRow, changes: Partial<GridEquipmentDraft>) => {
    const draft = row.draft;
    if (draft) propsRef.current.onPatchDraft(draft.key, changes);
  }, [propsRef]);
  const openCellEditor = useCallback((row: EquipmentTableRow, columnId: string) => {
    const current = propsRef.current;
    const canEditRow = row.kind === "draft" ? current.canCreate : current.canUpdate;
    if (!canEditRow || !equipmentEditableFields.includes(columnId as EquipmentEditableField)) return false;
    if (row.kind === "entry" && row.entry) propsRef.current.onEdit(row.entry);
    else if (!row.draft) return false;
    setActiveEditor({ rowKey: row.rowKey, field: columnId as EquipmentEditableField });
    return true;
  }, [propsRef]);
  const valueGetter = useCallback((field: string) => (params: { data?: EquipmentTableRow }) => {
    const row = params.data;
    if (!row) return "";
    if (field === "number") return row.number;
    const draft = row.draft;
    const entry = row.entry;
    const unit = draft ? propsRef.current.units.find((item) => item.id === Number(draft.equipmentId)) : entry;
    const values: Record<string, string | number> = {
      equipment: equipmentGridTitle(unit),
      organization: unit?.organization ?? "",
      responsibleUserName: entry?.responsibleUserName || (propsRef.current.showResponsibleUser ? "Офис" : propsRef.current.currentUserName || "—"),
      shift: draft ? optionName(propsRef.current.shifts, draft.shiftId) : entry?.shiftName ?? "",
      zone: draft ? optionName(propsRef.current.zones, draft.zoneId) : entry?.zoneName ?? "",
      mainWork: draft ? optionName(propsRef.current.mainWorkTypes, draft.mainWorkTypeId) : entry?.mainWorkTypeName ?? "",
      subwork: draft ? optionName(propsRef.current.subworkTypes, draft.subworkTypeId) : entry?.subworkTypeName ?? "",
      note: draft?.note ?? entry?.note ?? "",
      hours: draft?.hours ?? entry?.hours ?? "",
    };
    return values[field] ?? "";
  }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<EquipmentTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const field = params.colDef?.field as EquipmentEditableField | "organization" | "responsibleUserName" | undefined;
    const warning = field === "equipment" && row.timesheetConflict
      ? <small className="ag-timesheet-conflict" title={row.timesheetConflict.details}>⚠ {row.timesheetConflict.summary}</small>
      : null;
    const activeCellEditor = Boolean(field && row.draft && activeEditor?.rowKey === row.rowKey && activeEditor.field === field);
    if (!activeCellEditor) {
      const editable = Boolean(field && equipmentEditableFields.includes(field as EquipmentEditableField));
      const hasMenu = editable && field !== "note" && row.kind !== "entry";
      const value = params.value || (editable && row.kind !== "entry" ? "Не заполнено" : "—");
      if (field === "hours" && row.kind === "entry") return <strong>{params.value}</strong>;
      if (!editable || row.kind === "entry") return field === "equipment" ? <div className="ag-roster-employee-wrap"><span title={String(value)}>{value}</span>{warning}</div> : <span title={String(value)}>{value}</span>;
      const display = <EditableCellDisplay value={value} menuLabel={params.colDef?.headerName} onOpen={hasMenu && field ? () => openCellEditor(row, field) : undefined} />;
      return field === "equipment" ? <div className="ag-roster-employee-wrap">{display}{warning}</div> : display;
    }
    const draft = propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    if (!draft) return null;
    const patchAndClose = (changes: Partial<GridEquipmentDraft>) => { patchRow(row, changes); setActiveEditor(null); setSpreadsheetFocusRequestKey((key) => key + 1); };
    if (field === "equipment") return <div className="ag-cell-editor-host"><EquipmentCombobox key={draft.equipmentId || "new"} autoOpen value={draft.equipmentId} units={propsRef.current.units} blockedEquipment={blockedEquipment} onChange={(equipmentId) => patchAndClose({ equipmentId })} /></div>;
    if (field === "shift") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.shiftId} options={propsRef.current.shifts} placeholder="Смена" onChange={(shiftId) => patchAndClose({ shiftId })} /></div>;
    if (field === "zone") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.zoneId} options={propsRef.current.zones} placeholder="Зона" onChange={(zoneId) => patchAndClose({ zoneId })} /></div>;
    if (field === "mainWork") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.mainWorkTypeId} options={propsRef.current.mainWorkTypes} placeholder="Работа" onChange={(mainWorkTypeId) => patchAndClose({ mainWorkTypeId })} /></div>;
    if (field === "subwork") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.subworkTypeId} options={propsRef.current.subworkTypes} placeholder="Вид подработ" onChange={(subworkTypeId) => patchAndClose({ subworkTypeId })} /></div>;
    if (field === "hours") return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" value={draft.hours} ariaLabel="Часы" autoOpen onChange={(hours) => patchAndClose({ hours })} options={Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))} /></div>;
    if (field === "note") return <div className="ag-cell-editor-host"><EmployeeTextEditor deferChangeUntilBlur value={draft.note} placeholder="Необязательно" onBlur={() => setActiveEditor(null)} onEnter={() => { setActiveEditor(null); setSpreadsheetFocusRequestKey((key) => key + 1); }} onChange={(note) => patchRow(row, { note })} /></div>;
    return <span className="ag-autofill-value" title={String(params.value ?? "")}>{params.value || "—"}</span>;
  }, [activeEditor, blockedEquipment, openCellEditor, patchRow, propsRef]);

  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<EquipmentTableRow>) => {
    const current = propsRef.current;
    if (row.kind === "draft" ? !current.canCreate : !current.canUpdate) return false;
    const changes: Partial<GridEquipmentDraft> = {};
    if (values.equipment !== undefined) changes.equipmentId = pastedOptionId(unitOptions, values.equipment);
    if (values.shift !== undefined) changes.shiftId = pastedOptionId(propsRef.current.shifts, values.shift);
    if (values.zone !== undefined) changes.zoneId = pastedOptionId(propsRef.current.zones, values.zone);
    if (values.mainWork !== undefined) changes.mainWorkTypeId = pastedOptionId(propsRef.current.mainWorkTypes, values.mainWork);
    if (values.subwork !== undefined) changes.subworkTypeId = pastedOptionId(propsRef.current.subworkTypes, values.subwork);
    if (values.note !== undefined) changes.note = values.note;
    if (values.hours !== undefined) changes.hours = values.hours.trim();
    if (!Object.keys(changes).length) return false;
    if (row.kind === "entry" && row.entry) propsRef.current.onEdit(row.entry, changes);
    else patchRow(row, changes);
    return true;
  }, [patchRow, propsRef, unitOptions]);

  const columns = useMemo<ColDef<EquipmentTableRow>[]>(() => {
    return [
      { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, lockPosition: "left", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
      { field: "equipment", headerName: "Техника", minWidth: 250, flex: 2.1, pinned: "left", lockPinned: true, lockPosition: "left", headerComponentParams: pinnableHeader, valueGetter: valueGetter("equipment"), cellRenderer: editableRenderer },
      { field: "organization", headerName: "Организация", minWidth: 145, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("organization"), cellRenderer: editableRenderer },
      ...(props.showResponsibleUser ? [{ field: "responsibleUserName", headerName: "Ответственный прораб", minWidth: 180, flex: 1.2, headerComponentParams: pinnableHeader, valueGetter: valueGetter("responsibleUserName"), cellRenderer: editableRenderer } satisfies ColDef<EquipmentTableRow>] : []),
      { field: "shift", headerName: "Смена", minWidth: 115, flex: .75, headerComponentParams: pinnableHeader, valueGetter: valueGetter("shift"), cellRenderer: editableRenderer },
      { field: "zone", headerName: "Зона", minWidth: 140, flex: 1.1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("zone"), cellRenderer: editableRenderer },
      { field: "mainWork", headerName: "Работа", minWidth: 180, flex: 1.5, headerComponentParams: pinnableHeader, valueGetter: valueGetter("mainWork"), cellRenderer: editableRenderer },
      { field: "subwork", headerName: "Вид подработ", minWidth: 190, flex: 1.5, headerComponentParams: pinnableHeader, valueGetter: valueGetter("subwork"), cellRenderer: editableRenderer },
      { field: "note", headerName: "Примечание", minWidth: 170, flex: 1.25, headerComponentParams: pinnableHeader, valueGetter: valueGetter("note"), cellRenderer: editableRenderer },
      { field: "hours", headerName: "Часы", minWidth: 105, flex: .65, headerComponentParams: pinnableHeader, filter: personnelColumnFilter, filterParams: { ...personnelFilterParams, kind: "number" }, valueGetter: valueGetter("hours"), cellRenderer: editableRenderer },
    ];
  }, [editableRenderer, props.showResponsibleUser, valueGetter]);
  const defaultColDef = useMemo<ColDef<EquipmentTableRow>>(() => ({
    filter: personnelColumnFilter,
    filterParams: personnelFilterParams,
    floatingFilter: false,
    resizable: true,
    sortable: true,
    suppressHeaderMenuButton: true,
    suppressHeaderFilterButton: true,
    suppressMovable: true,
  }), []);

  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-placement-grid ag-equipment-grid"><LocalizedGrid<EquipmentTableRow>
    theme={gridTheme}
    rowData={rowData}
    columnDefs={columns}
    defaultColDef={defaultColDef}
    getRowId={(params: GetRowIdParams<EquipmentTableRow>) => params.data.rowKey}
    rowHeight={TABLE_ROW_HEIGHT}
    headerHeight={TABLE_HEADER_HEIGHT}
    loading={props.loading}
    loadingOverlayComponent={() => <span className="ag-overlay-message">Загружаем отчёт техники…</span>}
    noRowsOverlayComponent={() => <span className="ag-overlay-message">За выбранный день записей нет</span>}
    rowClassRules={{ "editable-row": (params) => params.data?.kind === "edit" || params.data?.kind === "draft", "carried-row": (params) => Boolean(params.data?.draft?.carriedFromPreviousDay), "equipment-downtime-row": (params) => normalizeSearch(String(valueGetter("subwork")(params))).includes("простой"), "timesheet-conflict-row": (params) => Boolean(params.data?.timesheetConflict) }}
    rowSelection={{ mode: "multiRow", checkboxes: (params) => {
      const current = propsRef.current;
      return Boolean(current.drafts.length
        ? current.canCreate && params.data?.kind === "draft"
        : (current.canUpdate || current.canDelete) && params.data?.kind === "entry");
    }, headerCheckbox: props.drafts.length ? props.canCreate : props.canUpdate || props.canDelete, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => {
      const current = propsRef.current;
      return Boolean(current.drafts.length
        ? current.canCreate && node.data?.kind === "draft"
        : (current.canUpdate || current.canDelete) && node.data?.kind === "entry");
    } }}
    selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }}
    onGridReady={(event: GridReadyEvent<EquipmentTableRow>) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }}
    onGridSizeChanged={(event) => event.api.sizeColumnsToFit()}
    onColumnResized={keepGridFilled}
    onSelectionChanged={(event) => {
      const selected = event.api.getSelectedRows();
      propsRef.current.onSelectionChange(selected.flatMap((row) => row.entry?.id ? [row.entry.id] : []));
      propsRef.current.onDraftSelectionChange(selected.flatMap((row) => row.kind === "draft" && row.draft ? [row.draft.key] : []));
    }}
    onCellMouseDown={(event) => {
      if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return;
      const rowKey = event.data?.rowKey;
      const field = event.column.getColDef().field;
      if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null);
    }}
    onCellDoubleClicked={(event) => {
      const row = event.data;
      const field = event.column.getColId();
      if (!row || isInteractiveGridTarget(event.event)) return;
      openCellEditor(row, field);
    }}
    onSpreadsheetPaste={pasteIntoRow}
    onSpreadsheetEdit={({ row, columnId }) => openCellEditor(row, columnId)}
    onSpreadsheetCancelEdit={() => setActiveEditor(null)}
    spreadsheetFocusRequestKey={spreadsheetFocusRequestKey}
    suppressCellFocus
  /></div></AgGridProvider>;
}

type EquipmentRegistryTableRow = {
  rowKey: string;
  kind: "entry" | "edit" | "draft";
  number: number;
  unit?: GridEquipmentUnit;
  draft?: GridEquipmentRegistryDraft;
} & GridDisplayFields<"organization" | "equipmentType" | "brand" | "model" | "registrationNumber" | "note" | "siteName">;

type EquipmentRegistryGridProps = {
  rows: GridEquipmentUnit[];
  drafts: GridEquipmentRegistryDraft[];
  sites: GridOption[];
  selectedIds: number[];
  fullRowEditIds: number[];
  loading: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canSelect: boolean;
  onEdit: (unit: GridEquipmentUnit, changes?: Partial<GridEquipmentRegistryDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridEquipmentRegistryDraft>) => void;
  onVisibleIdsChange: (ids: number[]) => void;
  onValidationError: (message: string) => void;
};

const equipmentRegistryTextFields = ["organization", "equipmentType", "brand", "model", "registrationNumber", "note"] as const;
type EquipmentRegistryTextField = typeof equipmentRegistryTextFields[number];
type EquipmentRegistryField = EquipmentRegistryTextField | "siteName";
const equipmentRegistryFields: EquipmentRegistryField[] = [...equipmentRegistryTextFields, "siteName"];

export function EquipmentRegistryAgGrid(props: EquipmentRegistryGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<EquipmentRegistryTableRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<{ rowKey: string; field: EquipmentRegistryField } | null>(null);
  const draftStructureKey = props.drafts.map((draft) => draft.id ? `edit-${draft.id}` : draft.key).join("|");
  const draftValuesKey = props.drafts.map((draft) => `${draft.key}:${draft.organization}:${draft.equipmentType}:${draft.brand}:${draft.model}:${draft.registrationNumber}:${draft.note}:${draft.projectSiteId}`).join("|");
  const selectedIdsKey = props.selectedIds.join("|");
  const newDraftCount = props.drafts.filter((draft) => !draft.id).length;
  const rowData = useMemo<EquipmentRegistryTableRow[]>(() => [
    ...props.rows.map((unit, index) => {
      const draft = props.drafts.find((candidate) => candidate.id === unit.id);
      return draft
        ? { rowKey: `equipment-registry-${unit.id}`, kind: "edit" as const, number: index + 1, unit, draft }
        : { rowKey: `equipment-registry-${unit.id}`, kind: "entry" as const, number: index + 1, unit };
    }),
    ...props.drafts.filter((draft) => !draft.id).map((draft, index) => ({ rowKey: `equipment-registry-new-${draft.key}`, kind: "draft" as const, number: props.rows.length + index + 1, draft })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [draftStructureKey, props.rows]);

  useEffect(() => {
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.refreshClientSideRowModel("everything");
      api.refreshCells({ force: true });
      api.redrawRows();
    });
  }, [draftStructureKey, draftValuesKey]);
  useEffect(() => {
    if (!newDraftCount) return;
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (api && !api.isDestroyed() && api.getDisplayedRowCount()) api.ensureIndexVisible(api.getDisplayedRowCount() - 1, "bottom");
    });
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
      api.forEachNode((node) => node.setSelected(Boolean(node.data?.unit && selected.has(node.data.unit.id))));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdsKey]);

  const valueGetter = useCallback((field: EquipmentRegistryField | "number") => (params: { data?: EquipmentRegistryTableRow }) => {
    const row = params.data;
    if (!row) return "";
    if (field === "number") return row.number;
    if (row.kind === "entry") return field === "siteName" ? row.unit?.assignedSiteName ?? "" : row.unit?.[field] ?? "";
    const draft = propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    if (field === "siteName") return propsRef.current.sites.find((site) => site.id === Number(draft?.projectSiteId))?.name ?? "";
    return draft?.[field] ?? "";
  }, [propsRef]);

  const openCellEditor = useCallback((row: EquipmentRegistryTableRow, columnId: string) => {
    const field = columnId as EquipmentRegistryField;
    const canEditRow = row.kind === "draft" ? propsRef.current.canCreate : propsRef.current.canUpdate;
    if (!canEditRow || !equipmentRegistryFields.includes(field) || (row.kind === "entry" && newDraftCount > 0)) return false;
    if (row.kind === "entry" && row.unit) propsRef.current.onEdit(row.unit);
    else if (!row.draft) return false;
    setActiveEditor({ rowKey: row.rowKey, field });
    return true;
  }, [newDraftCount, propsRef]);

  const editableRenderer = useCallback((params: CustomCellRendererProps<EquipmentRegistryTableRow>) => {
    const row = params.data;
    const field = params.colDef?.field as EquipmentRegistryField | undefined;
    if (!row || !field) return null;
    const currentProps = propsRef.current;
    const activeCellEditor = activeEditor?.rowKey === row.rowKey && activeEditor.field === field && Boolean(row.draft);
    if (!activeCellEditor) {
      const value = field === "siteName" ? params.value || "Не назначена" : params.value || "—";
      return row.draft
        ? <EditableCellDisplay value={value} menuLabel={params.colDef?.headerName} onOpen={field === "siteName" ? () => openCellEditor(row, field) : undefined} />
        : <span title={String(value)}>{value}</span>;
    }
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft!;
    if (field === "siteName") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.projectSiteId} options={currentProps.sites} placeholder="Не назначена" onChange={(projectSiteId) => { currentProps.onPatchDraft(draft.key, { projectSiteId }); setActiveEditor(null); }} /></div>;
    const placeholders: Record<EquipmentRegistryTextField, string> = {
      organization: "Организация",
      equipmentType: "Тип техники",
      brand: "Марка",
      model: "Модель",
      registrationNumber: "ГРЗ / инв. №",
      note: "Примечание",
    };
    return <div className="ag-cell-editor-host"><EmployeeTextEditor value={draft[field]} placeholder={placeholders[field]} onBlur={() => setActiveEditor(null)} onChange={(value) => currentProps.onPatchDraft(draft.key, { [field]: value })} /></div>;
  }, [activeEditor, openCellEditor, propsRef]);

  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<EquipmentRegistryTableRow>) => {
    const currentProps = propsRef.current;
    if (row.kind === "draft" ? !currentProps.canCreate : !currentProps.canUpdate) return false;
    if (row.kind === "entry" && currentProps.drafts.some((draft) => !draft.id)) return false;
    const changes: Partial<GridEquipmentRegistryDraft> = {};
    for (const field of equipmentRegistryTextFields) {
      if (values[field] === undefined) continue;
      const value = values[field].trim();
      if (["organization", "equipmentType", "model"].includes(field) && !value) {
        currentProps.onValidationError("Организация, тип техники и модель не могут быть пустыми.");
        return false;
      }
      changes[field] = value;
    }
    if (values.siteName !== undefined) {
      const pasted = values.siteName.trim();
      const unassigned = !pasted || ["не назначена", "не назначен", "без проекта", "—", "-"].includes(normalizeSearch(pasted));
      const projectSiteId = unassigned ? "" : pastedOptionId(currentProps.sites, pasted);
      if (!unassigned && !projectSiteId) {
        currentProps.onValidationError(`Значение «${pasted}» нельзя вставить в столбец «Проект». Выберите существующий проект.`);
        return false;
      }
      changes.projectSiteId = projectSiteId;
    }
    if (!Object.keys(changes).length) return false;
    if (row.kind === "entry" && row.unit) currentProps.onEdit(row.unit, changes);
    else if (row.draft) currentProps.onPatchDraft(row.draft.key, changes);
    else return false;
    return true;
  }, [propsRef]);

  const columns = useMemo<ColDef<EquipmentRegistryTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, lockPosition: "left", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "equipmentType", headerName: "Тип техники", minWidth: 170, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("equipmentType"), cellRenderer: editableRenderer },
    { field: "brand", headerName: "Марка", minWidth: 145, flex: .85, headerComponentParams: pinnableHeader, valueGetter: valueGetter("brand"), cellRenderer: editableRenderer },
    { field: "model", headerName: "Модель", minWidth: 200, flex: 1.3, headerComponentParams: pinnableHeader, valueGetter: valueGetter("model"), cellRenderer: editableRenderer },
    { field: "registrationNumber", headerName: "ГРЗ / инв. №", minWidth: 165, flex: .9, headerComponentParams: pinnableHeader, valueGetter: valueGetter("registrationNumber"), cellRenderer: editableRenderer },
    { field: "organization", headerName: "Организация", minWidth: 180, flex: 1.05, headerComponentParams: pinnableHeader, valueGetter: valueGetter("organization"), cellRenderer: editableRenderer },
    { field: "siteName", headerName: "Проект", minWidth: 190, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("siteName"), cellRenderer: editableRenderer },
    { field: "note", headerName: "Примечание", minWidth: 220, flex: 1.4, headerComponentParams: pinnableHeader, valueGetter: valueGetter("note"), cellRenderer: editableRenderer },
  ], [editableRenderer, valueGetter]);

  const reportVisibleRows = useCallback((api: GridApi<EquipmentRegistryTableRow>) => {
    const ids: number[] = [];
    api.forEachNodeAfterFilterAndSort((node) => { if (node.data?.unit?.id) ids.push(node.data.unit.id); });
    propsRef.current.onVisibleIdsChange(ids);
  }, [propsRef]);
  const defaultColDef = useMemo<ColDef<EquipmentRegistryTableRow>>(() => ({ filter: personnelColumnFilter, filterParams: personnelFilterParams, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true }), []);

  return <AgGridProvider modules={modules}><div className="employee-performance-frame">
    <div className="employee-performance-main">
      <div className="ag-grid-shell ag-admin-grid ag-employee-grid ag-equipment-registry-grid"><LocalizedGrid<EquipmentRegistryTableRow>
        theme={gridTheme}
        rowData={rowData}
        columnDefs={columns}
        defaultColDef={defaultColDef}
        getRowId={(params) => params.data.rowKey}
        rowHeight={TABLE_ROW_HEIGHT}
        headerHeight={TABLE_HEADER_HEIGHT}
        animateRows
        loading={props.loading}
        loadingOverlayComponent={() => <span className="ag-overlay-message">Загружаем реестр техники…</span>}
        noRowsOverlayComponent={() => <span className="ag-overlay-message">Реестр техники пока пуст</span>}
        rowClassRules={{ "editable-row": (params) => Boolean(params.data?.draft && (params.data.kind === "draft" || (params.data.draft.id && propsRef.current.fullRowEditIds.includes(params.data.draft.id)))) }}
        rowSelection={{ mode: "multiRow", checkboxes: (params) => propsRef.current.canSelect && propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: props.canSelect && props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => propsRef.current.canSelect && propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }}
        selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }}
        onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }}
        onGridSizeChanged={(event) => event.api.sizeColumnsToFit()}
        onColumnResized={keepGridFilled}
        onModelUpdated={(event) => reportVisibleRows(event.api)}
        onFilterChanged={(event) => reportVisibleRows(event.api)}
        onSortChanged={(event) => reportVisibleRows(event.api)}
        onSelectionChanged={(event) => { if (propsRef.current.canSelect) propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.unit?.id ? [row.unit.id] : [])); }}
        onCellMouseDown={(event) => {
          if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return;
          const rowKey = event.data?.rowKey;
          const field = event.column.getColDef().field;
          if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null);
        }}
        onCellDoubleClicked={(event) => {
          const row = event.data;
          if (!row || isInteractiveGridTarget(event.event)) return;
          openCellEditor(row, event.column.getColId());
        }}
        onSpreadsheetPaste={pasteIntoRow}
        onSpreadsheetEdit={({ row, columnId }) => openCellEditor(row, columnId)}
        onSpreadsheetCancelEdit={() => setActiveEditor(null)}
        spreadsheetSelectionResetKey={`${draftStructureKey}:${props.fullRowEditIds.join("|")}`}
        suppressCellFocus
      /></div>
    </div>
  </div></AgGridProvider>;
}

type ProjectEquipmentTableRow = {
  rowKey: string;
  kind: "entry" | "draft";
  number: number;
  unit?: GridEquipmentUnit;
  draft?: GridProjectEquipmentDraft;
} & GridDisplayFields<"equipmentType" | "brand" | "model" | "registrationNumber" | "organization" | "note">;

type ProjectEquipmentGridProps = {
  rows: GridEquipmentUnit[];
  allUnits: GridEquipmentUnit[];
  drafts: GridProjectEquipmentDraft[];
  selectedIds: number[];
  loading: boolean;
  canCreate: boolean;
  canSelect: boolean;
  onPatchDraft: (key: string, changes: Partial<GridProjectEquipmentDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
};

export function ProjectEquipmentAgGrid(props: ProjectEquipmentGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<ProjectEquipmentTableRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<string | null>(null);
  const draftStructureKey = props.drafts.map((draft) => draft.key).join("|");
  const draftEquipmentIds = props.drafts.map((draft) => `${draft.key}:${draft.equipmentId}`).join("|");
  const selectedIdsKey = props.selectedIds.join("|");
  const rowData = useMemo<ProjectEquipmentTableRow[]>(() => [
    ...props.rows.map((unit, index) => ({ rowKey: `project-equipment-${unit.id}`, kind: "entry" as const, number: index + 1, unit })),
    ...props.drafts.map((draft, index) => ({ rowKey: `project-equipment-new-${draft.key}`, kind: "draft" as const, number: props.rows.length + index + 1, draft })),
  ], [props.drafts, props.rows]);

  useEffect(() => { requestAnimationFrame(() => {
    const api = gridApi.current;
    if (!api || api.isDestroyed()) return;
    api.refreshClientSideRowModel("everything");
    api.refreshCells({ force: true });
    api.redrawRows();
  }); }, [draftEquipmentIds, draftStructureKey]);
  useEffect(() => {
    if (!props.drafts.length) return;
    requestAnimationFrame(() => { const api = gridApi.current; if (api && !api.isDestroyed() && api.getDisplayedRowCount()) api.ensureIndexVisible(api.getDisplayedRowCount() - 1, "bottom"); });
  }, [draftStructureKey, props.drafts.length]);
  useEffect(() => {
    const selected = new Set(props.selectedIds);
    requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(node.data?.unit && selected.has(node.data.unit.id))));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdsKey]);

  const availableUnitsFor = useCallback((draftKey: string) => {
    const assigned = new Set(propsRef.current.rows.map((unit) => unit.id));
    propsRef.current.drafts.forEach((draft) => { if (draft.key !== draftKey && draft.equipmentId) assigned.add(Number(draft.equipmentId)); });
    return propsRef.current.allUnits.filter((unit) => !assigned.has(unit.id));
  }, [propsRef]);
  const openCellEditor = useCallback((row: ProjectEquipmentTableRow, columnId: string) => {
    if (!propsRef.current.canCreate || row.kind !== "draft" || !row.draft || columnId !== "equipmentType") return false;
    setActiveEditor(row.rowKey);
    return true;
  }, [propsRef]);
  const valueGetter = useCallback((field: "number" | "equipmentType" | "brand" | "model" | "registrationNumber" | "organization" | "note") => (params: { data?: ProjectEquipmentTableRow }) => {
    const row = params.data;
    if (!row) return "";
    if (field === "number") return row.number;
    const draft = row.kind === "draft" ? propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft : undefined;
    const unit = row.kind === "entry" ? row.unit : propsRef.current.allUnits.find((item) => item.id === Number(draft?.equipmentId));
    return unit?.[field] ?? "";
  }, [propsRef]);
  const cellRenderer = useCallback((params: CustomCellRendererProps<ProjectEquipmentTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const draft = row.kind === "draft" ? propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft : undefined;
    if (draft && params.colDef?.field === "equipmentType") {
      if (activeEditor !== row.rowKey) return <EditableCellDisplay value={params.value || "Не заполнено"} menuLabel={params.colDef.headerName} onOpen={() => openCellEditor(row, "equipmentType")} />;
      return <div className="ag-cell-editor-host"><EquipmentCombobox autoOpen value={draft.equipmentId} units={availableUnitsFor(draft.key)} onChange={(equipmentId) => { propsRef.current.onPatchDraft(draft.key, { equipmentId }); setActiveEditor(null); }} /></div>;
    }
    return <span className={row.kind === "draft" ? "ag-autofill-value" : undefined} title={String(params.value || "—")}>{params.value || "—"}</span>;
  }, [activeEditor, availableUnitsFor, openCellEditor, propsRef]);
  const columns = useMemo<ColDef<ProjectEquipmentTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "equipmentType", headerName: "Тип техники", minWidth: 190, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("equipmentType"), cellRenderer },
    { field: "brand", headerName: "Марка", minWidth: 145, flex: .8, headerComponentParams: pinnableHeader, valueGetter: valueGetter("brand"), cellRenderer },
    { field: "model", headerName: "Модель", minWidth: 200, flex: 1.2, headerComponentParams: pinnableHeader, valueGetter: valueGetter("model"), cellRenderer },
    { field: "registrationNumber", headerName: "ГРЗ / инв. №", minWidth: 165, flex: .9, headerComponentParams: pinnableHeader, valueGetter: valueGetter("registrationNumber"), cellRenderer },
    { field: "organization", headerName: "Организация", minWidth: 180, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("organization"), cellRenderer },
    { field: "note", headerName: "Примечание", minWidth: 210, flex: 1.2, headerComponentParams: pinnableHeader, valueGetter: valueGetter("note"), cellRenderer },
  ], [cellRenderer, valueGetter]);
  const defaultColDef = useMemo<ColDef<ProjectEquipmentTableRow>>(() => ({ filter: personnelColumnFilter, filterParams: personnelFilterParams, floatingFilter: false, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true }), []);

  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid ag-project-equipment-grid"><LocalizedGrid<ProjectEquipmentTableRow>
    theme={gridTheme}
    rowData={rowData}
    columnDefs={columns}
    defaultColDef={defaultColDef}
    getRowId={(params) => params.data.rowKey}
    rowHeight={TABLE_ROW_HEIGHT}
    headerHeight={TABLE_HEADER_HEIGHT}
    loading={props.loading}
    loadingOverlayComponent={() => <span className="ag-overlay-message">Загружаем технику проекта…</span>}
    noRowsOverlayComponent={() => <span className="ag-overlay-message">В проекте пока нет техники</span>}
    rowClassRules={{ "editable-row": (params) => params.data?.kind === "draft" }}
    rowSelection={{ mode: "multiRow", checkboxes: (params) => propsRef.current.canSelect && propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: props.canSelect && props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => propsRef.current.canSelect && propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }}
    selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }}
    onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }}
    onGridSizeChanged={(event) => event.api.sizeColumnsToFit()}
    onColumnResized={keepGridFilled}
    onSelectionChanged={(event) => { if (propsRef.current.canSelect) propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.unit?.id ? [row.unit.id] : [])); }}
    onCellMouseDown={(event) => { if (!activeEditor || isInteractiveGridTarget(event.event)) return; if (event.data?.rowKey !== activeEditor || event.column.getColId() !== "equipmentType") setActiveEditor(null); }}
    onCellDoubleClicked={(event) => { if (event.data && !isInteractiveGridTarget(event.event)) openCellEditor(event.data, event.column.getColId()); }}
    onSpreadsheetEdit={({ row, columnId }) => openCellEditor(row, columnId)}
    onSpreadsheetCancelEdit={() => setActiveEditor(null)}
    suppressCellFocus
  /></div></AgGridProvider>;
}

type EmployeeTableRow = {
  rowKey: string;
  kind: "entry" | "edit" | "draft";
  number: number;
  employee?: GridEmployee;
  draft?: GridEmployeeDraft;
} & GridDisplayFields<"fullName" | "employmentType" | "department" | "position" | "siteName">;

type EmployeeGridProps = {
  rows: GridEmployee[];
  drafts: GridEmployeeDraft[];
  employmentTypes: GridOption[];
  departments: GridOption[];
  positions: GridOption[];
  sites: GridOption[];
  selectedIds: number[];
  fullRowEditIds: number[];
  readOnly?: boolean;
  selectionDisabled?: boolean;
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

  const openCellEditor = useCallback((row: EmployeeTableRow, columnId: string) => {
    if (propsRef.current.readOnly && row.kind !== "draft") return false;
    if (!["fullName", "employmentType", "department", "position", "siteName"].includes(columnId) || (row.kind === "entry" && newDraftCount > 0)) return false;
    if (row.kind === "entry" && row.employee) propsRef.current.onEdit(row.employee);
    else if (!row.draft) return false;
    setActiveEditor({ rowKey: row.rowKey, field: columnId });
    return true;
  }, [newDraftCount, propsRef]);

  const editableRenderer = useCallback((params: CustomCellRendererProps<EmployeeTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const field = params.colDef?.field;
    const currentProps = propsRef.current;
    const activeCellEditor = Boolean(field && activeEditor?.rowKey === row.rowKey && activeEditor.field === field && row.draft);
    if (!activeCellEditor) {
      const value = field === "siteName" ? params.value || "Без объекта" : params.value;
      const hasMenu = Boolean(row.draft && field && ["employmentType", "department", "position", "siteName"].includes(field));
      return row.draft
        ? <EditableCellDisplay value={String(value || "Не заполнено")} menuLabel={params.colDef?.headerName} onOpen={hasMenu ? () => openCellEditor(row, field!) : undefined} />
        : <span title={String(value ?? "")}>{value}</span>;
    }
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft!;
    if (field === "fullName") return <div className="ag-cell-editor-host"><EmployeeTextEditor value={draft.fullName} onBlur={() => setActiveEditor(null)} onChange={(fullName) => currentProps.onPatchDraft(draft.key, { fullName })} /></div>;
    if (field === "employmentType") return <div className="ag-cell-editor-host"><DraftNameSelect autoOpen value={draft.employmentType} options={currentProps.employmentTypes} placeholder="Тип" onChange={(employmentType) => { currentProps.onPatchDraft(draft.key, { employmentType }); setActiveEditor(null); }} /></div>;
    if (field === "department") return <div className="ag-cell-editor-host"><DraftNameSelect autoOpen value={draft.department} options={currentProps.departments} placeholder="Отдел" onChange={(department) => { currentProps.onPatchDraft(draft.key, { department }); setActiveEditor(null); }} /></div>;
    if (field === "position") return <div className="ag-cell-editor-host"><DraftNameSelect autoOpen value={draft.position} options={currentProps.positions} placeholder="Должность" onChange={(position) => { currentProps.onPatchDraft(draft.key, { position }); setActiveEditor(null); }} /></div>;
    if (field === "siteName") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.projectSiteId} options={currentProps.sites} placeholder="Без объекта" onChange={(projectSiteId) => { currentProps.onPatchDraft(draft.key, { projectSiteId }); setActiveEditor(null); }} /></div>;
    return <span>{params.value}</span>;
  }, [activeEditor, openCellEditor, propsRef]);

  const editActionRenderer = useCallback((params: CustomCellRendererProps<EmployeeTableRow>) => {
    const row = params.data;
    if (!row || row.kind === "entry") return null;
    return <div className="row-actions"><button type="button" onClick={() => propsRef.current.onCancelDraft(row.draft!.key)} title={row.draft?.id ? "Отменить изменения строки" : "Удалить несохранённую строку"} aria-label={row.draft?.id ? `Отменить изменения ${row.employee?.fullName ?? row.draft.fullName}` : "Удалить несохранённую строку"}><GridIcon name={row.draft?.id ? "back" : "trash"} /></button></div>;
  }, [propsRef]);

  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<EmployeeTableRow>) => {
    const currentProps = propsRef.current;
    if (currentProps.readOnly && row.kind !== "draft") return false;
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
      const pasted = values.siteName.trim();
      const unassigned = !pasted || ["без объекта", "не назначен", "не назначена", "без проекта", "—", "-"].includes(normalizeSearch(pasted));
      const projectSiteId = unassigned ? "" : pastedOptionId(currentProps.sites, pasted);
      if (!unassigned && !projectSiteId) { currentProps.onValidationError(`Значение «${pasted}» нельзя вставить в столбец «Проект». Выберите существующий проект или «Без объекта».`); return false; }
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
    if (row.kind === "entry") return field === "siteName" ? row.employee?.siteName ?? "Без объекта" : row.employee?.[field] ?? "";
    const draft = propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    if (field === "siteName") return propsRef.current.sites.find((site) => site.id === Number(draft?.projectSiteId))?.name ?? "Без объекта";
    return draft?.[field as keyof GridEmployeeDraft] ?? "";
  }, [propsRef]);

  const columns = useMemo<ColDef<EmployeeTableRow>[]>(() => [
    { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, lockPosition: "left", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
    { field: "fullName", headerName: "ФИО", minWidth: 230, flex: 1.4, headerComponentParams: pinnableHeader, valueGetter: valueGetter("fullName"), cellRenderer: editableRenderer },
    { field: "employmentType", headerName: "Тип", minWidth: 120, flex: .55, headerComponentParams: pinnableHeader, valueGetter: valueGetter("employmentType"), cellRenderer: editableRenderer },
    { field: "department", headerName: "Отдел", minWidth: 150, flex: .7, headerComponentParams: pinnableHeader, valueGetter: valueGetter("department"), cellRenderer: editableRenderer },
    { field: "position", headerName: "Должность", minWidth: 220, flex: 1.4, headerComponentParams: pinnableHeader, valueGetter: valueGetter("position"), cellRenderer: editableRenderer },
    { field: "siteName", headerName: "Проект", minWidth: 190, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("siteName"), cellRenderer: editableRenderer },
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
        rowHeight={TABLE_ROW_HEIGHT}
        headerHeight={TABLE_HEADER_HEIGHT}
        animateRows
        rowClassRules={{ "editable-row": (params) => Boolean(params.data?.draft && (params.data.kind === "draft" || (params.data.draft.id && propsRef.current.fullRowEditIds.includes(params.data.draft.id)))) }}
        rowSelection={{ mode: "multiRow", checkboxes: (params) => !propsRef.current.selectionDisabled && propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: !props.selectionDisabled && props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => !propsRef.current.selectionDisabled && propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }}
        selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }}
        onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }}
        onGridSizeChanged={(event) => event.api.sizeColumnsToFit()}
        onColumnResized={keepGridFilled}
        onModelUpdated={(event) => reportVisibleRows(event.api)}
        onFilterChanged={(event) => reportVisibleRows(event.api)}
        onSortChanged={(event) => reportVisibleRows(event.api)}
        onSelectionChanged={(event) => { if (!propsRef.current.selectionDisabled) propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.employee?.id ? [row.employee.id] : [])); }}
        onCellMouseDown={(event) => {
          if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return;
          const rowKey = event.data?.rowKey;
          const field = event.column.getColDef().field;
          if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null);
        }}
        onCellDoubleClicked={(event) => {
          const row = event.data;
          if (!row || isInteractiveGridTarget(event.event)) return;
          openCellEditor(row, event.column.getColId());
        }}
        onSpreadsheetPaste={pasteIntoRow}
        onSpreadsheetEdit={({ row, columnId }) => openCellEditor(row, columnId)}
        onSpreadsheetCancelEdit={() => setActiveEditor(null)}
        spreadsheetSelectionResetKey={`${draftStructureKey}:${props.fullRowEditIds.join("|")}`}
        suppressCellFocus
      /></div>
    </div>
  </div></AgGridProvider>;
}

type ProjectEmployeeTableRow = { rowKey: string; kind: "entry" | "draft"; number: number; employee?: GridEmployee; draft?: GridProjectEmployeeDraft; pending?: boolean } & GridDisplayFields<"fullName" | "employmentType" | "department" | "position">;
type ProjectEmployeeGridProps = {
  rows: GridEmployee[];
  allEmployees: GridEmployee[];
  drafts: GridProjectEmployeeDraft[];
  pendingDeletes: number[];
  readOnly?: boolean;
  selectionDisabled?: boolean;
  onPatchDraft: (key: string, changes: Partial<GridProjectEmployeeDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
};

export function ProjectEmployeeAgGrid(props: ProjectEmployeeGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<ProjectEmployeeTableRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<string | null>(null);
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
  const openCellEditor = useCallback((row: ProjectEmployeeTableRow, columnId: string) => {
    if (propsRef.current.readOnly || row.kind !== "draft" || !row.draft || columnId !== "fullName") return false;
    setActiveEditor(row.rowKey);
    return true;
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
    if (draft && params.colDef?.field === "fullName") {
      if (activeEditor !== row.rowKey) return <EditableCellDisplay value={params.value || "Не заполнено"} menuLabel={params.colDef.headerName} onOpen={() => openCellEditor(row, "fullName")} />;
      return <div className="ag-cell-editor-host"><EmployeeCombobox autoOpen value={draft.employeeQuery} employees={availableEmployeesFor(draft.key)} onChange={(employeeQuery, employeeId) => { propsRef.current.onPatchDraft(draft.key, { employeeQuery, employeeId }); setActiveEditor(null); }} /></div>;
    }
    return <span className={row.kind === "draft" ? "ag-autofill-value" : undefined} title={String(params.value ?? "")}>{params.value}</span>;
  }, [activeEditor, availableEmployeesFor, openCellEditor, propsRef]);
  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<ProjectEmployeeTableRow>) => {
    if (propsRef.current.readOnly) return false;
    if (row.kind !== "draft" || values.fullName === undefined) return false;
    const currentProps = propsRef.current;
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    if (!draft) return false;
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
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><LocalizedGrid<ProjectEmployeeTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={TABLE_ROW_HEIGHT} headerHeight={TABLE_HEADER_HEIGHT} rowClassRules={{ "editable-row": (params) => params.data?.kind === "draft" }} rowSelection={{ mode: "multiRow", checkboxes: (params) => !propsRef.current.selectionDisabled && propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: !props.selectionDisabled && props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => !propsRef.current.selectionDisabled && propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onSelectionChanged={(event) => { if (!propsRef.current.selectionDisabled) propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.employee?.id ? [row.employee.id] : [])); }} onCellMouseDown={(event) => { if (!activeEditor || isInteractiveGridTarget(event.event)) return; if (event.data?.rowKey !== activeEditor || event.column.getColId() !== "fullName") setActiveEditor(null); }} onCellDoubleClicked={(event) => { if (event.data && !isInteractiveGridTarget(event.event)) openCellEditor(event.data, event.column.getColId()); }} onSpreadsheetPaste={pasteIntoRow} onSpreadsheetEdit={({ row, columnId }) => openCellEditor(row, columnId)} onSpreadsheetCancelEdit={() => setActiveEditor(null)} suppressCellFocus /></div></AgGridProvider>;
}

type DirectoryTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; item?: GridOption; draft?: GridDirectoryDraft; pending?: boolean } & GridDisplayFields<"name" | "employmentType" | "department" | "position">;
type DirectoryGridProps = {
  title: string;
  rows: GridOption[];
  drafts: GridDirectoryDraft[];
  employees?: GridEmployee[];
  selectEmployee?: boolean;
  pendingDeletes: number[];
  readOnly?: boolean;
  selectionDisabled?: boolean;
  onEdit: (item: GridOption) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridDirectoryDraft>) => void;
};

export function DirectoryAgGrid(props: DirectoryGridProps) {
  const propsRef = useLatestRef(props);
  const gridApi = useRef<GridApi<DirectoryTableRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<string | null>(null);
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
  useEffect(() => { if (!props.drafts.length) requestAnimationFrame(() => setActiveEditor(null)); }, [props.drafts.length]);
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
  const openCellEditor = useCallback((row: DirectoryTableRow, columnId: string) => {
    const currentProps = propsRef.current;
    if ((currentProps.readOnly && row.kind !== "draft") || columnId !== "name" || row.pending) return false;
    if (row.kind === "entry") {
      if (currentProps.drafts.some((draft) => !draft.id) || !row.item) return false;
      currentProps.onEdit(row.item);
    }
    setActiveEditor(row.rowKey);
    return true;
  }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<DirectoryTableRow>) => {
    const row = params.data;
    if (!row) return null;
    if (row.kind === "entry") return <span title={String(params.value ?? "")}>{params.value}</span>;
    const draft = propsRef.current.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    if (!draft) return null;
    if (params.colDef?.field === "name") {
      if (activeEditor !== row.rowKey) return <EditableCellDisplay value={params.value ?? ""} menuLabel={propsRef.current.selectEmployee ? "сотрудник" : undefined} onOpen={propsRef.current.selectEmployee ? () => openCellEditor(row, "name") : undefined} />;
      if (propsRef.current.selectEmployee) return <EmployeeCombobox autoOpen value={draft.name} employees={propsRef.current.employees ?? []} onChange={(name, employeeId) => { propsRef.current.onPatchDraft(draft.key, { name, employeeId }); setActiveEditor(null); }} />;
      return <EmployeeTextEditor value={draft.name} placeholder={`Название: ${propsRef.current.title.toLocaleLowerCase("ru-RU")}`} onBlur={() => setActiveEditor(null)} onChange={(name) => propsRef.current.onPatchDraft(draft.key, { name })} />;
    }
    if (propsRef.current.selectEmployee) return <span className="ag-autofill-value" title={String(params.value ?? "")}>{params.value}</span>;
    return <span title={String(params.value ?? "")}>{params.value}</span>;
  }, [activeEditor, openCellEditor, propsRef]);
  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<DirectoryTableRow>) => {
    if (propsRef.current.readOnly && row.kind !== "draft") return false;
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
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><LocalizedGrid<DirectoryTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={TABLE_ROW_HEIGHT} headerHeight={TABLE_HEADER_HEIGHT} rowClassRules={{ "editable-row": (params) => params.data?.kind !== "entry" }} rowSelection={{ mode: "multiRow", checkboxes: (params) => !propsRef.current.selectionDisabled && propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: !props.selectionDisabled && props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => !propsRef.current.selectionDisabled && propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onSelectionChanged={(event) => { if (!propsRef.current.selectionDisabled) propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.item?.id ? [row.item.id] : [])); }} onCellMouseDown={(event) => { if (!activeEditor || isInteractiveGridTarget(event.event)) return; if (event.data?.rowKey !== activeEditor || event.column.getColId() !== "name") setActiveEditor(null); }} onCellDoubleClicked={(event) => { if (event.data && !isInteractiveGridTarget(event.event)) openCellEditor(event.data, event.column.getColId()); }} onSpreadsheetPaste={pasteIntoRow} onSpreadsheetEdit={({ row, columnId }) => openCellEditor(row, columnId)} onSpreadsheetCancelEdit={() => setActiveEditor(null)} suppressCellFocus /></div></AgGridProvider>;
}

type PositionGridProps = {
  rows: GridPosition[];
  drafts: GridPositionDraft[];
  employmentTypes: GridOption[];
  departments: GridOption[];
  pendingDeletes: number[];
  fullRowEditIds: number[];
  readOnly?: boolean;
  selectionDisabled?: boolean;
  onEdit: (position: GridPosition, changes?: Partial<GridPositionDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridPositionDraft>) => void;
  onVisibleIdsChange: (ids: number[]) => void;
};

type PositionTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; record?: GridPosition; draft?: GridPositionDraft; pending?: boolean } & GridDisplayFields<"employmentType" | "department" | "position">;

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
  const openCellEditor = useCallback((row: PositionTableRow, columnId: string) => {
    const currentProps = propsRef.current;
    if ((currentProps.readOnly && row.kind !== "draft") || !["employmentType", "department", "position"].includes(columnId)) return false;
    if (row.kind === "entry") {
      if (currentProps.drafts.some((draft) => !draft.id) || !row.record) return false;
      currentProps.onEdit(row.record);
    }
    setActiveEditor({ rowKey: row.rowKey, field: columnId });
    return true;
  }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<PositionTableRow>) => {
    const row = params.data;
    if (!row) return null;
    const currentProps = propsRef.current;
    const field = params.colDef?.field;
    const activeCellEditor = Boolean(field && activeEditor?.rowKey === row.rowKey && activeEditor.field === field && row.draft);
    if (!row.draft) return <span title={String(params.value ?? "")}>{params.value}</span>;
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft!;
    if (!activeCellEditor) return <EditableCellDisplay value={params.value ?? ""} menuLabel={field === "employmentType" ? "тип" : field === "department" ? "отдел" : undefined} onOpen={field === "employmentType" || field === "department" ? () => openCellEditor(row, field) : undefined} />;
    if (field === "employmentType") return <DraftNameSelect autoOpen value={draft.employmentType} options={currentProps.employmentTypes} placeholder="Тип" onChange={(employmentType) => { currentProps.onPatchDraft(draft.key, { employmentType }); setActiveEditor(null); }} />;
    if (field === "department") return <DraftNameSelect autoOpen value={draft.department} options={currentProps.departments} placeholder="Отдел" onChange={(department) => { currentProps.onPatchDraft(draft.key, { department }); setActiveEditor(null); }} />;
    return <EmployeeTextEditor value={draft.position} placeholder="Должность" onBlur={() => setActiveEditor(null)} onChange={(position) => currentProps.onPatchDraft(draft.key, { position })} />;
  }, [activeEditor, openCellEditor, propsRef]);
  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<PositionTableRow>) => {
    if (propsRef.current.readOnly && row.kind !== "draft") return false;
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
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><LocalizedGrid<PositionTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={TABLE_ROW_HEIGHT} headerHeight={TABLE_HEADER_HEIGHT} rowClassRules={{ "editable-row": (params) => Boolean(params.data?.draft && (params.data.kind === "draft" || (params.data.draft.id && propsRef.current.fullRowEditIds.includes(params.data.draft.id)))) }} rowSelection={{ mode: "multiRow", checkboxes: (params) => !propsRef.current.selectionDisabled && propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: !props.selectionDisabled && props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => !propsRef.current.selectionDisabled && propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onModelUpdated={(event) => reportVisibleRows(event.api)} onFilterChanged={(event) => reportVisibleRows(event.api)} onSortChanged={(event) => reportVisibleRows(event.api)} onSelectionChanged={(event) => { if (!propsRef.current.selectionDisabled) propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.record?.id ? [row.record.id] : [])); }} onCellMouseDown={(event) => { if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return; const rowKey = event.data?.rowKey; const field = event.column.getColDef().field; if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null); }} onCellDoubleClicked={(event) => { if (event.data && !isInteractiveGridTarget(event.event)) openCellEditor(event.data, event.column.getColId()); }} onSpreadsheetPaste={pasteIntoRow} onSpreadsheetEdit={({ row, columnId }) => openCellEditor(row, columnId)} onSpreadsheetCancelEdit={() => setActiveEditor(null)} spreadsheetSelectionResetKey={`${draftStructureKey}:${props.fullRowEditIds.join("|")}`} suppressCellFocus /></div></AgGridProvider>;
}

type UserTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; user?: GridUser; draft?: GridUserDraft } & GridDisplayFields<"fullName" | "email" | "status" | "role" | "site">;
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
  const openCellEditor = useCallback((row: UserTableRow, columnId: string) => {
    const currentProps = propsRef.current;
    if (!["fullName", "email", "role", "site"].includes(columnId)) return false;
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft;
    const role = draft?.role ?? row.user?.role;
    if (columnId === "site" && role !== "foreman") return false;
    if (row.kind === "entry") {
      if (currentProps.drafts.some((candidate) => !candidate.id) || !row.user) return false;
      currentProps.onEdit(row.user);
    }
    setActiveEditor({ rowKey: row.rowKey, field: columnId });
    return true;
  }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<UserTableRow>) => {
    const row = params.data; if (!row) return null;
    const currentProps = propsRef.current;
    const field = params.colDef?.field;
    const activeCellEditor = Boolean(field && activeEditor?.rowKey === row.rowKey && activeEditor.field === field && row.draft);
    if (!row.draft) return <span title={String(params.value ?? "")}>{params.value}</span>;
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft!;
    if (field === "status") return <span className="ag-autofill-value">{draft.id ? "Без изменений" : "Приглашение"}</span>;
    if (!activeCellEditor) return <EditableCellDisplay value={params.value ?? ""} menuLabel={field === "role" ? "роль" : field === "site" && draft.role === "foreman" ? "проект" : undefined} onOpen={field === "role" || (field === "site" && draft.role === "foreman") ? () => openCellEditor(row, field!) : undefined} />;
    if (field === "fullName") return <EmployeeTextEditor value={draft.fullName} placeholder="ФИО" onBlur={() => setActiveEditor(null)} onChange={(fullName) => currentProps.onPatchDraft(draft.key, { fullName })} />;
    if (field === "email") return <EmployeeTextEditor value={draft.email} placeholder="email@company.ru" onBlur={() => setActiveEditor(null)} onChange={(email) => currentProps.onPatchDraft(draft.key, { email })} />;
    if (field === "role") return <CustomSelect className="ag-custom-select" value={draft.role} ariaLabel="Роль" autoOpen onChange={(role) => { currentProps.onPatchDraft(draft.key, { role: role as UserRole, assignedSiteId: role !== "foreman" ? "" : draft.assignedSiteId }); setActiveEditor(null); }} options={[{ value: "foreman", label: "Прораб" }, { value: "engineer", label: "Инженер" }, { value: "superadmin", label: "Супер-админ" }]} />;
    if (draft.role !== "foreman") return <span className="ag-autofill-value">Все проекты</span>;
    return <DraftSelect autoOpen value={draft.assignedSiteId} options={currentProps.sites} placeholder="Проект" onChange={(assignedSiteId) => { currentProps.onPatchDraft(draft.key, { assignedSiteId }); setActiveEditor(null); }} />;
  }, [activeEditor, openCellEditor, propsRef]);
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
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><LocalizedGrid<UserTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={TABLE_ROW_HEIGHT} headerHeight={TABLE_HEADER_HEIGHT} rowClassRules={{ "editable-row": (params) => Boolean(params.data?.draft && (params.data.kind === "draft" || (params.data.draft.id && propsRef.current.fullRowEditIds.includes(params.data.draft.id)))) }} rowSelection={{ mode: "multiRow", checkboxes: (params) => propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onSelectionChanged={(event) => propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.user?.id ? [row.user.id] : []))} onCellMouseDown={(event) => { if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return; const rowKey = event.data?.rowKey; const field = event.column.getColDef().field; if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null); }} onCellDoubleClicked={(event) => { if (event.data && !isInteractiveGridTarget(event.event)) openCellEditor(event.data, event.column.getColId()); }} onSpreadsheetPaste={pasteIntoRow} onSpreadsheetEdit={({ row, columnId }) => openCellEditor(row, columnId)} onSpreadsheetCancelEdit={() => setActiveEditor(null)} spreadsheetSelectionResetKey={`${draftStructureKey}:${props.fullRowEditIds.join("|")}`} suppressCellFocus /></div></AgGridProvider>;
}

type SiteTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; number: number; site?: GridSite; draft?: GridSiteDraft } & GridDisplayFields<"name">;
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
  const openCellEditor = useCallback((row: SiteTableRow, columnId: string) => {
    const currentProps = propsRef.current;
    if (columnId !== "name") return false;
    if (row.kind === "entry") {
      if (currentProps.drafts.some((draft) => !draft.id) || !row.site) return false;
      currentProps.onEdit(row.site);
    }
    setActiveEditor({ rowKey: row.rowKey, field: columnId });
    return true;
  }, [propsRef]);
  const editableRenderer = useCallback((params: CustomCellRendererProps<SiteTableRow>) => {
    const row = params.data; if (!row) return null;
    const currentProps = propsRef.current;
    const field = params.colDef?.field;
    const activeCellEditor = Boolean(field && activeEditor?.rowKey === row.rowKey && activeEditor.field === field && row.draft);
    if (!row.draft) return <span title={String(params.value ?? "")}>{params.value}</span>;
    const draft = currentProps.drafts.find((candidate) => candidate.key === row.draft?.key) ?? row.draft!;
    if (!activeCellEditor) return <EditableCellDisplay value={params.value ?? ""} />;
    return <EmployeeTextEditor value={draft.name} placeholder="Название проекта" onBlur={() => setActiveEditor(null)} onChange={(name) => currentProps.onPatchDraft(draft.key, { name })} />;
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
  return <AgGridProvider modules={modules}><div className="ag-grid-shell ag-admin-grid ag-reference-grid"><LocalizedGrid<SiteTableRow> theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={(params) => params.data.rowKey} rowHeight={TABLE_ROW_HEIGHT} headerHeight={TABLE_HEADER_HEIGHT} rowClassRules={{ "editable-row": (params) => Boolean(params.data?.draft && (params.data.kind === "draft" || (params.data.draft.id && propsRef.current.fullRowEditIds.includes(params.data.draft.id)))) }} rowSelection={{ mode: "multiRow", checkboxes: (params) => propsRef.current.drafts.length === 0 && params.data?.kind === "entry", headerCheckbox: props.drafts.length === 0, selectAll: "filtered", enableClickSelection: false, isRowSelectable: (node) => propsRef.current.drafts.length === 0 && node.data?.kind === "entry" }} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true, suppressSizeToFit: true }} onGridReady={(event) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); }} onGridSizeChanged={(event) => event.api.sizeColumnsToFit()} onColumnResized={keepGridFilled} onSelectionChanged={(event) => propsRef.current.onSelectionChange(event.api.getSelectedRows().flatMap((row) => row.site?.id ? [row.site.id] : []))} onCellMouseDown={(event) => { if (!activeEditor || event.rowIndex === null || isInteractiveGridTarget(event.event)) return; const rowKey = event.data?.rowKey; const field = event.column.getColDef().field; if (rowKey !== activeEditor.rowKey || field !== activeEditor.field) setActiveEditor(null); }} onCellDoubleClicked={(event) => { if (event.data && !isInteractiveGridTarget(event.event)) openCellEditor(event.data, event.column.getColId()); }} onSpreadsheetPaste={pasteIntoRow} onSpreadsheetEdit={({ row, columnId }) => openCellEditor(row, columnId)} onSpreadsheetCancelEdit={() => setActiveEditor(null)} spreadsheetSelectionResetKey={`${draftStructureKey}:${props.fullRowEditIds.join("|")}`} suppressCellFocus /></div></AgGridProvider>;
}
