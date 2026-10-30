"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import type { ColDef, GridApi, GetContextMenuItemsParams, ICellRendererParams, IFilterParams, RowDragEndEvent, SuppressMouseEventHandlingParams } from "ag-grid-community";
import { gridTheme } from "./gridTheme";
import { gridLocaleRu } from "./gridLocaleRu";
import { AdminGridFooter } from "./AdminGridFooter";
import { useRowMoveActions, useWorkspaceTableOrder } from "./TableRowMoves";
import { workTypesOrderId } from "./workTypesRowOrder";
import { SelectionRowDragRenderer } from "./SelectionRowDragRenderer";
import { enterpriseFilterParams } from "./GridEnterpriseFilters";
import type { WorkTypeDraft, WorkTypeEdits, WorkTypeRow } from "./workTypesWorkspace";
import "./gridFilters.css";

type Props = {
  masters: WorkTypeRow[];
  details: Map<string, WorkTypeRow[]>;
  drafts: WorkTypeEdits;
  errors: Record<string, { name?: string; parentKey?: string }>;
  query: string;
  loading?: boolean;
  disabled: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  selectionVersion: number;
  onEdit: (rows: WorkTypeRow[]) => void;
  onPatch: (row: WorkTypeRow, changes: Partial<WorkTypeDraft>) => void;
  onAdd: (kind: WorkTypeDraft["directoryKind"], parentKey?: string) => void;
  onArchive: (rows: WorkTypeRow[]) => void;
  onSave: () => void;
  onCancel: () => void;
  registerGrid: (api: GridApi<WorkTypeRow>, parentKey?: string) => () => void;
  onEditingChange: (api: GridApi<WorkTypeRow>, editing: boolean) => void;
  onBatchStart: () => void;
  onBatchEnd: () => void;
  history: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
};
const Workspace = createContext<Props | null>(null);
const MasterGrid = createContext<RefObject<GridApi<WorkTypeRow> | null> | null>(null);
const EMPTY_ROWS: WorkTypeRow[] = [];

/** AG Grid owns expansion, detail row lifecycle, native editors, selection and clipboard. */
function WorkTypesDetail({ data }: CustomCellRendererProps<WorkTypeRow>) {
  const workspace = useContext(Workspace)!;
  const parent = workspace.masters.find(row => row.key === data?.key);
  if (!parent) return null;
  return <div className="work-types-detail" aria-label={`Подвиды: ${parent.name || "Новый вид работы"}`}>
    <div className="work-types-detail-heading"><strong>Подвиды работ</strong><span>{parent.name || "Новый вид работы"}</span></div>
    <WorkTypesEntityGrid parentKey={parent.key}/>
  </div>;
}

function WorkTypesEntityGrid({ parentKey }: { parentKey?: string }) {
  const props = useContext(Workspace)!;
  const masterGridRef = useContext(MasterGrid);
  const latest = useRef(props);
  useEffect(() => { latest.current = props; }, [props]);
  const master = parentKey === undefined;
  const rows = master ? props.masters : props.details.get(parentKey) ?? EMPTY_ROWS;
  const order = useWorkspaceTableOrder();
  const orderedRows = useMemo(() => order ? order.order(rows, workTypesOrderId) : rows, [rows, order]);
  const [api, setApi] = useState<GridApi<WorkTypeRow> | null>(null);
  const gridElement = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<WorkTypeRow[]>([]);
  const assignment = useRef<WorkTypeRow[]>([]);
  const [assigningCount, setAssigningCount] = useState(0);
  const [filtered, setFiltered] = useState(false);
  const [visibleCount, setVisibleCount] = useState(rows.length);
  const pending = Object.values(props.drafts);
  const dirty = pending.length > 0;
  const localPending = pending.filter(row => master ? row.directoryKind === "parent" : row.directoryKind === "child" && row.parentKey === parentKey);
  const moveBlocked = props.disabled || Boolean(props.loading) || dirty || filtered || Boolean(props.query.trim()) || !props.canUpdate;
  const canDragSelection = useCallback((row?: WorkTypeRow) => Boolean(row && !row.unassigned && workTypesOrderId(row) && !moveBlocked && order?.canWrite && !order.busy), [moveBlocked, order]);
  const selectionColumnDef = useMemo(() => ({
    width: 44, minWidth: 44, maxWidth: 44, pinned: "left" as const, lockPinned: true, lockPosition: "left" as const, resizable: false, suppressMovable: true,
    ...(order?.canWrite ? {
      cellRenderer: SelectionRowDragRenderer,
      cellRendererParams: (params: ICellRendererParams<WorkTypeRow>) => ({ canDrag: () => !params.node.detail && canDragSelection(params.data) }),
    } : {}),
  }), [order?.canWrite, canDragSelection]);
  const move = useCallback(async (operation: Parameters<NonNullable<typeof order>["move"]>[0]) => {
    if (!order || !api || api.isDestroyed()) return false;
    const sorted = api.getColumnState().some(column => column.sort);
    if (sorted) {
      const displayedIds: string[] = [];
      api.forEachNodeAfterFilterAndSort(node => { const id = node.data && workTypesOrderId(node.data); if (id) displayedIds.push(id); });
      operation = { ...operation, displayedIds };
    }
    const saved = await order.move(operation);
    if (saved && sorted && !api.isDestroyed()) api.applyColumnState({ defaultState: { sort: null, sortIndex: null } });
    return saved;
  }, [api, order]);
  const moveActions = useRowMoveActions(order ? { ...order, move } : null, moveBlocked);
  const parentOptions = useMemo(() => props.masters.filter(row => !row.unassigned), [props.masters]);
  const canEdit = useCallback((row?: WorkTypeRow) => Boolean(row && !row.unassigned && !props.disabled && (row.id ? props.canUpdate : props.canCreate)), [props.disabled, props.canUpdate, props.canCreate]);
  const columns = useMemo<ColDef<WorkTypeRow>[]>(() => [
    {
      field: "name", headerName: master ? "Вид работы" : "Подвид работы", minWidth: 280, flex: master ? 3 : 2,
      editable: params => canEdit(params.data), cellEditor: "agTextCellEditor", cellEditorParams: { maxLength: 240 },
      wrapText: true, autoHeight: true,
      cellClassRules: { "work-types-invalid-cell": params => Boolean(params.data && props.errors[params.data.key]?.name) },
      tooltipValueGetter: params => params.data ? props.errors[params.data.key]?.name ?? params.data.name : "",
      getQuickFilterText: params => params.data?.searchText ?? String(params.value ?? ""),
      ...(master ? { cellRenderer: "agGroupCellRenderer", cellRendererParams: {
        suppressCount: true, suppressDoubleClickExpand: true,
        // Let the native expander handle its clicks without starting a cell edit on dblclick.
        suppressMouseEventHandling: ({ event }: SuppressMouseEventHandlingParams<WorkTypeRow>) => event.target instanceof Element && Boolean(event.target.closest(".ag-group-expanded, .ag-group-contracted")),
        innerRenderer: ({ value }: CustomCellRendererProps<WorkTypeRow>) => <span className="work-types-master-name">{value || "Новый вид работы"}</span>,
      } } : {}),
    },
    ...(master ? [{
      field: "childCount", headerName: "Подвидов", width: 150, minWidth: 125, maxWidth: 190, editable: false,
      filterParams: (params: IFilterParams) => enterpriseFilterParams(params, { kind: "number" }), cellClass: "work-types-count-cell",
      cellRenderer: ({ value }: CustomCellRendererProps<WorkTypeRow>) => <span className="work-types-count">{value ?? 0}</span>,
    } satisfies ColDef<WorkTypeRow>] : [{
      field: "parentKey", headerName: "Вид работы", minWidth: 230, flex: 1, editable: params => canEdit(params.data),
      initialHide: true,
      cellEditor: "agRichSelectCellEditor", cellEditorPopup: true,
      cellEditorParams: () => ({ values: parentOptions.map(row => row.key), formatValue: (key: string) => parentOptions.find(row => row.key === key)?.name ?? "Без вида работы", allowTyping: true, filterList: true, searchType: "matchAny", highlightMatch: true }),
      valueFormatter: params => parentOptions.find(row => row.key === params.value)?.name ?? (params.value === "unassigned" || !params.value ? "Без вида работы" : String(params.value)),
      filterValueGetter: params => parentOptions.find(row => row.key === params.data?.parentKey)?.name ?? "Без вида работы",
      filterParams: (params: IFilterParams) => enterpriseFilterParams(params, { kind: "text", valueFormatter: ({ value }) => String(value ?? "") }),
      valueParser: params => {
        const text = String(params.newValue ?? "");
        return parentOptions.find(row => row.key === text || row.name.trim().toLocaleLowerCase("ru-RU") === text.trim().toLocaleLowerCase("ru-RU"))?.key ?? text;
      },
      cellClassRules: { "work-types-invalid-cell": params => Boolean(params.data && props.errors[params.data.key]?.parentKey) },
      tooltipValueGetter: params => params.data ? props.errors[params.data.key]?.parentKey ?? parentOptions.find(row => row.key === params.data?.parentKey)?.name ?? "Без вида работы" : "",
    } satisfies ColDef<WorkTypeRow>]),
  ], [canEdit, master, parentOptions, props.errors]);
  const defaultColDef = useMemo<ColDef<WorkTypeRow>>(() => ({
    sortable: true, resizable: true, filter: "agMultiColumnFilter", cellDataType: false,
    filterParams: (params: IFilterParams) => enterpriseFilterParams(params, { kind: "text" }),
    comparator: (left: unknown, right: unknown) => String(left ?? "").localeCompare(String(right ?? ""), "ru", { numeric: true, sensitivity: "base" }),
  }), []);
  const registerGrid = props.registerGrid;
  useEffect(() => {
    if (!api || api.isDestroyed()) return;
    return registerGrid(api, parentKey);
  }, [api, registerGrid, parentKey]);
  useEffect(() => {
    if (api && !api.isDestroyed()) api.deselectAll();
  }, [api, props.selectionVersion]);
  useEffect(() => {
    if (!api || api.isDestroyed()) return;
    api.refreshCells({ force: true });
  }, [api, props.errors]);
  const previousPendingKeys = useRef(new Set<string>());
  const pendingKeys = localPending.map(row => row.key).join("|");
  useEffect(() => {
    if (!api || api.isDestroyed()) return;
    const keys = new Set(pendingKeys ? pendingKeys.split("|") : []);
    const added = [...keys].some(key => !previousPendingKeys.current.has(key));
    previousPendingKeys.current = keys;
    if (added && api.isAnyFilterPresent()) api.setFilterModel(null);
  }, [api, pendingKeys]);
  const detailHeight = useCallback((row?: WorkTypeRow) => {
    const workspace = latest.current;
    const editingDetails = Object.values(workspace.drafts).some(draft => draft.directoryKind === "child" && draft.parentKey === row?.key);
    // Keep room for the heading, grid header, full input rows and a wrapping footer.
    // A short master viewport must scroll rather than squeeze the detail editor.
    const minimum = editingDetails ? 400 : 360;
    const available = Math.max(minimum, (gridElement.current?.clientHeight ?? 650) - 110);
    const desired = Math.max(minimum, 176 + Math.max(2, workspace.details.get(row?.key ?? "")?.length ?? 0) * 54);
    return Math.min(540, available, desired);
  }, []);
  const refreshDetailHeights = useCallback((grid: GridApi<WorkTypeRow>) => {
    if (!master || grid.isDestroyed()) return;
    for (let index = 0; index < grid.getDisplayedRowCount(); index++) {
      const node = grid.getDisplayedRowAtIndex(index);
      if (node?.detail) node.setRowHeight(detailHeight(node.data));
    }
    grid.onRowHeightChanged();
  }, [detailHeight, master]);
  useEffect(() => { if (api) refreshDetailHeights(api); }, [api, props.details, refreshDetailHeights]);
  const previousNewKeys = useRef(new Set<string>());
  const newKeys = rows.filter(row => !row.id && !row.unassigned).map(row => row.key).join("|");
  useEffect(() => {
    if (!api || api.isDestroyed()) return;
    const keys = newKeys ? newKeys.split("|") : [];
    const added = keys.find(key => !previousNewKeys.current.has(key));
    previousNewKeys.current = new Set(keys);
    if (!added) return;
    const frame = requestAnimationFrame(() => {
      if (api.isDestroyed()) return;
      const node = api.getRowNode(added);
      if (!node || node.rowIndex == null) return;
      api.ensureIndexVisible(node.rowIndex, "bottom");
      api.setFocusedCell(node.rowIndex, "name");
      api.startEditingCell({ rowIndex: node.rowIndex, colKey: "name" });
    });
    return () => cancelAnimationFrame(frame);
  }, [api, newKeys]);
  const contextMenu = (params: GetContextMenuItemsParams<WorkTypeRow>) => {
    const row = params.node?.data;
    const id = row && workTypesOrderId(row);
    return ["copy", "copyWithHeaders", "paste", ...(id ? moveActions.getActions(id, selected.map(workTypesOrderId).filter((key): key is string => Boolean(key)), () => api?.hidePopupMenu()).flatMap(action => [...(action.separatorBefore ? ["separator"] : []), { name: action.label, disabled: action.disabled, tooltip: action.title, action: action.onSelect }]) : [])] as ReturnType<NonNullable<import("ag-grid-community").GridOptions<WorkTypeRow>["getContextMenuItems"]>>;
  };
  const dragEnd = (event: RowDragEndEvent<WorkTypeRow>) => {
    if (!canDragSelection(event.node.data) || event.node.isSelected() !== true || event.node.detail || !event.overNode?.data || event.overNode.detail || event.overNode.data.unassigned) return;
    const movingIds = event.nodes.filter(node => node.isSelected() === true && !node.detail && canDragSelection(node.data)).map(node => node.data && workTypesOrderId(node.data)).filter((id): id is string => Boolean(id));
    const targetId = workTypesOrderId(event.overNode.data);
    if (!movingIds.length || !targetId || movingIds.includes(targetId)) return;
    const placement = event.y < (event.overNode.rowTop ?? 0) + (event.overNode.rowHeight ?? 54) / 2 ? "before" : "after";
    void move({ movingIds, targetId, placement });
  };
  const pendingCount = master ? pending.length : localPending.length;
  const canAdd = props.canCreate && !props.disabled && (master || parentKey !== "unassigned");
  return <div className={master ? "work-types-master" : "work-types-detail-content"}>
    <div ref={gridElement} className={`ag-grid-shell ag-admin-grid ag-reference-grid ${master ? "work-types-master-grid" : "work-types-detail-grid"}`} aria-busy={props.disabled}>
      <AgGridReact<WorkTypeRow>
        theme={gridTheme} localeText={gridLocaleRu} rowData={orderedRows} columnDefs={columns} defaultColDef={defaultColDef}
        getRowId={({ data }) => data.key} rowHeight={54} headerHeight={48} animateRows={false} rowBuffer={6}
        loading={props.loading} readOnlyEdit stopEditingWhenCellsLoseFocus enableFilterHandlers
        quickFilterText={props.query} cacheQuickFilter includeHiddenColumnsInQuickFilter
        masterDetail={master} isRowMaster={master ? () => true : undefined} detailCellRenderer={master ? WorkTypesDetail : undefined}
        keepDetailRows keepDetailRowsCount={8}
        getRowHeight={master ? params => params.node.detail ? detailHeight(params.data) : undefined : undefined}
        rowClassRules={{ "editable-row": params => Boolean(params.data && latest.current.drafts[params.data.key]), "work-types-unassigned": params => Boolean(params.data?.unassigned) }}
        rowSelection={props.canUpdate || props.canDelete ? { mode: "multiRow", selectAll: "filtered", enableClickSelection: false, checkboxes: params => Boolean(!dirty && !props.disabled && !params.node.detail && params.data && (params.data.unassigned ? props.canDelete : workTypesOrderId(params.data))), headerCheckbox: !dirty && !props.disabled, hideDisabledCheckboxes: true, isRowSelectable: node => Boolean(!dirty && !props.disabled && !node.detail && node.data && (node.data.unassigned ? props.canDelete : workTypesOrderId(node.data))) } : undefined}
        selectionColumnDef={selectionColumnDef}
        cellSelection={{ handle: { mode: "fill" } }} copyHeadersToClipboard={false} suppressClipboardPaste={props.disabled || !props.canCreate && !props.canUpdate}
        processCellForClipboard={params => params.column.getColId() === "parentKey" ? parentOptions.find(row => row.key === params.value)?.name ?? "Без вида работы" : String(params.value ?? "")}
        onCellEditRequest={event => {
          if (!event.data || event.colDef.field !== "name" && event.colDef.field !== "parentKey") return;
          const changes = { [event.colDef.field]: String(event.newValue ?? "") };
          const targets = event.colDef.field === "parentKey" && assignment.current.some(row => row.key === event.data.key) ? assignment.current : [event.data];
          if (targets.length > 1) latest.current.onBatchStart();
          for (const row of targets) latest.current.onPatch(row, changes);
          if (targets.length > 1) latest.current.onBatchEnd();
        }}
        onCellEditingStarted={event => {
          if (event.api.isAnyFilterPresent()) event.api.setFilterModel(null);
          latest.current.onEditingChange(event.api, true);
          if (event.column.getColId() === "name") requestAnimationFrame(() => {
            const masterApi = masterGridRef?.current;
            if (!master && parentKey && masterApi && !masterApi.isDestroyed()) {
              const parent = masterApi.getRowNode(parentKey);
              if (parent) masterApi.ensureNodeVisible(parent, "top");
            }
            const root = gridElement.current;
            const input = root?.querySelector<HTMLInputElement>(".ag-cell-inline-editing input");
            if (input && (document.activeElement === document.body || root?.contains(document.activeElement)) && document.activeElement !== input) { input.focus({ preventScroll: true }); input.select(); }
          });
        }} onCellEditingStopped={event => {
          latest.current.onEditingChange(event.api, false);
          if (!master && assignment.current.length) event.api.setColumnsVisible(["parentKey"], false);
          assignment.current = []; setAssigningCount(0);
        }}
        onPasteStart={props.onBatchStart} onPasteEnd={props.onBatchEnd} onFillStart={props.onBatchStart} onFillEnd={props.onBatchEnd}
        onCellKeyDown={event => {
          const key = event.event as KeyboardEvent | undefined;
          if (!key || !(key.ctrlKey || key.metaKey) || key.target instanceof Element && key.target.closest("input,textarea")) return;
          if (key.code === "KeyZ" || key.code === "KeyY") { key.preventDefault(); key.stopPropagation(); if (key.shiftKey || key.code === "KeyY") latest.current.history.redo(); else latest.current.history.undo(); }
        }}
        getContextMenuItems={contextMenu} rowDragMultiRow rowDragManaged={false} suppressMoveWhenRowDragging suppressRowDrag={moveBlocked || !order?.canWrite || order.busy} onRowDragEnd={dragEnd}
        onGridReady={({ api: ready }) => { ready.setGridAriaProperty("label", master ? "Виды работ" : "Подвиды работ"); if (master && masterGridRef) masterGridRef.current = ready; setApi(ready); }}
        onGridSizeChanged={event => refreshDetailHeights(event.api)}
        onModelUpdated={event => { let total = 0; event.api.forEachNodeAfterFilter(node => { if (node.data && !node.detail && !node.data.unassigned) total++; }); setVisibleCount(total); }}
        onFilterChanged={event => setFiltered(event.api.isAnyFilterPresent() || Boolean(props.query))}
        onSelectionChanged={event => setSelected(event.api.getSelectedRows())}
        popupParent={typeof document === "undefined" ? undefined : document.body}
      />
    </div>
    {moveActions.feedback}
    {assigningCount > 0 && <p className="work-types-assignment-hint" role="status">Выберите вид работы в ячейке — он применится к выбранным подвидам: {assigningCount}.</p>}
    {(props.canCreate || props.canUpdate || props.canDelete) && <AdminGridFooter
      addLabel={master ? "Добавить вид работы" : "Добавить подвид работы"} countLabel={master ? "Видов работ" : "Подвидов работ"} count={visibleCount}
      deletingCount={selected.length} deletingLabel="Архивировать" editorOpen={pendingCount > 0} editingExisting={pending.some(row => Boolean(row.id))} pendingCount={pendingCount}
      uniformActions saving={props.disabled} canCreate={canAdd} canUpdate={props.canUpdate} canDelete={props.canDelete}
      editingActions={localPending.length > 0 && canAdd ? [{ key: "add-another", label: master ? "Добавить ещё вид работы" : "Добавить ещё подвид", onClick: () => { api?.stopEditing(); props.onAdd(master ? "parent" : "child", parentKey); } }] : []}
      selectionActions={!master && props.canUpdate ? [{ key: "assign", label: "Назначить вид работы", disabled: !parentOptions.length || selected.length > 500, onClick: () => {
        if (!api || !selected.length) return;
        api.stopEditing();
        const first = api.getRowNode(selected[0].key);
        if (first?.rowIndex == null) return;
        assignment.current = selected;
        setAssigningCount(selected.length);
        // The parent is already shown in the detail heading. Reveal its chooser only for reassignment.
        api.setColumnsVisible(["parentKey"], true);
        api.ensureIndexVisible(first.rowIndex);
        api.ensureColumnVisible("parentKey");
        api.setFocusedCell(first.rowIndex, "parentKey");
        api.startEditingCell({ rowIndex: first.rowIndex, colKey: "parentKey" });
      } }] : []}
      onAdd={() => props.onAdd(master ? "parent" : "child", parentKey)} onDelete={() => props.onArchive(selected)} onEditSelection={selected.some(row => !row.unassigned) ? () => props.onEdit(selected.filter(row => !row.unassigned)) : undefined}
      onClearSelection={() => api?.deselectAll()} onCancelEditing={props.onCancel} onSave={props.onSave}/>
    }
    <span className="sr-only" aria-live="polite">{selected.length ? `Выбрано строк: ${selected.length}` : ""}</span>
  </div>;
}

export function WorkTypesTable(props: Props) {
  const masterGridRef = useRef<GridApi<WorkTypeRow> | null>(null);
  return <Workspace.Provider value={props}><MasterGrid.Provider value={masterGridRef}><WorkTypesEntityGrid/></MasterGrid.Provider></Workspace.Provider>;
}
