"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { themeQuartz, type ColDef, type GridApi, type IRowNode, type PostSortRowsParams } from "ag-grid-community";
import { type CustomCellRendererProps, type CustomInnerHeaderProps } from "ag-grid-react";
import type { GridEmployee, GridEntry, GridOption } from "./AgDataGrids";
import { personnelCellErrors, personnelEditableFields, personnelOptionFields, pastePersonnelCells, type PersonnelCellField, type PersonnelSpreadsheetDraft } from "./personnelSpreadsheet";
import { subworkOptions } from "./workTypeHierarchy";
import { CustomSelect } from "./CustomSelect";
import { GridTextEditor } from "./GridTextEditor";
import { comparePersonnelActivity, personnelActivityTime, personnelReportImportSortOptions } from "./personnelReportSorting";
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams, type SpreadsheetBatch } from "./GridFilters";
import { groupPersonnelReportDates, personnelReportOrderId } from "./personnelReportRowOrder";
import { ReportDatePicker } from "./ReportDateControls";
import "./personnelReportGrid.css";

export type PersonnelReportStatus = "draft" | "submitted" | "approved" | "rejected";
export type PersonnelReportGridRow = {
  rowKey: string;
  orderKey?: string;
  workDate: string;
  createdAt?: string;
  updatedAt?: string;
  rowOrder?: number;
  status: PersonnelReportStatus;
  entry?: GridEntry;
  draft?: PersonnelSpreadsheetDraft;
  editable?: boolean;
  dateEditable?: boolean;
  dateScopeLabel?: string;
  proposalId?: number;
  responsibleUserId?: number | null;
  responsibleUserName?: string;
  reviewNote?: string;
};
export type PersonnelReportGridProps = {
  rows: PersonnelReportGridRow[];
  groupByDate?: boolean;
  selectionScope?: string;
  today: string;
  loading: boolean;
  canCreate: boolean;
  canReview: boolean;
  employees: GridEmployee[];
  shifts: GridOption[];
  zones: GridOption[];
  mainWorkTypes: GridOption[];
  subworkTypes: GridOption[];
  masters: GridOption[];
  onChangeDate?: (row: PersonnelReportGridRow, workDate: string) => Promise<void>;
  onPatchDraft: (key: string, changes: Partial<PersonnelSpreadsheetDraft>) => void;
  onApplyRange: (batch: { rows: { rowKey?: string; values: Record<string, string> }[]; source: SpreadsheetBatch<unknown>["source"] }) => boolean;
  history: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
  requireComplete?: boolean;
  requiredRowKeys?: string[];
  emptyMessage?: string;
  onSelectionChange: (keys: string[]) => void;
  onVisibleRowsChange?: (keys: string[]) => void;
  onCopyRows: (rows: PersonnelReportGridRow[]) => void;
  onRemoveDraft?: (keys: string[]) => void;
  onValidationError: (message: string) => void;
  footerActions?: ReactNode;
};

// All workflow states participate in filters. `kind` is only the shared grid's
// filtering discriminator, not the approval status of the report.
type TableRow = { rowKey: string; orderKey?: string; workDate: string; kind: "entry"; insertionRank: number };
type EditableField = PersonnelCellField;
type Summary = { rows: number; dates: number; employees: number; hours: number; approved: number; submitted: number; draft: number; rejected: number; unapprovedRows: number };
const reportFixedSorts = ["workDate"];
const emptySummary: Summary = { rows: 0, dates: 0, employees: 0, hours: 0, approved: 0, submitted: 0, draft: 0, rejected: 0, unapprovedRows: 0 };
const editableFields = personnelEditableFields;
const statusLabels: Record<PersonnelReportStatus, string> = { draft: "Черновик", submitted: "На проверке", approved: "Подтверждён", rejected: "На доработке" };
const optionFields = personnelOptionFields;
const gridTheme = themeQuartz.withParams({ accentColor: "#f2aa00", backgroundColor: "#ffffff", borderColor: "#dedede", browserColorScheme: "light", cellHorizontalPadding: 12, fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif", fontSize: 13, foregroundColor: "#27272a", headerBackgroundColor: "#fafafa", headerFontSize: 13, headerFontWeight: 650, headerTextColor: "#27272a", rowBorder: { color: "#dedede", width: 1 }, rowHoverColor: "#f8fbff", selectedRowBackgroundColor: "#fff7df", spacing: 6 });
const displayDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split("-").reverse().join(".") : date;
const dateKey = (date: string) => date.split(".").reverse().join("-");
const formatHours = (hours: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(hours);

function FilterHeader(props: CustomInnerHeaderProps) {
  const [active, setActive] = useState(() => props.column.isFilterActive());
  useEffect(() => {
    const update = () => setActive(props.column.isFilterActive());
    props.api.addEventListener("filterChanged", update);
    return () => { if (!props.api.isDestroyed()) props.api.removeEventListener("filterChanged", update); };
  }, [props.api, props.column]);
  return <span className="ag-pinnable-header"><span>{props.displayName}</span><span className="ag-header-tools"><button type="button" className={active ? "ag-column-filter active" : "ag-column-filter"} aria-label={`Фильтр: ${props.displayName}`} title={`Фильтр: ${props.displayName}`} onClick={(event) => { event.stopPropagation(); props.api.showColumnFilter(props.column); }}><svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg></button></span></span>;
}

function valueFor(row: PersonnelReportGridRow, field: string, props: PersonnelReportGridProps): string | number {
  const entry = row.entry;
  const draft = row.draft;
  if (draft?.inputValues?.[field as EditableField] !== undefined) return draft.inputValues[field as EditableField]!;
  switch (field) {
    case "workDate": return displayDate(row.workDate);
    case "createdAt": return personnelActivityTime(row.createdAt ?? draft?.createdAt, row.workDate);
    case "updatedAt": return personnelActivityTime(row.updatedAt ?? draft?.updatedAt ?? row.createdAt, row.workDate);
    case "status": return statusLabels[row.status];
    case "employeeName": return draft?.employeeQuery ?? entry?.employeeName ?? "";
    case "responsibleUserName": return row.responsibleUserName ?? entry?.responsibleUserName ?? "Не назначен";
    case "hours": return draft ? draft.hours === "" ? "" : Number.isFinite(Number(draft.hours)) ? Number(draft.hours) : draft.hours : entry?.hours ?? "";
    case "note": return draft?.note ?? entry?.note ?? "";
    case "employmentType": case "department": case "position": {
      const employee = draft ? props.employees.find((item) => item.id === Number(draft.employeeId)) : undefined;
      const sameEmployee = !draft || Number(draft.employeeId) === entry?.employeeId;
      if (field === "position") return sameEmployee && entry ? entry.positionSnapshot : employee?.position ?? "";
      return sameEmployee && entry ? entry[field] : employee?.[field] ?? "";
    }
    case "shift": case "zone": case "mainWork": case "subwork": case "master": {
      const config = optionFields[field];
      const fallback = { shift: entry?.shiftName, zone: entry?.zoneName, mainWork: entry?.mainWorkTypeName, subwork: entry?.subworkTypeName, master: entry?.masterName };
      if (!draft) return fallback[field] ?? "";
      if (field === "master" && entry && Number(draft.masterId) === entry.masterId) return entry.masterName;
      const option = props[config.options].find((option) => option.id === Number(draft[config.draft]));
      return option?.name ?? (Number(draft[config.draft]) === entry?.[config.draft] ? fallback[field] : "") ?? "";
    }
    default: return "";
  }
}

function isInteractive(event?: Event | null) {
  return event?.target instanceof Element && Boolean(event.target.closest("button, input, textarea, select, [role='combobox'], .custom-select-menu"));
}

export function PersonnelReportGrid(props: PersonnelReportGridProps) {
  const propsRef = useRef(props);
  const rowsByKey = useMemo(() => new Map(props.rows.map((row) => [row.rowKey, row])), [props.rows]);
  const rowsRef = useRef(rowsByKey);
  // AG Grid applies rowData in a passive effect. Publish values before that
  // effect so a newly mounted row is complete on its very first render.
  useLayoutEffect(() => { propsRef.current = props; rowsRef.current = rowsByKey; }, [props, rowsByKey]);
  const apiRef = useRef<GridApi<TableRow> | null>(null);
  const getRowOrderId = personnelReportOrderId;
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
    groupPersonnelReportDates(nodes, node => node.group ? node.key ?? "" : node.data?.workDate ?? "", dateSort === "asc" ? "asc" : "desc");
  }, []);

  const refreshDateGroups = useCallback((api: GridApi<TableRow>) => {
    if (!propsRef.current.groupByDate) return;
    const groups: IRowNode<TableRow>[] = [];
    api.forEachNode(node => { if (node.group) groups.push(node); });
    // Full-width group renderers need explicit nodes to refresh their totals.
    if (groups.length) api.refreshCells({ rowNodes: groups, force: true });
  }, []);

  const reportSummary = useCallback((api: GridApi<TableRow>) => {
    const next = { ...emptySummary };
    const employeeIds = new Set<string>();
    const dates = new Set<string>();
    const keys: string[] = [];
    api.forEachNodeAfterFilterAndSort((node) => {
      const row = node.data && rowsRef.current.get(node.data.rowKey);
      if (!row) return;
      keys.push(row.rowKey);
      dates.add(row.workDate);
      next.rows++;
      if (row.status !== "approved") next.unapprovedRows++;
      const employeeId = row.draft ? row.draft.employeeId : row.entry?.employeeId;
      if (employeeId) employeeIds.add(String(employeeId));
      const hours = Number(valueFor(row, "hours", propsRef.current));
      if (Number.isFinite(hours) && (!row.draft || !personnelCellErrors(row.draft, propsRef.current).hours)) { next.hours += hours; next[row.status] += hours; }
    });
    next.employees = employeeIds.size;
    next.dates = dates.size;
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
  }, [props.selectionScope, props.groupByDate]);

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
      refreshDateGroups(api);
      const revealRow = movedRow ?? addedDraft;
      if (revealRow) {
        // A new editable row must be reachable even when an employee/date filter
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
  }, [rowsByKey, reportSummary, refreshDateGroups, props.requireComplete, props.requiredRowKeys]);

  const canEdit = useCallback((row: PersonnelReportGridRow) => Boolean(row.editable && row.draft), []);
  const openEditor = useCallback((row: TableRow, field: string, initialValue?: string) => {
    const source = rowsRef.current.get(row.rowKey);
    if (field === "subwork" && !source?.draft?.mainWorkTypeId) return false;
    if (!source || !canEdit(source) || !editableFields.includes(field as EditableField) || field === "employeeName" && source.draft?.lockedEmployee) return false;
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

  const renderDateGroup = useCallback((params: CustomCellRendererProps<TableRow>) => {
    const children = params.node.childrenAfterFilter ?? [];
    let hours = 0;
    for (const child of children) {
      const row = child.data && rowsRef.current.get(child.data.rowKey);
      if (!row) continue;
      const value = Number(valueFor(row, "hours", propsRef.current));
      if (Number.isFinite(value) && (!row.draft || !personnelCellErrors(row.draft, propsRef.current).hours)) hours += value;
    }
    return <span className="personnel-date-group-label"><strong>{displayDate(params.node.key ?? "")}</strong><span>Строк: {children.length}</span><span>{formatHours(hours)} ч</span></span>;
  }, []);
  const dateGroupRendererParams = useMemo(() => ({ suppressCount: true, innerRenderer: renderDateGroup }), [renderDateGroup]);

  const renderCell = useCallback((params: CustomCellRendererProps<TableRow>) => {
    const row = params.data && rowsRef.current.get(params.data.rowKey);
    if (!row) return null;
    const field = params.column?.getColId() as EditableField;
    const value = params.value ?? "";
    if (String(field) === "workDate" && (row.dateEditable ?? row.editable) && propsRef.current.onChangeDate) return <ReportDatePicker workDate={row.workDate} scopeLabel={row.dateScopeLabel} disabled={!row.editable} onChange={workDate => propsRef.current.onChangeDate!(row, workDate)} />;
    const issue = canEdit(row) && row.draft ? personnelCellErrors(row.draft, propsRef.current, (propsRef.current.requireComplete || propsRef.current.requiredRowKeys?.includes(row.rowKey)))[field] : undefined;
    if (String(field) === "status") return <span className={`personnel-report-status ${row.status}`} title={row.reviewNote || statusLabels[row.status]}>{statusLabels[row.status]}{row.reviewNote && <span aria-label={row.reviewNote}> · ⓘ</span>}</span>;
    if (!canEdit(row) || !editableFields.includes(field) || field === "employeeName" && row.draft?.lockedEmployee) return <span title={String(value)}>{value === "" ? "—" : value}</span>;
    const draft = row.draft!;
    if (field === "subwork" && !draft.mainWorkTypeId) return <span className="work-type-prerequisite" title="Сначала выберите вид работы">Сначала выберите вид работы</span>;
    if (activeEditor?.rowKey !== row.rowKey || activeEditor.field !== field) return <span className="ag-editable-cell-display" title={issue ? `${value || "Пустая ячейка"}. ${issue}` : String(value)} aria-invalid={Boolean(issue)}><span>{issue && <span className="personnel-cell-error-icon" aria-label={issue}>!</span>}{value === "" ? "Не заполнено" : value}</span>{field !== "note" && <button type="button" className="ag-editable-cell-menu" aria-label={`Открыть список: ${params.colDef?.headerName ?? field}`} title={`Открыть список: ${params.colDef?.headerName ?? field}`} onClick={(event) => { event.stopPropagation(); if (params.data) openEditor(params.data, field); }}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg></button>}</span>;
    const patch = (changes: Partial<PersonnelSpreadsheetDraft>) => { propsRef.current.onPatchDraft(draft.key, changes); closeEditor(); };
    if (activeEditor.initialValue !== undefined) return <div className="ag-cell-editor-host"><GridTextEditor value={activeEditor.initialValue} selectOnMount={false} placeholder={params.colDef?.headerName ?? field} onBlur={() => setActiveEditor(null)} onEnter={closeEditor} onChange={text => propsRef.current.onPatchDraft(draft.key, pastePersonnelCells(draft, { [field]: text }, propsRef.current))} /></div>;
    if (field === "note") return <div className="ag-cell-editor-host"><GridTextEditor value={draft.note} placeholder="Примечание к отчёту" onBlur={() => setActiveEditor(null)} onEnter={closeEditor} onChange={(note) => propsRef.current.onPatchDraft(draft.key, { note })} /></div>;
    if (field === "employeeName") return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" ariaLabel="Сотрудник" value={draft.employeeId} searchable autoOpen onChange={(employeeId) => patch({ employeeId, employeeQuery: propsRef.current.employees.find((item) => item.id === Number(employeeId))?.fullName ?? "" })} options={[{ value: "", label: "Выберите сотрудника" }, ...propsRef.current.employees.map((employee) => ({ value: String(employee.id), label: employee.fullName }))]} /></div>;
    if (field === "hours") return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" ariaLabel="Часы" value={draft.hours} autoOpen onChange={(hours) => patch({ hours })} options={[{ value: "", label: "Выберите часы" }, ...Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))]} /></div>;
    const config = optionFields[field];
    return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" ariaLabel={config.label} value={draft[config.draft]} autoOpen searchable onChange={(value) => patch({ [config.draft]: value })} options={[{ value: "", label: `Выберите: ${config.label.toLocaleLowerCase("ru-RU")}` }, ...(field === "subwork" ? subworkOptions(propsRef.current.subworkTypes, draft.mainWorkTypeId) : propsRef.current[config.options]).map((option) => ({ value: String(option.id), label: option.name }))]} /></div>;
  }, [activeEditor, canEdit, closeEditor, openEditor]);

  const columns = useMemo<ColDef<TableRow>[]>(() => {
    const column = (field: string, headerName: string, minWidth: number, flex = 1): ColDef<TableRow> => ({ colId: field, headerName, minWidth, flex, valueGetter: valueGetter(field), cellRenderer: renderCell, headerComponentParams: { innerHeaderComponent: FilterHeader } });
    return [
      { colId: "reportDateGroup", headerName: "Дата отчёта", valueGetter: ({ data }) => data?.workDate ?? "", rowGroup: Boolean(props.groupByDate), hide: true, lockVisible: true, suppressColumnsToolPanel: true, sortable: false, filter: false },
      { ...column("workDate", "Дата", 125), pinned: "left", width: 125, maxWidth: 145, suppressSizeToFit: true, filterParams: { ...personnelFilterParams, kind: "date", rowSortOptions: personnelReportImportSortOptions }, initialSort: "desc", initialSortIndex: 0, comparator: (a: string, b: string) => dateKey(a).localeCompare(dateKey(b)) },
      { colId: "__importOrder", headerName: "Порядок импорта", hide: true, lockVisible: true, suppressColumnsToolPanel: true, filter: false, sortable: true, valueGetter: ({ data }) => data?.insertionRank ?? Number.MAX_SAFE_INTEGER },
      ...(["createdAt", "updatedAt"] as const).map((field): ColDef<TableRow> => ({
        colId: field, headerName: field === "createdAt" ? "Добавлено" : "Изменено", hide: true, lockVisible: true,
        suppressColumnsToolPanel: true, filter: false, sortable: true, valueGetter: valueGetter(field),
        comparator: activityComparator,
      })),
      { ...column("employeeName", "ФИО", 220, 2), pinned: "left", width: 250, maxWidth: 320 },
      column("status", "Статус", 165),
      column("responsibleUserName", "Ответственный", 190),
      column("employmentType", "Тип", 100, .6),
      column("department", "Отдел", 125, .7),
      column("position", "Должность", 180, 1.4),
      column("shift", "Смена", 125, .8),
      column("zone", "Зона", 140),
      column("mainWork", "Вид работы", 170, 1.3),
      column("subwork", "Подвид работы", 180, 1.3),
      column("master", "Мастер", 165),
      { ...column("hours", "Часы", 105, .6), filterParams: { ...personnelFilterParams, kind: "number" } },
      column("note", "Примечание", 200, 1.5),
    ];
  }, [renderCell, valueGetter, activityComparator, props.groupByDate]);
  const defaultColDef = useMemo<ColDef<TableRow>>(() => ({ filter: personnelColumnFilter, filterParams: personnelFilterParams, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true, cellClassRules: { "personnel-cell-invalid": params => { const row = params.data && rowsRef.current.get(params.data.rowKey); return Boolean(row?.editable && row.draft && personnelCellErrors(row.draft, propsRef.current, (propsRef.current.requireComplete || propsRef.current.requiredRowKeys?.includes(row.rowKey)))[params.column.getColId() as EditableField]); } } }), []);

  const selectedRows = selectedKeys.flatMap((key) => rowsByKey.get(key) ?? []);
  const removableKeys = selectedRows.filter((row) => row.editable && row.draft && (row.status === "draft" || row.status === "rejected")).map((row) => row.rowKey);
  return <section className={`personnel-history-table${props.groupByDate ? " personnel-history-grouped" : ""}`} aria-label={props.groupByDate ? "Подтверждённые отчёты по датам" : "Отчёт персонала за все дни"}>
    {props.groupByDate && <div className="personnel-date-controls"><span>Дат: <strong>{summary.dates}</strong></span><div><button type="button" disabled={props.loading || !summary.dates} onClick={() => apiRef.current?.expandAll()}>Раскрыть все</button><button type="button" disabled={props.loading || !summary.dates} onClick={() => apiRef.current?.collapseAll()}>Свернуть все</button></div></div>}
    <div className="ag-grid-shell ag-placement-grid personnel-history-grid"><LocalizedGrid<TableRow>
      theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} postSortRows={keepDatesTogether}
      groupDisplayType={props.groupByDate ? "groupRows" : undefined} groupDefaultExpanded={0} groupMaintainOrder
      groupRowRendererParams={dateGroupRendererParams}
      enterpriseFilters showSortSummary={false} spreadsheetToolbar={false}
      getRowOrderId={getRowOrderId}
      rowOrderFixedSorts={reportFixedSorts} rowOrderAutoSwitchSort rowOrderBlocked={Boolean(activeEditor)}
      getRowId={({ data }) => data.rowKey} rowHeight={44} headerHeight={46} animateRows={false} loading={props.loading}
      loadingOverlayComponent={() => <span className="ag-overlay-message">Загружаем отчёты…</span>}
      noRowsOverlayComponent={() => <span className="ag-overlay-message">{props.emptyMessage ?? "За выбранный период отчётов пока нет"}</span>}
      rowClassRules={{ "personnel-date-group-row": ({ node }) => Boolean(node.group), "editable-row": ({ data }) => Boolean(data && rowsRef.current.get(data.rowKey)?.editable), "personnel-history-today": ({ data }) => Boolean(data && rowsRef.current.get(data.rowKey)?.workDate === propsRef.current.today), "personnel-history-rejected": ({ data }) => Boolean(data && rowsRef.current.get(data.rowKey)?.status === "rejected") }}
      rowSelection={{ mode: "multiRow", checkboxes: ({ node }) => Boolean(!node.group && node.data), isRowSelectable: node => Boolean(!node.group && node.data), headerCheckbox: true, selectAll: "filtered", enableClickSelection: false }}
      selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true }}
      onGridReady={(event) => { apiRef.current = event.api; reportSummary(event.api); }}
      onModelUpdated={(event) => reportSummary(event.api)} onFilterChanged={(event) => { refreshDateGroups(event.api); reportSummary(event.api); }} onSortChanged={(event) => reportSummary(event.api)}
      onSelectionChanged={(event) => { const keys = event.api.getSelectedRows().flatMap(row => row?.rowKey ? [row.rowKey] : []); setSelectedKeys(keys); propsRef.current.onSelectionChange(keys); }}
      onCellMouseDown={(event) => { if (activeEditor && !isInteractive(event.event) && (event.data?.rowKey !== activeEditor.rowKey || event.column.getColId() !== activeEditor.field)) setActiveEditor(null); }}
      onCellDoubleClicked={(event) => { if (event.data && !isInteractive(event.event)) openEditor(event.data, event.column.getColId()); }}
      onSpreadsheetEdit={({ row, columnId, initialValue }) => openEditor(row, columnId, initialValue)} onSpreadsheetCancelEdit={closeEditor}
      onSpreadsheetBatch={batch => { setActiveEditor(null); return propsRef.current.onApplyRange({ ...batch, rows: batch.rows.map(item => ({ rowKey: item.row?.rowKey, values: item.values })) }); }}
      canWriteSpreadsheetCell={(row, field) => { const source = rowsRef.current.get(row.rowKey); return Boolean(source && canEdit(source) && editableFields.includes(field as EditableField) && !(field === "employeeName" && source.draft?.lockedEmployee)); }}
      spreadsheetHistory={props.history}
      spreadsheetFocusRequestKey={focusRequest} spreadsheetSelectionResetKey={`${props.selectionScope ?? ""}:${Boolean(props.groupByDate)}:${structure}`}
      getSpreadsheetContextActions={({ row }) => { const source = rowsRef.current.get(row.rowKey); return source && propsRef.current.canCreate ? [{ label: "Скопировать строку на сегодня", onSelect: () => propsRef.current.onCopyRows([source]) }] : []; }}
      suppressCellFocus
    /></div>
    <div className="personnel-history-footer"><div className="personnel-history-summary" role="status"><strong>Строк: {summary.rows} · Сотрудников: {summary.employees} · Часы: {formatHours(summary.hours)}</strong>{summary.approved > 0 && summary.unapprovedRows > 0 && <span className="personnel-history-approved">Подтверждено: {formatHours(summary.approved)} ч.</span>}{summary.submitted > 0 && <span>На проверке: {formatHours(summary.submitted)} ч.</span>}{summary.draft + summary.rejected > 0 && <span>Черновики: {formatHours(summary.draft + summary.rejected)} ч.</span>}</div><div className="personnel-history-footer-actions">{props.footerActions}{selectedRows.length > 0 && <>{props.canCreate && <button type="button" className="secondary-button" disabled={props.loading} onClick={() => props.onCopyRows(selectedRows)}>Скопировать на сегодня ({selectedRows.length})</button>}{props.onRemoveDraft && removableKeys.length > 0 && <button type="button" className="secondary-button" disabled={props.loading} onClick={() => props.onRemoveDraft?.(removableKeys)}>Убрать из черновика ({removableKeys.length})</button>}</>}</div></div>
  </section>;
}
