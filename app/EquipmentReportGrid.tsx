"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type ColDef, type GridApi, type IRowNode, type PostSortRowsParams } from "ag-grid-community";
import { type CustomCellRendererProps } from "ag-grid-react";
import type { GridEquipmentUnit, GridEquipmentEntry, GridOption } from "./AgDataGrids";
import { equipmentCellErrors, equipmentEditableFields, equipmentOptionFields, pasteEquipmentCells, equipmentSpreadsheetName, equipmentUnavailableFor, type EquipmentAvailabilityMark, type EquipmentCellField, type EquipmentSpreadsheetDraft } from "./equipmentSpreadsheet";
import { subworkOptions } from "./workTypeHierarchy";
import { CustomSelect } from "./CustomSelect";
import { GridTextEditor } from "./GridTextEditor";
import { comparePersonnelActivity, personnelActivityTime, personnelReportImportSortOptions } from "./personnelReportSorting";
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams, type SpreadsheetBatch } from "./GridFilters";
import { groupEquipmentReportDates, equipmentReportOrderId } from "./equipmentReportRowOrder";
import type { EquipmentReportStatus } from "./equipmentReportTypes";
import { ReportDatePicker } from "./ReportDateControls";
import { SpreadsheetFilterHeader as FilterHeader } from "./SpreadsheetFilterHeader";
import { useWorkspaceTableOrder } from "./TableRowMoves";
import { useCatalogGridPreferences } from "./useCatalogGridPreferences";
import { EQUIPMENT_REPORT_COLUMN_SIZING, equipmentReportColumnWidths } from "./equipmentReportColumnSizing";
import { gridTheme } from "./gridTheme";
import { AgTablePageScroll } from "./TablePageScroll";
import "./personnelReportGrid.css";

export type { EquipmentReportStatus } from "./equipmentReportTypes";
export type EquipmentReportGridRow = {
  rowKey: string;
  orderKey?: string;
  workDate: string;
  createdAt?: string;
  updatedAt?: string;
  rowOrder?: number;
  status: EquipmentReportStatus;
  entry?: GridEquipmentEntry;
  draft?: EquipmentSpreadsheetDraft;
  editable?: boolean;
  dateEditable?: boolean;
  dateScopeLabel?: string;
  removable?: boolean;
  proposalId?: number;
  responsibleUserId?: number | null;
  responsibleUserName?: string;
  reviewNote?: string;
};
export type EquipmentReportGridProps = {
  rows: EquipmentReportGridRow[];
  sizingRows?: EquipmentReportGridRow[];
  preferenceScope?: { userId: number; siteId: number };
  selectionScope?: string;
  today: string;
  loading: boolean;
  canCreate: boolean;
  canReview: boolean;
  units: GridEquipmentUnit[];
  shifts: GridOption[];
  zones: GridOption[];
  mainWorkTypes: GridOption[];
  subworkTypes: GridOption[];
  dailyTimesheetMarks?: EquipmentAvailabilityMark[];
  onChangeDate?: (row: EquipmentReportGridRow, workDate: string) => Promise<void>;
  onPatchDraft: (key: string, changes: Partial<EquipmentSpreadsheetDraft>) => void;
  onPendingDraftInput?: (rowKey: string, field: EquipmentCellField, value: string | null) => void;
  onApplyRange: (batch: { rows: { rowKey?: string; values: Record<string, string> }[]; source: SpreadsheetBatch<unknown>["source"] }) => boolean;
  history: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
  requireComplete?: boolean;
  requiredRowKeys?: string[];
  emptyMessage?: string;
  onSelectionChange: (keys: string[]) => void;
  onVisibleRowsChange?: (keys: string[]) => void;
  onCopyRows: (rows: EquipmentReportGridRow[]) => void;
  onRemoveDraft?: (keys: string[]) => void;
  onValidationError: (message: string) => void;
  footerActions?: ReactNode;
  footerStatus?: ReactNode;
};

// All workflow states participate in filters. `kind` is only the shared grid's
// filtering discriminator, not the approval status of the report.
type TableRow = { rowKey: string; orderKey?: string; workDate: string; kind: "entry"; insertionRank: number };
type EditableField = EquipmentCellField;
type Summary = { rows: number; units: number; hours: number; productive: number; downtime: number; approved: number; submitted: number; draft: number; rejected: number; unapprovedRows: number };
const reportFixedSorts = ["workDate"];
const emptySummary: Summary = { rows: 0, units: 0, hours: 0, productive: 0, downtime: 0, approved: 0, submitted: 0, draft: 0, rejected: 0, unapprovedRows: 0 };
const editableFields = equipmentEditableFields;
const statusLabels: Record<EquipmentReportStatus, string> = { draft: "Черновик", submitted: "На проверке", approved: "Подтверждён", rejected: "На доработке" };
const optionFields = equipmentOptionFields;
const displayDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split("-").reverse().join(".") : date;
const dateKey = (date: string) => date.split(".").reverse().join("-");
const formatHours = (hours: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(hours);

type CatalogIndex = {
  units: Map<number, GridEquipmentUnit>;
  options: Record<"shifts" | "zones" | "mainWorkTypes" | "subworkTypes", Map<number, GridOption>>;
};
function valueFor(row: EquipmentReportGridRow, field: string, props: EquipmentReportGridProps, index?: CatalogIndex): string | number {
  const entry = row.entry;
  const draft = row.draft;
  if (draft?.inputValues?.[field as EditableField] !== undefined) return draft.inputValues[field as EditableField]!;
  const sameEquipment = !draft || Number(draft.equipmentId) === entry?.equipmentId;
  const unit = sameEquipment && entry ? entry : index ? index.units.get(Number(draft?.equipmentId)) : props.units.find(item => item.id === Number(draft?.equipmentId));
  switch (field) {
    case "workDate": return displayDate(row.workDate);
    case "createdAt": return personnelActivityTime(row.createdAt ?? draft?.createdAt, row.workDate);
    case "updatedAt": return personnelActivityTime(row.updatedAt ?? draft?.updatedAt ?? row.createdAt, row.workDate);
    case "status": return statusLabels[row.status];
    case "equipment": return equipmentSpreadsheetName(unit);
    case "responsibleUserName": return row.responsibleUserName ?? entry?.responsibleUserName ?? "Не назначен";
    case "hours": return draft ? draft.hours === "" ? "" : Number.isFinite(Number(draft.hours)) ? Number(draft.hours) : draft.hours : entry?.hours ?? "";
    case "note": return draft?.note ?? entry?.note ?? "";
    case "organization": case "equipmentType": case "brand": case "model": case "registrationNumber": return unit?.[field] ?? "";
    case "shift": case "zone": case "mainWork": case "subwork": {
      const config = optionFields[field];
      const fallback = { shift: entry?.shiftName, zone: entry?.zoneName, mainWork: entry?.mainWorkTypeName, subwork: entry?.subworkTypeName };
      if (!draft) return fallback[field] ?? "";
      const option = index ? index.options[config.options].get(Number(draft[config.draft])) : props[config.options].find(option => option.id === Number(draft[config.draft]));
      return Number(draft[config.draft]) === entry?.[config.draft] ? fallback[field] ?? option?.name ?? "" : option?.name ?? "";
    }
    default: return "";
  }
}

function isInteractive(event?: Event | null) {
  return event?.target instanceof Element && Boolean(event.target.closest("button, input, textarea, select, [role='combobox'], .custom-select-menu"));
}

export function EquipmentReportGrid(props: EquipmentReportGridProps) {
  const gridId = useId();
  const rowOrder = useWorkspaceTableOrder();
  const preferences = useCatalogGridPreferences({ userId: props.preferenceScope?.userId, siteId: props.preferenceScope?.siteId, scopeKey: "equipmentReport", ready: !rowOrder || rowOrder.ready || Boolean(rowOrder.error) });
  const propsRef = useRef(props);
  const rowsByKey = useMemo(() => new Map(props.rows.map((row) => [row.rowKey, row])), [props.rows]);
  const rowsRef = useRef(rowsByKey);
  // AG Grid applies rowData in a passive effect. Publish values before that
  // effect so a newly mounted row is complete on its very first render.
  useLayoutEffect(() => { propsRef.current = props; rowsRef.current = rowsByKey; }, [props, rowsByKey]);
  const apiRef = useRef<GridApi<TableRow> | null>(null);
  const [scrollApi, setScrollApi] = useState<GridApi<TableRow> | null>(null);
  const sizingHost = useRef<HTMLDivElement>(null);
  const defaultWidthsApplied = useRef(false);
  const applyDefaultWidths = preferences.applyDefaultWidths;
  const sizeInitialColumns = useCallback(() => {
    const api = apiRef.current;
    if (!api || api.isDestroyed() || propsRef.current.loading || defaultWidthsApplied.current) return;
    const apply = () => {
      if (api !== apiRef.current || api.isDestroyed() || propsRef.current.loading || defaultWidthsApplied.current) return;
      const current = propsRef.current;
      const source = current.sizingRows ?? current.rows;
      if (!source.length) return;
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return;
      const family = window.getComputedStyle(sizingHost.current ?? document.body).fontFamily;
      const options = Object.fromEntries((["shifts", "zones", "mainWorkTypes", "subworkTypes"] as const).map(field => [field, new Map(current[field].map(option => [option.id, option]))])) as CatalogIndex["options"];
      const index: CatalogIndex = { units: new Map(current.units.map(unit => [unit.id, unit])), options };
      const values = source.map(row => Object.fromEntries(Object.keys(EQUIPMENT_REPORT_COLUMN_SIZING).map(field => [field, valueFor(row, field, current, index)])));
      const widths = equipmentReportColumnWidths(values, (text, bold) => {
        context.font = `${bold ? 650 : 400} 13px ${family}`;
        return context.measureText(text).width;
      });
      applyDefaultWidths(widths);
      defaultWidthsApplied.current = true;
    };
    void (document.fonts?.ready ?? Promise.resolve()).then(apply);
  }, [applyDefaultWidths]);
  useEffect(() => { sizeInitialColumns(); }, [props.loading, props.sizingRows, props.rows, sizeInitialColumns]);
  const getRowOrderId = equipmentReportOrderId;
  const [activeEditor, setActiveEditor] = useState<{ rowKey: string; field: EditableField; initialValue?: string } | null>(null);
  const [summary, setSummary] = useState(emptySummary);
  const lastVisibleKeys = useRef<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [focusRequest, setFocusRequest] = useState(0);
  const previousRowKeys = useRef(new Set(props.rows.map((row) => row.rowKey)));
  const previousRowDates = useRef(new Map(props.rows.map(row => [row.rowKey, row.workDate])));
  const structure = JSON.stringify(props.rows.map(({ rowKey, workDate, orderKey }) => ({ rowKey, workDate, orderKey })));
  const rowData = useMemo<TableRow[]>(() => (JSON.parse(structure) as { rowKey: string; orderKey?: string; workDate: string }[]).map((row, insertionRank) => ({ ...row, kind: "entry", insertionRank })), [structure]);
  const keepDatesTogether = useCallback(({ nodes, api }: PostSortRowsParams<TableRow>) => {
    const dateSort = api.getColumnState().find(column => column.colId === "workDate")?.sort;
    groupEquipmentReportDates(nodes, node => node.data?.workDate ?? "", dateSort === "asc" ? "asc" : "desc");
  }, []);

  const reportSummary = useCallback((api: GridApi<TableRow>) => {
    const next = { ...emptySummary };
    const equipmentIds = new Set<string>();
    const keys: string[] = [];
    api.forEachNodeAfterFilterAndSort((node) => {
      const row = node.data && rowsRef.current.get(node.data.rowKey);
      if (!row) return;
      keys.push(row.rowKey);
      next.rows++;
      if (row.status !== "approved") next.unapprovedRows++;
      const equipmentId = row.draft?.equipmentId || row.entry?.equipmentId;
      if (equipmentId) equipmentIds.add(String(equipmentId));
      const hours = Number(valueFor(row, "hours", propsRef.current));
      if (Number.isFinite(hours) && (!row.draft || !equipmentCellErrors(row.draft, propsRef.current, false, row.workDate).hours)) {
        next.hours += hours;
        next[row.status] += hours;
        next[String(valueFor(row, "subwork", propsRef.current)).toLocaleLowerCase("ru-RU").includes("простой") ? "downtime" : "productive"] += hours;
      }
    });
    next.units = equipmentIds.size;
    setSummary((current) => Object.keys(next).every((key) => current[key as keyof Summary] === next[key as keyof Summary]) ? current : next);
    const visibleKey = JSON.stringify(keys);
    if (lastVisibleKeys.current !== visibleKey) {
      lastVisibleKeys.current = visibleKey;
      propsRef.current.onVisibleRowsChange?.(keys);
    }
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const api = apiRef.current;
      if (api && !api.isDestroyed()) api.deselectAll();
      setSelectedKeys([]);
      setActiveEditor(null);
      propsRef.current.onSelectionChange([]);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.selectionScope]);

  useEffect(() => {
    if (props.loading) return;
    const frame = requestAnimationFrame(() => {
      const api = apiRef.current;
      if (api && !api.isDestroyed()) {
        // Two empty workflow tabs share rowData, but need different messages.
        api.hideOverlay();
        if (!propsRef.current.rows.length && !propsRef.current.loading) api.showNoRowsOverlay();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [props.emptyMessage, props.loading, props.rows.length]);

  useEffect(() => {
    const addedDraft = [...rowsByKey.values()].find((row) => row.editable && !previousRowKeys.current.has(row.rowKey));
    const movedRow = [...rowsByKey.values()].find(row => previousRowDates.current.has(row.rowKey) && previousRowDates.current.get(row.rowKey) !== row.workDate);
    previousRowDates.current = new Map([...rowsByKey.values()].map(row => [row.rowKey, row.workDate]));
    previousRowKeys.current = new Set(rowsByKey.keys());
    const frame = requestAnimationFrame(() => {
      const api = apiRef.current;
      if (!api || api.isDestroyed()) return;
      // The data objects stay stable while keystrokes live in GridTextEditor.
      // Refresh committed values in place; never tear down an editing row.
      api.refreshClientSideRowModel("everything");
      api.refreshCells({ force: true });
      const revealRow = movedRow ?? addedDraft;
      if (revealRow) {
        // A new editable row must be reachable even when an equipment/date filter
        // had hidden blank values before the row was created.
        api.setFilterModel(null);
        const node = api.getRowNode(revealRow.rowKey);
        // Only scroll when the new row is outside the viewport. Aligning every
        // addition to the top hides the drafts added by the preceding clicks.
        if (node) api.ensureNodeVisible(node);
      }
      reportSummary(api);
    });
    return () => cancelAnimationFrame(frame);
  }, [rowsByKey, reportSummary, props.requireComplete, props.requiredRowKeys, props.dailyTimesheetMarks]);

  const canEdit = useCallback((row: EquipmentReportGridRow) => Boolean(row.editable && row.draft), []);
  const openEditor = useCallback((row: TableRow, field: string, initialValue?: string) => {
    const source = rowsRef.current.get(row.rowKey);
    if (field === "subwork" && !source?.draft?.mainWorkTypeId) return false;
    if (!source || !canEdit(source) || !editableFields.includes(field as EditableField) || field === "equipment" && source.draft?.lockedEquipment) return false;
    if (initialValue !== undefined) propsRef.current.onPendingDraftInput?.(row.rowKey, field as EditableField, initialValue);
    setActiveEditor({ rowKey: row.rowKey, field: field as EditableField, initialValue });
    return true;
  }, [canEdit]);
  const closeEditor = useCallback(() => { setActiveEditor(null); setFocusRequest((value) => value + 1); }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const api = apiRef.current;
      if (api && !api.isDestroyed()) api.refreshCells({ force: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeEditor]);
  const valueGetter = useCallback((field: string) => ({ data }: { data?: TableRow }) => {
    const source = data && rowsRef.current.get(data.rowKey);
    return source ? valueFor(source, field, propsRef.current) : "";
  }, []);
  const activityComparator = useCallback((left: number, right: number, leftNode: IRowNode<TableRow>, rightNode: IRowNode<TableRow>) => comparePersonnelActivity(left, right,
    leftNode.data?.insertionRank ?? 0, rightNode.data?.insertionRank ?? 0), []);

  const renderCell = useCallback((params: CustomCellRendererProps<TableRow>) => {
    const row = params.data && rowsRef.current.get(params.data.rowKey);
    if (!row) return null;
    const field = params.column?.getColId() as EditableField;
    const value = params.value ?? "";
    if (String(field) === "workDate" && (row.dateEditable ?? row.editable) && propsRef.current.onChangeDate) return <ReportDatePicker workDate={row.workDate} scopeLabel={row.dateScopeLabel} disabled={!row.editable} onChange={workDate => propsRef.current.onChangeDate!(row, workDate)} />;
    const issue = canEdit(row) && row.draft ? equipmentCellErrors(row.draft, propsRef.current, (propsRef.current.requireComplete || propsRef.current.requiredRowKeys?.includes(row.rowKey)), row.workDate)[field] : undefined;
    const unavailable = field === "equipment" ? equipmentUnavailableFor(propsRef.current, row.draft?.equipmentId || row.entry?.equipmentId || "", row.workDate) : undefined;
    const withAvailability = (content: ReactNode) => unavailable ? <div className="ag-roster-employee-wrap">{content}<small className="ag-timesheet-conflict" title={`Техника недоступна по табелю: ${unavailable}`}>⚠ {unavailable}</small></div> : content;
    if (String(field) === "status") return <span className={`personnel-report-status ${row.status}`} title={row.reviewNote || statusLabels[row.status]}>{statusLabels[row.status]}{row.reviewNote && <span aria-label={row.reviewNote}> · ⓘ</span>}</span>;
    if (!canEdit(row) || !editableFields.includes(field) || field === "equipment" && row.draft?.lockedEquipment) return withAvailability(<span title={String(value)}>{value === "" ? "—" : value}</span>);
    const draft = row.draft!;
    if (field === "subwork" && !draft.mainWorkTypeId) return <span className="work-type-prerequisite" title="Сначала выберите вид работы">Сначала выберите вид работы</span>;
    if (activeEditor?.rowKey !== row.rowKey || activeEditor.field !== field) return withAvailability(<span className="ag-editable-cell-display" title={issue ? `${value || "Пустая ячейка"}. ${issue}` : String(value)} aria-invalid={Boolean(issue)}><span>{issue && <span className="personnel-cell-error-icon" aria-label={issue}>!</span>}{value === "" ? "Не заполнено" : value}</span>{field !== "note" && <button type="button" className="ag-editable-cell-menu" aria-label={`Открыть список: ${params.colDef?.headerName ?? field}`} title={`Открыть список: ${params.colDef?.headerName ?? field}`} onClick={(event) => { event.stopPropagation(); if (params.data) openEditor(params.data, field); }}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg></button>}</span>);
    const patch = (changes: Partial<EquipmentSpreadsheetDraft>) => { propsRef.current.onPatchDraft(draft.key, changes); closeEditor(); };
    const onPendingValue = (value: string | null) => propsRef.current.onPendingDraftInput?.(draft.key, field, value);
    if (activeEditor.initialValue !== undefined) return <div className="ag-cell-editor-host"><GridTextEditor value={activeEditor.initialValue} originalValue={String(valueFor(row, field, propsRef.current))} selectOnMount={false} placeholder={params.colDef?.headerName ?? field} onPendingValue={onPendingValue} onBlur={() => setActiveEditor(null)} onEnter={closeEditor} onChange={text => propsRef.current.onPatchDraft(draft.key, pasteEquipmentCells(draft, { [field]: text }, propsRef.current))} /></div>;
    if (field === "note") return <div className="ag-cell-editor-host"><GridTextEditor value={draft.note} placeholder="Примечание к отчёту" onPendingValue={onPendingValue} onBlur={() => setActiveEditor(null)} onEnter={closeEditor} onChange={(note) => propsRef.current.onPatchDraft(draft.key, { note })} /></div>;
    if (field === "equipment") return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" ariaLabel="Техника" value={draft.equipmentId} searchable autoOpen onChange={equipmentId => patch({ equipmentId, equipmentQuery: equipmentSpreadsheetName(propsRef.current.units.find(unit => unit.id === Number(equipmentId))) })} options={[{ value: "", label: "Выберите технику" }, ...propsRef.current.units.map(unit => {
      const unavailable = equipmentUnavailableFor(propsRef.current, unit.id, row.workDate);
      return { value: String(unit.id), label: equipmentSpreadsheetName(unit), searchText: [unit.equipmentType, unit.brand, unit.organization, unavailable].filter(Boolean).join(" "), title: unavailable ? `Недоступна по табелю: ${unavailable}` : undefined, disabled: Boolean(unavailable) };
    })]} /></div>;
    if (field === "hours") return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" ariaLabel="Часы" value={draft.hours} autoOpen onChange={(hours) => patch({ hours })} options={[{ value: "", label: "Выберите часы" }, ...Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))]} /></div>;
    const config = optionFields[field];
    return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" ariaLabel={config.label} value={draft[config.draft]} autoOpen searchable onChange={(value) => patch({ [config.draft]: value })} options={[{ value: "", label: `Выберите: ${config.label.toLocaleLowerCase("ru-RU")}` }, ...(field === "subwork" ? subworkOptions(propsRef.current.subworkTypes, draft.mainWorkTypeId) : propsRef.current[config.options]).map((option) => ({ value: String(option.id), label: option.name }))]} /></div>;
  }, [activeEditor, canEdit, closeEditor, openEditor]);

  const columns = useMemo<ColDef<TableRow>[]>(() => {
    // Editors recreate these definitions. Only initialize sizing so AG Grid can
    // retain manual widths instead of re-enabling flex after every cell edit.
    const column = (field: string, headerName: string, minWidth: number, flex = 1): ColDef<TableRow> => ({ colId: field, headerName, minWidth, initialFlex: flex, valueGetter: valueGetter(field), cellRenderer: renderCell, headerComponentParams: { innerHeaderComponent: FilterHeader } });
    return [
      { ...column("workDate", "Дата", 125), pinned: "left", initialWidth: 125, maxWidth: 145, suppressSizeToFit: true, filterParams: { ...personnelFilterParams, kind: "date", rowSortOptions: personnelReportImportSortOptions }, initialSort: "desc", initialSortIndex: 0, comparator: (a: string, b: string) => dateKey(a).localeCompare(dateKey(b)) },
      { colId: "__importOrder", headerName: "Порядок импорта", hide: true, lockVisible: true, suppressColumnsToolPanel: true, filter: false, sortable: true, valueGetter: ({ data }) => data?.insertionRank ?? Number.MAX_SAFE_INTEGER },
      ...(["createdAt", "updatedAt"] as const).map((field): ColDef<TableRow> => ({
        colId: field, headerName: field === "createdAt" ? "Добавлено" : "Изменено", hide: true, lockVisible: true,
        suppressColumnsToolPanel: true, filter: false, sortable: true, valueGetter: valueGetter(field),
        comparator: activityComparator,
      })),
      { ...column("equipment", "Техника", 250, 2), pinned: "left", initialWidth: 280 },
      column("status", "Статус", 140),
      column("responsibleUserName", "Ответственный", 190),
      column("organization", "Организация", 160),
      column("equipmentType", "Тип техники", 150),
      column("brand", "Марка", 130),
      column("model", "Модель", 160),
      column("registrationNumber", "ГРЗ / Инв. №", 155),
      column("shift", "Смена", 100, .8),
      column("zone", "Зона", 140),
      column("mainWork", "Вид работы", 170, 1.3),
      column("subwork", "Подвид работы", 180, 1.3),
      { ...column("hours", "Часы", 80), initialWidth: 84, initialFlex: undefined, filterParams: { ...personnelFilterParams, kind: "number" } },
      column("note", "Примечание", 200, 1.5),
    ];
  }, [renderCell, valueGetter, activityComparator]);
  const defaultColDef = useMemo<ColDef<TableRow>>(() => ({ filter: personnelColumnFilter, filterParams: { ...personnelFilterParams, presentation: "checklist" }, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true, cellClassRules: { "personnel-cell-invalid": params => { const row = params.data && rowsRef.current.get(params.data.rowKey); return Boolean(row?.editable && row.draft && equipmentCellErrors(row.draft, propsRef.current, (propsRef.current.requireComplete || propsRef.current.requiredRowKeys?.includes(row.rowKey)), row.workDate)[params.column.getColId() as EditableField]); } } }), []);

  const selectedRows = selectedKeys.flatMap((key) => rowsByKey.get(key) ?? []);
  const removableKeys = selectedRows.filter((row) => row.removable !== false && row.editable && row.draft && (row.status === "draft" || row.status === "rejected")).map((row) => row.rowKey);
  const footerPanel = <div className="personnel-history-footer"><div className="personnel-history-summary" role="status"><strong>Строк: {summary.rows} · Единиц техники: {summary.units} · Часы: {formatHours(summary.hours)}</strong><span>Работа: {formatHours(summary.productive)} ч. · Простой: {formatHours(summary.downtime)} ч.</span>{summary.approved > 0 && summary.unapprovedRows > 0 && <span className="personnel-history-approved">Подтверждено: {formatHours(summary.approved)} ч.</span>}{summary.submitted > 0 && <span>На проверке: {formatHours(summary.submitted)} ч.</span>}{summary.draft + summary.rejected > 0 && <span>Черновики: {formatHours(summary.draft + summary.rejected)} ч.</span>}{props.footerStatus && <div className="personnel-history-save-status">{props.footerStatus}</div>}</div><div className="personnel-history-footer-actions">{props.footerActions}{selectedRows.length > 0 && <>{props.canCreate && <button type="button" className="secondary-button" disabled={props.loading} onClick={() => props.onCopyRows(selectedRows)}>Скопировать на сегодня ({selectedRows.length})</button>}{props.onRemoveDraft && removableKeys.length > 0 && <button type="button" className="secondary-button" disabled={props.loading} onClick={() => props.onRemoveDraft?.(removableKeys)}>Убрать из черновика ({removableKeys.length})</button>}</>}</div></div>;
  return <section className="personnel-history-table personnel-page-scroll-table equipment-report-table" aria-label="Отчёт техники за все дни">
    <AgTablePageScroll gridRoot={sizingHost} api={scrollApi} footer={footerPanel} className="personnel-report-page-scroll-stage" frameClassName="personnel-report-page-scroll-frame" label="Горизонтальная прокрутка отчёта техники"><div ref={sizingHost} id={gridId} className="ag-grid-shell ag-placement-grid personnel-history-grid ag-equipment-grid"><LocalizedGrid<TableRow>
      theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} postSortRows={keepDatesTogether}
      enterpriseFilters showSortSummary={false} spreadsheetToolbar={false} suppressHorizontalScroll scrollbarWidth={0}
      getRowOrderId={getRowOrderId}
      rowOrderFixedSorts={reportFixedSorts} rowOrderAutoSwitchSort rowOrderBlocked={Boolean(activeEditor)} preserveSavedSort={preferences.hasSavedSort}
      getRowId={({ data }) => data.rowKey} rowHeight={44} headerHeight={46} animateRows={false} loading={props.loading}
      loadingOverlayComponent={() => <span className="ag-overlay-message">Загружаем отчёты…</span>}
      noRowsOverlayComponent={() => <span className="ag-overlay-message">{props.emptyMessage ?? "За выбранный период отчётов пока нет"}</span>}
      rowClassRules={{ "editable-row": ({ data }) => Boolean(data && rowsRef.current.get(data.rowKey)?.editable), "personnel-history-today": ({ data }) => Boolean(data && rowsRef.current.get(data.rowKey)?.workDate === propsRef.current.today), "personnel-history-rejected": ({ data }) => Boolean(data && rowsRef.current.get(data.rowKey)?.status === "rejected"), "timesheet-conflict-row": ({ data }) => { const row = data && rowsRef.current.get(data.rowKey); return Boolean(row && equipmentUnavailableFor(propsRef.current, row.draft?.equipmentId || row.entry?.equipmentId || "", row.workDate)); } }}
      rowSelection={{ mode: "multiRow", checkboxes: ({ node }) => Boolean(!node.group && node.data), isRowSelectable: node => Boolean(!node.group && node.data), headerCheckbox: true, selectAll: "filtered", enableClickSelection: false }}
      selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true }}
      onGridReady={(event) => { apiRef.current = event.api; setScrollApi(event.api); defaultWidthsApplied.current = false; preferences.attach(event.api); reportSummary(event.api); sizeInitialColumns(); }}
      onColumnResized={preferences.onColumnResized}
      onModelUpdated={(event) => reportSummary(event.api)} onFilterChanged={(event) => reportSummary(event.api)} onSortChanged={(event) => { preferences.onSortChanged(); reportSummary(event.api); }}
      onSelectionChanged={(event) => { const keys = event.api.getSelectedRows().flatMap(row => row?.rowKey ? [row.rowKey] : []); setSelectedKeys(keys); propsRef.current.onSelectionChange(keys); }}
      onCellMouseDown={(event) => { if (activeEditor && !isInteractive(event.event) && (event.data?.rowKey !== activeEditor.rowKey || event.column.getColId() !== activeEditor.field)) setActiveEditor(null); }}
      onCellDoubleClicked={(event) => { if (event.data && !isInteractive(event.event)) openEditor(event.data, event.column.getColId()); }}
      onSpreadsheetEdit={({ row, columnId, initialValue }) => openEditor(row, columnId, initialValue)} onSpreadsheetCancelEdit={closeEditor}
      onSpreadsheetBatch={batch => { setActiveEditor(null); return propsRef.current.onApplyRange({ ...batch, rows: batch.rows.map(item => ({ rowKey: item.row?.rowKey, values: item.values })) }); }}
      canWriteSpreadsheetCell={(row, field) => { const source = rowsRef.current.get(row.rowKey); return Boolean(source && canEdit(source) && editableFields.includes(field as EditableField) && !(field === "equipment" && source.draft?.lockedEquipment)); }}
      spreadsheetHistory={props.history}
      spreadsheetFocusRequestKey={focusRequest} spreadsheetSelectionResetKey={`${props.selectionScope ?? ""}:${structure}`}
      getSpreadsheetContextActions={({ row }) => { const source = rowsRef.current.get(row.rowKey); return source && propsRef.current.canCreate ? [{ label: "Скопировать строку на сегодня", onSelect: () => propsRef.current.onCopyRows([source]) }] : []; }}
      suppressCellFocus
    /></div>
    </AgTablePageScroll>
  </section>;
}
