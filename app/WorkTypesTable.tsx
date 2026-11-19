"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import type { ColDef, GridApi, GetContextMenuItemsParams, MenuItemDef, ICellRendererParams, IFilterParams, PostSortRowsParams, RowDragEvent, SuppressMouseEventHandlingParams } from "ag-grid-community";
import { gridTheme } from "./gridTheme";
import { gridLocaleRu } from "./gridLocaleRu";
import { tableColumnMenuItems } from "./gridColumnMenu";
import { AdminGridFooter } from "./AdminGridFooter";
import { useRowMoveActions, useWorkspaceTableOrder } from "./TableRowMoves";
import type { TableContextMenuAction } from "./TableContextMenu";
import { workTypesOrderId } from "./workTypesRowOrder";
import { SelectionRowDragRenderer } from "./SelectionRowDragRenderer";
import { enterpriseFilterParams } from "./GridEnterpriseFilters";
import type { WorkTypeDraft, WorkTypeEdits, WorkTypeRow } from "./workTypesWorkspace";
import "./gridFilters.css";
import { useEmptyGridRows } from "./useEmptyGridRows";
import { useTableEscapeSelection } from "./useTableEscapeSelection";
import { useGridFilterEscape } from "./useGridFilterEscape";
import { SpreadsheetFilterHeader } from "./SpreadsheetFilterHeader";
import { useCatalogGridPreferences } from "./useCatalogGridPreferences";
import { AgTablePageScroll } from "./TablePageScroll";
import { isTableSelectAllShortcut, isTableTextEntryTarget } from "./tableSelectAllShortcut";
import { isTableRowSelectionBlocked, tableColumnSelectionIntent, tableRowSelectionIntent } from "./tableRowSelectionShortcut";
import { findSpreadsheetDataRowIndex, isStructuralSpreadsheetRow, nativeSpreadsheetSelectionKey, nativeSpreadsheetSelectionValues, spreadsheetDataColumns, spreadsheetDataRowRanges, spreadsheetHeaderValues } from "./gridSpreadsheetRows";
import { serializeSpreadsheetText, stripSpreadsheetHeaderRow } from "./spreadsheetClipboard";
import { useTableCopyToast, writeTableClipboardText } from "./useTableCopyToast";
import { createRowDropIndicator } from "./rowDropIndicator";
import { resolveGridRowDropTarget } from "./gridRowDropTarget";
import { rowDragPoint, startRowDragAutoScroll } from "./rowDragAutoScroll";
import type { RowMove } from "./tableRowOrder";
import { dispatchUndoShortcut, useUndoShortcut } from "./useUndoShortcut";
import { historyShortcut } from "./undoShortcut";

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
  preferenceScope?: { userId: number; siteId?: number };
  selectionVersion: number;
  onEdit: (rows: WorkTypeRow[]) => void;
  onPatch: (row: WorkTypeRow, changes: Partial<WorkTypeDraft>) => void;
  onAdd: (kind: WorkTypeDraft["directoryKind"], parentKey?: string) => void;
  onRemoveNew?: (rows: WorkTypeRow[]) => void;
  onArchive: (rows: WorkTypeRow[]) => void;
  onSave: () => void;
  onCancel: () => void;
  registerGrid: (api: GridApi<WorkTypeRow>, parentKey?: string) => () => void;
  onEditingChange: (api: GridApi<WorkTypeRow>, editing: boolean) => void;
  onBatchStart: () => void;
  onBatchEnd: () => void;
  history: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
};
type WorkspaceValue = Props & { showCopyToast: (message: string) => void };
const Workspace = createContext<WorkspaceValue | null>(null);
const MasterGrid = createContext<RefObject<GridApi<WorkTypeRow> | null> | null>(null);
const EMPTY_ROWS: WorkTypeRow[] = [];

type WholeWorkTypeRows = { anchorId: string; endId: string; columnId: string; rangeKey: string };
type WholeWorkTypeColumns = { anchorId: string; endId: string; rowId: string; rangeKey: string };

function selectedWorkTypeColumns(grid: GridApi<WorkTypeRow>) {
  const ids = new Set((grid.getCellRanges() ?? []).flatMap(range => range.columns.map(column => column.getColId())));
  return spreadsheetDataColumns(grid).filter(column => ids.has(column.getColId()));
}

/** All displayed records, including virtual rows; the active record stays put. */
function selectWorkTypeColumnRange(grid: GridApi<WorkTypeRow>, anchorId: string, endId: string, rowId: string): WholeWorkTypeColumns | null {
  const columns = spreadsheetDataColumns(grid);
  const anchor = columns.findIndex(column => column.getColId() === anchorId), end = columns.findIndex(column => column.getColId() === endId);
  const row = grid.getRowNode(rowId);
  if (anchor < 0 || end < 0 || row?.rowIndex == null || isStructuralSpreadsheetRow(row)) return null;
  const selected = columns.slice(Math.min(anchor, end), Math.max(anchor, end) + 1);
  grid.clearCellSelection();
  for (const range of spreadsheetDataRowRanges(grid)) grid.addCellRange({ ...range, columns: selected });
  grid.setFocusedCell(row.rowIndex, endId);
  grid.ensureIndexVisible(row.rowIndex);
  grid.ensureColumnVisible(endId);
  return { anchorId, endId, rowId, rangeKey: nativeSpreadsheetSelectionKey(grid) };
}

/** Split full rows around detail panels so copying and filling never touch them. */
function selectWorkTypeRowRange(grid: GridApi<WorkTypeRow>, anchorIndex: number, endIndex: number, columnId: string): WholeWorkTypeRows | null {
  const anchor = grid.getDisplayedRowAtIndex(anchorIndex), end = grid.getDisplayedRowAtIndex(endIndex);
  const columns = spreadsheetDataColumns(grid);
  if (!anchor?.id || !end?.id || isStructuralSpreadsheetRow(anchor) || isStructuralSpreadsheetRow(end) || !columns.length) return null;
  const start = Math.min(anchorIndex, endIndex), finish = Math.max(anchorIndex, endIndex);
  const focusedColumn = columns.find(column => column.getColId() === columnId) ?? columns[0];
  grid.clearCellSelection();
  for (const range of spreadsheetDataRowRanges(grid)) {
    const rowStartIndex = Math.max(start, range.rowStartIndex), rowEndIndex = Math.min(finish, range.rowEndIndex);
    if (rowStartIndex <= rowEndIndex) grid.addCellRange({ rowStartIndex, rowEndIndex, columns });
  }
  grid.setFocusedCell(endIndex, focusedColumn);
  grid.ensureIndexVisible(endIndex);
  return { anchorId: anchor.id, endId: end.id, columnId: focusedColumn.getColId(), rangeKey: nativeSpreadsheetSelectionKey(grid) };
}

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
  useLayoutEffect(() => { latest.current = props; }, [props]);
  const master = parentKey === undefined;
  const rows = master ? props.masters : props.details.get(parentKey) ?? EMPTY_ROWS;
  const order = useWorkspaceTableOrder();
  const preferences = useCatalogGridPreferences({ ...props.preferenceScope, scopeKey: master ? "worktypes:parents" : "worktypes:children", ready: !props.loading && (!order || order.ready) });
  const orderedRows = useMemo(() => order ? order.order(rows, workTypesOrderId) : rows, [rows, order]);
  const [api, setApi] = useState<GridApi<WorkTypeRow> | null>(null);
  const gridElement = useRef<HTMLDivElement>(null);
  useUndoShortcut({ rootRef: gridElement, undo: props.history.undo, redo: props.history.redo,
    canUndo: props.history.canUndo, canRedo: props.history.canRedo, disabled: props.disabled });
  const trackFilterEscape = useGridFilterEscape<WorkTypeRow>({ api, getRoot: () => gridElement.current });
  useEmptyGridRows(gridElement, api, 44);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const selected = useMemo(() => {
    const byKey = new Map(rows.map(row => [row.key, row]));
    return selectedKeys.flatMap(key => byKey.has(key) ? [byKey.get(key)!] : []);
  }, [rows, selectedKeys]);
  const selectedNew = selected.filter(row => row.id === undefined && !row.unassigned);
  const selectedSaved = selected.filter(row => row.id !== undefined || row.unassigned);
  const selectionIncludesHeaders = useRef<string | null>(null);
  const wholeRows = useRef<WholeWorkTypeRows | null>(null);
  const wholeColumns = useRef<WholeWorkTypeColumns | null>(null);
  const lastHeaderClipboard = useRef<string | null>(null);
  const lastHeaderValues = useRef<string[] | null>(null);
  const paintSelectedHeaders = useCallback((grid: GridApi<WorkTypeRow>) => {
    requestAnimationFrame(() => {
      const root = gridElement.current;
      if (!root || grid.isDestroyed()) return;
      const selectedIds = new Set(selectionIncludesHeaders.current !== null ? (wholeColumns.current ? selectedWorkTypeColumns(grid) : spreadsheetDataColumns(grid)).map(column => column.getColId()) : []);
      root.querySelectorAll<HTMLElement>(".ag-header-cell[col-id]").forEach(header => {
        if (header.closest(".work-types-master-grid,.work-types-detail-grid") !== root) return;
        header.classList.toggle("ag-excel-header-selected", selectedIds.has(header.getAttribute("col-id") ?? ""));
      });
    });
  }, []);
  const clearSelectedHeaders = useCallback(() => {
    selectionIncludesHeaders.current = null;
    if (api && !api.isDestroyed()) {
      api.setGridOption("copyHeadersToClipboard", false);
      paintSelectedHeaders(api);
    }
  }, [api, paintSelectedHeaders]);
  const selectWholeRows = useCallback((anchorIndex: number, endIndex: number, columnId: string) => {
    if (!api || api.isDestroyed() || !api.isModuleRegistered("CellSelectionModule") || api.getEditingCells().length) return false;
    wholeColumns.current = null;
    clearSelectedHeaders();
    wholeRows.current = selectWorkTypeRowRange(api, anchorIndex, endIndex, columnId);
    return Boolean(wholeRows.current);
  }, [api, clearSelectedHeaders]);
  const selectWholeColumns = useCallback((anchorId: string, endId: string, rowId: string) => {
    if (!api || api.isDestroyed() || !api.isModuleRegistered("CellSelectionModule") || api.getEditingCells().length) return false;
    wholeRows.current = null;
    wholeColumns.current = selectWorkTypeColumnRange(api, anchorId, endId, rowId);
    selectionIncludesHeaders.current = wholeColumns.current?.rangeKey ?? null;
    api.setGridOption("copyHeadersToClipboard", selectionIncludesHeaders.current !== null);
    paintSelectedHeaders(api);
    return Boolean(wholeColumns.current);
  }, [api, paintSelectedHeaders]);
  const handleWholeColumnKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const intent = tableColumnSelectionIntent(event.nativeEvent);
    if (!intent || !api || api.isDestroyed() || !api.isModuleRegistered("CellSelectionModule") || api.getEditingCells().length) return false;
    const current = wholeColumns.current;
    if (intent !== "column" && !current) return false;
    const columns = spreadsheetDataColumns(api), focus = api.getFocusedCell();
    if (focus?.rowPinned) return false;
    const headerId = event.target instanceof Element ? event.target.closest<HTMLElement>(".ag-header-cell[col-id]")?.getAttribute("col-id") : undefined;
    const rangeColumns = api.getCellRanges()?.at(-1)?.columns.filter(column => columns.includes(column));
    const rowIndex = focus?.rowIndex ?? findSpreadsheetDataRowIndex(api, 0, 1);
    const rowId = current?.rowId ?? (rowIndex == null ? undefined : api.getDisplayedRowAtIndex(rowIndex)?.id);
    const anchorId = current?.anchorId ?? headerId ?? wholeRows.current?.columnId ?? rangeColumns?.[0]?.getColId() ?? focus?.column.getColId();
    let endId = current?.endId ?? headerId ?? wholeRows.current?.columnId ?? rangeColumns?.at(-1)?.getColId() ?? focus?.column.getColId();
    if (intent !== "column") {
      const index = columns.findIndex(column => column.getColId() === endId);
      if (index < 0) { wholeColumns.current = null; clearSelectedHeaders(); return false; }
      endId = columns[Math.max(0, Math.min(columns.length - 1, index + (intent === "left" ? -1 : 1)))]?.getColId();
    }
    if (!rowId || !anchorId || !endId || !selectWholeColumns(anchorId, endId, rowId)) return false;
    event.preventDefault(); event.stopPropagation();
    return true;
  };
  const handleWholeRowKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const intent = tableRowSelectionIntent(event.nativeEvent);
    if (!intent || !api || api.isDestroyed() || !api.isModuleRegistered("CellSelectionModule") || api.getEditingCells().length) return false;
    const current = wholeRows.current;
    if (intent !== "row" && !current) return false;
    const focus = api.getFocusedCell();
    const range = api.getCellRanges()?.at(-1);
    const columnRow = wholeColumns.current ? api.getRowNode(wholeColumns.current.rowId)?.rowIndex : undefined;
    const anchorIndex = current ? api.getRowNode(current.anchorId)?.rowIndex : columnRow ?? range?.startRow?.rowIndex ?? focus?.rowIndex;
    let endIndex = current ? api.getRowNode(current.endId)?.rowIndex : columnRow ?? range?.endRow?.rowIndex ?? focus?.rowIndex;
    if (anchorIndex == null || endIndex == null || focus?.rowPinned || range?.startRow?.rowPinned || range?.endRow?.rowPinned) { wholeRows.current = null; return false; }
    if (intent !== "row") {
      const direction = intent === "up" ? -1 : 1;
      endIndex = findSpreadsheetDataRowIndex(api, endIndex + direction, direction) ?? endIndex;
    }
    const columnId = current?.columnId ?? focus?.column.getColId() ?? spreadsheetDataColumns(api)[0]?.getColId();
    if (!columnId || !selectWholeRows(anchorIndex, endIndex, columnId)) return false;
    event.preventDefault(); event.stopPropagation();
    return true;
  };
  const extendWholeColumnsToPointer = (event: React.PointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
    if (!event.shiftKey || event.button !== 0 || !wholeColumns.current || !api || api.isDestroyed() || !(event.target instanceof Element) || isTableRowSelectionBlocked(event.target)) return false;
    const columnId = event.target.closest<HTMLElement>(".ag-cell[col-id], .ag-header-cell[col-id]")?.getAttribute("col-id");
    if (!columnId || !selectWholeColumns(wholeColumns.current.anchorId, columnId, wholeColumns.current.rowId)) return false;
    event.preventDefault(); event.stopPropagation();
    return true;
  };
  const extendWholeRowsToPointer = (event: React.PointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
    if (!event.shiftKey || event.button !== 0 || !wholeRows.current || !api || api.isDestroyed() || !(event.target instanceof Element) || isTableRowSelectionBlocked(event.target)) return false;
    const cell = event.target.closest<HTMLElement>(".ag-cell[col-id]");
    const row = cell?.closest<HTMLElement>(".ag-row[row-index]");
    const anchorIndex = api.getRowNode(wholeRows.current.anchorId)?.rowIndex;
    if (!row || anchorIndex == null || !selectWholeRows(anchorIndex, Number(row.getAttribute("row-index")), wholeRows.current.columnId)) return false;
    event.preventDefault(); event.stopPropagation();
    return true;
  };
  useTableEscapeSelection({
    hasSelection: () => Boolean(selectionIncludesHeaders.current !== null || api && !api.isDestroyed() && (api.getSelectedNodes().length || api.getFocusedCell() || api.isModuleRegistered("CellSelectionModule") && api.getCellRanges()?.length)),
    isEditing: () => Boolean(api && !api.isDestroyed() && api.getEditingCells().length),
    clearSelection: () => {
      wholeRows.current = null;
      wholeColumns.current = null;
      clearSelectedHeaders();
      if (!api || api.isDestroyed()) return;
      api.deselectAll();
      setSelectedKeys([]);
      if (api.isModuleRegistered("CellSelectionModule")) api.clearCellSelection();
      api.clearFocusedCell();
    },
  });
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
      field: "name", headerName: master ? "Вид работы" : "Подвид работы", minWidth: 280, initialFlex: master ? 3 : 2,
      editable: params => canEdit(params.data), cellEditor: "agTextCellEditor", cellEditorParams: { maxLength: 240 },
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
      field: "childCount", headerName: "Подвидов", initialWidth: 150, minWidth: 125, maxWidth: 190, editable: false,
      filterParams: (params: IFilterParams) => enterpriseFilterParams(params, { kind: "number", presentation: "checklist" }), cellClass: "work-types-count-cell",
      cellRenderer: ({ value }: CustomCellRendererProps<WorkTypeRow>) => <span className="work-types-count">{value ?? 0}</span>,
    } satisfies ColDef<WorkTypeRow>] : [{
      field: "parentKey", headerName: "Вид работы", minWidth: 230, initialFlex: 1, editable: params => canEdit(params.data),
      initialHide: true,
      cellEditor: "agRichSelectCellEditor", cellEditorPopup: true,
      cellEditorParams: () => ({ values: parentOptions.map(row => row.key), formatValue: (key: string) => parentOptions.find(row => row.key === key)?.name ?? "Без вида работы", allowTyping: true, filterList: true, searchType: "matchAny", highlightMatch: true }),
      valueFormatter: params => parentOptions.find(row => row.key === params.value)?.name ?? (params.value === "unassigned" || !params.value ? "Без вида работы" : String(params.value)),
      filterValueGetter: params => parentOptions.find(row => row.key === params.data?.parentKey)?.name ?? "Без вида работы",
      filterParams: (params: IFilterParams) => enterpriseFilterParams(params, { kind: "text", presentation: "checklist", valueFormatter: ({ value }) => String(value ?? "") }),
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
    headerComponentParams: { innerHeaderComponent: SpreadsheetFilterHeader },
    suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true,
    filterParams: (params: IFilterParams) => enterpriseFilterParams(params, { kind: "text", presentation: "checklist" }),
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
  const pendingKeys = localPending.filter(row => row.id === undefined).map(row => row.key).join("|");
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
    const desired = Math.max(minimum, 156 + Math.max(2, workspace.details.get(row?.key ?? "")?.length ?? 0) * 44);
    return Math.min(540, available, desired);
  }, []);
  const refreshDetailHeights = useCallback((grid: GridApi<WorkTypeRow>) => {
    if (!master || grid.isDestroyed()) return;
    let changed = false;
    for (let index = 0; index < grid.getDisplayedRowCount(); index++) {
      const node = grid.getDisplayedRowAtIndex(index);
      if (node?.detail) {
        const height = detailHeight(node.data);
        if (node.rowHeight !== height) { node.setRowHeight(height); changed = true; }
      }
    }
    if (changed) grid.onRowHeightChanged();
  }, [detailHeight, master]);
  const detailHeightFrame = useRef<number | null>(null);
  const queueDetailHeights = useCallback((grid: GridApi<WorkTypeRow>) => {
    if (!master) return;
    if (detailHeightFrame.current !== null) cancelAnimationFrame(detailHeightFrame.current);
    detailHeightFrame.current = requestAnimationFrame(() => { detailHeightFrame.current = null; refreshDetailHeights(grid); });
  }, [master, refreshDetailHeights]);
  useEffect(() => {
    if (api) queueDetailHeights(api);
    return () => { if (detailHeightFrame.current !== null) cancelAnimationFrame(detailHeightFrame.current); detailHeightFrame.current = null; };
  }, [api, props.details, queueDetailHeights]);
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
      api.ensureIndexVisible(node.rowIndex, "top");
      api.setFocusedCell(node.rowIndex, "name");
      // Undo can restore a row too. Keep focus on the cell so the next redo
      // reaches table history; typing or Enter opens the native editor.
    });
    return () => cancelAnimationFrame(frame);
  }, [api, newKeys]);
  const keepNewRowsFirst = useCallback(({ nodes }: PostSortRowsParams<WorkTypeRow>) => {
    const rank = new Map(rows.filter(row => row.id === undefined && !row.unassigned).map((row, index) => [row.key, index]));
    const added = nodes.filter(node => rank.has(node.data?.key ?? "")).sort((left, right) => rank.get(left.data!.key)! - rank.get(right.data!.key)!);
    if (added.length) nodes.splice(0, nodes.length, ...added, ...nodes.filter(node => !rank.has(node.data?.key ?? "")));
  }, [rows]);
  const contextMenu = (params: GetContextMenuItemsParams<WorkTypeRow>) => {
    const row = params.node?.data;
    if (!row || params.node?.detail || !params.column) return [];
    const id = row && workTypesOrderId(row);
    const nativeAction = (action: TableContextMenuAction): MenuItemDef<WorkTypeRow> => ({
      name: action.label,
      disabled: action.disabled,
      tooltip: action.title,
      ...(action.children ? { subMenu: action.children.flatMap(child => [...(child.separatorBefore ? ["separator" as const] : []), nativeAction(child)]) } : { action: action.onSelect }),
    });
    return [
      { name: "Копировать / вставить", subMenu: ["copy", "copyWithHeaders", ...(params.column.isCellEditable(params.node!) ? ["paste" as const] : [])] },
      ...(id ? moveActions.getActions(id, selected.map(workTypesOrderId).filter((key): key is string => Boolean(key)), () => api?.hidePopupMenu()).flatMap(action => [...(action.separatorBefore ? ["separator" as const] : []), nativeAction(action)]) : []),
    ] satisfies ("separator" | MenuItemDef<WorkTypeRow>)[];
  };
  const dropIndicator = useRef<ReturnType<typeof createRowDropIndicator> | null>(null);
  const activeRowDrag = useRef<RowDragEvent<WorkTypeRow> | null>(null);
  const rowDragCancelled = useRef(false);
  const rowDragScroll = useRef<ReturnType<typeof startRowDragAutoScroll>>(null);
  const stopRowDrag = useCallback(() => {
    activeRowDrag.current = null;
    dropIndicator.current?.clear();
    const scroll = rowDragScroll.current;
    rowDragScroll.current = null;
    scroll?.stop();
  }, []);
  const dragOperation = useCallback((event: RowDragEvent<WorkTypeRow>): RowMove<string> | null => {
    if (rowDragCancelled.current || event.api !== api || !canDragSelection(event.node.data) || event.node.isSelected() !== true || event.node.detail || !event.overNode?.data || event.overNode.detail || event.overNode.data.unassigned) return null;
    // Master and detail grids share an order scope, but a drag stays among its siblings.
    const siblingIds = new Set(rows.map(workTypesOrderId).filter((id): id is string => Boolean(id)));
    const movingIds = event.nodes.filter(node => node.isSelected() === true && !node.detail && canDragSelection(node.data)).map(node => node.data && workTypesOrderId(node.data)).filter((id): id is string => Boolean(id) && siblingIds.has(id!));
    const targetId = workTypesOrderId(event.overNode.data);
    if (!movingIds.length || !targetId || !siblingIds.has(targetId) || movingIds.includes(targetId)) return null;
    const placement = event.y < (event.overNode.rowTop ?? 0) + (event.overNode.rowHeight ?? 44) / 2 ? "before" : "after";
    return { movingIds, targetId, placement };
  }, [api, canDragSelection, rows]);
  const refreshRowDrop = useCallback(() => {
    const root = gridElement.current;
    const event = activeRowDrag.current;
    const target = root && event ? resolveGridRowDropTarget(root, event, dragOperation) : null;
    if (target && (target.operation.placement === "before" || target.operation.placement === "after")) dropIndicator.current?.show({ row: target.row, placement: target.operation.placement, count: target.operation.movingIds.length, rowNumber: target.rowNumber });
    else dropIndicator.current?.clear();
  }, [dragOperation]);
  const latestRowDropRefresh = useRef(refreshRowDrop);
  useLayoutEffect(() => { latestRowDropRefresh.current = refreshRowDrop; }, [refreshRowDrop]);
  useEffect(() => {
    const root = gridElement.current;
    const view = root?.ownerDocument.defaultView;
    if (!root || !view || !api) return;
    const indicator = createRowDropIndicator(root);
    dropIndicator.current = indicator;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { rowDragCancelled.current = true; stopRowDrag(); } };
    const refresh = () => latestRowDropRefresh.current();
    root.ownerDocument.addEventListener("keydown", escape, true);
    root.ownerDocument.addEventListener("scroll", refresh, true);
    view.addEventListener("blur", stopRowDrag);
    return () => {
      stopRowDrag(); indicator.destroy(); dropIndicator.current = null;
      root.ownerDocument.removeEventListener("keydown", escape, true);
      root.ownerDocument.removeEventListener("scroll", refresh, true);
      view.removeEventListener("blur", stopRowDrag);
    };
  }, [api, stopRowDrag]);
  useEffect(() => stopRowDrag, [api, moveBlocked, order?.busy, order?.canWrite, parentKey, stopRowDrag]);
  const dragMove = (event: RowDragEvent<WorkTypeRow>) => {
    if (rowDragCancelled.current || !canDragSelection(event.node.data)) { stopRowDrag(); return; }
    activeRowDrag.current = event;
    refreshRowDrop();
    const point = rowDragPoint(event.event);
    const root = gridElement.current;
    if (!point || !root) return;
    if (rowDragScroll.current) rowDragScroll.current.update(point);
    else {
      let session: ReturnType<typeof startRowDragAutoScroll> = null;
      // AG delivers rowDragEnd asynchronously after the native mouseup listener.
      // Keep the gesture/preview until that event resolves its final destination.
      session = startRowDragAutoScroll(root, point, "grid", () => { if (rowDragScroll.current === session) rowDragScroll.current = null; });
      rowDragScroll.current = session;
    }
  };
  const dragEnd = (event: RowDragEvent<WorkTypeRow>) => {
    const root = gridElement.current;
    const target = root ? resolveGridRowDropTarget(root, event, dragOperation) : null;
    stopRowDrag();
    if (target) void move(target.operation);
  };
  const pendingCount = master ? pending.length : localPending.length;
  const canAdd = props.canCreate && !props.disabled && (master || parentKey !== "unassigned");
  const selectable = (row?: WorkTypeRow) => Boolean(row && !props.disabled && (row.unassigned ? props.canDelete : row.id === undefined ? props.canCreate : props.canUpdate || props.canDelete));
  const grid = <div ref={gridElement} className={`ag-grid-shell ag-admin-grid ag-reference-grid ag-grid-empty-rows ${master ? "work-types-master-grid" : "work-types-detail-grid"}`} role="grid" aria-label={master ? "Таблица видов работ" : "Таблица подвидов работ"} aria-busy={props.disabled} tabIndex={0} onPointerDownCapture={event => {
      if (event.button === 2 || !(event.target instanceof Element) || event.target.closest(".work-types-master-grid,.work-types-detail-grid") !== event.currentTarget) return;
      if (extendWholeColumnsToPointer(event)) return;
      if (extendWholeRowsToPointer(event)) return;
      wholeRows.current = null;
      wholeColumns.current = null;
      rowDragCancelled.current = false;
      clearSelectedHeaders();
    }} onMouseDownCapture={event => {
      if (event.target instanceof Element && event.target.closest(".work-types-master-grid,.work-types-detail-grid") === event.currentTarget && !extendWholeColumnsToPointer(event)) extendWholeRowsToPointer(event);
    }} onClickCapture={event => {
      if (event.target instanceof Element && event.target.closest(".work-types-master-grid,.work-types-detail-grid") === event.currentTarget && !extendWholeColumnsToPointer(event)) extendWholeRowsToPointer(event);
    }} onKeyDownCapture={event => {
      // The nested detail grid owns its shortcut; the master must not overwrite its range.
      if (event.target instanceof Element && event.target.closest(".work-types-master-grid,.work-types-detail-grid") !== event.currentTarget) return;
      if (historyShortcut(event.nativeEvent)) {
        // Route before AG Grid consumes the keystroke. The shared dispatcher
        // leaves native input undo and portalled editors to their owner.
        if (dispatchUndoShortcut(event.nativeEvent)) event.stopPropagation();
        return;
      }
      if (isTableSelectAllShortcut(event.nativeEvent)) {
        event.preventDefault(); event.stopPropagation();
        wholeRows.current = null;
        wholeColumns.current = null;
        if (!api || api.isDestroyed() || !api.isModuleRegistered("CellSelectionModule")) return;
        const columns = spreadsheetDataColumns(api);
        api.clearCellSelection();
        const ranges = spreadsheetDataRowRanges(api);
        if (columns.length) {
          for (const range of ranges) api.addCellRange({ ...range, columns });
          if (ranges.length) api.setFocusedCell(ranges[0].rowStartIndex, columns[0]);
        }
        selectionIncludesHeaders.current = columns.length ? nativeSpreadsheetSelectionKey(api) : null;
        api.setGridOption("copyHeadersToClipboard", selectionIncludesHeaders.current !== null);
        paintSelectedHeaders(api);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing
        && (event.code === "KeyC" || event.key.toLocaleLowerCase("en-US") === "c") && !isTableTextEntryTarget(event.target)) {
        // Preserve the browser copy event. AG's native key handler cancels it
        // and writes through navigator.clipboard, which is not always granted.
        event.stopPropagation();
        return;
      }
      if (handleWholeColumnKey(event)) return;
      if (handleWholeRowKey(event)) return;
      const navigating = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Tab"].includes(event.key);
      const editing = !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "Enter" || event.key === "F2" || event.key.length === 1 && Boolean(event.key.trim()));
      if ((navigating || editing) && !isTableTextEntryTarget(event.target)) {
        const current = wholeRows.current;
        const columnSelection = wholeColumns.current;
        wholeRows.current = null;
        wholeColumns.current = null;
        if ((current || columnSelection) && api && !api.isDestroyed()) {
          const rowIndex = api.getRowNode(columnSelection?.rowId ?? current!.endId)?.rowIndex;
          const columnId = columnSelection?.endId ?? current!.columnId;
          if (rowIndex != null) {
            api.clearCellSelection();
            api.addCellRange({ rowStartIndex: rowIndex, rowEndIndex: rowIndex, columns: [columnId] });
            api.setFocusedCell(rowIndex, columnId);
          }
        }
        clearSelectedHeaders();
      }
    }} onCopyCapture={event => {
      if (event.defaultPrevented || isTableTextEntryTarget(event.target) || !api || api.isDestroyed() || !api.isModuleRegistered("CellSelectionModule")) return;
      if (event.target instanceof Element && event.target.closest(".work-types-master-grid,.work-types-detail-grid") !== event.currentTarget) return;
      const matrix = nativeSpreadsheetSelectionValues(api, { includeHeaders: selectionIncludesHeaders.current !== null });
      if (!matrix) return;
      event.preventDefault(); event.stopPropagation();
      const text = serializeSpreadsheetText(matrix);
      event.clipboardData.setData("text/plain", text);
      lastHeaderClipboard.current = selectionIncludesHeaders.current !== null ? text : null;
      lastHeaderValues.current = selectionIncludesHeaders.current !== null ? matrix[0] : null;
      const copiedRows = Math.max(0, matrix.length - (selectionIncludesHeaders.current !== null ? 1 : 0));
      props.showCopyToast(`Скопировано: ${copiedRows} × ${matrix[0]?.length ?? 0}`);
    }}>
      <AgGridReact<WorkTypeRow>
        theme={gridTheme} localeText={gridLocaleRu} rowData={orderedRows} columnDefs={columns} defaultColDef={defaultColDef}
        postProcessPopup={trackFilterEscape}
        getRowId={({ data }) => data.key} rowHeight={44} headerHeight={46} animateRows={false} rowBuffer={6} postSortRows={keepNewRowsFirst} suppressMovableColumns
        loading={props.loading} readOnlyEdit stopEditingWhenCellsLoseFocus enableFilterHandlers
        suppressHorizontalScroll={master} scrollbarWidth={master ? 0 : undefined}
        quickFilterText={props.query} cacheQuickFilter includeHiddenColumnsInQuickFilter
        masterDetail={master} isRowMaster={master ? () => true : undefined} detailCellRenderer={master ? WorkTypesDetail : undefined}
        keepDetailRows keepDetailRowsCount={8}
        detailRowHeight={master ? 540 : undefined}
        rowClassRules={{ "editable-row": params => Boolean(params.data && latest.current.drafts[params.data.key]), "work-types-unassigned": params => Boolean(params.data?.unassigned) }}
        rowSelection={props.canCreate || props.canUpdate || props.canDelete ? { mode: "multiRow", selectAll: "filtered", enableClickSelection: false, checkboxes: params => !params.node.detail && selectable(params.data), headerCheckbox: !props.disabled, hideDisabledCheckboxes: true, isRowSelectable: node => !node.detail && selectable(node.data) } : undefined}
        selectionColumnDef={selectionColumnDef}
        cellSelection={{ handle: { mode: "fill" } }} copyHeadersToClipboard={false} suppressClipboardPaste={props.disabled || !props.canCreate && !props.canUpdate}
        processDataFromClipboard={params => {
          const copiedOwnHeader = lastHeaderClipboard.current === serializeSpreadsheetText(params.data);
          const headers = copiedOwnHeader && lastHeaderValues.current ? lastHeaderValues.current : spreadsheetHeaderValues(params.api, wholeColumns.current ? selectedWorkTypeColumns(params.api) : spreadsheetDataColumns(params.api));
          if (selectionIncludesHeaders.current !== null && params.api.getDisplayedRowCount() === 0 && params.data.length === 1
            && params.data[0].length === headers.length && headers.every((header, index) => params.data[0][index] === header)) return null;
          const includesHeaders = selectionIncludesHeaders.current !== null || copiedOwnHeader;
          return includesHeaders ? stripSpreadsheetHeaderRow(params.data, headers) : params.data;
        }}
        processCellForClipboard={params => params.column.getColId() === "parentKey" ? parentOptions.find(row => row.key === params.value)?.name ?? "Без вида работы" : String(params.value ?? "")}
        sendToClipboard={({ data }) => {
          void writeTableClipboardText(data).then(
            () => props.showCopyToast("Скопировано"),
            () => props.showCopyToast("Не удалось скопировать"),
          );
        }}
        onCellEditRequest={event => {
          if (!event.data || event.colDef.field !== "name" && event.colDef.field !== "parentKey") return;
          const changes = { [event.colDef.field]: String(event.newValue ?? "") };
          const targets = event.colDef.field === "parentKey" && assignment.current.some(row => row.key === event.data.key) ? assignment.current : [event.data];
          if (targets.length > 1) latest.current.onBatchStart();
          for (const row of targets) latest.current.onPatch(row, changes);
          if (targets.length > 1) latest.current.onBatchEnd();
        }}
        onCellEditingStarted={event => {
          wholeRows.current = null;
          wholeColumns.current = null;
          clearSelectedHeaders();
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
        getContextMenuItems={contextMenu} columnMenu="new" getMainMenuItems={tableColumnMenuItems} rowDragMultiRow rowDragManaged={false} suppressMoveWhenRowDragging suppressRowDrag={moveBlocked || !order?.canWrite || order.busy}
        onRowDragEnter={dragMove} onRowDragMove={dragMove} onRowDragLeave={stopRowDrag} onRowDragEnd={dragEnd} onDragStopped={stopRowDrag} onRowDragCancel={() => { rowDragCancelled.current = true; stopRowDrag(); }}
        onGridReady={({ api: ready }) => { ready.setGridAriaProperty("label", master ? "Виды работ" : "Подвиды работ"); if (master && masterGridRef) masterGridRef.current = ready; preferences.attach(ready); setApi(ready); }}
        onColumnResized={preferences.onColumnResized}
        onSortChanged={() => { wholeRows.current = null; wholeColumns.current = null; clearSelectedHeaders(); preferences.onSortChanged(); }}
        onCellSelectionChanged={event => {
          if (wholeRows.current && nativeSpreadsheetSelectionKey(event.api) !== wholeRows.current.rangeKey) wholeRows.current = null;
          if (wholeColumns.current && nativeSpreadsheetSelectionKey(event.api) !== wholeColumns.current.rangeKey) wholeColumns.current = null;
          if (selectionIncludesHeaders.current !== null && nativeSpreadsheetSelectionKey(event.api) !== selectionIncludesHeaders.current) clearSelectedHeaders();
          else paintSelectedHeaders(event.api);
        }}
        onBodyScroll={event => { paintSelectedHeaders(event.api); refreshRowDrop(); }}
        onDisplayedColumnsChanged={event => paintSelectedHeaders(event.api)}
        onGridSizeChanged={event => queueDetailHeights(event.api)}
        onModelUpdated={event => { let total = 0; event.api.forEachNodeAfterFilter(node => { if (node.data && !node.detail && !node.data.unassigned) total++; }); setVisibleCount(total); queueDetailHeights(event.api); paintSelectedHeaders(event.api); }}
        onFilterChanged={event => { wholeRows.current = null; wholeColumns.current = null; clearSelectedHeaders(); setFiltered(event.api.isAnyFilterPresent() || Boolean(props.query)); }}
        onSelectionChanged={event => setSelectedKeys(event.api.getSelectedRows().map(row => row.key))}
        popupParent={typeof document === "undefined" ? undefined : document.body}
      />
    </div>;
  const footer = <>
    {moveActions.feedback}
    {assigningCount > 0 && <p className="work-types-assignment-hint" role="status">Выберите вид работы в ячейке — он применится к выбранным подвидам: {assigningCount}.</p>}
    {(props.canCreate || props.canUpdate || props.canDelete) && <AdminGridFooter
      addLabel={master ? "Добавить вид работы" : "Добавить подвид работы"} countLabel={master ? "Видов работ" : "Подвидов работ"} count={visibleCount}
      deletingCount={selectedSaved.length} selectedDraftCount={selectedNew.length} deletingLabel="Архивировать" editorOpen={dirty} editingExisting={pending.some(row => Boolean(row.id))} pendingCount={pendingCount}
      compact allowMultiple uniformActions saving={props.disabled} canCreate={props.canCreate} addDisabled={!canAdd} canUpdate={props.canUpdate} canDelete={props.canDelete}
      onRemoveSelectedDrafts={props.onRemoveNew ? () => { props.onRemoveNew?.(selectedNew); requestAnimationFrame(() => gridElement.current?.focus({ preventScroll: true })); } : undefined}
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
      onAdd={() => { api?.stopEditing(); props.onAdd(master ? "parent" : "child", parentKey); }} onDelete={() => props.onArchive(selectedSaved)} onEditSelection={selectedSaved.some(row => !row.unassigned) ? () => props.onEdit(selectedSaved.filter(row => !row.unassigned)) : undefined}
      onClearSelection={() => { api?.deselectAll(); setSelectedKeys([]); }} onCancelEditing={props.onCancel} onSave={props.onSave}/>
    }
  </>;
  return <div className={master ? "work-types-master" : "work-types-detail-content"}>
    <AgTablePageScroll gridRoot={gridElement} api={api} enabled={master} label="Горизонтальная прокрутка видов работ" footer={footer}>{grid}</AgTablePageScroll>
    <span className="sr-only" aria-live="polite">{selected.length ? `Выбрано строк: ${selected.length}` : ""}</span>
  </div>;
}

export function WorkTypesTable(props: Props) {
  const masterGridRef = useRef<GridApi<WorkTypeRow> | null>(null);
  const { showCopyToast, copyToast } = useTableCopyToast();
  const workspace = useMemo<WorkspaceValue>(() => ({ ...props, showCopyToast }), [props, showCopyToast]);
  return <Workspace.Provider value={workspace}><MasterGrid.Provider value={masterGridRef}><WorkTypesEntityGrid/></MasterGrid.Provider>{copyToast}</Workspace.Provider>;
}
