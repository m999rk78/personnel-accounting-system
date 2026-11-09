"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ColDef, GridApi, PostSortRowsParams } from "ag-grid-community";
import type { CustomCellRendererProps } from "ag-grid-react";
import type { GridEmployee, GridEmployeeDraft, GridOption } from "./AgDataGrids";
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams, type SpreadsheetBatch } from "./GridFilters";
import { CustomSelect } from "./CustomSelect";
import { GridTextEditor } from "./GridTextEditor";
import { SpreadsheetFilterHeader } from "./SpreadsheetFilterHeader";
import { applyEmployeeSpreadsheetBatch, removeNewEmployeeDrafts, type EmployeeSpreadsheetReferences } from "./employeeSpreadsheet";
import { useEmployeeSpreadsheetHistory } from "./useEmployeeSpreadsheetHistory";
import { useEmployeeGridPreferences } from "./useEmployeeGridPreferences";
import { useWorkspaceTableOrder } from "./TableRowMoves";
import { gridTheme } from "./gridTheme";
import { AgTablePageScroll } from "./TablePageScroll";
import { employeeBitrixStatus } from "./bitrixEmployeeStatus";
import "./employeeSpreadsheet.css";

type EmployeeTableRow = { rowKey: string; kind: "entry" | "edit" | "draft"; employee?: GridEmployee; draft?: GridEmployeeDraft } & Partial<Record<"fullName" | "employmentType" | "department" | "position" | "siteName" | "bitrixCheckLabel", string>>;
type DraftSelectionActions = { selectedDraftCount: number; removeSelectedDrafts: () => number; clearSelection: () => void };
type EmployeeGridProps = EmployeeSpreadsheetReferences & {
  rows: GridEmployee[];
  drafts: GridEmployeeDraft[];
  selectedIds: number[];
  fullRowEditIds: number[];
  readOnly?: boolean;
  canCreate?: boolean;
  loading?: boolean;
  selectionDisabled?: boolean;
  preferenceScope?: { userId: number };
  renderFooter?: (selection: DraftSelectionActions) => ReactNode;
  onEdit: (employee: GridEmployee, changes?: Partial<GridEmployeeDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridEmployeeDraft>) => void;
  onReplaceDrafts?: (drafts: GridEmployeeDraft[]) => void;
  onVisibleIdsChange: (ids: number[]) => void;
  onValidationError: (message: string) => void;
  onReorder: (employeeIds: number[]) => Promise<void>;
};
const editableFields = new Set(["fullName", "employmentType", "department", "position", "siteName"]);
const isInteractive = (event?: Event | null) => event?.target instanceof Element && Boolean(event.target.closest("button,input,textarea,select,[role='combobox']"));
const filterHeader = { innerHeaderComponent: SpreadsheetFilterHeader };

function EmployeeFooter({ render, selection }: { render: (selection: DraftSelectionActions) => ReactNode; selection: DraftSelectionActions }) {
  return render(selection);
}

export function EmployeeAgGrid(props: EmployeeGridProps) {
  const [selectedDraftKeys, setSelectedDraftKeys] = useState<string[]>([]);
  const draftsById = useMemo(() => new Map(props.drafts.filter(draft => draft.id).map(draft => [draft.id!, draft])), [props.drafts]);
  const draftsByKey = useMemo(() => new Map(props.drafts.map(draft => [draft.key, draft])), [props.drafts]);
  const liveSelectedDraftKeys = useMemo(() => selectedDraftKeys.filter(key => draftsByKey.has(key) && draftsByKey.get(key)?.id === undefined), [selectedDraftKeys, draftsByKey]);
  const latest = useRef({ ...props, draftsById, draftsByKey, selectedDraftKeys: liveSelectedDraftKeys });
  useLayoutEffect(() => { latest.current = { ...props, draftsById, draftsByKey, selectedDraftKeys: liveSelectedDraftKeys }; }, [props, draftsById, draftsByKey, liveSelectedDraftKeys]);
  const frame = useRef<HTMLDivElement>(null);
  const gridApi = useRef<GridApi<EmployeeTableRow> | null>(null);
  const [pageApi, setPageApi] = useState<GridApi<EmployeeTableRow> | null>(null);
  const [activeEditor, setActiveEditor] = useState<{ rowKey: string; field: string; initialValue?: string } | null>(null);
  const history = useEmployeeSpreadsheetHistory({ drafts: props.drafts, onReplaceDrafts: props.onReplaceDrafts });
  const draftHistory = useRef(history);
  useLayoutEffect(() => { draftHistory.current = history; }, [history]);
  const tableOrder = useWorkspaceTableOrder();
  const preferences = useEmployeeGridPreferences({ userId: props.preferenceScope?.userId ?? 0, enabled: Boolean(props.preferenceScope), ready: (!tableOrder || tableOrder.ready) && !props.loading });
  const attachPreferences = preferences.attach;
  useEffect(() => {
    // Restore after the shared table has applied its initial import/manual order.
    if (tableOrder?.ready && gridApi.current && !gridApi.current.isDestroyed()) attachPreferences(gridApi.current);
  }, [tableOrder?.ready, attachPreferences]);
  const draftStructure = props.drafts.map(draft => `${draft.key}:${draft.id ?? "new"}`).join("|");
  const draftSelectionSignature = liveSelectedDraftKeys.join("|");
  const rowData = useMemo<EmployeeTableRow[]>(() => [
    ...props.drafts.filter(draft => !draft.id).map(draft => ({ rowKey: `employee-new-${draft.key}`, kind: "draft" as const, draft })),
    ...props.rows.map(employee => {
      const draft = draftsById.get(employee.id);
      // Inline edits must keep their filter identity; only new rows need revealing.
      return { rowKey: `employee-${employee.id}`, kind: "entry" as const, employee, draft };
    }),
    // Values come from the latest drafts without replacing row nodes while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [props.rows, draftStructure]);
  const previousNewKeys = useRef(new Set<string>());
  useEffect(() => {
    const newRows = rowData.filter(row => row.kind === "draft");
    const added = newRows.find(row => !previousNewKeys.current.has(row.rowKey));
    previousNewKeys.current = new Set(newRows.map(row => row.rowKey));
    if (!added) return;
    const frame = requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      const node = api.getRowNode(added.rowKey);
      if (api.isAnyFilterPresent()) api.setFilterModel(null);
      if (node) api.ensureNodeVisible(node, "top");
    });
    return () => cancelAnimationFrame(frame);
  }, [rowData]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      api.refreshClientSideRowModel("filter");
      api.refreshCells({ force: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.drafts]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const api = gridApi.current;
      if (!api || api.isDestroyed()) return;
      const selected = new Set(latest.current.selectedIds);
      const selectedDrafts = new Set(latest.current.selectedDraftKeys);
      api.forEachNode(node => {
        const row = node.data;
        const desired = Boolean(row?.employee ? !latest.current.selectionDisabled && selected.has(row.employee.id) : row?.draft && selectedDrafts.has(row.draft.key));
        if (node.isSelected() !== desired) node.setSelected(desired);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.selectedIds, draftSelectionSignature, draftStructure]);

  const clearSelection = useCallback(() => {
    const api = gridApi.current;
    if (api && !api.isDestroyed()) api.deselectAll();
    setSelectedDraftKeys([]);
    latest.current.onSelectionChange([]);
  }, []);
  const removeSelectedDrafts = useCallback(() => {
    const current = latest.current;
    if (current.loading || current.canCreate === false || !current.onReplaceDrafts) return 0;
    const result = removeNewEmployeeDrafts(current.drafts, current.selectedDraftKeys);
    if (!result.removedKeys.length) return 0;
    draftHistory.current.replace(result.drafts);
    setSelectedDraftKeys([]);
    setActiveEditor(null);
    requestAnimationFrame(() => frame.current?.querySelector<HTMLElement>(".localized-grid-body")?.focus({ preventScroll: true }));
    return result.removedKeys.length;
  }, []);

  const canWrite = useCallback((row: EmployeeTableRow, field: string) => editableFields.has(field) && !latest.current.loading && (row.employee ? !latest.current.readOnly : latest.current.canCreate !== false), []);
  const applyBatch = useCallback((batch: SpreadsheetBatch<EmployeeTableRow>) => {
    const current = latest.current;
    if (current.loading) return false;
    try {
      const result = applyEmployeeSpreadsheetBatch({ rows: batch.rows, drafts: current.drafts, references: current, canCreate: current.canCreate !== false, canUpdate: !current.readOnly, newKey: () => crypto.randomUUID() });
      if (current.onReplaceDrafts) draftHistory.current.replace(result.drafts);
      else {
        // Compatibility for standalone consumers of the former grid props.
        if (result.drafts.some(draft => !draft.id && !current.drafts.some(candidate => candidate.key === draft.key))) throw new Error("Добавьте пустые строки перед вставкой новых сотрудников.");
        for (const draft of result.drafts) {
          if (current.drafts.some(candidate => candidate.key === draft.key)) current.onPatchDraft(draft.key, draft);
          else if (draft.id) { const employee = current.rows.find(row => row.id === draft.id); if (employee) current.onEdit(employee, draft); }
          else throw new Error("Добавьте пустую строку перед вставкой новых сотрудников.");
        }
      }
      setActiveEditor(null);
      current.onValidationError("");
      return true;
    } catch (error) { current.onValidationError(error instanceof Error ? error.message : "Не удалось изменить ячейки."); return false; }
  }, []);
  const openEditor = useCallback((row: EmployeeTableRow, field: string, initialValue?: string) => {
    if (!canWrite(row, field)) return false;
    if (row.employee && !latest.current.drafts.some(draft => draft.id === row.employee!.id)) {
      const employee = row.employee;
      if (latest.current.onReplaceDrafts) draftHistory.current.prepare({ key: `employee-${employee.id}`, id: employee.id, fullName: employee.fullName, employmentType: employee.employmentType, department: employee.department, position: employee.position, projectSiteId: employee.siteId == null ? "" : String(employee.siteId) });
      else latest.current.onEdit(employee);
    }
    setActiveEditor({ rowKey: row.rowKey, field, initialValue });
    return true;
  }, [canWrite]);
  const valueFor = useCallback((row: EmployeeTableRow, field: string): string => {
    const draft = row.employee ? latest.current.draftsById.get(row.employee.id) : latest.current.draftsByKey.get(row.draft?.key ?? "");
    if (field === "bitrixCheckLabel") {
      return employeeBitrixStatus(row.employee).label;
    }
    if (field === "siteName") return draft ? latest.current.sites.find(site => site.id === Number(draft.projectSiteId))?.name ?? "Без объекта" : row.employee?.siteName ?? "Без объекта";
    return draft?.[field as keyof GridEmployeeDraft]?.toString() ?? row.employee?.[field as keyof GridEmployee]?.toString() ?? "";
  }, []);
  const editableRenderer = useCallback((params: CustomCellRendererProps<EmployeeTableRow>) => {
    const row = params.data, field = params.colDef?.field;
    if (!row || !field) return null;
    const current = latest.current;
    const draft = row.employee ? current.draftsById.get(row.employee.id) : current.draftsByKey.get(row.draft?.key ?? "");
    const active = activeEditor?.rowKey === row.rowKey && activeEditor.field === field && draft;
    const commit = (value: string) => applyBatch({ rows: [{ row: { ...row, draft }, rowIndex: params.node.rowIndex ?? 0, values: { [field]: value } }], source: "paste" });
    if (active) {
      if (field === "fullName") return <div className="ag-cell-editor-host"><GridTextEditor value={activeEditor.initialValue ?? draft.fullName} originalValue={draft.fullName} selectOnMount={activeEditor.initialValue === undefined} onChange={commit} onBlur={() => setActiveEditor(null)} /></div>;
      const options: GridOption[] = field === "siteName" ? current.sites : field === "employmentType" ? current.employmentTypes : field === "department" ? current.departments : current.positions;
      const value = field === "siteName" ? draft.projectSiteId : draft[field as "employmentType" | "department" | "position"];
      return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" value={value} ariaLabel={params.colDef?.headerName ?? field} autoOpen searchable initialQuery={activeEditor.initialValue} requireExactQueryOnEnter onInvalidQuery={query => current.onValidationError(`Значение «${query}» не найдено в столбце «${params.colDef?.headerName}». Выберите значение из списка.`)} options={[{ value: "", label: field === "siteName" ? "Без объекта" : "Не заполнено", disabled: field === "siteName" && current.requiredSiteId !== undefined }, ...options.map(option => ({ value: field === "siteName" ? String(option.id) : option.name, label: option.name }))]} onChange={commit} /></div>;
    }
    const value = String(params.value || (field === "siteName" ? "Без объекта" : "Не заполнено"));
    return <span className="ag-editable-cell-display" title={value}><span>{value}</span>{field !== "fullName" && canWrite(row, field) && <button type="button" className="ag-editable-cell-menu" aria-label={`Открыть список: ${params.colDef?.headerName}`} onClick={event => { event.stopPropagation(); openEditor(row, field); }}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg></button>}</span>;
  }, [activeEditor, applyBatch, canWrite, openEditor]);
  const bitrixRenderer = useCallback((params: CustomCellRendererProps<EmployeeTableRow>) => {
    const { label, tone, details } = employeeBitrixStatus(params.data?.employee);
    return <div className="bitrix-grid-check" title={details || label}><span className={`bitrix-grid-status ${tone}`}>{label}</span>{details && <span className="bitrix-grid-details">{details}</span>}</div>;
  }, []);
  const columns = useMemo<ColDef<EmployeeTableRow>[]>(() => [
    { field: "fullName", headerName: "ФИО", pinned: "left", lockPinned: true, initialWidth: 250, minWidth: 180, cellRenderer: editableRenderer },
    { field: "employmentType", headerName: "Тип", initialFlex: .55, minWidth: 105, cellRenderer: editableRenderer },
    { field: "department", headerName: "Отдел", initialFlex: .7, minWidth: 125, cellRenderer: editableRenderer },
    { field: "position", headerName: "Должность", initialFlex: 1.4, minWidth: 210, cellRenderer: editableRenderer },
    { field: "siteName", headerName: "Проект", initialFlex: 1, minWidth: 180, cellRenderer: editableRenderer },
    { colId: "bitrixCheckLabel", headerName: "Проверка Б24 / расхождение", initialFlex: 1.3, minWidth: 260, cellRenderer: bitrixRenderer },
  ], [editableRenderer, bitrixRenderer]);
  const defaultColDef = useMemo<ColDef<EmployeeTableRow>>(() => ({ headerComponentParams: filterHeader, valueGetter: params => params.data ? valueFor(params.data, params.column.getColId()) : "", filter: personnelColumnFilter, filterParams: { ...personnelFilterParams, presentation: "checklist" }, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true }), [valueFor]);
  const reportVisibleRows = useCallback((api: GridApi<EmployeeTableRow>) => {
    const ids: number[] = [];
    api.forEachNodeAfterFilterAndSort(node => { if (node.data?.employee) ids.push(node.data.employee.id); });
    latest.current.onVisibleIdsChange(ids);
  }, []);
  const keepNewRowsFirst = useCallback(({ nodes }: PostSortRowsParams<EmployeeTableRow>) => {
    const rank = new Map(latest.current.drafts.filter(draft => !draft.id).map((draft, index) => [`employee-new-${draft.key}`, index]));
    const newRows = nodes.filter(node => rank.has(node.data?.rowKey ?? "")).sort((a, b) => rank.get(a.data!.rowKey)! - rank.get(b.data!.rowKey)!);
    if (newRows.length) nodes.splice(0, nodes.length, ...newRows, ...nodes.filter(node => !rank.has(node.data?.rowKey ?? "")));
  }, []);
  const rowSelection = useMemo(() => {
    if (props.selectionDisabled && props.canCreate === false) return undefined;
    const selectable = (row?: EmployeeTableRow) => Boolean(row?.employee ? !latest.current.selectionDisabled : row?.draft && row.draft.id === undefined && latest.current.canCreate !== false);
    return { mode: "multiRow" as const, checkboxes: (params: { data?: EmployeeTableRow }) => selectable(params.data), headerCheckbox: true, selectAll: "filtered" as const, enableClickSelection: false as const, hideDisabledCheckboxes: true, isRowSelectable: (node: { data?: EmployeeTableRow }) => selectable(node.data) };
  }, [props.selectionDisabled, props.canCreate]);
  return <AgTablePageScroll gridRoot={frame} api={pageApi} label="Горизонтальная прокрутка сотрудников" footer={props.renderFooter && <EmployeeFooter render={props.renderFooter} selection={{ selectedDraftCount: liveSelectedDraftKeys.length, removeSelectedDrafts, clearSelection }} />}><div ref={frame} className="employee-performance-frame employee-spreadsheet-frame"><div className="employee-performance-main"><div className="ag-grid-shell ag-admin-grid ag-employee-grid"><LocalizedGrid<EmployeeTableRow>
    theme={gridTheme} rowData={rowData} columnDefs={columns} defaultColDef={defaultColDef} getRowId={params => params.data.rowKey}
    rowHeight={44} headerHeight={46} animateRows={false} postSortRows={keepNewRowsFirst} loading={props.loading}
    suppressHorizontalScroll scrollbarWidth={0}
    spreadsheetToolbar={false} showSortSummary={false} rowOrderAutoSwitchSort preserveSavedSort={preferences.hasSavedSort} rowOrderBlocked={Boolean(activeEditor) || props.drafts.length > 0}
    rowClassRules={{ "editable-row": params => Boolean(params.data?.draft), "bitrix-mismatch-row": params => params.data?.employee?.bitrixCheckStatus === "mismatch" && !params.data.employee.bitrixCheckAcknowledged, "bitrix-missing-row": params => params.data?.employee?.bitrixCheckStatus === "missing_in_bitrix" && !params.data.employee.bitrixCheckAcknowledged, "bitrix-dismissed-row": params => params.data?.employee?.bitrixCheckStatus === "dismissed_in_bitrix" && !params.data.employee.bitrixCheckAcknowledged, "bitrix-blacklisted-row": params => params.data?.employee?.bitrixCheckStatus === "blacklisted_in_bitrix" && !params.data.employee.bitrixCheckAcknowledged }}
    rowSelection={rowSelection} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true }}
    onGridReady={event => { gridApi.current = event.api; setPageApi(event.api); preferences.attach(event.api); reportVisibleRows(event.api); }} onColumnResized={preferences.onColumnResized}
    onModelUpdated={event => reportVisibleRows(event.api)} onFilterChanged={event => reportVisibleRows(event.api)} onSortChanged={event => { preferences.onSortChanged(); reportVisibleRows(event.api); }}
    onSelectionChanged={event => {
      const rows = event.api.getSelectedRows();
      const draftKeys = latest.current.canCreate === false ? [] : rows.flatMap(row => !row.employee && row.draft?.id === undefined && row.draft && latest.current.draftsByKey.has(row.draft.key) ? [row.draft.key] : []);
      setSelectedDraftKeys(current => current.length === draftKeys.length && current.every((key, index) => key === draftKeys[index]) ? current : draftKeys);
      const savedIds = latest.current.selectionDisabled ? [] : rows.flatMap(row => row.employee ? [row.employee.id] : []);
      const previousIds = latest.current.selectedIds;
      if (savedIds.length !== previousIds.length || savedIds.some((id, index) => id !== previousIds[index])) latest.current.onSelectionChange(savedIds);
    }}
    onCellMouseDown={event => { if (activeEditor && !isInteractive(event.event) && (event.data?.rowKey !== activeEditor.rowKey || event.column.getColId() !== activeEditor.field)) setActiveEditor(null); }}
    onCellDoubleClicked={event => { if (event.data && !isInteractive(event.event)) openEditor(event.data, event.column.getColId()); }}
    onSpreadsheetBatch={applyBatch} canWriteSpreadsheetCell={canWrite} spreadsheetHistory={history}
    onSpreadsheetEdit={({ row, columnId, initialValue }) => openEditor(row, columnId, initialValue)} onSpreadsheetCancelEdit={() => setActiveEditor(null)}
    suppressCellFocus
  /></div></div></div></AgTablePageScroll>;
}
