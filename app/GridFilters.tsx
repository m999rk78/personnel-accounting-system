"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact, useGridFilterDisplay, type AgGridReactProps, type CustomFilterDisplayProps, type CustomFloatingFilterDisplayProps } from "ag-grid-react";
import type { CellMouseDownEvent, CellMouseOverEvent, ColDef, ColGroupDef, ColumnFilter, GridApi, IFilterParams, IRowNode, RowDragEvent } from "ag-grid-community";
import { compareGridValues, describeGridFilter, filterValueKey, isConditionValid, matchesPersonnelFilter, normalizeFilterText, numberOperations, textOperations, dateOperations, filterDateKey, type FilterCondition, type PersonnelFilterModel } from "./gridFilterModel";
import { gridLocaleRu } from "./gridLocaleRu";
import { tableColumnMenuItems } from "./gridColumnMenu";
import { CustomSelect } from "./CustomSelect";
import { VirtualChoiceList } from "./VirtualChoiceList";
import { DateFilterTree } from "./DateFilterTree";
import { matchesDateFilterSearch } from "./dateFilterTreeModel";
import { enterpriseFilterParams, type EnterpriseFilterOptions } from "./GridEnterpriseFilters";
import { useGridFilterPopup } from "./useGridFilterPopup";
import { useGridFilterEscape } from "./useGridFilterEscape";
import { closeTableContextMenus, TableContextMenu, type TableContextMenuAction } from "./TableContextMenu";
import { useRowMoveActions, useWorkspaceTableOrder } from "./TableRowMoves";
import { gridRowEntityId, rowMoveIsBlocked, saveManualRowMove, type RowMove, type RowOrderId } from "./tableRowOrder";
import { prependUnrankedReportDrafts } from "./reportNewRowOrder";
import "./gridFilters.css";
import { parseSpreadsheetText, serializeSpreadsheetText, spreadsheetClipboardHtml, stripSpreadsheetHeaderRow } from "./spreadsheetClipboard";
import { useWorkspaceAccess } from "./TableAccessContext";
import { SelectionRowDragRenderer } from "./SelectionRowDragRenderer";
import { gridRowSelection } from "./gridRowSelection";
import { allSpreadsheetCells, findSpreadsheetDataRowIndex, isStructuralSpreadsheetRow, spreadsheetDataColumns, spreadsheetHeaderValues, spreadsheetPointRowIndex, spreadsheetRangeHasStructuralRows } from "./gridSpreadsheetRows";
import { summarizeSpreadsheetSelection, type SpreadsheetSelectionSummary } from "./gridSelectionSummary";
import { isTableSelectAllShortcut } from "./tableSelectAllShortcut";
import { historyShortcut } from "./undoShortcut";
import { dispatchUndoShortcut, useUndoShortcut } from "./useUndoShortcut";
import { isTableRowSelectionBlocked, tableColumnSelectionIntent, tableRowSelectionIntent } from "./tableRowSelectionShortcut";
import { createImportOrderRank, IMPORT_ORDER_COLUMN, importOrderColumnState, importOrderScopes, shouldApplyImportOrder } from "./importOrderSorting";
import { useEmptyGridRows } from "./useEmptyGridRows";
import { useTableEscapeSelection } from "./useTableEscapeSelection";
import { useTableCopyToast, writeTableClipboardText } from "./useTableCopyToast";
import { rowDragPoint, startRowDragAutoScroll } from "./rowDragAutoScroll";
import { createRowDropIndicator } from "./rowDropIndicator";
import { resolveGridRowDropTarget } from "./gridRowDropTarget";
import { selectedSpreadsheetAreas, selectedSpreadsheetCells, spreadsheetSelectionContains, spreadsheetSelectionValues, toggleSpreadsheetCell, type SpreadsheetPoint, type SpreadsheetSelection } from "./gridMultiSelection";

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
  const { root: popupRef, attach: attachPopup } = useGridFilterPopup<HTMLFormElement>(props);
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
  const canSortByImport = Boolean(api.getColumn(IMPORT_ORDER_COLUMN));
  const activeImportSort = sortedColumns.find(item => item.colId === IMPORT_ORDER_COLUMN);
  const appliedSort: SortDraft = props.rowSortOptions
    ? { columnId: sortedColumns[0]?.colId ?? "", sort: sortedColumns[0]?.sort ?? null }
    : canSortByImport && !sortedColumns.length ? { columnId: "", sort: null }
      : activeImportSort && !currentSort ? { columnId: IMPORT_ORDER_COLUMN, sort: activeImportSort.sort ?? null } : { columnId, sort: currentSort?.sort ?? null };
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
  const matching = values.filter(({ value }) => kind === "date" ? matchesDateFilterSearch(value, search) : normalizeFilterText(value || "(Пустые)").includes(normalizeFilterText(search)));
  const selected = new Set(model.values ?? []);
  const checkedCount = matching.filter(({ value }) => selected.has(value)).length;
  const selectedCount = values.filter(({ value }) => selected.has(value)).length;
  const update = (patch: Partial<PersonnelFilterModel>) => {
    const next = { ...model, ...patch, kind };
    onStateChange({ model: next.values === null && !next.conditions.length ? null : next,
      valid: next.conditions.every((condition) => isConditionValid(condition, kind)) });
  };
  const setValues = (selection: Set<string>) => update({ values: selection.size ? [...selection] : null });
  const changeSearch = (value: string) => {
    setSearch(value);
    const needle = normalizeFilterText(value);
    update({ values: needle ? values.filter(({ value }) => kind === "date" ? matchesDateFilterSearch(value, needle) : normalizeFilterText(value || "(Пустые)").includes(needle)).map(({ value }) => value) : props.model?.values ?? null });
  };
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
    if (props.rowSortOptions || sortDraft.columnId === IMPORT_ORDER_COLUMN || !sortDraft.columnId || sortDraft.sort && !keepOtherSorts) {
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
        ]} /> : <CustomSelect ariaLabel="Порядок строк" value={selectedSort.columnId === IMPORT_ORDER_COLUMN ? "import" : !selectedSort.columnId ? "manual" : selectedSort.sort ?? "none"} onChange={value => setSortDraft(value === "import" ? { columnId: IMPORT_ORDER_COLUMN, sort: "asc" } : value === "manual" ? { columnId: "", sort: null } : { columnId, sort: value === "none" ? null : value as "asc" | "desc" })} options={[
          { value: "none", label: "Без сортировки по этой колонке" },
          { value: "asc", label: kind === "date" ? "Сначала ранние даты" : kind === "number" ? "От меньшего к большему" : "По алфавиту: от А до Я" },
          { value: "desc", label: kind === "date" ? "Сначала поздние даты" : kind === "number" ? "От большего к меньшему" : "По алфавиту: от Я до А" },
          ...(canSortByImport ? [{ value: "import", label: "Порядок импорта" }, { value: "manual", label: "Ручной порядок" }] : []),
        ]} />}</div>
        {!props.rowSortOptions && hasOtherSorts && <label className="grid-filter-additive"><input type="checkbox" checked={keepOtherSorts} disabled={!selectedSort.sort} onChange={event => { setKeepOtherSorts(event.target.checked); setSortDraft(selectedSort); }} /><span>Сохранить сортировку других колонок</span></label>}
      </section>
      <section className="grid-filter-choices" aria-label="Выбор значений">
        <div className="grid-filter-section-heading"><strong>Показать значения</strong><span>Выбрано {selectedCount} из {values.length}</span></div>
        <label className="grid-filter-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg><input ref={searchInput} aria-label="Поиск значений" placeholder={kind === "date" ? "Найти дату…" : "Найти в списке…"} value={search} onChange={(event) => changeSearch(event.target.value)} /></label>
        <div className="grid-filter-selection"><ValueCheckbox checked={matching.length > 0 && checkedCount === matching.length} mixed={checkedCount > 0 && checkedCount < matching.length} onChange={(checked) => {
          const next = new Set(selected);
          matching.forEach(({ value }) => { if (checked) next.add(value); else next.delete(value); });
          setValues(next);
        }}><span>{search ? "Все найденные" : "Все значения"}</span></ValueCheckbox><button type="button" onClick={() => search ? update({ values: matchingValues }) : setValues(new Set())}>{search ? "Только найденные" : "Снять выбор"}</button></div>
        {kind === "date" ? <DateFilterTree key={search} values={values} selected={selected} onChange={setValues} search={search} /> : <VirtualChoiceList key={search} items={matchingValues} emptyText={search ? "Ничего не найдено. Попробуйте другой запрос." : "Нет значений с учётом остальных фильтров."} renderItem={(value) => <ValueCheckbox checked={selected.has(value)} onChange={(checked) => { const next = new Set(selected); if (checked) next.add(value); else next.delete(value); setValues(next); }}><span title={value || "(Пустые)"}>{value || "(Пустые)"}</span><small title="Количество строк">{counts.get(value)}</small></ValueCheckbox>} />}
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

// Submenu parents only reveal their children; close the menu after the selected
// leaf finishes, so navigation and asynchronous custom actions retain errors.
function closeContextActionsAfterSelection(actions: TableContextMenuAction[], close: () => void): TableContextMenuAction[] {
  return actions.map(action => action.children
    ? { ...action, children: closeContextActionsAfterSelection(action.children, close) }
    : { ...action, onSelect: async () => { await action.onSelect(); close(); } });
}

type LocalizedGridProps<TData extends FilterRow> = AgGridReactProps<TData> & {
  onSpreadsheetPaste?: (payload: SpreadsheetPastePayload<TData>) => boolean;
  onSpreadsheetEdit?: (payload: SpreadsheetEditPayload<TData>) => boolean;
  onSpreadsheetCancelEdit?: () => void;
  spreadsheetFocusRequestKey?: number;
  spreadsheetSelectionResetKey?: string;
  spreadsheetClipboardFormat?: "text" | "excel";
  onSpreadsheetSelectionSummary?: (summary: SpreadsheetSelectionSummary | null) => void;
  getSpreadsheetContextActions?: (payload: SpreadsheetContextPayload<TData>) => TableContextMenuAction[];
  getRowOrderId?: (row: TData) => RowOrderId | undefined;
  rowOrderFixedSorts?: string[];
  rowOrderBlocked?: boolean;
  rowOrderAutoSwitchSort?: boolean;
  preserveSavedSort?: boolean;
  onSpreadsheetBatch?: (batch: SpreadsheetBatch<TData>) => boolean;
  canWriteSpreadsheetCell?: (row: TData, columnId: string) => boolean;
  spreadsheetHistory?: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
  enterpriseFilters?: boolean;
  showSortSummary?: boolean;
  formatFilterSummaryValue?: (columnId: string, value: unknown) => string;
  spreadsheetToolbar?: boolean;
};

function isInteractiveTarget(event?: Event | null) {
  const target = event?.target;
  return target instanceof Element && Boolean(target.closest("button, input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox'], .actions-cell"));
}

function spreadsheetColumns<TData>(grid: GridApi<TData>) {
  return spreadsheetDataColumns(grid);
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

function wholeSpreadsheetRows<TData>(grid: GridApi<TData>, start: SpreadsheetPoint, end: SpreadsheetPoint, activeColumnId: string): SpreadsheetSelection | null {
  const columns = spreadsheetColumns(grid);
  const startIndex = spreadsheetPointRowIndex(grid, start);
  const endIndex = spreadsheetPointRowIndex(grid, end);
  if (!columns.length || startIndex === null || endIndex === null) return null;
  const first = grid.getDisplayedRowAtIndex(startIndex), last = grid.getDisplayedRowAtIndex(endIndex);
  if (!first?.data || !last?.data || isStructuralSpreadsheetRow(first) || isStructuralSpreadsheetRow(last)) return null;
  return {
    start: { rowIndex: startIndex, rowId: first.id, columnId: columns[0].getColId() },
    end: { rowIndex: endIndex, rowId: last.id, columnId: columns.at(-1)!.getColId() },
    rowModeColumnId: columns.some(column => column.getColId() === activeColumnId) ? activeColumnId : columns[0].getColId(),
  };
}

function spreadsheetActivePoint(current: SpreadsheetSelection, edge: "start" | "end" = "end"): SpreadsheetPoint {
  if (current.rowModeColumnId) return { ...current.end, columnId: current.rowModeColumnId };
  if (current.columnModeRow) return { ...current.columnModeRow, columnId: current.end.columnId };
  return current[edge];
}

function wholeSpreadsheetColumns<TData>(grid: GridApi<TData>, startColumnId: string, endColumnId: string, activeRow: SpreadsheetPoint): SpreadsheetSelection | null {
  const columns = spreadsheetColumns(grid);
  if (![startColumnId, endColumnId].every(id => columns.some(column => column.getColId() === id))) return null;
  const activeIndex = spreadsheetPointRowIndex(grid, activeRow);
  const firstIndex = findSpreadsheetDataRowIndex(grid, 0, 1);
  const lastIndex = findSpreadsheetDataRowIndex(grid, grid.getDisplayedRowCount() - 1, -1);
  if (activeIndex === null || firstIndex === null || lastIndex === null) return null;
  const activeNode = grid.getDisplayedRowAtIndex(activeIndex);
  if (!activeNode?.data || isStructuralSpreadsheetRow(activeNode)) return null;
  return {
    start: { rowIndex: firstIndex, rowId: grid.getDisplayedRowAtIndex(firstIndex)?.id, columnId: startColumnId },
    end: { rowIndex: lastIndex, rowId: grid.getDisplayedRowAtIndex(lastIndex)?.id, columnId: endColumnId },
    columnModeRow: { rowIndex: activeIndex, rowId: activeNode.id },
  };
}

export function LocalizedGrid<TData extends FilterRow>({ onSpreadsheetPaste: suppliedPaste, onSpreadsheetEdit: suppliedEdit, onSpreadsheetCancelEdit, spreadsheetFocusRequestKey = 0, spreadsheetSelectionResetKey = "", spreadsheetClipboardFormat = "text", onSpreadsheetSelectionSummary, getSpreadsheetContextActions, getRowOrderId = gridRowEntityId, rowOrderFixedSorts, rowOrderBlocked = false, rowOrderAutoSwitchSort = false, preserveSavedSort = false, onSpreadsheetBatch: suppliedBatch, canWriteSpreadsheetCell, spreadsheetHistory: suppliedHistory, enterpriseFilters = true, showSortSummary = true, formatFilterSummaryValue, spreadsheetToolbar = true, popupParent: requestedPopupParent, ...props }: LocalizedGridProps<TData>) {
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
  const rowNumberFrame = useRef<number | null>(null);
  const refreshRowNumbers = useCallback((grid: GridApi<TData>) => {
    if (grid.isDestroyed() || !grid.getColumn("number")) return;
    if (rowNumberFrame.current !== null) cancelAnimationFrame(rowNumberFrame.current);
    // A sort changes node.rowIndex without changing its data. Refresh the
    // presentation-only counter after AG Grid finishes positioning the rows.
    rowNumberFrame.current = requestAnimationFrame(() => {
      rowNumberFrame.current = null;
      if (!grid.isDestroyed()) grid.refreshCells({ columns: ["number"], force: true });
    });
  }, []);
  useEffect(() => () => { if (rowNumberFrame.current !== null) cancelAnimationFrame(rowNumberFrame.current); }, []);
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
    if (rowOrderAutoSwitchSort && hasSavedRowOrder && !preserveSavedSort && api && !api.isDestroyed()) api.applyColumnState({ state: api.getColumnState().filter(column => rowOrderFixedSorts?.includes(column.colId)), defaultState: { sort: null, sortIndex: null } });
  }, [api, rowOrderAutoSwitchSort, rowOrderFixedSorts, hasSavedRowOrder, preserveSavedSort]);
  const orderedRowData = useMemo(() => rowOrder
    ? prependUnrankedReportDrafts(rowOrder.order(props.rowData ?? [], getRowOrderId), rowOrder.ids, getRowOrderId, rowOrder.scope)
    : props.rowData, [props.rowData, rowOrder, getRowOrderId]);
  const sourceColumns = props.columnDefs;
  const importedScope = importOrderScopes.has(rowOrder?.scope ?? "");
  const importRank = useMemo(() => importedScope ? createImportOrderRank(props.rowData ?? [], rowOrder?.importIds ?? [], getRowOrderId) : null, [importedScope, props.rowData, rowOrder?.importIds, getRowOrderId]);
  const baseFilter = props.defaultColDef?.filter;
  const baseFilterParams = props.defaultColDef?.filterParams;
  const nativeFilters = Boolean(enterpriseFilters && api?.isModuleRegistered("MultiFilterModule") && api.isModuleRegistered("SetFilterModule"));
  // Refreshing the hidden import sort column must leave the filter components mounted.
  const filterColumns = useMemo(() => {
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
  const orderedColumns = useMemo(() => {
    if (!importRank || filterColumns.some(column => !("children" in column) && column.colId === IMPORT_ORDER_COLUMN)) return filterColumns;
    return [...filterColumns, {
      colId: IMPORT_ORDER_COLUMN, headerName: "Порядок импорта", hide: true, lockVisible: true, suppressColumnsToolPanel: true,
      filter: false, sortable: true, valueGetter: params => params.data ? importRank(params.data) : null,
      comparator: (left: number, right: number) => left - right,
    } satisfies ColDef<TData>];
  }, [filterColumns, importRank]);
  const importActivation = rowOrder?.importOrderRevision ?? 0;
  // Opening a second view of the same project must not replay an earlier import.
  const lastImportActivation = useRef(importActivation);
  const importDefaultApplied = useRef<GridApi<TData> | null>(null);
  const importReady = rowOrder?.ready ?? false;
  const defaultImportSort = importedScope && Boolean(rowOrder?.hasImportOrder && !rowOrder.hasSavedOrder);
  useEffect(() => {
    if (!api || api.isDestroyed() || !api.getColumn(IMPORT_ORDER_COLUMN)) return;
    const activated = lastImportActivation.current < importActivation;
    lastImportActivation.current = importActivation;
    const firstLoad = importReady && importDefaultApplied.current !== api;
    if (firstLoad) importDefaultApplied.current = api;
    if (shouldApplyImportOrder({ activated, firstLoad, defaultImport: defaultImportSort, sorted: api.getColumnState().some(column => Boolean(column.sort)) })) api.applyColumnState(importOrderColumnState());
  }, [api, importActivation, importReady, defaultImportSort, orderedColumns]);
  const previousEditState = useRef<{ api: GridApi<TData>; rows: Set<string> } | null>(null);
  const { rowData: sourceRows, getRowId: sourceGetRowId, context: sourceContext } = props;
  useEffect(() => {
    if (!api || api.isDestroyed() || !nativeFilters) return;
    const rows = new Set((sourceRows ?? []).flatMap((row, index) => row.kind === "entry" ? [] : [
      `${row.kind}:${sourceGetRowId?.({ data: row, api, context: sourceContext, level: 0, parentKeys: undefined }) ?? index}`,
    ]));
    const previous = previousEditState.current?.api === api ? previousEditState.current : null;
    previousEditState.current = { api, rows };
    // Reveal newly created draft/full-row editors. Opening a cell only blocks
    // row moves and must preserve the filters applied to existing report rows.
    const addedEditableRows = [...rows].some(key => !previous?.rows.has(key));
    if (addedEditableRows && api.isAnyFilterPresent()) api.setFilterModel(null);
  }, [api, nativeFilters, sourceRows, sourceGetRowId, sourceContext]);
  const [selection, setSelection] = useState<SpreadsheetSelection | null>(null);
  const [includeSelectedHeaders, setIncludeSelectedHeaders] = useState(false);
  const [spreadsheetStatus, setSpreadsheetStatus] = useState("");
  const [contextMenu, setContextMenu] = useState<(SpreadsheetContextPayload<TData> & { x: number; y: number; error: string }) | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const trackFilterEscape = useGridFilterEscape<TData>({ api, getRoot: () => body.current?.parentElement ?? null });
  const { copyToast, showCopyToast } = useTableCopyToast(body);
  const rowDragScroll = useRef<ReturnType<typeof startRowDragAutoScroll>>(null);
  const rowDropIndicator = useRef<ReturnType<typeof createRowDropIndicator>>(null);
  const activeRowDrag = useRef<RowDragEvent<TData> | null>(null);
  const clearRowDropIndicator = useCallback(() => { activeRowDrag.current = null; rowDropIndicator.current?.clear(); }, []);
  const stopRowDragScroll = useCallback(() => { rowDragScroll.current?.stop(); rowDragScroll.current = null; clearRowDropIndicator(); }, [clearRowDropIndicator]);
  useEffect(() => stopRowDragScroll, [api, rowMoveDisabled, rowOrder?.busy, rowOrder?.canWrite, stopRowDragScroll]);
  const resolveRowDragMove = useCallback((event: RowDragEvent<TData>): RowMove | null => {
    if (!canDragSelection() || !selectionDrag || event.node.isSelected() !== true || !event.node.data || !event.overNode?.data) return null;
    const targetId = getRowOrderId(event.overNode.data);
    const draggedId = getRowOrderId(event.node.data);
    if (!targetId || !draggedId) return null;
    const selectedIds = event.api.getSelectedRows().map(getRowOrderId).filter((id): id is RowOrderId => Boolean(id));
    const movingIds = [...new Set(selectedIds.includes(draggedId) ? selectedIds : [draggedId])];
    if (movingIds.includes(targetId)) return null;
    // Reports keep each day's rows together. Do not advertise a drop which the
    // server will reject or which cannot match the indicator after saving.
    if (rowOrder?.scope === "personnel-report-rows" || rowOrder?.scope === "equipment-report-rows") {
      const date = String(targetId).slice(0, 10);
      if (movingIds.some(id => String(id).slice(0, 10) !== date)) return null;
    }
    const placement = event.y < (event.overNode.rowTop ?? 0) + (event.overNode.rowHeight ?? 44) / 2 ? "before" : "after";
    return { movingIds, targetId, placement };
  }, [canDragSelection, selectionDrag, getRowOrderId, rowOrder?.scope]);
  const paintRowDropIndicator = useCallback(() => {
    const root = body.current;
    const event = activeRowDrag.current;
    const target = root && event && resolveGridRowDropTarget(root, event, resolveRowDragMove);
    if (!root || !target) { rowDropIndicator.current?.clear(); return; }
    rowDropIndicator.current ??= createRowDropIndicator(root);
    rowDropIndicator.current.show({ row: target.row, placement: target.operation.placement, count: target.operation.movingIds.length, rowNumber: target.rowNumber });
  }, [resolveRowDragMove]);
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    const document = root.ownerDocument;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") stopRowDragScroll(); };
    document.addEventListener("scroll", paintRowDropIndicator, true);
    document.addEventListener("keydown", escape, true);
    document.defaultView?.addEventListener("blur", stopRowDragScroll);
    return () => {
      document.removeEventListener("scroll", paintRowDropIndicator, true);
      document.removeEventListener("keydown", escape, true);
      document.defaultView?.removeEventListener("blur", stopRowDragScroll);
      stopRowDragScroll();
      rowDropIndicator.current?.destroy(); rowDropIndicator.current = null;
    };
  }, [api, paintRowDropIndicator, stopRowDragScroll]);
  useEmptyGridRows(body, api, props.rowHeight ?? 54);
  const selectionRef = useRef(selection);
  const selectionIncludesHeaders = useRef(false);
  const lastHeaderClipboard = useRef<string | null>(null);
  const lastSelectionRef = useRef(selection);
  const selectionSummaryCallback = useRef(onSpreadsheetSelectionSummary);
  const lastSelectionSummary = useRef<SpreadsheetSelectionSummary | null | undefined>(undefined);
  useEffect(() => { selectionSummaryCallback.current = onSpreadsheetSelectionSummary; }, [onSpreadsheetSelectionSummary]);
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
    const filters = Object.entries(grid.getFilterModel()).map(([id, model]) => ({ id, name: grid.getColumnDef(id)?.headerName ?? id, description: describeGridFilter(model, formatFilterSummaryValue ? value => formatFilterSummaryValue(id, value) : undefined) }));
    const sorts = grid.getColumnState().filter((state): state is typeof state & { sort: "asc" | "desc" } => state.sort === "asc" || state.sort === "desc")
      .sort((left, right) => (left.sortIndex ?? 0) - (right.sortIndex ?? 0))
      .map((state, index) => ({ id: state.colId, name: grid.getColumnDef(state.colId)?.headerName ?? state.colId, direction: state.sort, priority: index + 1 }));
    setSummary({ count, total, filters, sorts });
  }, [setSummary, formatFilterSummaryValue]);
  const sourceDefaultColDef = props.defaultColDef;
  const hasSpreadsheetBatch = Boolean(onSpreadsheetBatch);
  const enhancedDefaultColDef = useMemo<ColDef<TData>>(() => ({
    ...sourceDefaultColDef,
    comparator: sourceDefaultColDef?.comparator ?? compareGridValues,
    // AG Grid receives native keydown before React: leave editing keys to inputs.
    // Summary updates may replace the batch callback. Its presence alone affects
    // keyboard handling; rebuilding column definitions would close a live filter.
    suppressKeyboardEvent: (params) => hasSpreadsheetBatch || isInteractiveTarget(params.event) || Boolean(sourceDefaultColDef?.suppressKeyboardEvent?.(params)),
  }), [sourceDefaultColDef, hasSpreadsheetBatch]);
  const paintSelection = useCallback((grid: GridApi<TData>) => {
    requestAnimationFrame(() => {
      const root = body.current;
      if (!root || grid.isDestroyed()) return;
      root.querySelectorAll(".ag-excel-selected,.ag-excel-top,.ag-excel-right,.ag-excel-bottom,.ag-excel-left").forEach((cell) => cell.classList.remove("ag-excel-selected", "ag-excel-top", "ag-excel-right", "ag-excel-bottom", "ag-excel-left"));
      root.querySelectorAll(".ag-excel-header-selected").forEach(header => header.classList.remove("ag-excel-header-selected"));
      const bounds = spreadsheetBounds(grid, selectionRef.current);
      const areas = selectionRef.current?.ranges?.length ? selectedSpreadsheetAreas(grid, selectionRef.current) : bounds ? [bounds] : [];
      if (selectionSummaryCallback.current) {
        const summary = summarizeSpreadsheetSelection(grid, selectionRef.current?.ranges?.length ? areas : bounds);
        const previous = lastSelectionSummary.current;
        if (previous === undefined || previous?.count !== summary?.count || previous?.sum !== summary?.sum) {
          lastSelectionSummary.current = summary;
          selectionSummaryCallback.current(summary);
        }
      }
      if (selectionIncludesHeaders.current) {
        const selectedColumns = new Set((areas.length ? areas.flatMap(area => area.columns.slice(area.columnStart, area.columnEnd + 1)) : selectionRef.current ? [] : spreadsheetColumns(grid)).map(column => column.getColId()));
        root.querySelectorAll<HTMLElement>(".ag-header-cell[col-id]").forEach(header => {
          if (header.closest(".localized-grid-body") === root && selectedColumns.has(header.getAttribute("col-id") ?? "")) header.classList.add("ag-excel-header-selected");
        });
      }
      if (!areas.length) return;
      root.querySelectorAll<HTMLElement>(".ag-cell[col-id]").forEach((cell) => {
        const row = Number(cell.closest(".ag-row")?.getAttribute("row-index"));
        if (isStructuralSpreadsheetRow(grid.getDisplayedRowAtIndex(row))) return;
        const column = areas[0].columns.findIndex((item) => item.getColId() === cell.getAttribute("col-id"));
        const contains = (rowIndex: number, columnIndex: number) => areas.some(area => rowIndex >= area.rowStart && rowIndex <= area.rowEnd && columnIndex >= area.columnStart && columnIndex <= area.columnEnd);
        if (!contains(row, column)) return;
        cell.classList.add("ag-excel-selected");
        if (!contains(row - 1, column)) cell.classList.add("ag-excel-top");
        if (!contains(row + 1, column)) cell.classList.add("ag-excel-bottom");
        if (!contains(row, column - 1)) cell.classList.add("ag-excel-left");
        if (!contains(row, column + 1)) cell.classList.add("ag-excel-right");
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
  }, [api, paintSelection, selection, includeSelectedHeaders]);
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
  const selectCell = useCallback((event: Pick<CellMouseDownEvent<TData>, "api" | "rowIndex" | "node" | "column" | "event">) => {
    const mouseEvent = event.event as MouseEvent | undefined;
    const additive = (mouseEvent?.metaKey || mouseEvent?.ctrlKey) && !mouseEvent.shiftKey;
    if (event.rowIndex === null || isStructuralSpreadsheetRow(event.node) || ["actions", "rowOrder", "ag-Grid-SelectionColumn"].includes(event.column.getColId()) || !additive && isInteractiveTarget(event.event)) return;
    const point = { rowIndex: event.rowIndex, columnId: event.column.getColId(), rowId: event.node.id };
    if (mouseEvent && mouseEvent.button !== 0) return;
    if ((mouseEvent?.metaKey || mouseEvent?.ctrlKey) && !mouseEvent.shiftKey) {
      const removing = spreadsheetSelectionContains(event.api, selectionRef.current, point);
      const next = toggleSpreadsheetCell(event.api, selectionRef.current, point);
      mouseEvent.preventDefault();
      dragging.current = !removing;
      selectionIncludesHeaders.current = false; setIncludeSelectedHeaders(false);
      selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
      body.current?.focus({ preventScroll: true });
      return;
    }
    const start = mouseEvent?.shiftKey && selectionRef.current ? selectionRef.current.start : point;
    dragging.current = true;
    selectionIncludesHeaders.current = false;
    setIncludeSelectedHeaders(false);
    const current = selectionRef.current;
    const rowMode = mouseEvent?.shiftKey && current?.rowModeColumnId;
    const columnMode = mouseEvent?.shiftKey && current?.columnModeRow;
    const next = columnMode && current ? wholeSpreadsheetColumns(event.api, start.columnId, point.columnId, spreadsheetActivePoint(current))
      : rowMode ? wholeSpreadsheetRows(event.api, start, point, rowMode) : { start, end: point, ...(mouseEvent?.shiftKey && current?.ranges ? { ranges: current.ranges } : {}) };
    selectionIncludesHeaders.current = Boolean(next?.columnModeRow);
    setIncludeSelectedHeaders(selectionIncludesHeaders.current);
    selectionRef.current = next;
    lastSelectionRef.current = next;
    setSelection(next);
    body.current?.focus({ preventScroll: true });
  }, []);
  const extendSelection = useCallback((event: CellMouseOverEvent<TData>) => {
    if (!dragging.current || event.rowIndex === null || isStructuralSpreadsheetRow(event.node) || ["actions", "rowOrder", "ag-Grid-SelectionColumn"].includes(event.column.getColId()) || !selectionRef.current) return;
    const point = { rowIndex: event.rowIndex, columnId: event.column.getColId(), rowId: event.node.id };
    const current = selectionRef.current;
    const next = current.columnModeRow ? wholeSpreadsheetColumns(event.api, current.start.columnId, point.columnId, spreadsheetActivePoint(current))
      : current.rowModeColumnId ? wholeSpreadsheetRows(event.api, current.start, point, current.rowModeColumnId) : { start: current.start, end: point, ...(current.ranges ? { ranges: current.ranges } : {}) };
    selectionRef.current = next;
    lastSelectionRef.current = next;
    setSelection(next);
  }, []);
  const clearSelection = useCallback(() => {
    dragging.current = false;
    selectionIncludesHeaders.current = false;
    setIncludeSelectedHeaders(false);
    selectionRef.current = null;
    setSelection(null);
    setSpreadsheetStatus("");
    setContextMenu(null);
  }, []);
  useTableEscapeSelection({
    hasSelection: () => Boolean(selectionRef.current || selectionIncludesHeaders.current || api && !api.isDestroyed() && (api.getSelectedNodes().length || api.getFocusedCell() || api.isModuleRegistered("CellSelectionModule") && api.getCellRanges()?.length)),
    isEditing: () => Boolean(api && !api.isDestroyed() && api.getEditingCells().length),
    clearSelection: () => {
      clearSelection();
      lastSelectionRef.current = null;
      if (!api || api.isDestroyed()) return;
      api.deselectAll();
      // AG Grid delivers selection callbacks asynchronously. Publish the cleared
      // state now so a queued controlled-selection frame cannot select it again.
      if (props.rowSelection) props.onSelectionChanged?.({
        type: "selectionChanged", api, context: props.context, source: "api",
        selectedNodes: [], serverSideState: null,
      });
      if (api.isModuleRegistered("CellSelectionModule")) api.clearCellSelection();
      api.clearFocusedCell();
    },
  });
  const selectWholeRows = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const intent = tableRowSelectionIntent(event.nativeEvent);
    if (!intent || !api || api.isDestroyed() || api.getEditingCells().length) return false;
    const current = selectionRef.current;
    if (intent !== "row" && !current?.rowModeColumnId) return false;
    const focused = api.getFocusedCell();
    const firstIndex = focused?.rowIndex ?? findSpreadsheetDataRowIndex(api, 0, 1);
    const columns = spreadsheetColumns(api);
    if (firstIndex === null || !columns.length) { event.preventDefault(); return true; }
    const fallback = { rowIndex: firstIndex, rowId: api.getDisplayedRowAtIndex(firstIndex)?.id, columnId: focused?.column.getColId() ?? columns[0].getColId() };
    const active = current ? spreadsheetActivePoint(current) : fallback;
    const start = current?.columnModeRow ? active : current?.start ?? fallback;
    const end = current?.columnModeRow ? active : current?.end ?? fallback;
    const endIndex = spreadsheetPointRowIndex(api, end);
    if (endIndex === null) { event.preventDefault(); return true; }
    const targetIndex = intent === "row" ? endIndex : findSpreadsheetDataRowIndex(api, endIndex + (intent === "up" ? -1 : 1), intent === "up" ? -1 : 1) ?? endIndex;
    const point = { ...end, rowIndex: targetIndex, rowId: api.getDisplayedRowAtIndex(targetIndex)?.id };
    const next = wholeSpreadsheetRows(api, start, point, current?.rowModeColumnId ?? end.columnId);
    event.preventDefault();
    if (!next) return true;
    dragging.current = false;
    selectionIncludesHeaders.current = false;
    setIncludeSelectedHeaders(false);
    selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
    setContextMenu(null);
    api.ensureIndexVisible(targetIndex);
    body.current?.focus({ preventScroll: true });
    return true;
  }, [api]);
  const selectWholeColumns = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const intent = tableColumnSelectionIntent(event.nativeEvent);
    if (!intent || !api || api.isDestroyed() || api.getEditingCells().length) return false;
    const current = selectionRef.current;
    if (intent !== "column" && !current?.columnModeRow) return false;
    const columns = spreadsheetColumns(api);
    const focused = api.getFocusedCell();
    const firstIndex = focused?.rowIndex ?? findSpreadsheetDataRowIndex(api, 0, 1);
    event.preventDefault();
    if (firstIndex === null || !columns.length) return true;
    const headerColumnId = typeof Element !== "undefined" && event.target instanceof Element ? event.target.closest(".ag-header-cell[col-id]")?.getAttribute("col-id") : null;
    const fallback = { rowIndex: firstIndex, rowId: api.getDisplayedRowAtIndex(firstIndex)?.id, columnId: focused?.column.getColId() ?? columns[0].getColId() };
    const active = current ? spreadsheetActivePoint(current) : fallback;
    const endId = intent === "column" && headerColumnId ? headerColumnId : active.columnId;
    const index = columns.findIndex(column => column.getColId() === endId);
    if (index < 0) return true;
    const target = columns[Math.max(0, Math.min(columns.length - 1, index + (intent === "left" ? -1 : intent === "right" ? 1 : 0)))];
    const startId = current && !current.rowModeColumnId && !headerColumnId ? current.start.columnId : endId;
    const next = wholeSpreadsheetColumns(api, startId, target.getColId(), active);
    if (!next) return true;
    dragging.current = false;
    selectionIncludesHeaders.current = true; setIncludeSelectedHeaders(true);
    selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
    setContextMenu(null);
    api.ensureColumnVisible(target);
    body.current?.focus({ preventScroll: true });
    return true;
  }, [api]);
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
    const current = selectionRef.current ? spreadsheetActivePoint(selectionRef.current) : undefined;
    const currentRowIndex = current ? spreadsheetPointRowIndex(api, current) : undefined;
    if (currentRowIndex === null) { event.preventDefault(); return true; }
    const currentColumnIndex = current ? columns.findIndex((column) => column.getColId() === (selectionRef.current?.rowModeColumnId ?? current.columnId)) : -1;
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
      start: event.shiftKey && event.key !== "Tab" && selectionRef.current && !selectionRef.current.rowModeColumnId && !selectionRef.current.columnModeRow ? selectionRef.current.start : point,
      end: point,
      ...(event.shiftKey && event.key !== "Tab" && selectionRef.current?.ranges ? { ranges: selectionRef.current.ranges } : {}),
    };
    event.preventDefault();
    dragging.current = false;
    selectionIncludesHeaders.current = false;
    setIncludeSelectedHeaders(false);
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
      if ((!selectionRef.current && !selectionIncludesHeaders.current) || !(target instanceof Node) || body.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".custom-select-menu,.ag-employee-menu,.table-context-menu,.personnel-spreadsheet-tools")) return;
      if (target instanceof Element && target.closest("[data-table-page-horizontal]") && target.closest(".table-page-scroll-stage") === body.current?.closest(".table-page-scroll-stage")) return;
      clearSelection();
    };
    document.addEventListener("pointerdown", clearSelectionOutsideGrid);
    return () => document.removeEventListener("pointerdown", clearSelectionOutsideGrid);
  }, [clearSelection]);
  const selectedText = useCallback(() => {
    if (!api || !selectionRef.current && !selectionIncludesHeaders.current) return;
    if (selectionRef.current?.ranges?.length) {
      const text = serializeSpreadsheetText(spreadsheetSelectionValues(api, selectionRef.current, selectionIncludesHeaders.current));
      lastHeaderClipboard.current = selectionIncludesHeaders.current ? text : null;
      return text;
    }
    const bounds = spreadsheetBounds(api, selectionRef.current);
    if (!bounds) {
      const text = selectionIncludesHeaders.current && !selectionRef.current ? serializeSpreadsheetText([spreadsheetHeaderValues(api, spreadsheetColumns(api))]) : "";
      lastHeaderClipboard.current = selectionIncludesHeaders.current ? text : null;
      return text;
    }
    const lines: string[][] = selectionIncludesHeaders.current ? [spreadsheetHeaderValues(api, bounds.columns.slice(bounds.columnStart, bounds.columnEnd + 1))] : [];
    for (let rowIndex = bounds.rowStart; rowIndex <= bounds.rowEnd; rowIndex++) {
      const rowNode = api.getDisplayedRowAtIndex(rowIndex);
      if (!rowNode?.data || isStructuralSpreadsheetRow(rowNode)) continue;
      lines.push(bounds.columns.slice(bounds.columnStart, bounds.columnEnd + 1).map((column) => String(api.getCellValue({ rowNode, colKey: column, useFormatter: true }) ?? "")));
    }
    const text = serializeSpreadsheetText(lines);
    lastHeaderClipboard.current = selectionIncludesHeaders.current ? text : null;
    return text;
  }, [api]);
  const selectedClipboardHtml = useCallback((text: string) => {
    if (spreadsheetClipboardFormat !== "excel" || !api) return;
    const current = selectionRef.current;
    const bounds = spreadsheetBounds(api, current);
    const selectedIds = current?.ranges?.length ? new Set([...selectedSpreadsheetCells(api, current).values()].flatMap(ids => [...ids])) : null;
    const columns = selectedIds ? spreadsheetColumns(api).filter(column => selectedIds.has(column.getColId()))
      : bounds ? bounds.columns.slice(bounds.columnStart, bounds.columnEnd + 1)
        : selectionIncludesHeaders.current ? spreadsheetColumns(api) : [api.getFocusedCell()?.column].filter(column => column !== undefined);
    return spreadsheetClipboardHtml(text, columns.map(column => {
      const type = column.getColDef().type;
      return type === "numericColumn" || Array.isArray(type) && type.includes("numericColumn");
    }));
  }, [api, spreadsheetClipboardFormat]);
  const copySelection = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.nativeEvent)) return;
    const text = selectedText();
    if (text === undefined) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    const html = selectedClipboardHtml(text);
    if (html) event.clipboardData.setData("text/html", html);
    if (api && selectionRef.current?.ranges?.length) {
      const count = [...selectedSpreadsheetCells(api, selectionRef.current).values()].reduce((total, ids) => total + ids.size, 0);
      if (count) showCopyToast(`Скопировано ячеек: ${count}`);
      return;
    }
    const bounds = api ? spreadsheetBounds(api, selectionRef.current) : null;
    if (!bounds) {
      const columns = api && selectionIncludesHeaders.current && !selectionRef.current ? spreadsheetColumns(api).length : 0;
      if (columns) showCopyToast(`Скопировано: 1 × ${columns}`);
      return;
    }
    let copiedRows = selectionIncludesHeaders.current ? 1 : 0;
    for (let index = bounds.rowStart; index <= bounds.rowEnd; index++) {
      const node = api?.getDisplayedRowAtIndex(index);
      if (node?.data && !isStructuralSpreadsheetRow(node)) copiedRows++;
    }
    if (copiedRows) showCopyToast(`Скопировано: ${copiedRows} × ${bounds.columnEnd - bounds.columnStart + 1}`);
  }, [api, selectedText, showCopyToast, selectedClipboardHtml]);
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
    if (selectionRef.current.ranges?.length) {
      setSpreadsheetStatus("Для вставки выберите одну ячейку или один непрерывный диапазон");
      return false;
    }
    const bounds = spreadsheetBounds(api, selectionRef.current);
    if (!bounds) return false;
    const parsed = parseSpreadsheetText(text);
    const copiedHere = lastHeaderClipboard.current === serializeSpreadsheetText(parsed);
    const includesHeaders = selectionIncludesHeaders.current || copiedHere;
    const headers = copiedHere ? parsed[0] ?? [] : spreadsheetHeaderValues(api, selectionRef.current.columnModeRow ? bounds.columns.slice(bounds.columnStart, bounds.columnEnd + 1) : spreadsheetColumns(api));
    const matrix = includesHeaders ? stripSpreadsheetHeaderRow(parsed, headers) : parsed;
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
    if (selectionRef.current?.ranges?.length) {
      if (operation !== "clear") { setSpreadsheetStatus("Для заполнения выберите один непрерывный диапазон"); return false; }
      const changes: SpreadsheetBatch<TData>["rows"] = [];
      for (const [rowIndex, ids] of selectedSpreadsheetCells(api, selectionRef.current)) {
        const node = api.getDisplayedRowAtIndex(rowIndex);
        if (!node?.data) continue;
        const values: Record<string, string> = {};
        for (const columnId of ids) {
          if (requireAllWritable && !canWriteSpreadsheetCell?.(node.data, columnId)) { setSpreadsheetStatus("Выделение содержит ячейки, доступные только для просмотра"); return false; }
          values[columnId] = "";
        }
        changes.push({ row: node.data, rowIndex, values });
      }
      if (!changes.length) return false;
      const applied = onSpreadsheetBatch({ rows: changes, source: "clear" });
      if (applied) setSpreadsheetStatus("Выделенные ячейки очищены");
      return applied;
    }
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
    if (!(target instanceof Element) || !body.current?.contains(target) || target.closest("button, input, textarea, select, [role='combobox'], .actions-cell") || !api) return;
    const cell = target.closest<HTMLElement>(".ag-cell[col-id]");
    const rowElement = cell?.closest<HTMLElement>(".ag-row[row-index]");
    const columnId = cell?.getAttribute("col-id");
    const rowIndex = Number(rowElement?.getAttribute("row-index"));
    const rowNode = Number.isInteger(rowIndex) ? api.getDisplayedRowAtIndex(rowIndex) : null;
    if (!cell || cell.closest(".ag-root") !== body.current.querySelector(".ag-root") || !columnId || columnId === "actions" || columnId === "ag-Grid-SelectionColumn" || !rowNode?.data || rowNode.group || isStructuralSpreadsheetRow(rowNode)) return;
    event.preventDefault();
    event.stopPropagation();
    api.hidePopupMenu();
    const point = { rowIndex, columnId, rowId: rowNode.id };
    const existing = spreadsheetBounds(api, selectionRef.current);
    const clickedColumn = existing?.columns.findIndex(column => column.getColId() === columnId) ?? -1;
    const inside = selectionRef.current?.ranges?.length ? spreadsheetSelectionContains(api, selectionRef.current, point) : existing && rowIndex >= existing.rowStart && rowIndex <= existing.rowEnd && clickedColumn >= existing.columnStart && clickedColumn <= existing.columnEnd;
    const next = inside ? selectionRef.current! : { start: point, end: point };
    if (!inside) { selectionIncludesHeaders.current = false; setIncludeSelectedHeaders(false); }
    selectionRef.current = next;
    lastSelectionRef.current = next;
    setSelection(next);
    body.current?.focus({ preventScroll: true });
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      row: rowNode.data,
      rowIndex,
      columnId,
      value: String(api.getCellValue({ rowNode, colKey: columnId, useFormatter: true }) ?? ""),
      error: "",
    });
  }, [api]);
  const editSelectedCell = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!api || !onSpreadsheetEdit || !selectionRef.current || isInteractiveTarget(event.nativeEvent)) return;
    const current = selectionRef.current;
    const bounds = spreadsheetBounds(api, current);
    const wholeAxis = Boolean(current.rowModeColumnId || current.columnModeRow);
    if (!bounds || !wholeAxis && (bounds.rowStart !== bounds.rowEnd || bounds.columnStart !== bounds.columnEnd)) return;
    const active = spreadsheetActivePoint(current);
    const rowIndex = wholeAxis ? spreadsheetPointRowIndex(api, active) : bounds.rowStart;
    const columnId = wholeAxis ? active.columnId : bounds.columns[bounds.columnStart]?.getColId();
    const rowNode = rowIndex === null ? null : api.getDisplayedRowAtIndex(rowIndex);
    if (!rowNode?.data || rowIndex === null || !columnId || !onSpreadsheetEdit({ row: rowNode.data, rowIndex, columnId })) return;
    if (wholeAxis || current.ranges?.length) {
      selectionIncludesHeaders.current = false; setIncludeSelectedHeaders(false);
      const point = { rowIndex, rowId: rowNode.id, columnId };
      const next = { start: point, end: point };
      selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
    }
    rememberCellUndo(rowIndex, columnId);
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
  useUndoShortcut({
    rootRef: body,
    undo: undoSpreadsheetChange,
    redo: spreadsheetHistory ? () => { onSpreadsheetCancelEdit?.(); spreadsheetHistory.redo(); } : undefined,
    canUndo: spreadsheetHistory ? spreadsheetHistory.canUndo : Boolean(onSpreadsheetPaste),
    canRedo: spreadsheetHistory?.canRedo ?? false,
    disabled: Boolean(props.loading || rowOrder?.busy),
  });
  const handleSpreadsheetKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (historyShortcut(event.nativeEvent)) {
      if (dispatchUndoShortcut(event.nativeEvent)) event.stopPropagation();
      return;
    }
    if (event.key === "Escape") return; // The shared capture handler clears every selection together.
    if (isTableSelectAllShortcut(event.nativeEvent)) {
      event.preventDefault();
      const next = api && !api.isDestroyed() ? allSpreadsheetCells(api, spreadsheetColumns(api)) : null;
      dragging.current = false;
      selectionIncludesHeaders.current = Boolean(api && !api.isDestroyed() && spreadsheetColumns(api).length);
      setIncludeSelectedHeaders(selectionIncludesHeaders.current);
      selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
      setContextMenu(null);
      body.current?.focus({ preventScroll: true });
      setSpreadsheetStatus(next ? "Выделены все данные и заголовки таблицы. Ctrl+C или ⌘C — скопировать." : selectionIncludesHeaders.current ? "Выделены заголовки таблицы. Ctrl+C или ⌘C — скопировать." : "В таблице нет данных для выделения.");
      return;
    }
    if (selectWholeColumns(event) || selectWholeRows(event)) return;
    if (isInteractiveTarget(event.nativeEvent)) return;
    if (onSpreadsheetBatch) {
      const modifier = event.ctrlKey || event.metaKey;
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); changeRange("clear"); return; }
      if (modifier && (event.code === "KeyD" || event.code === "KeyR")) { event.preventDefault(); changeRange(event.code === "KeyD" ? "down" : "right"); return; }
      if (!modifier && !event.altKey && event.key.length === 1 && !event.nativeEvent.isComposing && api && selectionRef.current) {
        const current = selectionRef.current;
        const point = spreadsheetActivePoint(current, "start");
        const rowIndex = spreadsheetPointRowIndex(api, point);
        const node = rowIndex === null ? null : api.getDisplayedRowAtIndex(rowIndex);
        if (rowIndex !== null && node?.data && !isStructuralSpreadsheetRow(node) && onSpreadsheetEdit?.({ row: node.data, rowIndex, columnId: point.columnId, initialValue: event.key })) {
          if (current.rowModeColumnId || current.columnModeRow || current.ranges?.length) {
            selectionIncludesHeaders.current = false; setIncludeSelectedHeaders(false);
            const next = { start: point, end: point };
            selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
          }
          event.preventDefault(); return;
        }
      }
    }
    if (moveSelection(event)) return;
    if (event.key === "Enter" || event.key === "F2") editSelectedCell(event);
  };
  return <div className="localized-grid">
    {copyToast}
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
    <div className="localized-grid-body ag-grid-empty-rows" ref={body} role="grid" tabIndex={0} onContextMenu={openContextMenu} onPointerDownCapture={(event) => {
      const target = event.target;
      if (event.button === 0 && event.shiftKey && selectionRef.current?.columnModeRow && api && target instanceof Element && !isTableRowSelectionBlocked(target) && target.closest(".localized-grid-body") === event.currentTarget) {
        const columnId = target.closest(".ag-cell[col-id], .ag-header-cell[col-id]")?.getAttribute("col-id");
        const current = selectionRef.current;
        const next = columnId ? wholeSpreadsheetColumns(api, current.start.columnId, columnId, spreadsheetActivePoint(current)) : null;
        if (next) {
          event.preventDefault(); event.stopPropagation();
          dragging.current = true; selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
          body.current?.focus({ preventScroll: true });
          return;
        }
      }
      if (event.button === 0 && event.shiftKey && selectionRef.current?.rowModeColumnId && api && target instanceof Element && !isTableRowSelectionBlocked(target)) {
        const row = target.closest<HTMLElement>(".ag-row[row-index]");
        const rowIndex = Number(row?.getAttribute("row-index"));
        if (row && target.closest(".localized-grid-body") === event.currentTarget && Number.isInteger(rowIndex)) {
          const point = { rowIndex, rowId: api.getDisplayedRowAtIndex(rowIndex)?.id, columnId: selectionRef.current.rowModeColumnId };
          const next = wholeSpreadsheetRows(api, selectionRef.current.start, point, selectionRef.current.rowModeColumnId);
          if (next) {
            event.preventDefault(); event.stopPropagation();
            dragging.current = true; selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
            body.current?.focus({ preventScroll: true });
            return;
          }
        }
      }
      const additive = (event.metaKey || event.ctrlKey) && !event.shiftKey;
      const editingInput = target instanceof Element && Boolean(target.closest("input,textarea,select,[contenteditable='true'],[role='textbox']"));
      if (api && target instanceof Element && !(additive ? editingInput : isInteractiveTarget(event.nativeEvent)) && event.button === 0) {
        const cell = target.closest<HTMLElement>(".ag-cell[col-id]");
        const rowElement = cell?.closest<HTMLElement>(".ag-row[row-index]");
        const columnId = cell?.getAttribute("col-id");
        const rowIndex = Number(rowElement?.getAttribute("row-index"));
        const node = Number.isInteger(rowIndex) ? api.getDisplayedRowAtIndex(rowIndex) : undefined;
        const column = columnId ? api.getColumn(columnId) : undefined;
        if (rowElement && node && column && columnId && !["actions", "rowOrder", "ag-Grid-SelectionColumn"].includes(columnId) && !isStructuralSpreadsheetRow(node)) {
          // AG cell events are deferred. Capture the native pointer synchronously
          // so its delayed mousedown cannot revive a drag after pointerup.
          selectCell({ api, rowIndex, node, column, event: event.nativeEvent });
          if (additive) { event.preventDefault(); event.stopPropagation(); }
        }
      }
    }} onClickCapture={(event) => {
      const target = event.target;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && target instanceof Element && !target.closest("input,textarea,select,[contenteditable='true'],[role='textbox']")) {
        const columnId = target.closest(".ag-cell[col-id]")?.getAttribute("col-id");
        if (columnId && !["actions", "rowOrder", "ag-Grid-SelectionColumn"].includes(columnId)) { event.preventDefault(); event.stopPropagation(); return; }
      }
      if (event.shiftKey && target instanceof Element && !isTableRowSelectionBlocked(target) && (selectionRef.current?.rowModeColumnId && target.closest(".ag-row") || selectionRef.current?.columnModeRow && target.closest(".ag-cell[col-id], .ag-header-cell[col-id]"))) {
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (!(target instanceof Element) || !target.closest(".ag-editable-cell-menu")) return;
      const cell = target.closest<HTMLElement>(".ag-cell[col-id]");
      const row = cell?.closest<HTMLElement>(".ag-row[row-index]");
      const columnId = cell?.getAttribute("col-id");
      const rowIndex = Number(row?.getAttribute("row-index"));
      if (api && row && columnId && Number.isInteger(rowIndex) && !isStructuralSpreadsheetRow(api.getDisplayedRowAtIndex(rowIndex))) {
        // Opening a cell's menu is an edit of that cell, even though the button
        // is interactive. Restore this origin when its portal editor closes.
        const point = { rowIndex, columnId, rowId: api.getDisplayedRowAtIndex(rowIndex)?.id };
        const next = { start: point, end: point };
        dragging.current = false;
        selectionIncludesHeaders.current = false;
        setIncludeSelectedHeaders(false);
        selectionRef.current = next;
        lastSelectionRef.current = next;
        setSelection(next);
        rememberCellUndo(rowIndex, columnId);
      }
    }} onPointerDown={clearSelectionOnEmptySpace} onCopy={copySelection} onCut={onSpreadsheetBatch ? event => {
      if (isInteractiveTarget(event.nativeEvent)) return;
      const text = selectedText();
      if (text === undefined) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
      changeRange("clear", true);
    } : undefined} onPaste={pasteSelection} onKeyDown={onSpreadsheetBatch ? undefined : handleSpreadsheetKeyDown} onKeyDownCapture={event => {
      if (!onSpreadsheetBatch && !isTableSelectAllShortcut(event.nativeEvent) && !tableRowSelectionIntent(event.nativeEvent) && !tableColumnSelectionIntent(event.nativeEvent) && !historyShortcut(event.nativeEvent)) return;
      handleSpreadsheetKeyDown(event);
      if (event.defaultPrevented) event.stopPropagation();
    }} aria-label="Таблица. Ctrl/⌘ с кликом добавляет или убирает отдельные ячейки. Ctrl+A или ⌘A выделяет все данные; Ctrl+C или ⌘C копирует выделенное. Стрелки перемещают выбранную ячейку, Shift со стрелками расширяет выделение. Двойной клик, Enter или F2 открывает редактирование. Доступны вставка и отмена через Ctrl+Z как в Excel.">
      {spreadsheetStatus && <span className="sr-only" aria-live="polite">{spreadsheetStatus}</span>}
      {/* AG's global suppression also blocks header menus. Disable only its body
          items: cells use our scoped clipboard menu, headers keep native actions. */}
      <AgGridReact<TData> {...props} rowSelection={rowSelection} selectionColumnDef={selectionColumnDef} rowData={orderedRowData} columnDefs={orderedColumns} defaultColDef={enhancedDefaultColDef} popupParent={requestedPopupParent ?? popupParent} suppressContextMenu={false} getContextMenuItems={() => []} columnMenu="new" getMainMenuItems={props.getMainMenuItems ?? tableColumnMenuItems} suppressMovableColumns enableFilterHandlers localeText={gridLocaleRu}
      postProcessPopup={params => { trackFilterEscape(params); props.postProcessPopup?.(params); }}
      sendToClipboard={props.sendToClipboard ?? (({ data }) => {
        void writeTableClipboardText(data, selectedClipboardHtml(data))
          .then(() => showCopyToast("Скопировано"), () => showCopyToast("Не удалось скопировать"));
      })}
      onColumnHeaderContextMenu={event => { closeTableContextMenus(); setContextMenu(null); props.onColumnHeaderContextMenu?.(event); }}
      rowDragManaged={false} rowDragMultiRow={selectionDrag || props.rowDragMultiRow} suppressRowDrag={rowMoveDisabled || Boolean(rowOrder?.busy)}
      onRowDragEnter={event => {
        const point = rowDragPoint(event.event);
        if (body.current && point && canDragSelection() && event.node.isSelected() === true) {
          activeRowDrag.current = event;
          paintRowDropIndicator();
          if (rowDragScroll.current) rowDragScroll.current.update(point);
          else {
            let session: ReturnType<typeof startRowDragAutoScroll> = null;
            // AG dispatches rowDragEnd asynchronously. Its own completion event
            // clears the preview; the earlier document mouseup must not erase
            // the accepted gesture before the final drop callback runs.
            session = startRowDragAutoScroll(body.current, point, "grid", () => { if (rowDragScroll.current === session) rowDragScroll.current = null; });
            rowDragScroll.current = session;
          }
        }
        props.onRowDragEnter?.(event);
      }}
      onRowDragMove={event => {
        if (activeRowDrag.current) { activeRowDrag.current = event; paintRowDropIndicator(); }
        const point = rowDragPoint(event.event); if (point) rowDragScroll.current?.update(point);
        props.onRowDragMove?.(event);
      }}
      onRowDragLeave={event => { clearRowDropIndicator(); props.onRowDragLeave?.(event); }}
      onRowDragCancel={event => { stopRowDragScroll(); props.onRowDragCancel?.(event); }}
      onDragStopped={event => { stopRowDragScroll(); props.onDragStopped?.(event); }}
      onDragCancelled={event => { stopRowDragScroll(); props.onDragCancelled?.(event); }}
      onRowDragEnd={(event) => {
        const target = activeRowDrag.current && body.current && resolveGridRowDropTarget(body.current, event, resolveRowDragMove);
        stopRowDragScroll();
        if (target) void finishRowMove(target.operation);
      }}
      onGridReady={(event) => { setApi(event.api); updateSummary(event.api); props.onGridReady?.(event); }}
      onSelectionChanged={event => { if (props.rowSelection) props.onSelectionChanged?.(event); }}
      onCellMouseDown={props.onCellMouseDown}
      onCellMouseOver={(event) => { extendSelection(event); props.onCellMouseOver?.(event); }}
      onCellDoubleClicked={(event) => { if (access?.edit === false) return; if (event.rowIndex !== null && !isInteractiveTarget(event.event)) rememberCellUndo(event.rowIndex, event.column.getColId()); props.onCellDoubleClicked?.(event); }}
      onBodyScroll={(event) => { paintSelection(event.api); paintRowDropIndicator(); props.onBodyScroll?.(event); }}
      onDisplayedColumnsChanged={event => { paintSelection(event.api); props.onDisplayedColumnsChanged?.(event); }}
      onModelUpdated={(event) => { updateSummary(event.api); paintSelection(event.api); paintRowDropIndicator(); refreshRowNumbers(event.api); props.onModelUpdated?.(event); }}
      onRowGroupOpened={(event) => { clearSelection(); props.onRowGroupOpened?.(event); }}
      onFilterChanged={(event) => { clearSelection(); updateSummary(event.api); props.onFilterChanged?.(event); }}
      onSortChanged={(event) => { clearSelection(); updateSummary(event.api); props.onSortChanged?.(event); }}
    />{contextMenu && <TableContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      caption={api?.getColumnDef(contextMenu.columnId)?.headerName ?? "Ячейка"}
      value={contextMenu.value}
      error={contextMenu.error}
      onClose={() => setContextMenu(null)}
      actions={[
        ...closeContextActionsAfterSelection(getSpreadsheetContextActions?.(contextMenu) ?? [], () => setContextMenu(null)),
        { label: "Копировать / вставить", section: "Работа с таблицей", onSelect: () => {}, children: [
        { label: "Копировать ячейку", shortcut: "Ctrl+C", onSelect: async () => {
          try {
            const text = selectedText() ?? contextMenu.value;
            await writeTableClipboardText(text, selectedClipboardHtml(text));
            showCopyToast("Скопировано");
            setContextMenu(null);
          } catch {
            setContextMenu(current => current ? { ...current, error: "Не удалось скопировать. Разрешите доступ к буферу обмена." } : current);
          }
        } },
        ...(onSpreadsheetPaste || onSpreadsheetBatch ? [{ label: "Вставить в ячейку", shortcut: "Ctrl+V", disabled: !onSpreadsheetPaste && !onSpreadsheetBatch, title: onSpreadsheetPaste || onSpreadsheetBatch ? undefined : "Таблица доступна только для просмотра", onSelect: async () => { try { const changed = pasteText(await navigator.clipboard.readText()); if (changed) setContextMenu(null); else setContextMenu((current) => current ? { ...current, error: "Эту ячейку нельзя изменить или значение не подходит." } : current); } catch { setContextMenu((current) => current ? { ...current, error: "Не удалось прочитать буфер обмена. Разрешите доступ в браузере." } : current); } } }] satisfies TableContextMenuAction[] : []),
        ...(onSpreadsheetBatch ? [
          { label: "Вырезать диапазон", shortcut: "Ctrl+X", onSelect: async () => { try { await navigator.clipboard.writeText(selectedText() ?? contextMenu.value); changeRange("clear", true); setContextMenu(null); } catch { setContextMenu(current => current ? { ...current, error: "Не удалось записать в буфер обмена." } : current); } } },
          { label: "Очистить диапазон", shortcut: "Delete", onSelect: () => { changeRange("clear"); setContextMenu(null); } },
          { label: "Заполнить вниз", shortcut: "Ctrl+D", onSelect: () => { changeRange("down"); setContextMenu(null); } },
          { label: "Заполнить вправо", shortcut: "Ctrl+R", onSelect: () => { changeRange("right"); setContextMenu(null); } },
        ] satisfies TableContextMenuAction[] : []),
        ] },
        ...(onSpreadsheetEdit ? [{ label: "Редактировать ячейку", shortcut: "Enter", separatorBefore: true, onSelect: () => {
          if (onSpreadsheetEdit?.(contextMenu)) {
            const point = { rowIndex: contextMenu.rowIndex, rowId: api?.getDisplayedRowAtIndex(contextMenu.rowIndex)?.id, columnId: contextMenu.columnId };
            const next = { start: point, end: point };
            dragging.current = false; selectionIncludesHeaders.current = false; setIncludeSelectedHeaders(false);
            selectionRef.current = next; lastSelectionRef.current = next; setSelection(next);
            rememberCellUndo(contextMenu.rowIndex, contextMenu.columnId); setSpreadsheetStatus("Редактирование ячейки"); setContextMenu(null);
          } else setContextMenu((current) => current ? { ...current, error: "Эта ячейка недоступна для редактирования." } : current);
        } }] satisfies TableContextMenuAction[] : []),
        ...(rowSelection ? [{ label: api?.getDisplayedRowAtIndex(contextMenu.rowIndex)?.isSelected() ? "Снять выделение строки" : "Выбрать строку для действий", separatorBefore: true, disabled: api?.getDisplayedRowAtIndex(contextMenu.rowIndex)?.selectable === false, onSelect: () => { const node = api?.getDisplayedRowAtIndex(contextMenu.rowIndex); if (node) node.setSelected(!node.isSelected(), !node.isSelected()); setContextMenu(null); } } satisfies TableContextMenuAction] : []),
        ...(getRowOrderId(contextMenu.row) ? rowMoves.getActions(getRowOrderId(contextMenu.row)!, api?.getSelectedRows().map(getRowOrderId).filter((id): id is RowOrderId => Boolean(id)) ?? [], () => setContextMenu(null)) : []),
      ]}
    />}</div>
  </div>;
}
