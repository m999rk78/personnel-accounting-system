"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ColDef, GridApi, PostSortRowsParams } from "ag-grid-community";
import type { CustomCellRendererProps } from "ag-grid-react";
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams, type SpreadsheetBatch } from "./GridFilters";
import { CustomSelect, type CustomSelectOption } from "./CustomSelect";
import { GridTextEditor } from "./GridTextEditor";
import { SpreadsheetFilterHeader } from "./SpreadsheetFilterHeader";
import { applyCatalogBatch, removeCatalogDrafts, type CatalogDraft, type CatalogRow } from "./catalogSpreadsheetModel";
import { useCatalogDraftHistory } from "./useCatalogDraftHistory";
import { useCatalogGridPreferences } from "./useCatalogGridPreferences";
import { useWorkspaceTableOrder } from "./TableRowMoves";
import { gridTheme } from "./gridTheme";
import { AgTablePageScroll } from "./TablePageScroll";
import "./catalogSpreadsheet.css";

export type { CatalogDraft } from "./catalogSpreadsheetModel";
export type CatalogDraftSelectionActions = { selectedDraftCount: number; removeSelectedDrafts: () => number; clearSelection: () => void };
export type CatalogColumn<R, D> = {
  field: string; headerName: string; minWidth?: number; initialWidth?: number; initialFlex?: number; pinned?: "left";
  editable?: boolean | ((record: R | undefined, draft: D | undefined) => boolean);
  value: (record: R | undefined, draft: D | undefined) => string;
  editValue?: (draft: D) => string;
  options?: (draft: D, drafts: D[]) => CustomSelectOption[];
};
export type CatalogSpreadsheetGridProps<R extends { id: number }, D extends CatalogDraft> = {
  rows: R[]; drafts: D[]; columns: CatalogColumn<R, D>[]; scopeKey: string;
  canCreate: boolean; canUpdate: boolean; canSelect: boolean; loading?: boolean;
  preferenceScope?: { userId: number; siteId?: number };
  newDraft: (key: string) => D; toDraft: (record: R) => D;
  patchDraft: (draft: D, values: Record<string, string>, drafts: D[]) => D;
  validateDrafts?: (drafts: D[], changedKeys: string[]) => void;
  selectedIds: number[]; onSelectionChange: (ids: number[]) => void; onReplaceDrafts: (drafts: D[]) => void;
  onVisibleIdsChange?: (ids: number[]) => void; onValidationError?: (message: string) => void;
  renderFooter?: (selection: CatalogDraftSelectionActions) => ReactNode;
};
const fieldEditable = <R, D,>(column: CatalogColumn<R, D>, record: R | undefined, draft: D | undefined) => typeof column.editable === "function" ? column.editable(record, draft) : column.editable !== false;
const interactive = (event?: Event | null) => event?.target instanceof Element && Boolean(event.target.closest("button,input,textarea,select,[role='combobox']"));
function CatalogFooter({ render, selection }: { render: (selection: CatalogDraftSelectionActions) => ReactNode; selection: CatalogDraftSelectionActions }) { return render(selection); }

/** The catalog fields vary; editing, selection, history and layout follow one implementation. */
export function CatalogSpreadsheetGrid<R extends { id: number }, D extends CatalogDraft>(props: CatalogSpreadsheetGridProps<R, D>) {
  const identity = `${props.preferenceScope?.userId ?? "standalone"}:${props.scopeKey}:${props.preferenceScope?.siteId ?? "global"}`;
  return <CatalogGridWorkspace<R, D> key={identity} {...props} />;
}

function CatalogGridWorkspace<R extends { id: number }, D extends CatalogDraft>(props: CatalogSpreadsheetGridProps<R, D>) {
  type Row = CatalogRow<R, D>;
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [editor, setEditor] = useState<{ rowKey: string; field: string; initialValue?: string } | null>(null);
  const byId = useMemo(() => new Map(props.drafts.filter(draft => draft.id !== undefined).map(draft => [draft.id, draft])), [props.drafts]);
  const byKey = useMemo(() => new Map(props.drafts.map(draft => [draft.key, draft])), [props.drafts]);
  const fields = useMemo(() => new Map(props.columns.map(column => [column.field, column])), [props.columns]);
  const selectedDraftKeys = useMemo(() => selectedKeys.filter(key => byKey.has(key) && byKey.get(key)?.id === undefined), [selectedKeys, byKey]);
  const current = useRef({ ...props, byId, byKey, fields, selectedDraftKeys });
  useLayoutEffect(() => { current.current = { ...props, byId, byKey, fields, selectedDraftKeys }; }, [props, byId, byKey, fields, selectedDraftKeys]);
  const shell = useRef<HTMLDivElement>(null), api = useRef<GridApi<Row> | null>(null);
  const [pageApi, setPageApi] = useState<GridApi<Row> | null>(null);
  const history = useCatalogDraftHistory(props.drafts, props.onReplaceDrafts);
  const historyRef = useRef(history);
  useLayoutEffect(() => { historyRef.current = history; }, [history]);
  const tableOrder = useWorkspaceTableOrder();
  const preferences = useCatalogGridPreferences({ ...props.preferenceScope, scopeKey: props.scopeKey, ready: (!tableOrder || tableOrder.ready) && !props.loading });
  const attachPreferences = preferences.attach;
  useEffect(() => { if (tableOrder?.ready && api.current && !api.current.isDestroyed()) attachPreferences(api.current); }, [tableOrder?.ready, attachPreferences]);
  const structure = props.drafts.map(draft => `${draft.key}:${draft.id ?? "new"}`).join("|");
  const selectionKey = selectedDraftKeys.join("|");
  const rows = useMemo<Row[]>(() => [
    ...props.drafts.filter(draft => draft.id === undefined).map(draft => ({ rowKey: `catalog-new-${draft.key}`, kind: "draft" as const, draft })),
    ...props.rows.map(record => ({ rowKey: `catalog-${props.scopeKey}-${record.id}`, kind: "entry" as const, record, draft: byId.get(record.id) })),
    // Values are read from the current draft maps; row nodes stay stable while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [props.rows, props.scopeKey, structure]);
  const editorHasDraft = Boolean(editor && rows.some(row => row.rowKey === editor.rowKey && (row.record ? byId.has(row.record.id) : byKey.has(row.draft?.key ?? ""))));
  const previousNew = useRef(new Set<string>());
  useEffect(() => {
    const next = rows.filter(row => row.kind === "draft"), added = next.find(row => !previousNew.current.has(row.rowKey));
    previousNew.current = new Set(next.map(row => row.rowKey));
    if (!added) return;
    const frame = requestAnimationFrame(() => { const grid = api.current; if (!grid || grid.isDestroyed()) return; if (grid.isAnyFilterPresent()) grid.setFilterModel(null); const node = grid.getRowNode(added.rowKey); if (node) grid.ensureNodeVisible(node, "top"); });
    return () => cancelAnimationFrame(frame);
  }, [rows]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { const grid = api.current; if (grid && !grid.isDestroyed()) { grid.refreshClientSideRowModel("filter"); grid.refreshCells({ force: true }); } });
    return () => cancelAnimationFrame(frame);
  }, [props.drafts]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const grid = api.current; if (!grid || grid.isDestroyed()) return;
      const selected = new Set(current.current.selectedIds), drafts = new Set(current.current.selectedDraftKeys);
      grid.forEachNode(node => { const row = node.data; const desired = Boolean(row?.record ? current.current.canSelect && selected.has(row.record.id) : row?.draft && current.current.canCreate && drafts.has(row.draft.key)); if (node.isSelected() !== desired) node.setSelected(desired); });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.selectedIds, selectionKey, structure]);
  const resolveDraft = useCallback((row: Row) => row.record ? current.current.byId.get(row.record.id) : current.current.byKey.get(row.draft?.key ?? ""), []);
  const canWrite = useCallback((row: Row, field: string) => {
    const value = current.current, column = value.fields.get(field);
    return Boolean(column && !value.loading && (row.record ? value.canUpdate : value.canCreate) && fieldEditable(column, row.record, resolveDraft(row)));
  }, [resolveDraft]);
  const applyRange = useCallback((batch: SpreadsheetBatch<Row>) => {
    const value = current.current;
    if (value.loading) return false;
    try {
      const next = applyCatalogBatch({ rows: batch.rows, drafts: value.drafts, canCreate: value.canCreate, canUpdate: value.canUpdate, newDraft: value.newDraft, toDraft: value.toDraft, patchDraft: value.patchDraft, validateDrafts: value.validateDrafts, editableFields: (record, draft) => value.columns.filter(column => fieldEditable(column, record, draft)).map(column => column.field), newKey: () => crypto.randomUUID() });
      if (next === value.drafts) return false;
      historyRef.current.replace(next); setEditor(null); value.onValidationError?.(""); return true;
    } catch (error) { value.onValidationError?.(error instanceof Error ? error.message : "Не удалось изменить ячейки."); return false; }
  }, []);
  const open = useCallback((row: Row, field: string, initialValue?: string) => {
    if (!canWrite(row, field)) return false;
    if (row.record && !current.current.byId.has(row.record.id)) historyRef.current.prepare(current.current.toDraft(row.record));
    setEditor({ rowKey: row.rowKey, field, initialValue }); return true;
  }, [canWrite]);
  const clearSelection = useCallback(() => { if (api.current && !api.current.isDestroyed()) api.current.deselectAll(); setSelectedKeys([]); current.current.onSelectionChange([]); }, []);
  const removeSelectedDrafts = useCallback(() => {
    const value = current.current;
    if (value.loading || !value.canCreate) return 0;
    const next = removeCatalogDrafts(value.drafts, value.selectedDraftKeys), removed = value.drafts.length - next.length;
    if (!removed) return 0;
    historyRef.current.replace(next); setSelectedKeys([]); setEditor(null);
    requestAnimationFrame(() => shell.current?.querySelector<HTMLElement>(".localized-grid-body")?.focus({ preventScroll: true }));
    return removed;
  }, []);
  const renderer = useCallback((params: CustomCellRendererProps<Row>) => {
    const row = params.data, field = params.column?.getColId(); if (!row || !field) return null;
    const value = current.current, column = value.fields.get(field); if (!column) return null;
    const draft = resolveDraft(row), active = draft && editor?.rowKey === row.rowKey && editor.field === field;
    const display = String(params.value ?? "");
    const commit = (text: string) => applyRange({ rows: [{ row: { ...row, draft }, rowIndex: params.node.rowIndex ?? 0, values: { [field]: text } }], source: "paste" });
    if (active) {
      const original = column.editValue?.(draft) ?? column.value(undefined, draft);
      if (column.options) {
        const choices = column.options(draft, value.drafts), options = choices.some(option => option.value === "") ? choices : [{ value: "", label: "Не заполнено" }, ...choices];
        return <div className="ag-cell-editor-host"><CustomSelect className="ag-custom-select" ariaLabel={column.headerName} value={original} options={options} autoOpen searchable initialQuery={editor.initialValue} requireExactQueryOnEnter onInvalidQuery={query => value.onValidationError?.(`Значение «${query}» не найдено в столбце «${column.headerName}». Выберите из списка.`)} onChange={commit} /></div>;
      }
      return <div className="ag-cell-editor-host"><GridTextEditor value={editor.initialValue ?? original} originalValue={original} placeholder={column.headerName} selectOnMount={editor.initialValue === undefined} onChange={commit} onBlur={() => setEditor(null)} /></div>;
    }
    return <span className="ag-editable-cell-display" title={display}><span>{display || (canWrite(row, field) ? "Не заполнено" : "—")}</span>{column.options && canWrite(row, field) && <button type="button" className="ag-editable-cell-menu" aria-label={`Открыть список: ${column.headerName}`} onClick={event => { event.stopPropagation(); open(row, field); }}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg></button>}</span>;
  }, [editor, resolveDraft, applyRange, canWrite, open]);
  const columns = useMemo<ColDef<Row>[]>(() => props.columns.map(column => ({ colId: column.field, headerName: column.headerName, minWidth: column.minWidth ?? 140, initialWidth: column.initialWidth, initialFlex: column.initialFlex, pinned: column.pinned, lockPinned: Boolean(column.pinned), cellRenderer: renderer })), [props.columns, renderer]);
  const defaults = useMemo<ColDef<Row>>(() => ({ headerComponentParams: { innerHeaderComponent: SpreadsheetFilterHeader }, valueGetter: params => { const row = params.data; return row ? current.current.fields.get(params.column.getColId())?.value(row.record, resolveDraft(row)) ?? "" : ""; }, filter: personnelColumnFilter, filterParams: { ...personnelFilterParams, presentation: "checklist" }, resizable: true, sortable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true }), [resolveDraft]);
  const visible = useCallback((grid: GridApi<Row>) => { const ids: number[] = []; grid.forEachNodeAfterFilterAndSort(node => { if (node.data?.record) ids.push(node.data.record.id); }); current.current.onVisibleIdsChange?.(ids); }, []);
  const newFirst = useCallback(({ nodes }: PostSortRowsParams<Row>) => { const ranks = new Map(current.current.drafts.filter(draft => draft.id === undefined).map((draft, index) => [`catalog-new-${draft.key}`, index])); const newRows = nodes.filter(node => ranks.has(node.data?.rowKey ?? "")).sort((a, b) => ranks.get(a.data!.rowKey)! - ranks.get(b.data!.rowKey)!); if (newRows.length) nodes.splice(0, nodes.length, ...newRows, ...nodes.filter(node => !ranks.has(node.data?.rowKey ?? ""))); }, []);
  const selection = useMemo(() => {
    if (!props.canCreate && !props.canSelect) return undefined;
    const selectable = (row?: Row) => Boolean(row?.record ? current.current.canSelect : row?.draft && current.current.canCreate);
    return { mode: "multiRow" as const, checkboxes: (params: { data?: Row }) => selectable(params.data), headerCheckbox: true, selectAll: "filtered" as const, enableClickSelection: false as const, hideDisabledCheckboxes: true, isRowSelectable: (node: { data?: Row }) => selectable(node.data) };
  }, [props.canCreate, props.canSelect]);
  return <AgTablePageScroll gridRoot={shell} api={pageApi} label="Горизонтальная прокрутка справочника" footer={props.renderFooter && <CatalogFooter render={props.renderFooter} selection={{ selectedDraftCount: selectedDraftKeys.length, removeSelectedDrafts, clearSelection }} />}><div ref={shell} className="ag-grid-shell ag-admin-grid ag-reference-grid ag-catalog-grid"><LocalizedGrid<Row>
    theme={gridTheme} rowData={rows} columnDefs={columns} defaultColDef={defaults} getRowId={params => params.data.rowKey} getRowOrderId={row => row.record?.id}
    rowHeight={44} headerHeight={46} animateRows={false} postSortRows={newFirst} loading={props.loading}
    suppressHorizontalScroll scrollbarWidth={0}
    rowOrderBlocked={editorHasDraft || props.drafts.length > 0} rowOrderAutoSwitchSort preserveSavedSort={preferences.hasSavedSort} spreadsheetToolbar={false} showSortSummary={false}
    rowClassRules={{ "editable-row": params => Boolean(params.data && resolveDraft(params.data)) }}
    rowSelection={selection} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", lockPinned: true, lockPosition: "left", resizable: false, suppressMovable: true }}
    onGridReady={event => { api.current = event.api; setPageApi(event.api); preferences.attach(event.api); visible(event.api); }} onColumnResized={preferences.onColumnResized}
    onModelUpdated={event => visible(event.api)} onFilterChanged={event => visible(event.api)} onSortChanged={event => { preferences.onSortChanged(); visible(event.api); }}
    onSelectionChanged={event => { const selected = event.api.getSelectedRows(); const keys = current.current.canCreate ? selected.flatMap(row => row.draft && !row.record ? [row.draft.key] : []) : []; setSelectedKeys(previous => previous.length === keys.length && previous.every((key, index) => key === keys[index]) ? previous : keys); const ids = current.current.canSelect ? selected.flatMap(row => row.record ? [row.record.id] : []) : []; if (ids.length !== current.current.selectedIds.length || ids.some((id, index) => id !== current.current.selectedIds[index])) current.current.onSelectionChange(ids); }}
    onCellMouseDown={event => { if (editor && !interactive(event.event) && (event.data?.rowKey !== editor.rowKey || event.column.getColId() !== editor.field)) setEditor(null); }}
    onCellDoubleClicked={event => { if (event.data && !interactive(event.event)) open(event.data, event.column.getColId()); }}
    onSpreadsheetBatch={applyRange} canWriteSpreadsheetCell={canWrite} spreadsheetHistory={history}
    onSpreadsheetEdit={({ row, columnId, initialValue }) => open(row, columnId, initialValue)} onSpreadsheetCancelEdit={() => setEditor(null)} suppressCellFocus
  /></div></AgTablePageScroll>;
}
