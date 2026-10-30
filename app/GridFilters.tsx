"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact, useGridFilterDisplay, type AgGridReactProps, type CustomFilterDisplayProps, type CustomFloatingFilterDisplayProps } from "ag-grid-react";
import type { CellMouseDownEvent, CellMouseOverEvent, ColDef, ColGroupDef, ColumnFilter, GridApi, IFilterParams, IRowNode } from "ag-grid-community";
import { compareGridValues, describeGridFilter, filterValueKey, isConditionValid, matchesPersonnelFilter, normalizeFilterText, numberOperations, textOperations, dateOperations, filterDateKey, type FilterCondition, type PersonnelFilterModel } from "./gridFilterModel";
import { gridLocaleRu } from "./gridLocaleRu";
import { CustomSelect } from "./CustomSelect";
import { VirtualChoiceList } from "./VirtualChoiceList";
import { enterpriseFilterParams, type EnterpriseFilterOptions } from "./GridEnterpriseFilters";
import { useGridFilterPopup } from "./useGridFilterPopup";
import { TableContextMenu, type TableContextMenuAction } from "./TableContextMenu";
import { useRowMoveActions, useWorkspaceTableOrder } from "./TableRowMoves";
import { gridRowEntityId, rowMoveIsBlocked, saveManualRowMove, type RowOrderId } from "./tableRowOrder";
import "./gridFilters.css";
import { parseSpreadsheetText, serializeSpreadsheetText } from "./spreadsheetClipboard";
import { useWorkspaceAccess } from "./TableAccessContext";
import { SelectionRowDragRenderer } from "./SelectionRowDragRenderer";
import { gridRowSelection } from "./gridRowSelection";
import { findSpreadsheetDataRowIndex, isStructuralSpreadsheetRow, spreadsheetPointRowIndex, spreadsheetRangeHasStructuralRows } from "./gridSpreadsheetRows";

type FilterRow = { kind: "entry" | "edit" | "draft" };
type FilterProps = CustomFilterDisplayProps<FilterRow, unknown, PersonnelFilterModel> & {
  kind?: PersonnelFilterModel["kind"];
  rowSortOptions?: readonly { label: string; columnId: string; sort: "asc" | "desc" | null }[];
};

function ValueCheckbox({ checked, mixed = false, onChange, children }: { checked: boolean; mixed?: boolean; onChange: (checked: boolean) => void; children: React.ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="grid-value-option"><input ref={ref} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{children}</label>;
}

type SortDraft = { columnId: string; sort: "asc" | "desc" | null };
const sortKey = (option: SortDraft) => `${option.columnId}:${option.sort ?? "none"}`;

function PersonnelFilter(props: FilterProps) {
  const { root: popupRef, attach: attachPopup } = useGridFilterPopup<HTMLFormElement>();
  const { api, column, colDef, getValue, doesRowPassOtherFilter, onStateChange, state } = props;
  const kind = props.kind ?? "text";
  const empty: PersonnelFilterModel = { filterType: "personnel", kind, values: null, conditions: [], operator: "AND" };
  const model = state.model ?? empty;
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [sortDraft, setSortDraft] = useState<SortDraft | null>(null);
  const [keepOtherSorts, setKeepOtherSorts] = useState(false);
  const [conditionsOpen, setConditionsOpen] = useState(model.conditions.length > 0);
  const searchInput = useRef<HTMLInputElement>(null);
  const sortedColumns = api.getColumnState().filter((item) => item.sort).sort((left, right) => (left.sortIndex ?? 0) - (right.sortIndex ?? 0));
  const columnId = column.getColId();
  const currentSort = sortedColumns.find((item) => item.colId === columnId);
  const appliedSort: SortDraft = props.rowSortOptions
    ? { columnId: sortedColumns[0]?.colId ?? "", sort: sortedColumns[0]?.sort ?? null }
    : { columnId, sort: currentSort?.sort ?? null };
  const selectedSort = sortDraft ?? appliedSort;
  const reportSortKey = props.rowSortOptions?.some(option => sortKey(option) === sortKey(selectedSort)) ? sortKey(selectedSort) : "keep";
  const hasOtherSorts = sortedColumns.some(item => item.colId !== columnId);
  useGridFilterDisplay({ afterGuiAttached: () => {
    attachPopup();
    setSearch(""); setSortDraft(null);
    setKeepOtherSorts(Boolean(currentSort && sortedColumns.length > 1));
    setConditionsOpen(model.conditions.length > 0);
    setRevision((value) => value + 1);
    searchInput.current?.focus({ preventScroll: true });
  } });
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    api.addEventListener("rowDataUpdated", refresh);
    api.addEventListener("filterChanged", refresh);
    api.addEventListener("sortChanged", refresh);
    return () => { if (!api.isDestroyed()) { api.removeEventListener("rowDataUpdated", refresh); api.removeEventListener("filterChanged", refresh); api.removeEventListener("sortChanged", refresh); } };
  }, [api]);
  const values = useMemo(() => {
    const counts = new Map<string, number>();
    api.forEachNode((node) => {
      if (!node.data || node.data.kind !== "entry" || !doesRowPassOtherFilter(node)) return;
      const value = filterValueKey(getValue(node));
      counts.set(value, (counts.get(value) ?? 0) + 1);
    });
    return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => {
      if (!a.value) return b.value ? 1 : 0;
      if (!b.value) return -1;
      return kind === "date" ? filterDateKey(b.value).localeCompare(filterDateKey(a.value)) : kind === "number" ? Number(a.value) - Number(b.value) : compareGridValues(a.value, b.value);
    });
    // revision refreshes values when another column's filter or the row data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, getValue, doesRowPassOtherFilter, kind, revision]);
  const matching = values.filter(({ value }) => normalizeFilterText(value || "(Пустые)").includes(normalizeFilterText(search)));
  const selected = new Set(model.values ?? values.map(({ value }) => value));
  const checkedCount = matching.filter(({ value }) => selected.has(value)).length;
  const selectedCount = values.filter(({ value }) => selected.has(value)).length;
  const update = (patch: Partial<PersonnelFilterModel>) => {
    const next = { ...model, ...patch, kind };
    onStateChange({ model: next.values === null && !next.conditions.length ? null : next,
      valid: next.conditions.every((condition) => isConditionValid(condition, kind)) });
  };
  const setValues = (selection: Set<string>) => update({ values: [...selection] });
  const updateCondition = (index: number, patch: Partial<FilterCondition>) => update({
    conditions: model.conditions.map((condition, current) => current === index ? { ...condition, ...patch } : condition),
  });
  const valid = model.conditions.every((condition) => isConditionValid(condition, kind));
  const operations = kind === "number" ? numberOperations : kind === "date" ? dateOperations : textOperations;
  const matchingValues = matching.map(({ value }) => value);
  const counts = new Map(matching.map(({ value, count }) => [value, count]));
  const preview = useMemo(() => {
    let count = 0;
    let total = 0;
    api.forEachNode((node) => {
      if (node.data?.kind !== "entry" || !doesRowPassOtherFilter(node)) return;
      total++;
      if (matchesPersonnelFilter(getValue(node), model)) count++;
    });
    return { count, total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, getValue, doesRowPassOtherFilter, state.model, revision]);
  const apply = () => {
    if (!valid) return;
    // Commit both controls together. Selecting a sort never closes the filter
    // or reorders the table before the user presses Apply.
    props.onAction("apply");
    if (!sortDraft || api.isDestroyed()) return;
    if (props.rowSortOptions || sortDraft.sort && !keepOtherSorts) {
      api.applyColumnState({ state: sortDraft.columnId ? [{ colId: sortDraft.columnId, sort: sortDraft.sort, sortIndex: 0 }] : [], defaultState: { sort: null, sortIndex: null } });
    } else {
      const sortIndex = sortDraft.sort ? currentSort?.sortIndex ?? sortedColumns.reduce((maximum, item) => Math.max(maximum, item.sortIndex ?? 0), -1) + 1 : null;
      api.applyColumnState({ state: [{ colId: columnId, sort: sortDraft.sort, sortIndex }] });
    }
  };
  const reset = () => {
    onStateChange({ model: null, valid: true });
    setSortDraft({ columnId: props.rowSortOptions ? "" : columnId, sort: null });
    setSearch(""); setConditionsOpen(false);
  };
  return <form ref={popupRef} className="personnel-filter" aria-label={`Настройка фильтра: ${colDef.headerName}`} onSubmit={event => { event.preventDefault(); apply(); }}>
    <header className="grid-filter-heading">
      <div><strong>{colDef.headerName}</strong><span>Сортировка и фильтры</span></div>
      <button type="button" className="grid-filter-close" aria-label="Закрыть без применения" onClick={() => props.onAction("cancel")}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>
    </header>
    <div className="grid-filter-body">
      <section className="grid-filter-sort" aria-label="Сортировка строк">
        <div className="grid-filter-field"><span>Порядок строк</span>{props.rowSortOptions ? <CustomSelect ariaLabel="Порядок строк" value={reportSortKey} onChange={value => {
          const option = props.rowSortOptions?.find(option => sortKey(option) === value);
          setSortDraft(option ?? null);
        }} options={[
          ...(reportSortKey === "keep" ? [{ value: "keep", label: "Сохранить текущую сортировку" }] : []),
          ...props.rowSortOptions.map(option => ({ value: sortKey(option), label: option.label })),
        ]} /> : <CustomSelect ariaLabel="Порядок строк" value={selectedSort.sort ?? "none"} onChange={value => setSortDraft({ columnId, sort: value === "none" ? null : value as "asc" | "desc" })} options={[
          { value: "none", label: "Без сортировки по этой колонке" },
          { value: "asc", label: kind === "date" ? "Сначала ранние даты" : kind === "number" ? "От меньшего к большему" : "По алфавиту: от А до Я" },
          { value: "desc", label: kind === "date" ? "Сначала поздние даты" : kind === "number" ? "От большего к меньшему" : "По алфавиту: от Я до А" },
        ]} />}</div>
        {!props.rowSortOptions && hasOtherSorts && <label className="grid-filter-additive"><input type="checkbox" checked={keepOtherSorts} disabled={!selectedSort.sort} onChange={event => { setKeepOtherSorts(event.target.checked); setSortDraft(selectedSort); }} /><span>Сохранить сортировку других колонок</span></label>}
      </section>
      <section className="grid-filter-choices" aria-label="Выбор значений">
        <div className="grid-filter-section-heading"><strong>Показать значения</strong><span>Выбрано {selectedCount} из {values.length}</span></div>
        <label className="grid-filter-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg><input ref={searchInput} aria-label="Поиск значений" placeholder={kind === "date" ? "Найти дату…" : "Найти в списке…"} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <div className="grid-filter-selection"><ValueCheckbox checked={matching.length > 0 && checkedCount === matching.length} mixed={checkedCount > 0 && checkedCount < matching.length} onChange={(checked) => {
          const next = new Set(selected);
          matching.forEach(({ value }) => { if (checked) next.add(value); else next.delete(value); });
          if (checked && !search) update({ values: null }); else setValues(next);
        }}><span>{search ? "Все найденные" : "Все значения"}</span></ValueCheckbox><button type="button" onClick={() => update({ values: search ? matchingValues : [] })}>{search ? "Только найденные" : "Снять выбор"}</button></div>
        <VirtualChoiceList key={search} items={matchingValues} emptyText={search ? "Ничего не найдено. Попробуйте другой запрос." : "Нет значений с учётом остальных фильтров."} renderItem={(value) => <ValueCheckbox checked={selected.has(value)} onChange={(checked) => { const next = new Set(selected); if (checked) next.add(value); else next.delete(value); setValues(next); }}><span title={value || "(Пустые)"}>{value || "(Пустые)"}</span><small title="Количество строк">{counts.get(value)}</small></ValueCheckbox>} />
        {model.values?.length === 0 && <p className="grid-filter-hint">Ничего не выбрано — строки будут скрыты.</p>}
      </section>
      <details className="grid-filter-conditions" open={conditionsOpen} onToggle={event => setConditionsOpen(event.currentTarget.open)}>
        <summary><span>{kind === "date" ? "Период и условия" : "Дополнительные условия"}</span>{model.conditions.length > 0 && <small>{model.conditions.length}</small>}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg></summary>
        <div className="grid-filter-condition-body">
          <p className="grid-filter-hint">{kind === "date" ? "Выберите период или сравнение с датой. Границы периода включены." : "Уточните выбор: например, по части названия или диапазону чисел."}</p>
          {model.conditions.length > 1 && <div className="grid-filter-join"><span>Показать строки, где</span><CustomSelect ariaLabel="Объединение условий" value={model.operator} onChange={operator => update({ operator: operator as "AND" | "OR" })} options={[{ value: "AND", label: "Выполнены все условия" }, { value: "OR", label: "Выполнено хотя бы одно условие" }]} /></div>}
          {model.conditions.map((condition, index) => <div className="grid-filter-condition" key={index}>
            <div className="grid-filter-condition-operation"><CustomSelect ariaLabel={`Условие ${index + 1}`} value={condition.type} onChange={type => updateCondition(index, { type })} options={operations.map(([value, label]) => ({ value, label }))} /><button type="button" aria-label={`Удалить условие ${index + 1}`} onClick={() => update({ conditions: model.conditions.filter((_, current) => current !== index) })}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button></div>
            {condition.type !== "blank" && condition.type !== "notBlank" && <div className="grid-filter-condition-inputs"><label><span>{condition.type === "inRange" ? "С" : kind === "date" ? "Дата" : "Значение"}</span><input aria-label={`Значение условия ${index + 1}`} type={kind === "date" ? "date" : "text"} inputMode={kind === "number" ? "decimal" : undefined} placeholder={kind === "number" ? "Введите число" : "Введите текст"} value={kind === "date" ? filterDateKey(condition.value) : condition.value} onInput={kind === "date" ? event => updateCondition(index, { value: event.currentTarget.value }) : undefined} onChange={(event) => updateCondition(index, { value: event.target.value })} /></label>{condition.type === "inRange" && <label><span>По</span><input aria-label={`Верхняя граница ${index + 1}`} type={kind === "date" ? "date" : "text"} inputMode={kind === "number" ? "decimal" : undefined} placeholder="Включительно" value={kind === "date" ? filterDateKey(condition.to) : condition.to ?? ""} onInput={kind === "date" ? event => updateCondition(index, { to: event.currentTarget.value }) : undefined} onChange={(event) => updateCondition(index, { to: event.target.value })} /></label>}</div>}
          </div>)}
          {model.conditions.length < 4 && <button className="grid-filter-add" type="button" onClick={() => update({ conditions: [...model.conditions, { type: kind === "date" ? "inRange" : kind === "number" ? "equals" : "contains", value: "" }] })}>+ Добавить условие</button>}
        </div>
      </details>
    </div>
    <footer className="grid-filter-footer">
      <p className={valid ? "grid-filter-preview" : "grid-filter-validation"} role="status">{valid ? <>Будет показано <strong>{preview.count}</strong> из {preview.total} строк</> : kind === "date" ? "Укажите даты. Начало периода должно быть не позже конца." : kind === "number" ? "Укажите числа. Начало диапазона должно быть не больше конца." : "Заполните текст каждого условия."}</p>
      <div><button type="button" className="grid-filter-reset" onClick={reset}>Сбросить</button><button type="button" onClick={() => props.onAction("cancel")}>Отмена</button><button type="submit" className="grid-filter-apply" disabled={!valid}>Применить</button></div>
    </footer>
  </form>;
}

export const personnelColumnFilter: ColumnFilter<FilterRow, unknown, unknown, PersonnelFilterModel> = {
  component: PersonnelFilter,
  doesFilterPass: ({ node, model, handlerParams }) => node.data?.kind !== "entry" || matchesPersonnelFilter(handlerParams.getValue(node), model),
};

export const personnelFilterParams = { buttons: ["apply"], closeOnApply: true, useForm: false };

export function PersonnelFloatingFilter(props: CustomFloatingFilterDisplayProps<FilterRow, unknown, PersonnelFilterModel, { kind?: PersonnelFilterModel["kind"] }>) {
  const kind = props.filterParams?.kind ?? "text";
  const condition = props.model?.conditions.find((item) => item.type === "contains" || item.type === "equals");
  const value = condition?.value ?? "";
  const update = (nextValue: string) => {
    const current = props.model ?? { filterType: "personnel", kind, values: null, conditions: [], operator: "AND" as const };
    const conditions = current.conditions.filter((item) => item !== condition);
    if (nextValue) conditions.unshift({ type: kind === "text" ? "contains" : "equals", value: nextValue });
    props.onModelChange(current.values === null && conditions.length === 0 ? null : { ...current, kind, conditions });
  };
  return <div className="personnel-floating-filter">
    <input aria-label={`Быстрый фильтр: ${props.column.getColDef().headerName ?? props.column.getColId()}`} inputMode={kind === "number" ? "decimal" : "text"} value={value} onChange={(event) => update(event.target.value)} type={kind === "date" ? "date" : "text"} placeholder="Фильтр…" />
    <button type="button" onClick={props.showParentFilter} title="Открыть выбор значений" aria-label={`Открыть расширенный фильтр: ${props.column.getColDef().headerName ?? props.column.getColId()}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg></button>
  </div>;
}

export type SpreadsheetPastePayload<TData> = {
  row: TData;
  rowIndex: number;
  values: Record<string, string>;
  source?: "paste" | "undo";
};

export type SpreadsheetEditPayload<TData> = {
  row: TData;
  rowIndex: number;
  columnId: string;
  initialValue?: string;
};

export type SpreadsheetBatch<TData> = {
  rows: { row?: TData; rowIndex: number; values: Record<string, string> }[];
  source: "paste" | "clear" | "fill";
};

export type SpreadsheetContextPayload<TData> = SpreadsheetEditPayload<TData> & { value: string };

type SpreadsheetPoint = { rowIndex: number; columnId: string; rowId?: string };
type SpreadsheetSelection = { start: SpreadsheetPoint; end: SpreadsheetPoint };
type LocalizedGridProps<TData extends FilterRow> = AgGridReactProps<TData> & {
  onSpreadsheetPaste?: (payload: SpreadsheetPastePayload<TData>) => boolean;
  onSpreadsheetEdit?: (payload: SpreadsheetEditPayload<TData>) => boolean;
  onSpreadsheetCancelEdit?: () => void;
  spreadsheetFocusRequestKey?: number;
  spreadsheetSelectionResetKey?: string;
  getSpreadsheetContextActions?: (payload: SpreadsheetContextPayload<TData>) => TableContextMenuAction[];
  getRowOrderId?: (row: TData) => RowOrderId | undefined;
  rowOrderFixedSorts?: string[];
  rowOrderBlocked?: boolean;
  rowOrderAutoSwitchSort?: boolean;
  onSpreadsheetBatch?: (batch: SpreadsheetBatch<TData>) => boolean;
  canWriteSpreadsheetCell?: (row: TData, columnId: string) => boolean;
  spreadsheetHistory?: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
  enterpriseFilters?: boolean;
  showSortSummary?: boolean;
  spreadsheetToolbar?: boolean;
};

function isInteractiveTarget(event?: Event | null) {
  const target = event?.target;
  return target instanceof Element && Boolean(target.closest("button, input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox'], .actions-cell"));
}

function spreadsheetColumns<TData>(grid: GridApi<TData>) {
  return grid.getAllDisplayedColumns().filter((column) => {
    const columnId = column.getColId();
    return columnId !== "actions" && columnId !== "rowOrder" && columnId !== "ag-Grid-SelectionColumn";
  });
}

function spreadsheetBounds<TData>(grid: GridApi<TData>, current: SpreadsheetSelection | null) {
  if (!current) return null;
  const columns = spreadsheetColumns(grid);
  const startColumn = columns.findIndex((column) => column.getColId() === current.start.columnId);
  const endColumn = columns.findIndex((column) => column.getColId() === current.end.columnId);
  if (startColumn < 0 || endColumn < 0) return null;
  const startRow = spreadsheetPointRowIndex(grid, current.start);
  const endRow = spreadsheetPointRowIndex(grid, current.end);
  if (startRow === null || endRow === null) return null;
  return {
    columns,
    rowStart: Math.min(startRow, endRow),
    rowEnd: Math.max(startRow, endRow),
    columnStart: Math.min(startColumn, endColumn),
    columnEnd: Math.max(startColumn, endColumn),
  };
}

export function LocalizedGrid<TData extends FilterRow>({ onSpreadsheetPaste: suppliedPaste, onSpreadsheetEdit: suppliedEdit, onSpreadsheetCancelEdit, spreadsheetFocusRequestKey = 0, spreadsheetSelectionResetKey = "", getSpreadsheetContextActions, getRowOrderId = gridRowEntityId, rowOrderFixedSorts, rowOrderBlocked = false, rowOrderAutoSwitchSort = false, onSpreadsheetBatch: suppliedBatch, canWriteSpreadsheetCell, spreadsheetHistory: suppliedHistory, enterpriseFilters = true, showSortSummary = true, spreadsheetToolbar = true, popupParent: requestedPopupParent, ...props }: LocalizedGridProps<TData>) {
  const access = useWorkspaceAccess();
  const onSpreadsheetPaste = access?.edit === false ? undefined : suppliedPaste;
  const onSpreadsheetEdit = access?.edit === false ? undefined : suppliedEdit;
  const onSpreadsheetBatch = access?.edit === false ? undefined : suppliedBatch;
  const spreadsheetHistory = access?.edit === false ? undefined : suppliedHistory;
  useEffect(() => {
    if (access?.edit !== false || !onSpreadsheetCancelEdit) return;
    const frame = requestAnimationFrame(onSpreadsheetCancelEdit);
    return () => cancelAnimationFrame(frame);
  }, [access?.edit, onSpreadsheetCancelEdit]);
  const [api, setApi] = useState<GridApi<TData> | null>(null);
  // Popups use the viewport, including when the table itself has only a few rows.
  const [popupParent] = useState(() => typeof document === "undefined" ? undefined : document.body);
  const [summary, setSummary] = useState<{
    count: number;
    total: number;
    filters: { id: string; name: string; description: string }[];
    sorts: { id: string; name: string; direction: "asc" | "desc"; priority: number }[];
  }>({ count: 0, total: 0, filters: [], sorts: [] });
  const rowOrder = useWorkspaceTableOrder();
  const rowMoveDisabled = rowMoveIsBlocked({ editing: rowOrderBlocked, loading: Boolean(props.loading), filtered: summary.filters.length > 0,
    sorted: summary.sorts.some((sort) => !rowOrderFixedSorts?.includes(sort.id)), switchSort: rowOrderAutoSwitchSort, hasDraftRows: (props.rowData ?? []).some((row) => row.kind !== "entry") });
  const finishRowMove = useCallback(async (operation: Parameters<NonNullable<typeof rowOrder>["move"]>[0]) => {
    if (!rowOrder) return false;
    if (rowOrderAutoSwitchSort && api && !api.isDestroyed() && api.getColumnState().some((column) => column.sort)) {
      const displayedIds: RowOrderId[] = [];
      api.forEachNodeAfterFilterAndSort((node) => { const id = node.data && getRowOrderId(node.data); if (id) displayedIds.push(id); });
      operation = { ...operation, displayedIds: [...new Set(displayedIds)] };
    }
    return saveManualRowMove(operation, rowOrder.move, () => {
      if (rowOrderAutoSwitchSort && api && !api.isDestroyed()) api.applyColumnState({ state: api.getColumnState().filter(column => rowOrderFixedSorts?.includes(column.colId)), defaultState: { sort: null, sortIndex: null } });
    });
  }, [api, rowOrder, rowOrderAutoSwitchSort, rowOrderFixedSorts, getRowOrderId]);
  const effectiveRowOrder = useMemo(() => rowOrder ? { ...rowOrder, move: finishRowMove } : null, [rowOrder, finishRowMove]);
  const rowMoves = useRowMoveActions(effectiveRowOrder, rowMoveDisabled);
  const rowSelection = useMemo(() => gridRowSelection<TData>({ supplied: props.rowSelection, canSelect: access?.select !== false,
    canReorder: Boolean(rowOrder?.canWrite), isOrderable: row => row.kind === "entry" && getRowOrderId(row) !== undefined,
  }), [props.rowSelection, access?.select, rowOrder?.canWrite, getRowOrderId]);
  const selectionDrag = Boolean(rowSelection) && Boolean(rowOrder?.canWrite);
  const canDragSelection = useCallback(() => !rowMoveDisabled && !rowOrder?.busy && Boolean(rowOrder?.canWrite), [rowMoveDisabled, rowOrder?.busy, rowOrder?.canWrite]);
  // Keep the renderer in the definition from the first render. AG Grid can create
  // the selection column later, when asynchronous reorder permissions arrive.
  const selectionColumnDef = useMemo(() => ({
    width: 44, minWidth: 44, maxWidth: 44, pinned: "left" as const, lockPinned: true, lockPosition: "left" as const, resizable: false,
    ...props.selectionColumnDef,
    cellRenderer: SelectionRowDragRenderer,
    cellRendererParams: { canDrag: canDragSelection },
  }), [props.selectionColumnDef, canDragSelection]);
  const hasSavedRowOrder = rowOrder?.hasSavedOrder ?? false;
  useEffect(() => {
    // Reopening a report must not let the default hidden activity sort undo a saved manual order.
    if (rowOrderAutoSwitchSort && hasSavedRowOrder && api && !api.isDestroyed()) api.applyColumnState({ state: api.getColumnState().filter(column => rowOrderFixedSorts?.includes(column.colId)), defaultState: { sort: null, sortIndex: null } });
  }, [api, rowOrderAutoSwitchSort, rowOrderFixedSorts, hasSavedRowOrder]);
  const orderedRowData = useMemo(() => rowOrder ? rowOrder.order(props.rowData ?? [], getRowOrderId) : props.rowData, [props.rowData, rowOrder, getRowOrderId]);
  const sourceColumns = props.columnDefs;
  const baseFilter = props.defaultColDef?.filter;
  const baseFilterParams = props.defaultColDef?.filterParams;
  const nativeFilters = Boolean(enterpriseFilters && api?.isModuleRegistered("MultiFilterModule") && api.isModuleRegistered("SetFilterModule"));
  const orderedColumns = useMemo(() => {
    const enhanceColumn = (definition: ColDef<TData> | ColGroupDef<TData>): ColDef<TData> | ColGroupDef<TData> => {
      if ("children" in definition) return { ...definition, children: definition.children.map(enhanceColumn) };
      let column = definition;
      if (nativeFilters && (column.filter ?? baseFilter) === personnelColumnFilter) {
        const localParams = column.filterParams;
        column = { ...column, cellDataType: false, filter: "agMultiColumnFilter", filterParams: (params: IFilterParams) => {
          const options = {
            ...(typeof baseFilterParams === "function" ? baseFilterParams(params) : baseFilterParams),
            ...(typeof localParams === "function" ? localParams(params) : localParams),
          } as EnterpriseFilterOptions;
          return enterpriseFilterParams(params, options);
        } };
      }
      return column.colId === "number" || column.field === "number" ? { ...column, valueGetter: (params: { node?: { rowIndex: number | null } | null }) => typeof params.node?.rowIndex === "number" ? params.node.rowIndex + 1 : "" } : column;
    };
    return (sourceColumns ?? []).map(enhanceColumn);
  }, [sourceColumns, baseFilter, baseFilterParams, nativeFilters]);
  const previousEditState = useRef<{ api: GridApi<TData>; rows: Set<string>; blocked: boolean } | null>(null);
  const { rowData: sourceRows, getRowId: sourceGetRowId, context: sourceContext } = props;
  useEffect(() => {
    if (!api || api.isDestroyed() || !nativeFilters) return;
    const rows = new Set((sourceRows ?? []).flatMap((row, index) => row.kind === "entry" ? [] : [
      `${row.kind}:${sourceGetRowId?.({ data: row, api, context: sourceContext, level: 0, parentKeys: undefined }) ?? index}`,
    ]));
    const previous = previousEditState.current?.api === api ? previousEditState.current : null;
    previousEditState.current = { api, rows, blocked: rowOrderBlocked };
    // Native filters evaluate drafts just like saved rows. Clear only when an
    // editor opens or new draft rows appear, so a blank draft stays accessible.
    // Ordinary refreshes and typing in an existing draft keep the user's filter.
    const startedEditing = rowOrderBlocked && !previous?.blocked || [...rows].some(key => !previous?.rows.has(key));
    if (startedEditing && api.isAnyFilterPresent()) api.setFilterModel(null);
  }, [api, nativeFilters, sourceRows, sourceGetRowId, sourceContext, rowOrderBlocked]);
  const [selection, setSelection] = useState<SpreadsheetSelection | null>(null);
  const [spreadsheetStatus, setSpreadsheetStatus] = useState("");
  const [contextMenu, setContextMenu] = useState<(SpreadsheetContextPayload<TData> & { x: number; y: number; error: string }) | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const selectionRef = useRef(selection);
  const lastSelectionRef = useRef(selection);
  const previousFocusRequestKey = useRef(spreadsheetFocusRequestKey);
  const dragging = useRef(false);
  const undoStack = useRef<SpreadsheetPastePayload<TData>[][]>([]);
  const undoing = useRef(false);
  const rememberUndo = useCallback((changes: SpreadsheetPastePayload<TData>[]) => {
    if (!changes.length) return;
    undoStack.current = [...undoStack.current.slice(-49), changes.map((change) => ({ ...change, values: { ...change.values } }))];
  }, []);
  const updateSummary = useCallback((grid: GridApi<TData>) => {
    let count = 0, total = 0;
    grid.forEachNode((node: IRowNode<TData>) => { if (node.data?.kind === "entry") total++; });
    grid.forEachNodeAfterFilter((node: IRowNode<TData>) => { if (node.data?.kind === "entry") count++; });
    const filters = Object.entries(grid.getFilterModel()).map(([id, model]) => ({ id, name: grid.getColumnDef(id)?.headerName ?? id, description: describeGridFilter(model) }));
    const sorts = grid.getColumnState().filter((state): state is typeof state & { sort: "asc" | "desc" } => state.sort === "asc" || state.sort === "desc")
      .sort((left, right) => (left.sortIndex ?? 0) - (right.sortIndex ?? 0))
      .map((state, index) => ({ id: state.colId, name: grid.getColumnDef(state.colId)?.headerName ?? state.colId, direction: state.sort, priority: index + 1 }));
    setSummary({ count, total, filters, sorts });
  }, [setSummary]);
  const sourceDefaultColDef = props.defaultColDef;
  const enhancedDefaultColDef = useMemo<ColDef<TData>>(() => ({
    ...sourceDefaultColDef,
    comparator: sourceDefaultColDef?.comparator ?? compareGridValues,
    // AG Grid receives native keydown before React: leave editing keys to inputs.
    suppressKeyboardEvent: (params) => Boolean(onSpreadsheetBatch) || isInteractiveTarget(params.event) || Boolean(sourceDefaultColDef?.suppressKeyboardEvent?.(params)),
  }), [sourceDefaultColDef, onSpreadsheetBatch]);
  const paintSelection = useCallback((grid: GridApi<TData>) => {
    requestAnimationFrame(() => {
      const root = body.current;
      if (!root) return;
      root.querySelectorAll(".ag-excel-selected,.ag-excel-top,.ag-excel-right,.ag-excel-bottom,.ag-excel-left").forEach((cell) => cell.classList.remove("ag-excel-selected", "ag-excel-top", "ag-excel-right", "ag-excel-bottom", "ag-excel-left"));
      const bounds = spreadsheetBounds(grid, selectionRef.current);
      if (!bounds) return;
      root.querySelectorAll<HTMLElement>(".ag-cell[col-id]").forEach((cell) => {
        const row = Number(cell.closest(".ag-row")?.getAttribute("row-index"));
        const column = bounds.columns.findIndex((item) => item.getColId() === cell.getAttribute("col-id"));
        if (row < bounds.rowStart || row > bounds.rowEnd || column < bounds.columnStart || column > bounds.columnEnd) return;
        cell.classList.add("ag-excel-selected");
        if (row === bounds.rowStart) cell.classList.add("ag-excel-top");
        if (row === bounds.rowEnd) cell.classList.add("ag-excel-bottom");
        if (column === bounds.columnStart) cell.classList.add("ag-excel-left");
        if (column === bounds.columnEnd) cell.classList.add("ag-excel-right");
      });
    });
  }, []);
  useEffect(() => {
    const finishDrag = () => { dragging.current = false; };
    window.addEventListener("pointerup", finishDrag);
    return () => window.removeEventListener("pointerup", finishDrag);
  }, []);
  useEffect(() => {
    // Event handlers update the ref synchronously; a delayed effect must not
    // overwrite a newer click just before a paste.
    if (api) paintSelection(api);
  }, [api, paintSelection, selection]);
  useEffect(() => {
    if (previousFocusRequestKey.current === spreadsheetFocusRequestKey) return;
    previousFocusRequestKey.current = spreadsheetFocusRequestKey;
    const selectionToRestore = lastSelectionRef.current;
    if (selectionToRestore) {
      selectionRef.current = selectionToRestore;
      setSelection(selectionToRestore);
    }
    const frame = requestAnimationFrame(() => body.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [spreadsheetFocusRequestKey]);
  useEffect(() => {
    if (!spreadsheetStatus) return;
    const timeout = window.setTimeout(() => setSpreadsheetStatus(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [spreadsheetStatus]);
  const selectCell = useCallback((event: CellMouseDownEvent<TData>) => {
    if (onSpreadsheetBatch) return; // Enhanced tables select synchronously on pointerdown.
    if (event.rowIndex === null || isStructuralSpreadsheetRow(event.node) || ["actions", "rowOrder", "ag-Grid-SelectionColumn"].includes(event.column.getColId()) || isInteractiveTarget(event.event)) return;
    const point = { rowIndex: event.rowIndex, columnId: event.column.getColId(), rowId: event.node.id };
    const mouseEvent = event.event as MouseEvent | undefined;
    if (mouseEvent?.button === 2 && onSpreadsheetBatch) return;
    const start = mouseEvent?.shiftKey && selectionRef.current ? selectionRef.current.start : point;
    dragging.current = true;
    const next = { start, end: point };
    selectionRef.current = next;
    lastSelectionRef.current = next;
    setSelection(next);
    body.current?.focus({ preventScroll: true });
  }, [onSpreadsheetBatch]);
  const extendSelection = useCallback((event: CellMouseOverEvent<TData>) => {
    if (!dragging.current || event.rowIndex === null || isStructuralSpreadsheetRow(event.node) || ["actions", "rowOrder", "ag-Grid-SelectionColumn"].includes(event.column.getColId()) || !selectionRef.current) return;
    const next = { start: selectionRef.current.start, end: { rowIndex: event.rowIndex, columnId: event.column.getColId(), rowId: event.node.id } };
    selectionRef.current = next;
    lastSelectionRef.current = next;
    setSelection(next);
  }, []);
  const clearSelection = useCallback(() => {
    dragging.current = false;
    selectionRef.current = null;
    setSelection(null);
    setSpreadsheetStatus("");
    setContextMenu(null);
  }, []);
  const moveSelection = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!api || isInteractiveTarget(event.nativeEvent) || event.altKey) return false;
    if ((event.ctrlKey || event.metaKey) && (!onSpreadsheetBatch || !event.key.startsWith("Arrow"))) return false;
    const movement = {
      ArrowLeft: { row: 0, column: -1 },
      ArrowRight: { row: 0, column: 1 },
      ArrowUp: { row: -1, column: 0 },
      ArrowDown: { row: 1, column: 0 },
      ...(onSpreadsheetBatch ? { Tab: { row: 0, column: event.shiftKey ? -1 : 1 }, Home: { row: 0, column: -Infinity }, End: { row: 0, column: Infinity } } : {}),
    }[event.key];
    if (!movement) return false;
    const columns = spreadsheetColumns(api);
    const rowCount = api.getDisplayedRowCount();
    if (!columns.length || !rowCount) return false;
    const current = selectionRef.current?.end;
    const currentRowIndex = current?.rowId ? api.getRowNode(current.rowId)?.rowIndex ?? current.rowIndex : current?.rowIndex;
    const currentColumnIndex = current ? columns.findIndex((column) => column.getColId() === current.columnId) : -1;
    const rowIndex = current && currentRowIndex !== undefined
      ? Math.max(0, Math.min(rowCount - 1, currentRowIndex + movement.row))
      : 0;
    const columnIndex = current
      ? Math.max(0, Math.min(columns.length - 1, Math.max(0, currentColumnIndex) + movement.column))
      : 0;
    const edge = event.ctrlKey || event.metaKey;
    const targetRowIndex = edge && movement.row ? movement.row < 0 ? 0 : rowCount - 1 : rowIndex;
    const searchDirection = edge && movement.row ? movement.row < 0 ? 1 : -1 : movement.row < 0 ? -1 : 1;
    const nextRowIndex = findSpreadsheetDataRowIndex(api, targetRowIndex, searchDirection);
    if (nextRowIndex === null) { event.preventDefault(); return true; }
    const nextColumnIndex = edge && movement.column ? movement.column < 0 ? 0 : columns.length - 1 : columnIndex;
    const point = { rowIndex: nextRowIndex, columnId: columns[nextColumnIndex].getColId(), rowId: api.getDisplayedRowAtIndex(nextRowIndex)?.id };
    const next = {
      start: event.shiftKey && event.key !== "Tab" && selectionRef.current ? selectionRef.current.start : point,
      end: point,
    };
    event.preventDefault();
    dragging.current = false;
    selectionRef.current = next;
    lastSelectionRef.current = next;
    setSelection(next);
    api.ensureIndexVisible(nextRowIndex);
    api.ensureColumnVisible(columns[nextColumnIndex]);
    body.current?.focus({ preventScroll: true });
    return true;
  }, [api, onSpreadsheetBatch]);
  const clearSelectionOnEmptySpace = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".ag-row, .ag-header, .ag-filter, .ag-popup")) return;
    clearSelection();
  }, [clearSelection]);
  useEffect(() => {
    const selectionAtReset = selectionRef.current;
    const frame = requestAnimationFrame(() => {
      // A click after new rows render takes precedence over a scheduled reset.
      if (selectionRef.current === selectionAtReset) clearSelection();
    });
    return () => cancelAnimationFrame(frame);
  }, [clearSelection, spreadsheetSelectionResetKey]);
  useEffect(() => {
    const clearSelectionOutsideGrid = (event: PointerEvent) => {
      const target = event.target;
      if (!selectionRef.current || !(target instanceof Node) || body.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".custom-select-menu,.ag-employee-menu,.table-context-menu,.personnel-spreadsheet-tools")) return;
      clearSelection();
    };
    document.addEventListener("pointerdown", clearSelectionOutsideGrid);
    return () => document.removeEventListener("pointerdown", clearSelectionOutsideGrid);
  }, [clearSelection]);
  const selectedText = useCallback(() => {
    if (!api || !selectionRef.current) return;
    const bounds = spreadsheetBounds(api, selectionRef.current);
    if (!bounds) return "";
    const lines: string[][] = [];
    for (let rowIndex = bounds.rowStart; rowIndex <= bounds.rowEnd; rowIndex++) {
      const rowNode = api.getDisplayedRowAtIndex(rowIndex);
      if (!rowNode?.data) continue;
      lines.push(bounds.columns.slice(bounds.columnStart, bounds.columnEnd + 1).map((column) => String(api.getCellValue({ rowNode, colKey: column, useFormatter: true }) ?? "")));
    }
    return onSpreadsheetBatch ? serializeSpreadsheetText(lines) : lines.map(row => row.map(value => value.replaceAll("\t", " ").replaceAll(/\r?\n/g, " ")).join("\t")).join("\n");
  }, [api, onSpreadsheetBatch]);
  const copySelection = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.nativeEvent)) return;
    const text = selectedText();
    if (text === undefined) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    const bounds = api ? spreadsheetBounds(api, selectionRef.current) : null;
    if (!bounds) return;
    let copiedRows = 0;
    for (let index = bounds.rowStart; index <= bounds.rowEnd; index++) if (api?.getDisplayedRowAtIndex(index)?.data) copiedRows++;
    setSpreadsheetStatus(`Скопировано: ${copiedRows} × ${bounds.columnEnd - bounds.columnStart + 1}`);
  }, [api, selectedText]);
  const previousCellValues = useCallback((rowNode: IRowNode<TData>, columns: { getColId: () => string }[]) => Object.fromEntries(columns.flatMap((column) => {
    const columnId = column.getColId();
    if (columnId === "number" || columnId === "actions" || columnId === "rowOrder") return [];
    return [[columnId, String(api?.getCellValue({ rowNode, colKey: columnId, useFormatter: true }) ?? "")]];
  })), [api]);
  const rememberCellUndo = useCallback((rowIndex: number, columnId: string) => {
    if (spreadsheetHistory || !api || !onSpreadsheetPaste || columnId === "number" || columnId === "actions" || columnId === "rowOrder") return;
    const rowNode = api.getDisplayedRowAtIndex(rowIndex);
    const column = api.getColumn(columnId);
    if (!rowNode?.data || !column) return;
    rememberUndo([{ row: rowNode.data, rowIndex, values: previousCellValues(rowNode, [column]) }]);
  }, [api, onSpreadsheetPaste, previousCellValues, rememberUndo, spreadsheetHistory]);
  const pasteText = useCallback((text: string) => {
    if (!api || (!onSpreadsheetPaste && !onSpreadsheetBatch) || !selectionRef.current) return false;
    const bounds = spreadsheetBounds(api, selectionRef.current);
    if (!bounds) return false;
    const matrix = parseSpreadsheetText(text);
    if (!matrix.length) return false;
    const sourceRows = matrix.length;
    const sourceColumns = matrix.reduce((maximum, line) => Math.max(maximum, line.length), 0);
    const selectedRows = bounds.rowEnd - bounds.rowStart + 1;
    const selectedColumns = bounds.columnEnd - bounds.columnStart + 1;
    const targetRows = onSpreadsheetBatch && selectedRows >= sourceRows && selectedRows % sourceRows === 0 ? selectedRows : sourceRows === 1 ? selectedRows : sourceRows;
    const targetColumns = onSpreadsheetBatch && selectedColumns >= sourceColumns && selectedColumns % sourceColumns === 0 ? selectedColumns : sourceColumns === 1 ? selectedColumns : sourceColumns;
    if (onSpreadsheetBatch && targetRows > 1000) { setSpreadsheetStatus("За один раз можно вставить не более 1000 строк"); return false; }
    if (spreadsheetRangeHasStructuralRows(api, bounds.rowStart, bounds.rowStart + targetRows - 1)) {
      setSpreadsheetStatus("Вставляйте данные внутри одной даты, не захватывая заголовки дат");
      return false;
    }
    let changed = 0;
    const undoChanges: SpreadsheetPastePayload<TData>[] = [];
    const batchRows: SpreadsheetBatch<TData>["rows"] = [];
    for (let offset = 0; offset < targetRows; offset++) {
      const rowIndex = bounds.rowStart + offset;
      const rowNode = api.getDisplayedRowAtIndex(rowIndex);
      if (!rowNode?.data && !onSpreadsheetBatch) continue;
      const values: Record<string, string> = {};
      for (let index = 0; index < targetColumns; index++) {
        const column = bounds.columns[bounds.columnStart + index];
        const columnId = column?.getColId();
        if (columnId && columnId !== "number" && columnId !== "actions" && columnId !== "rowOrder") values[columnId] = matrix[offset % sourceRows]?.[index % sourceColumns] ?? "";
      }
      const columns = bounds.columns.filter((column) => Object.hasOwn(values, column.getColId()));
      if (onSpreadsheetBatch) { batchRows.push({ row: rowNode?.data, rowIndex, values }); continue; }
      if (!rowNode?.data) continue;
      const previousValues = previousCellValues(rowNode, columns);
      if (Object.keys(values).length && onSpreadsheetPaste?.({ row: rowNode.data, rowIndex, values })) {
        changed++;
        undoChanges.push({ row: rowNode.data, rowIndex, values: previousValues });
      }
    }
    if (onSpreadsheetBatch) {
      const applied = onSpreadsheetBatch({ rows: batchRows, source: "paste" });
      if (applied) { setSpreadsheetStatus(`Вставлен диапазон: ${targetRows} × ${targetColumns}`); body.current?.focus({ preventScroll: true }); }
      return applied;
    }
    if (!changed) {
      setSpreadsheetStatus("В выбранных ячейках нет доступных для редактирования полей");
      return false;
    }
    rememberUndo(undoChanges);
    // Draft rows intentionally keep stable objects while a person types so AG Grid
    // does not recreate an active editor. A paste updates React state outside the
    // grid, therefore explicitly repaint after that state has been committed.
    requestAnimationFrame(() => {
      if (api.isDestroyed()) return;
      api.refreshClientSideRowModel("everything");
      api.refreshCells({ force: true });
      api.redrawRows();
    });
    setSpreadsheetStatus(`Вставлено строк: ${changed}`);
    return true;
  }, [api, onSpreadsheetPaste, onSpreadsheetBatch, previousCellValues, rememberUndo]);

  const changeRange = useCallback((operation: "clear" | "down" | "right", requireAllWritable = false) => {
    if (!api || !onSpreadsheetBatch) return false;
    const bounds = spreadsheetBounds(api, selectionRef.current);
    if (!bounds) return false;
    if (spreadsheetRangeHasStructuralRows(api, bounds.rowStart, bounds.rowEnd)) {
      setSpreadsheetStatus("Выделите ячейки внутри одной даты, не захватывая заголовки дат");
      return false;
    }
    const changes: SpreadsheetBatch<TData>["rows"] = [];
    for (let rowIndex = bounds.rowStart; rowIndex <= bounds.rowEnd; rowIndex++) {
      const node = api.getDisplayedRowAtIndex(rowIndex);
      if (!node?.data) continue;
      const values: Record<string, string> = {};
      for (let index = bounds.columnStart; index <= bounds.columnEnd; index++) {
        const columnId = bounds.columns[index].getColId();
        if (operation === "down" && rowIndex === bounds.rowStart || operation === "right" && index === bounds.columnStart) continue;
        if (requireAllWritable && !canWriteSpreadsheetCell?.(node.data, columnId)) { setSpreadsheetStatus("Выделение содержит ячейки, доступные только для просмотра"); return false; }
        const sourceNode = operation === "down" ? api.getDisplayedRowAtIndex(bounds.rowStart) : node;
        const sourceColumn = operation === "right" ? bounds.columns[bounds.columnStart].getColId() : columnId;
        values[columnId] = operation === "clear" ? "" : String(sourceNode ? api.getCellValue({ rowNode: sourceNode, colKey: sourceColumn, useFormatter: true }) ?? "" : "");
      }
      if (Object.keys(values).length) changes.push({ row: node.data, rowIndex, values });
    }
    const applied = onSpreadsheetBatch({ rows: changes, source: operation === "clear" ? "clear" : "fill" });
    if (applied) setSpreadsheetStatus(operation === "clear" ? "Выделенные ячейки очищены" : "Выделенный диапазон заполнен");
    return applied;
  }, [api, onSpreadsheetBatch, canWriteSpreadsheetCell]);
  const pasteSelection = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.nativeEvent)) return;
    event.preventDefault();
    pasteText(event.clipboardData.getData("text/plain"));
  }, [pasteText]);

  const openContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("button, input, textarea, select, [role='combobox'], .actions-cell") || !api) return;
    const cell = target.closest<HTMLElement>(".ag-cell[col-id]");
    const rowElement = cell?.closest<HTMLElement>(".ag-row[row-index]");
    const columnId = cell?.getAttribute("col-id");
    const rowIndex = Number(rowElement?.getAttribute("row-index"));
    const rowNode = Number.isInteger(rowIndex) ? api.getDisplayedRowAtIndex(rowIndex) : null;
    if (!cell || !columnId || columnId === "actions" || columnId === "ag-Grid-SelectionColumn" || !rowNode?.data) return;
    event.preventDefault();
    const point = { rowIndex, columnId, rowId: rowNode.id };
    const existing = spreadsheetBounds(api, selectionRef.current);
    const clickedColumn = existing?.columns.findIndex(column => column.getColId() === columnId) ?? -1;
    const inside = onSpreadsheetBatch && existing && rowIndex >= existing.rowStart && rowIndex <= existing.rowEnd && clickedColumn >= existing.columnStart && clickedColumn <= existing.columnEnd;
    const next = inside ? selectionRef.current! : { start: point, end: point };
    selectionRef.current = next;
    lastSelectionRef.current = next;
    setSelection(next);
    body.current?.focus({ preventScroll: true });
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 256)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 490)),
      row: rowNode.data,
      rowIndex,
      columnId,
      value: String(api.getCellValue({ rowNode, colKey: columnId, useFormatter: true }) ?? ""),
      error: "",
    });
  }, [api, onSpreadsheetBatch]);
  const editSelectedCell = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!api || !onSpreadsheetEdit || !selectionRef.current || isInteractiveTarget(event.nativeEvent)) return;
    const bounds = spreadsheetBounds(api, selectionRef.current);
    if (!bounds || bounds.rowStart !== bounds.rowEnd || bounds.columnStart !== bounds.columnEnd) return;
    const rowNode = api.getDisplayedRowAtIndex(bounds.rowStart);
    const columnId = bounds.columns[bounds.columnStart]?.getColId();
    if (!rowNode?.data || !columnId || !onSpreadsheetEdit({ row: rowNode.data, rowIndex: bounds.rowStart, columnId })) return;
    rememberCellUndo(bounds.rowStart, columnId);
    event.preventDefault();
    setSpreadsheetStatus("Редактирование ячейки");
  }, [api, onSpreadsheetEdit, rememberCellUndo]);
  const undoSpreadsheetChange = useCallback(() => {
    if (spreadsheetHistory) { onSpreadsheetCancelEdit?.(); spreadsheetHistory.undo(); return true; }
    if (undoing.current) return true;
    const changes = undoStack.current.pop();
    if (!changes?.length || !onSpreadsheetPaste) {
      setSpreadsheetStatus("Нет изменений для отмены");
      return true;
    }
    undoing.current = true;
    let changed = 0;
    try {
      for (const change of changes) if (onSpreadsheetPaste({ ...change, source: "undo" })) changed++;
      if (changed && api) requestAnimationFrame(() => {
        if (api.isDestroyed()) return;
        api.refreshClientSideRowModel("everything");
        api.refreshCells({ force: true });
        api.redrawRows();
      });
      setSpreadsheetStatus(changed ? `Отменено изменений: ${changed}` : "Не удалось отменить изменение");
    } catch {
      undoStack.current.push(changes);
      setSpreadsheetStatus("Не удалось отменить изменение");
    } finally {
      undoing.current = false;
    }
    return true;
  }, [api, onSpreadsheetPaste, onSpreadsheetCancelEdit, spreadsheetHistory]);
  useEffect(() => {
    const undoOutsideGrid = (event: KeyboardEvent) => {
      const target = event.target;
      const undoShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && (event.code === "KeyZ" || event.key.toLocaleLowerCase("en-US") === "z");
      if (spreadsheetHistory || !undoShortcut || isInteractiveTarget(event) || !undoStack.current.length || (target instanceof Node && body.current?.contains(target))) return;
      event.preventDefault();
      undoSpreadsheetChange();
    };
    document.addEventListener("keydown", undoOutsideGrid);
    return () => document.removeEventListener("keydown", undoOutsideGrid);
  }, [undoSpreadsheetChange, spreadsheetHistory]);
  const handleSpreadsheetKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.nativeEvent)) return;
    if (onSpreadsheetBatch) {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.code === "KeyA" && api) {
        const columns = spreadsheetColumns(api);
        const last = api.getDisplayedRowCount() - 1;
        if (columns.length && last >= 0) {
          event.preventDefault();
          const next = { start: { rowIndex: 0, rowId: api.getDisplayedRowAtIndex(0)?.id, columnId: columns[0].getColId() }, end: { rowIndex: last, rowId: api.getDisplayedRowAtIndex(last)?.id, columnId: columns.at(-1)!.getColId() } };
          selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
        }
        return;
      }
      if (modifier && (event.code === "KeyY" || event.code === "KeyZ" && event.shiftKey)) { event.preventDefault(); onSpreadsheetCancelEdit?.(); spreadsheetHistory?.redo(); return; }
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); changeRange("clear"); return; }
      if (modifier && (event.code === "KeyD" || event.code === "KeyR")) { event.preventDefault(); changeRange(event.code === "KeyD" ? "down" : "right"); return; }
      if (!modifier && !event.altKey && event.key.length === 1 && !event.nativeEvent.isComposing && api && selectionRef.current) {
        const point = selectionRef.current.start;
        const node = point.rowId ? api.getRowNode(point.rowId) : api.getDisplayedRowAtIndex(point.rowIndex);
        if (node?.data && onSpreadsheetEdit?.({ row: node.data, rowIndex: node.rowIndex ?? point.rowIndex, columnId: point.columnId, initialValue: event.key })) { event.preventDefault(); return; }
      }
    }
    const undoShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && (event.code === "KeyZ" || event.key.toLocaleLowerCase("en-US") === "z");
    if (undoShortcut) { event.preventDefault(); undoSpreadsheetChange(); return; }
    if (event.key === "Escape") { event.preventDefault(); onSpreadsheetCancelEdit?.(); clearSelection(); return; }
    if (moveSelection(event)) return;
    if (event.key === "Enter" || event.key === "F2") editSelectedCell(event);
  };
  return <div className="localized-grid">
    {spreadsheetToolbar && onSpreadsheetBatch && <div className="personnel-spreadsheet-tools" onPointerDown={event => event.preventDefault()}><div><button type="button" disabled={!spreadsheetHistory?.canUndo} onClick={() => spreadsheetHistory?.undo()} title="Ctrl+Z / ⌘Z">↶ Отменить</button><button type="button" disabled={!spreadsheetHistory?.canRedo} onClick={() => spreadsheetHistory?.redo()} title="Ctrl+Shift+Z / ⌘⇧Z">↷ Повторить</button><button type="button" onClick={() => changeRange("down")} title="Ctrl+D / ⌘D">Заполнить вниз</button><button type="button" onClick={() => changeRange("right")} title="Ctrl+R / ⌘R">Заполнить вправо</button><button type="button" onClick={() => changeRange("clear")} title="Delete / Backspace">Очистить</button></div><span role="status">{spreadsheetStatus || "Выделите диапазон · Ctrl/⌘ C, X, V · Shift + стрелки"}</span></div>}
    {rowMoves.feedback}
    {(summary.filters.length > 0 || showSortSummary && summary.sorts.length > 0) && <div className="grid-filter-summary" aria-label={showSortSummary ? "Активные фильтры и сортировка" : "Активные фильтры"}>
      <span aria-live="polite">Строк: <b>{summary.count}</b> из {summary.total}</span>
      <div className="grid-filter-chips">
        {summary.filters.map((filter) => <button key={`filter-${filter.id}`} type="button" title={`${filter.name}: ${filter.description}. Нажмите для сброса.`} aria-label={`Сбросить фильтр: ${filter.name}`} onClick={async () => { if (api) { await api.setColumnFilterModel(filter.id, null); api.onFilterChanged(); } }}><span>{filter.name}: {filter.description}</span><span aria-hidden="true">×</span></button>)}
        {showSortSummary && summary.sorts.map((sort) => <button className="grid-sort-chip" key={`sort-${sort.id}`} type="button" title={`Сортировка по столбцу «${sort.name}». Нажмите для сброса.`} aria-label={`Сбросить сортировку: ${sort.name}`} onClick={() => api?.applyColumnState({ state: [{ colId: sort.id, sort: null, sortIndex: null }] })}><span>{summary.sorts.length > 1 ? `${sort.priority}. ` : ""}{sort.name} {sort.direction === "asc" ? "↑" : "↓"}</span><span aria-hidden="true">×</span></button>)}
      </div>
      <button className="grid-filter-clear" type="button" onClick={() => { api?.setFilterModel(null); if (showSortSummary) api?.applyColumnState({ state: [], defaultState: { sort: null, sortIndex: null } }); }}>{showSortSummary ? "Сбросить всё" : "Сбросить фильтры"}</button>
    </div>}
    <div className="localized-grid-body" ref={body} role="grid" tabIndex={0} onContextMenu={openContextMenu} onPointerDownCapture={(event) => {
      const target = event.target;
      if (onSpreadsheetBatch && api && target instanceof Element && !isInteractiveTarget(event.nativeEvent) && event.button !== 2) {
        const cell = target.closest<HTMLElement>(".ag-cell[col-id]");
        const rowElement = cell?.closest<HTMLElement>(".ag-row[row-index]");
        const columnId = cell?.getAttribute("col-id");
        const rowIndex = Number(rowElement?.getAttribute("row-index"));
        if (rowElement && columnId && !["actions", "rowOrder", "ag-Grid-SelectionColumn"].includes(columnId) && Number.isInteger(rowIndex) && !isStructuralSpreadsheetRow(api.getDisplayedRowAtIndex(rowIndex))) {
          const point = { rowIndex, columnId, rowId: api.getDisplayedRowAtIndex(rowIndex)?.id };
          const next = { start: event.shiftKey && selectionRef.current ? selectionRef.current.start : point, end: point };
          dragging.current = true; selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
          body.current?.focus({ preventScroll: true });
        }
      }
      if (!(target instanceof Element) || !target.closest(".ag-editable-cell-menu")) return;
      const cell = target.closest<HTMLElement>(".ag-cell[col-id]");
      const row = cell?.closest<HTMLElement>(".ag-row[row-index]");
      const columnId = cell?.getAttribute("col-id");
      const rowIndex = Number(row?.getAttribute("row-index"));
      if (columnId && Number.isInteger(rowIndex)) rememberCellUndo(rowIndex, columnId);
    }} onPointerDown={clearSelectionOnEmptySpace} onCopy={copySelection} onCut={onSpreadsheetBatch ? event => {
      if (isInteractiveTarget(event.nativeEvent)) return;
      const text = selectedText();
      if (text === undefined) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
      changeRange("clear", true);
    } : undefined} onPaste={pasteSelection} onKeyDown={onSpreadsheetBatch ? undefined : handleSpreadsheetKeyDown} onKeyDownCapture={onSpreadsheetBatch ? event => { handleSpreadsheetKeyDown(event); if (event.defaultPrevented) event.stopPropagation(); } : undefined} aria-label="Таблица. Стрелки перемещают выбранную ячейку, Shift со стрелками расширяет выделение. Двойной клик, Enter или F2 открывает редактирование. Доступны копирование, вставка и отмена через Ctrl+Z как в Excel.">
      {spreadsheetStatus && <span className="sr-only" aria-live="polite">{spreadsheetStatus}</span>}
      <AgGridReact<TData> {...props} rowSelection={rowSelection} selectionColumnDef={selectionColumnDef} rowData={orderedRowData} columnDefs={orderedColumns} defaultColDef={enhancedDefaultColDef} popupParent={requestedPopupParent ?? popupParent} suppressContextMenu suppressMovableColumns enableFilterHandlers localeText={gridLocaleRu}
      rowDragManaged={false} rowDragMultiRow={selectionDrag || props.rowDragMultiRow} suppressRowDrag={rowMoveDisabled || Boolean(rowOrder?.busy)}
      onRowDragEnd={(event) => {
        if (!rowOrder?.canWrite || rowMoveDisabled || rowOrder.busy || !event.overNode?.data || !event.node.data) return;
        if (!selectionDrag || event.node.isSelected() !== true) return;
        const targetId = getRowOrderId(event.overNode.data);
        const draggedId = getRowOrderId(event.node.data);
        if (!targetId || !draggedId) return;
        const selectedIds = event.api.getSelectedRows().map(getRowOrderId).filter((id): id is RowOrderId => Boolean(id));
        const movingIds = [...new Set(selectedIds.includes(draggedId) ? selectedIds : [draggedId])];
        if (movingIds.includes(targetId)) return;
        const placement = event.y < (event.overNode.rowTop ?? 0) + (event.overNode.rowHeight ?? 44) / 2 ? "before" : "after";
        void finishRowMove({ movingIds, placement, targetId });
      }}
      onGridReady={(event) => { setApi(event.api); updateSummary(event.api); props.onGridReady?.(event); }}
      onSelectionChanged={event => { if (props.rowSelection) props.onSelectionChanged?.(event); }}
      onCellMouseDown={(event) => { selectCell(event); props.onCellMouseDown?.(event); }}
      onCellMouseOver={(event) => { extendSelection(event); props.onCellMouseOver?.(event); }}
      onCellDoubleClicked={(event) => { if (access?.edit === false) return; if (event.rowIndex !== null && !isInteractiveTarget(event.event)) rememberCellUndo(event.rowIndex, event.column.getColId()); props.onCellDoubleClicked?.(event); }}
      onBodyScroll={(event) => { paintSelection(event.api); props.onBodyScroll?.(event); }}
      onModelUpdated={(event) => { updateSummary(event.api); paintSelection(event.api); props.onModelUpdated?.(event); }}
      onRowGroupOpened={(event) => { clearSelection(); props.onRowGroupOpened?.(event); }}
      onFilterChanged={(event) => { if (onSpreadsheetBatch) clearSelection(); updateSummary(event.api); props.onFilterChanged?.(event); }}
      onSortChanged={(event) => { if (onSpreadsheetBatch) clearSelection(); updateSummary(event.api); props.onSortChanged?.(event); }}
    />{contextMenu && <TableContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      caption={api?.getColumnDef(contextMenu.columnId)?.headerName ?? "Ячейка"}
      value={contextMenu.value}
      error={contextMenu.error}
      onClose={() => setContextMenu(null)}
      actions={[
        { label: "Копировать ячейку", shortcut: "Ctrl+C", onSelect: async () => { try { await navigator.clipboard.writeText(selectedText() ?? contextMenu.value); setSpreadsheetStatus("Ячейка скопирована"); setContextMenu(null); } catch { setContextMenu((current) => current ? { ...current, error: "Не удалось скопировать. Разрешите доступ к буферу обмена." } : current); } } },
        ...(onSpreadsheetPaste || onSpreadsheetBatch ? [{ label: "Вставить в ячейку", shortcut: "Ctrl+V", disabled: !onSpreadsheetPaste && !onSpreadsheetBatch, title: onSpreadsheetPaste || onSpreadsheetBatch ? undefined : "Таблица доступна только для просмотра", onSelect: async () => { try { const changed = pasteText(await navigator.clipboard.readText()); if (changed) setContextMenu(null); else setContextMenu((current) => current ? { ...current, error: "Эту ячейку нельзя изменить или значение не подходит." } : current); } catch { setContextMenu((current) => current ? { ...current, error: "Не удалось прочитать буфер обмена. Разрешите доступ в браузере." } : current); } } }] satisfies TableContextMenuAction[] : []),
        ...(onSpreadsheetBatch ? [
          { label: "Вырезать диапазон", shortcut: "Ctrl+X", onSelect: async () => { try { await navigator.clipboard.writeText(selectedText() ?? contextMenu.value); changeRange("clear", true); setContextMenu(null); } catch { setContextMenu(current => current ? { ...current, error: "Не удалось записать в буфер обмена." } : current); } } },
          { label: "Очистить диапазон", shortcut: "Delete", onSelect: () => { changeRange("clear"); setContextMenu(null); } },
          { label: "Заполнить вниз", shortcut: "Ctrl+D", onSelect: () => { changeRange("down"); setContextMenu(null); } },
          { label: "Заполнить вправо", shortcut: "Ctrl+R", onSelect: () => { changeRange("right"); setContextMenu(null); } },
        ] satisfies TableContextMenuAction[] : []),
        ...(onSpreadsheetEdit ? [{ label: "Редактировать ячейку", shortcut: "Enter", separatorBefore: true, onSelect: () => { if (onSpreadsheetEdit?.(contextMenu)) { rememberCellUndo(contextMenu.rowIndex, contextMenu.columnId); setSpreadsheetStatus("Редактирование ячейки"); setContextMenu(null); } else setContextMenu((current) => current ? { ...current, error: "Эта ячейка недоступна для редактирования." } : current); } }] satisfies TableContextMenuAction[] : []),
        ...(rowSelection ? [{ label: api?.getDisplayedRowAtIndex(contextMenu.rowIndex)?.isSelected() ? "Снять выделение строки" : "Выбрать строку для действий", separatorBefore: true, disabled: api?.getDisplayedRowAtIndex(contextMenu.rowIndex)?.selectable === false, onSelect: () => { const node = api?.getDisplayedRowAtIndex(contextMenu.rowIndex); if (node) node.setSelected(!node.isSelected(), !node.isSelected()); setContextMenu(null); } } satisfies TableContextMenuAction] : []),
        ...(getRowOrderId(contextMenu.row) ? rowMoves.getActions(getRowOrderId(contextMenu.row)!, api?.getSelectedRows().map(getRowOrderId).filter((id): id is RowOrderId => Boolean(id)) ?? [], () => setContextMenu(null)) : []),
        ...(getSpreadsheetContextActions?.(contextMenu) ?? []).map((action) => ({ ...action, onSelect: async () => { await action.onSelect(); setContextMenu(null); } })),
      ]}
    />}</div>
  </div>;
}
