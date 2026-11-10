"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useColumnFilterToggle } from "./useColumnFilterToggle";
import { equipmentUnavailableReason, isEquipmentUnavailable } from "./equipmentAvailability";
import {
  type ColDef,
  type ColumnResizedEvent,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
} from "ag-grid-community";
import {
  type CustomCellRendererProps,
  type CustomInnerHeaderProps,
} from "ag-grid-react";
import { subworkOptions } from "./workTypeHierarchy";
import { CustomSelect } from "./CustomSelect";
import { choiceMenuPosition, choiceMenuWidth, type ChoiceMenuPosition } from "./choiceMenuLayout";
import { GridTextEditor } from "./GridTextEditor";
import { ColumnFilterIcon } from "./ColumnFilterIcon";

// LocalizedGrid wraps AgGridReact with shared Russian filters and their summary.
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams, type SpreadsheetPastePayload } from "./GridFilters";
import { useWorkspaceAccess } from "./TableAccessContext";
import { gridTheme } from "./gridTheme";
import "./gridEmptyRows.css";

export { gridTheme } from "./gridTheme";

export type GridOption = { id: number; name: string; mainWorkTypeId?: number | null };
export type GridEmployee = {
  id: number;
  sortOrder?: number;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
  source: string;
  availabilityStatus?: string;
  bitrix24Stage?: string;
  siteId: number | null;
  siteName: string | null;
  bitrixCheckStatus?: "mismatch" | "missing_in_bitrix" | "dismissed_in_bitrix" | "blacklisted_in_bitrix" | null;
  bitrixCheckDetails?: string | null;
  bitrixCheckAcknowledged?: number | boolean;
};
export type GridEmployeeUsage = {
  employeeId: number;
  responsibleUserId: number | null;
  responsibleUserName: string;
  hours: number;
};
export type GridEmployeeDraft = { key: string; id?: number; fullName: string; employmentType: string; department: string; position: string; projectSiteId: string };
export type GridProjectEmployeeDraft = { key: string; employeeId: string; employeeQuery: string };
export type GridDirectoryDraft = { key: string; id?: number; name: string; employeeId?: string };
export type GridPosition = { id: number; employmentType: string; department: string; position: string };
export type GridPositionDraft = { key: string; id?: number; employmentType: string; department: string; position: string };
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

const TABLE_ROW_HEIGHT = 54;
const TABLE_HEADER_HEIGHT = 52;

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; }, [value]);
  return ref;
}

function useRefreshGrid<T>(gridApi: RefObject<GridApi<T> | null>, revision: string) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.refreshClientSideRowModel("everything");
      // Redrawing rows destroys live editors and selects their text again.
      // Refresh values in place after a committed edit instead.
      api.refreshCells({ force: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [gridApi, revision]);
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

function GridIcon({ name }: { name: "pin" | "filter" }) {
  if (name === "filter") return <ColumnFilterIcon />;
  return <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "pin" && <><path d="M12 17v5M5 8.5l4-4V2h6v2.5l4 4V11H5Z"/><path d="M8 11v3h8v-3"/></>}
  </svg>;
}

function PinnableInnerHeader(props: CustomInnerHeaderProps) {
  const [pinned, setPinned] = useState(() => props.column.getPinned() === "left");
  const [filterActive, setFilterActive] = useState(() => props.column.isFilterActive());
  const { open: filterOpen, buttonProps } = useColumnFilterToggle(props);
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
  return <span className="ag-pinnable-header"><span>{props.displayName}</span><span className="ag-header-tools"><button type="button" className={pinned ? "ag-column-pin active" : "ag-column-pin"} onClick={(event) => { event.stopPropagation(); props.api.setColumnsPinned([props.column], pinned ? null : "left"); }} title={pinned ? `Открепить ${props.displayName}` : `Закрепить ${props.displayName}`} aria-label={pinned ? `Открепить ${props.displayName}` : `Закрепить ${props.displayName}`}><GridIcon name="pin" /></button><button type="button" className={filterActive ? "ag-column-filter active" : "ag-column-filter"} aria-expanded={filterOpen} aria-haspopup="dialog" {...buttonProps} title={`Фильтр: ${props.displayName}`} aria-label={`Фильтр: ${props.displayName}`}><GridIcon name="filter" /></button></span></span>;
}

export const pinnableHeader = { innerHeaderComponent: PinnableInnerHeader };

function optionName(options: GridOption[], id: string) {
  return options.find((option) => option.id === Number(id))?.name ?? "";
}

function pastedOptionId(options: GridOption[], value: string) {
  const normalized = normalizeSearch(value);
  return String(options.find((option) => String(option.id) === value.trim() || normalizeSearch(option.name) === normalized)?.id ?? "");
}


function isInteractiveGridTarget(event?: Event | null) {
  const target = event?.target;
  return target instanceof Element && Boolean(target.closest("button, input, textarea, select, [role='combobox'], .actions-cell"));
}

function DraftSelect({ value, options, placeholder, onChange, autoOpen = false, disabled = false, required = false }: { value: string; options: GridOption[]; placeholder: string; onChange: (value: string) => void; autoOpen?: boolean; disabled?: boolean; required?: boolean }) {
  return <CustomSelect disabled={disabled} className="ag-custom-select" value={value} ariaLabel={placeholder} onChange={onChange} autoOpen={autoOpen} searchable options={[{ value: "", label: placeholder, disabled: required }, ...options.map((option) => ({ value: String(option.id), label: option.name }))]} />;
}

function EditableCellDisplay({ value, menuLabel, onOpen }: { value: string | number; menuLabel?: string; onOpen?: () => void }) {
  const access = useWorkspaceAccess();
  return <span className="ag-editable-cell-display" title={String(value)}>
    <span>{value}</span>
    {access?.edit !== false && onOpen && <button type="button" className="ag-editable-cell-menu" title={`Открыть список: ${menuLabel ?? "значение"}`} aria-label={`Открыть список: ${menuLabel ?? "значение"}`} onClick={(event) => { event.stopPropagation(); onOpen(); }}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg></button>}
  </span>;
}

function normalizeSearch(value: string) {
  return value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim().replace(/\s+/g, " ");
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
  onVisibleIdsChange?: (ids: number[]) => void;
  onDraftSelectionChange: (keys: string[]) => void;
  onValidationError: (message: string) => void;
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
  const [position, setPosition] = useState<ChoiceMenuPosition | null>(null);
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
    const labels = filtered.map((unit) => `${equipmentGridTitle(unit)} · ${unit.organization} · ${unit.note}`);
    setPosition(choiceMenuPosition(rect, { width: window.innerWidth, height: window.innerHeight }, choiceMenuWidth(input, labels, 420)));
  }, [filtered]);

  function openMenu() {
    if (open) return;
    setPosition(null);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const reposition = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) updatePosition(); };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
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
      onFocus={openMenu}
      onClick={openMenu}
      onChange={(event) => {
        setInputValue(event.target.value);
        setActiveIndex(selectableIndex(0, 1));
        openMenu();
      }}
      onBlur={() => {
        if (normalizeSearch(inputValue) === normalizeSearch(selectedTitle)) return;
        const exact = units.find((unit) => normalizeSearch(equipmentGridTitle(unit)) === normalizeSearch(inputValue));
        onChange(exact ? String(exact.id) : "");
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); openMenu(); setActiveIndex((index) => selectableIndex(index + 1, 1)); }
        if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => selectableIndex(index - 1, -1)); }
        if (event.key === "Enter" && open && filtered[activeIndex] && !blockedEquipment.has(filtered[activeIndex].id)) { event.preventDefault(); select(filtered[activeIndex]); }
        if (event.key === "Escape") setOpen(false);
      }}
    />
    <span className="ag-combobox-chevron" aria-hidden="true">⌄</span>
    {open && position && typeof document !== "undefined" && createPortal(<div id={listboxId} ref={menu} className="ag-employee-menu ag-equipment-menu" role="listbox" data-placement={position.placement} style={{ top: position.top, bottom: position.bottom, left: position.left, width: position.width, maxHeight: position.maxHeight }}>
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

  useRefreshGrid(gridApi, JSON.stringify([draftStructureKey, draftValuesKey]));

  useEffect(() => {
    const selected = new Set(props.selectedIds);
    const selectedDrafts = new Set(props.selectedDraftKeys);
    const frame = requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.forEachNode((node) => node.setSelected(Boolean(
        (node.data?.entry && selected.has(node.data.entry.id))
        || (node.data?.kind === "draft" && node.data.draft && selectedDrafts.has(node.data.draft.key)),
      )));
    });
    return () => cancelAnimationFrame(frame);
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
    if (field === "mainWork") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.mainWorkTypeId} options={propsRef.current.mainWorkTypes} placeholder="Вид работы" onChange={(mainWorkTypeId) => patchAndClose({ mainWorkTypeId })} /></div>;
    if (field === "subwork") return <div className="ag-cell-editor-host"><DraftSelect autoOpen value={draft.subworkTypeId} disabled={!draft.mainWorkTypeId} options={subworkOptions(propsRef.current.subworkTypes, draft.mainWorkTypeId)} placeholder={draft.mainWorkTypeId ? "Подвид работы" : "Сначала выберите вид работы"} onChange={(subworkTypeId) => patchAndClose({ subworkTypeId })} /></div>;
    if (field === "hours") return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" value={draft.hours} ariaLabel="Часы" autoOpen onChange={(hours) => patchAndClose({ hours })} options={Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))} /></div>;
    if (field === "note") return <div className="ag-cell-editor-host"><GridTextEditor value={draft.note} placeholder="Необязательно" onBlur={() => setActiveEditor(null)} onEnter={() => { setActiveEditor(null); setSpreadsheetFocusRequestKey((key) => key + 1); }} onChange={(note) => patchRow(row, { note })} /></div>;
    return <span className="ag-autofill-value" title={String(params.value ?? "")}>{params.value || "—"}</span>;
  }, [activeEditor, blockedEquipment, openCellEditor, patchRow, propsRef]);

  const pasteIntoRow = useCallback(({ row, values }: SpreadsheetPastePayload<EquipmentTableRow>) => {
    const current = propsRef.current;
    if (row.kind === "draft" ? !current.canCreate : !current.canUpdate) return false;
    const changes: Partial<GridEquipmentDraft> = {};
    const pasteOption = (raw: string, options: GridOption[], label: string) => {
      const pasted = raw.trim();
      const id = pastedOptionId(options, pasted);
      if (pasted && !id) current.onValidationError(`Значение «${pasted}» нельзя вставить в столбец «${label}». Выберите значение из справочника.`);
      return pasted && !id ? null : id;
    };
    if (values.equipment !== undefined) {
      const pasted = values.equipment.trim();
      const equipmentId = pastedOptionId(unitOptions, pasted);
      if (pasted && !equipmentId) { current.onValidationError(`Техника «${pasted}» не найдена в доступном реестре.`); return false; }
      const blockedReason = equipmentId ? blockedEquipment.get(Number(equipmentId)) : undefined;
      if (blockedReason) { current.onValidationError(`Эту технику нельзя добавить: ${blockedReason}.`); return false; }
      changes.equipmentId = equipmentId;
    }
    if (values.shift !== undefined) { const id = pasteOption(values.shift, current.shifts, "Смена"); if (id === null) return false; changes.shiftId = id; }
    if (values.zone !== undefined) { const id = pasteOption(values.zone, current.zones, "Зона"); if (id === null) return false; changes.zoneId = id; }
    if (values.mainWork !== undefined) { const id = pasteOption(values.mainWork, current.mainWorkTypes, "Работа"); if (id === null) return false; changes.mainWorkTypeId = id; }
    if (values.subwork !== undefined) { const id = pasteOption(values.subwork, subworkOptions(current.subworkTypes, changes.mainWorkTypeId ?? row.draft?.mainWorkTypeId ?? row.entry?.mainWorkTypeId), "Подвид работы"); if (id === null) return false; changes.subworkTypeId = id; }
    if (values.note !== undefined) changes.note = values.note;
    if (values.hours !== undefined) {
      const hours = values.hours.trim();
      if (hours && (!/^\d+$/.test(hours) || Number(hours) < 1 || Number(hours) > 10)) { current.onValidationError(`Значение «${hours}» нельзя вставить в столбец «Часы». Допустимы целые числа от 1 до 10.`); return false; }
      changes.hours = hours;
    }
    if (!Object.keys(changes).length) return false;
    if (row.kind === "entry" && row.entry) propsRef.current.onEdit(row.entry, changes);
    else patchRow(row, changes);
    return true;
  }, [blockedEquipment, patchRow, propsRef, unitOptions]);

  const columns = useMemo<ColDef<EquipmentTableRow>[]>(() => {
    return [
      { colId: "number", headerName: "№", width: 66, minWidth: 54, pinned: "left", lockPinned: true, lockPosition: "left", suppressMovable: true, suppressSizeToFit: true, sortable: false, filter: false, valueGetter: valueGetter("number") },
      { field: "equipment", headerName: "Техника", minWidth: 250, flex: 2.1, pinned: "left", lockPinned: true, lockPosition: "left", headerComponentParams: pinnableHeader, valueGetter: valueGetter("equipment"), cellRenderer: editableRenderer },
      { field: "organization", headerName: "Организация", minWidth: 145, flex: 1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("organization"), cellRenderer: editableRenderer },
      ...(props.showResponsibleUser ? [{ field: "responsibleUserName", headerName: "Ответственный", minWidth: 180, flex: 1.2, headerComponentParams: pinnableHeader, valueGetter: valueGetter("responsibleUserName"), cellRenderer: editableRenderer } satisfies ColDef<EquipmentTableRow>] : []),
      { field: "shift", headerName: "Смена", minWidth: 115, flex: .75, headerComponentParams: pinnableHeader, valueGetter: valueGetter("shift"), cellRenderer: editableRenderer },
      { field: "zone", headerName: "Зона", minWidth: 140, flex: 1.1, headerComponentParams: pinnableHeader, valueGetter: valueGetter("zone"), cellRenderer: editableRenderer },
      { field: "mainWork", headerName: "Вид работы", minWidth: 180, flex: 1.5, headerComponentParams: pinnableHeader, valueGetter: valueGetter("mainWork"), cellRenderer: editableRenderer },
      { field: "subwork", headerName: "Подвид работы", minWidth: 190, flex: 1.5, headerComponentParams: pinnableHeader, valueGetter: valueGetter("subwork"), cellRenderer: editableRenderer },
      { field: "note", headerName: "Примечание", minWidth: 170, flex: 1.25, headerComponentParams: pinnableHeader, valueGetter: valueGetter("note"), cellRenderer: editableRenderer },
      { field: "hours", headerName: "Часы", minWidth: 105, flex: .65, headerComponentParams: pinnableHeader, filter: personnelColumnFilter, filterParams: { ...personnelFilterParams, kind: "number" }, valueGetter: valueGetter("hours"), cellRenderer: editableRenderer },
    ];
  }, [editableRenderer, props.showResponsibleUser, valueGetter]);
  const reportVisibleRows = useCallback((api: GridApi<EquipmentTableRow>) => {
    const ids: number[] = [];
    api.forEachNodeAfterFilterAndSort((node) => { if (node.data?.entry?.id) ids.push(node.data.entry.id); });
    propsRef.current.onVisibleIdsChange?.(ids);
  }, [propsRef]);
  const defaultColDef = useMemo<ColDef<EquipmentTableRow>>(() => ({
    filter: personnelColumnFilter,
    filterParams: { ...personnelFilterParams, presentation: "checklist" },
    floatingFilter: false,
    resizable: true,
    sortable: true,
    suppressHeaderMenuButton: true,
    suppressHeaderFilterButton: true,
    suppressMovable: true,
  }), []);

  return <div className="ag-grid-shell ag-placement-grid ag-equipment-grid"><LocalizedGrid<EquipmentTableRow> rowOrderBlocked={Boolean(activeEditor)}
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
    rowClassRules={{ "editable-row": (params) => params.data?.kind === "edit" || params.data?.kind === "draft", "carried-row": (params) => Boolean(params.data?.draft?.carriedFromPreviousDay), "timesheet-conflict-row": (params) => Boolean(params.data?.timesheetConflict) }}
    rowSelection={!(props.canCreate || props.canUpdate || props.canDelete) ? undefined : { mode: "multiRow", checkboxes: (params) => {
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
    onGridReady={(event: GridReadyEvent<EquipmentTableRow>) => { gridApi.current = event.api; event.api.sizeColumnsToFit(); reportVisibleRows(event.api); }}
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
  /></div>;
}

export { EquipmentRegistryAgGrid, ProjectEquipmentAgGrid } from "./EquipmentDirectoryGrids";

export { EmployeeAgGrid } from "./EmployeeDirectoryGrid";


export { DirectoryAgGrid, PositionAgGrid, ProjectEmployeeAgGrid } from "./ReferenceDirectoryGrids";
