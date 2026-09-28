"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact, useGridFilterDisplay, type AgGridReactProps, type CustomFilterDisplayProps, type CustomFloatingFilterDisplayProps } from "ag-grid-react";
import type { CellMouseDownEvent, CellMouseOverEvent, ColumnFilter, GridApi, IRowNode } from "ag-grid-community";
import { describePersonnelFilter, filterValueKey, isConditionValid, matchesPersonnelFilter, normalizeFilterText, numberOperations, textOperations, type FilterCondition, type PersonnelFilterModel } from "./gridFilterModel";
import { gridLocaleRu } from "./gridLocaleRu";
import { CustomSelect } from "./CustomSelect";
import "./gridFilters.css";

type FilterRow = { kind: "entry" | "edit" | "draft" };
type FilterProps = CustomFilterDisplayProps<FilterRow, unknown, PersonnelFilterModel> & { kind?: "text" | "number" };

function ValueCheckbox({ checked, mixed = false, onChange, children }: { checked: boolean; mixed?: boolean; onChange: (checked: boolean) => void; children: React.ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="grid-value-option"><input ref={ref} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{children}</label>;
}

function PersonnelFilter(props: FilterProps) {
  const { api, column, colDef, getValue, doesRowPassOtherFilter, onStateChange, state } = props;
  const kind = props.kind ?? "text";
  const empty: PersonnelFilterModel = { filterType: "personnel", kind, values: null, conditions: [], operator: "AND" };
  const model = state.model ?? empty;
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const valuesList = useRef<HTMLDivElement>(null);
  useGridFilterDisplay({ afterGuiAttached: () => {
    setSearch(""); setScrollTop(0); setRevision((value) => value + 1);
    if (valuesList.current) valuesList.current.scrollTop = 0;
    searchInput.current?.focus();
  } });
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    api.addEventListener("rowDataUpdated", refresh);
    api.addEventListener("filterChanged", refresh);
    return () => { if (!api.isDestroyed()) { api.removeEventListener("rowDataUpdated", refresh); api.removeEventListener("filterChanged", refresh); } };
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
      return kind === "number" ? Number(a.value) - Number(b.value) : a.value.localeCompare(b.value, "ru", { numeric: true });
    });
    // revision refreshes values when another column's filter or the row data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, getValue, doesRowPassOtherFilter, kind, revision]);
  const matching = values.filter(({ value }) => normalizeFilterText(value || "(Пустые)").includes(normalizeFilterText(search)));
  const selected = new Set(model.values ?? values.map(({ value }) => value));
  const checkedCount = matching.filter(({ value }) => selected.has(value)).length;
  const update = (patch: Partial<PersonnelFilterModel>) => {
    const next = { ...model, ...patch };
    onStateChange({ model: next.values === null && !next.conditions.length ? null : next,
      valid: next.conditions.every((condition) => isConditionValid(condition, kind)) });
  };
  const setValues = (selection: Set<string>) => update({ values: [...selection] });
  const updateCondition = (index: number, patch: Partial<FilterCondition>) => update({
    conditions: model.conditions.map((condition, current) => current === index ? { ...condition, ...patch } : condition),
  });
  const valid = model.conditions.every((condition) => isConditionValid(condition, kind));
  // Keep the checklist responsive for large employee directories; render only visible rows.
  const start = Math.max(0, Math.floor(scrollTop / 34) - 3);
  const visibleValues = matching.slice(start, start + 14);
  const previewCount = useMemo(() => {
    let count = 0;
    api.forEachNode((node) => {
      if (node.data?.kind === "entry" && doesRowPassOtherFilter(node) && matchesPersonnelFilter(getValue(node), model)) count++;
    });
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, getValue, doesRowPassOtherFilter, state.model, revision]);
  return <div className="personnel-filter" aria-label={`Настройка фильтра: ${colDef.headerName}`}>
    <div className="grid-filter-heading"><strong>{colDef.headerName}</strong><span>{kind === "number" ? "Числовой фильтр" : "Фильтр по значениям"}</span></div>
    <div className="grid-filter-sort"><button type="button" onClick={() => api.applyColumnState({ state: [{ colId: column.getColId(), sort: "asc" }], defaultState: { sort: null } })}>{kind === "number" ? "По возрастанию ↑" : "От А до Я ↑"}</button><button type="button" onClick={() => api.applyColumnState({ state: [{ colId: column.getColId(), sort: "desc" }], defaultState: { sort: null } })}>{kind === "number" ? "По убыванию ↓" : "От Я до А ↓"}</button></div>
    <label className="grid-filter-search"><span className="sr-only">Поиск значений</span><input ref={searchInput} placeholder="Найти значение…" value={search} onChange={(event) => { setSearch(event.target.value); setScrollTop(0); if (valuesList.current) valuesList.current.scrollTop = 0; }} /></label>
    <div className="grid-filter-selection"><ValueCheckbox checked={matching.length > 0 && checkedCount === matching.length} mixed={checkedCount > 0 && checkedCount < matching.length} onChange={(checked) => {
      const next = new Set(selected);
      matching.forEach(({ value }) => { if (checked) next.add(value); else next.delete(value); });
      setValues(next);
    }}><span>{search ? "Выбрать найденные" : "Выбрать все"}</span></ValueCheckbox><button type="button" onClick={() => update({ values: null })}>Все значения</button></div>
    {search && matching.length > 0 && <button className="grid-filter-only" type="button" onClick={() => update({ values: matching.map(({ value }) => value) })}>Оставить только найденные ({matching.length})</button>}
    <div className="grid-filter-values" ref={valuesList} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      {matching.length ? <div style={{ height: matching.length * 34, position: "relative" }}><div style={{ position: "absolute", top: start * 34, left: 0, right: 0 }}>
        {visibleValues.map(({ value, count }) => <ValueCheckbox key={value} checked={selected.has(value)} onChange={(checked) => { const next = new Set(selected); if (checked) next.add(value); else next.delete(value); setValues(next); }}><span title={value || "(Пустые)"}>{value || "(Пустые)"}</span><small>{count}</small></ValueCheckbox>)}
      </div></div> : <p>Значения не найдены</p>}
    </div>
    <div className="grid-filter-conditions"><div className="grid-filter-condition-heading"><strong>Условия</strong><span>Дополняют выбор значений</span></div>
      {model.conditions.length > 1 && <div className="grid-filter-join"><span>Совпадение</span><CustomSelect ariaLabel="Объединение условий" value={model.operator} onChange={(operator) => update({ operator: operator as "AND" | "OR" })} options={[{ value: "AND", label: "Всех условий (И)" }, { value: "OR", label: "Любого условия (ИЛИ)" }]} /></div>}
      {model.conditions.map((condition, index) => <div className="grid-filter-condition" key={index}>
        <div><CustomSelect ariaLabel={`Условие ${index + 1}`} value={condition.type} onChange={(type) => updateCondition(index, { type })} options={(kind === "number" ? numberOperations : textOperations).map(([operation, label]) => ({ value: operation, label }))} /><button type="button" aria-label={`Удалить условие ${index + 1}`} onClick={() => update({ conditions: model.conditions.filter((_, current) => current !== index) })}>×</button></div>
        {condition.type !== "blank" && condition.type !== "notBlank" && <div><input aria-label={`Значение условия ${index + 1}`} inputMode={kind === "number" ? "decimal" : "text"} placeholder={condition.type === "inRange" ? "От" : "Введите значение"} value={condition.value} onChange={(event) => updateCondition(index, { value: event.target.value })} />{condition.type === "inRange" && <input aria-label={`Верхняя граница ${index + 1}`} inputMode="decimal" placeholder="До включительно" value={condition.to ?? ""} onChange={(event) => updateCondition(index, { to: event.target.value })} />}</div>}
      </div>)}
      {model.conditions.length < 4 && <button className="grid-filter-add" type="button" onClick={() => update({ conditions: [...model.conditions, { type: kind === "number" ? "equals" : "contains", value: "" }] })}>+ Добавить условие</button>}
    </div>
    <p className={valid ? "grid-filter-preview" : "grid-filter-validation"} role="status">{valid ? `Подходит строк: ${previewCount}` : kind === "number" ? "Введите числа. В диапазоне «От» не должно превышать «До»." : "Введите текст для каждого условия."}</p>
  </div>;
}

export const personnelColumnFilter: ColumnFilter<FilterRow, unknown, unknown, PersonnelFilterModel> = {
  component: PersonnelFilter,
  doesFilterPass: ({ node, model, handlerParams }) => node.data?.kind !== "entry" || matchesPersonnelFilter(handlerParams.getValue(node), model),
};

export const personnelFilterParams = { buttons: ["reset", "cancel", "apply"], closeOnApply: true };

export function PersonnelFloatingFilter(props: CustomFloatingFilterDisplayProps<FilterRow, unknown, PersonnelFilterModel, { kind?: "text" | "number" }>) {
  const kind = props.filterParams?.kind ?? "text";
  const condition = props.model?.conditions.find((item) => item.type === "contains" || item.type === "equals");
  const value = condition?.value ?? "";
  const update = (nextValue: string) => {
    const current = props.model ?? { filterType: "personnel", kind, values: null, conditions: [], operator: "AND" as const };
    const conditions = current.conditions.filter((item) => item !== condition);
    if (nextValue) conditions.unshift({ type: kind === "number" ? "equals" : "contains", value: nextValue });
    props.onModelChange(current.values === null && conditions.length === 0 ? null : { ...current, kind, conditions });
  };
  return <div className="personnel-floating-filter">
    <input aria-label={`Быстрый фильтр: ${props.column.getColDef().headerName ?? props.column.getColId()}`} inputMode={kind === "number" ? "decimal" : "text"} value={value} onChange={(event) => update(event.target.value)} placeholder="Фильтр…" />
    <button type="button" onClick={props.showParentFilter} title="Открыть выбор значений" aria-label={`Открыть расширенный фильтр: ${props.column.getColDef().headerName ?? props.column.getColId()}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg></button>
  </div>;
}

export type SpreadsheetPastePayload<TData> = {
  row: TData;
  rowIndex: number;
  values: Record<string, string>;
};

type SpreadsheetPoint = { rowIndex: number; columnId: string };
type SpreadsheetSelection = { start: SpreadsheetPoint; end: SpreadsheetPoint };
type LocalizedGridProps<TData extends FilterRow> = AgGridReactProps<TData> & {
  onSpreadsheetPaste?: (payload: SpreadsheetPastePayload<TData>) => boolean;
  spreadsheetSelectionResetKey?: string;
};

function isInteractiveTarget(event?: Event | null) {
  const target = event?.target;
  return target instanceof Element && Boolean(target.closest("button, input, textarea, select, [role='combobox'], .actions-cell"));
}

function spreadsheetBounds<TData>(grid: GridApi<TData>, current: SpreadsheetSelection | null) {
  if (!current) return null;
  const columns = grid.getAllDisplayedColumns().filter((column) => column.getColId() !== "actions");
  const startColumn = columns.findIndex((column) => column.getColId() === current.start.columnId);
  const endColumn = columns.findIndex((column) => column.getColId() === current.end.columnId);
  if (startColumn < 0 || endColumn < 0) return null;
  return {
    columns,
    rowStart: Math.min(current.start.rowIndex, current.end.rowIndex),
    rowEnd: Math.max(current.start.rowIndex, current.end.rowIndex),
    columnStart: Math.min(startColumn, endColumn),
    columnEnd: Math.max(startColumn, endColumn),
  };
}

export function LocalizedGrid<TData extends FilterRow>({ onSpreadsheetPaste, spreadsheetSelectionResetKey = "", ...props }: LocalizedGridProps<TData>) {
  const [api, setApi] = useState<GridApi<TData> | null>(null);
  const [summary, setSummary] = useState<{ count: number; total: number; filters: { id: string; name: string; description: string }[] }>({ count: 0, total: 0, filters: [] });
  const [selection, setSelection] = useState<SpreadsheetSelection | null>(null);
  const [spreadsheetStatus, setSpreadsheetStatus] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const selectionRef = useRef(selection);
  const dragging = useRef(false);
  const updateSummary = useCallback((grid: GridApi<TData>) => {
    let count = 0, total = 0;
    grid.forEachNode((node: IRowNode<TData>) => { if (node.data?.kind === "entry") total++; });
    grid.forEachNodeAfterFilter((node: IRowNode<TData>) => { if (node.data?.kind === "entry") count++; });
    const filters = Object.entries(grid.getFilterModel()).map(([id, model]) => ({ id, name: grid.getColumnDef(id)?.headerName ?? id, description: describePersonnelFilter(model) }));
    setSummary({ count, total, filters });
  }, []);
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
  useEffect(() => { selectionRef.current = selection; if (api) paintSelection(api); }, [api, paintSelection, selection]);
  useEffect(() => {
    if (!spreadsheetStatus) return;
    const timeout = window.setTimeout(() => setSpreadsheetStatus(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [spreadsheetStatus]);
  const selectCell = useCallback((event: CellMouseDownEvent<TData>) => {
    if (event.rowIndex === null || event.column.getColId() === "actions" || isInteractiveTarget(event.event)) return;
    const point = { rowIndex: event.rowIndex, columnId: event.column.getColId() };
    const mouseEvent = event.event as MouseEvent | undefined;
    const start = mouseEvent?.shiftKey && selectionRef.current ? selectionRef.current.start : point;
    dragging.current = true;
    const next = { start, end: point };
    selectionRef.current = next;
    setSelection(next);
    body.current?.focus({ preventScroll: true });
  }, []);
  const extendSelection = useCallback((event: CellMouseOverEvent<TData>) => {
    if (!dragging.current || event.rowIndex === null || event.column.getColId() === "actions" || !selectionRef.current) return;
    const next = { start: selectionRef.current.start, end: { rowIndex: event.rowIndex, columnId: event.column.getColId() } };
    selectionRef.current = next;
    setSelection(next);
  }, []);
  const clearSelection = useCallback(() => {
    dragging.current = false;
    selectionRef.current = null;
    setSelection(null);
    setSpreadsheetStatus("");
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(clearSelection);
    return () => cancelAnimationFrame(frame);
  }, [clearSelection, spreadsheetSelectionResetKey]);
  useEffect(() => {
    const clearSelectionOutsideGrid = (event: PointerEvent) => {
      const target = event.target;
      if (!selectionRef.current || !(target instanceof Node) || body.current?.contains(target)) return;
      clearSelection();
    };
    document.addEventListener("pointerdown", clearSelectionOutsideGrid);
    return () => document.removeEventListener("pointerdown", clearSelectionOutsideGrid);
  }, [clearSelection]);
  const copySelection = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!api || !selectionRef.current || isInteractiveTarget(event.nativeEvent)) return;
    const bounds = spreadsheetBounds(api, selectionRef.current);
    if (!bounds) return;
    const lines: string[] = [];
    for (let rowIndex = bounds.rowStart; rowIndex <= bounds.rowEnd; rowIndex++) {
      const rowNode = api.getDisplayedRowAtIndex(rowIndex);
      if (!rowNode) continue;
      lines.push(bounds.columns.slice(bounds.columnStart, bounds.columnEnd + 1).map((column) => String(api.getCellValue({ rowNode, colKey: column, useFormatter: true }) ?? "").replaceAll("\t", " ").replaceAll(/\r?\n/g, " ")).join("\t"));
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", lines.join("\n"));
    setSpreadsheetStatus(`Скопировано: ${bounds.rowEnd - bounds.rowStart + 1} × ${bounds.columnEnd - bounds.columnStart + 1}`);
  }, [api]);
  const pasteSelection = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!api || !onSpreadsheetPaste || !selectionRef.current || isInteractiveTarget(event.nativeEvent)) return;
    const bounds = spreadsheetBounds(api, selectionRef.current);
    if (!bounds) return;
    const lines = event.clipboardData.getData("text/plain").replace(/\r/g, "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const matrix = lines.map((line) => line.split("\t"));
    if (!matrix.length) return;
    const sourceRows = matrix.length;
    const sourceColumns = Math.max(...matrix.map((line) => line.length));
    const selectedRows = bounds.rowEnd - bounds.rowStart + 1;
    const selectedColumns = bounds.columnEnd - bounds.columnStart + 1;
    const targetRows = sourceRows === 1 ? selectedRows : sourceRows;
    const targetColumns = sourceColumns === 1 ? selectedColumns : sourceColumns;
    let changed = 0;
    for (let offset = 0; offset < targetRows; offset++) {
      const rowIndex = bounds.rowStart + offset;
      const rowNode = api.getDisplayedRowAtIndex(rowIndex);
      if (!rowNode?.data) continue;
      const values: Record<string, string> = {};
      for (let index = 0; index < targetColumns; index++) {
        const column = bounds.columns[bounds.columnStart + index];
        const columnId = column?.getColId();
        if (columnId && columnId !== "number" && columnId !== "actions") values[columnId] = matrix[offset % sourceRows]?.[index % sourceColumns] ?? "";
      }
      if (Object.keys(values).length && onSpreadsheetPaste({ row: rowNode.data, rowIndex, values })) changed++;
    }
    event.preventDefault();
    if (!changed) {
      setSpreadsheetStatus("В выбранных ячейках нет доступных для редактирования полей");
      return;
    }
    setSpreadsheetStatus(`Вставлено строк: ${changed}`);
  }, [api, onSpreadsheetPaste]);
  return <div className="localized-grid">
    {summary.filters.length > 0 && <div className="grid-filter-summary" aria-label="Активные фильтры">
      <span aria-live="polite">Строк: <b>{summary.count}</b> из {summary.total}</span>
      <div className="grid-filter-chips">{summary.filters.map((filter) => <button key={filter.id} type="button" title={`${filter.name}: ${filter.description}. Нажмите для сброса.`} aria-label={`Сбросить фильтр: ${filter.name}`} onClick={async () => { if (api) { await api.setColumnFilterModel(filter.id, null); api.onFilterChanged(); } }}><span>{filter.name}: {filter.description}</span><span aria-hidden="true">×</span></button>)}</div>
      <button className="grid-filter-clear" type="button" onClick={() => api?.setFilterModel(null)}>Сбросить все</button>
    </div>}
    <div className="localized-grid-body" ref={body} role="grid" tabIndex={0} onCopy={copySelection} onPaste={pasteSelection} onKeyDown={(event) => { if (event.key === "Escape") clearSelection(); }} aria-label="Таблица. Ячейки можно выделять мышью и копировать как в Excel.">
      {spreadsheetStatus && <span className="sr-only" aria-live="polite">{spreadsheetStatus}</span>}
      <AgGridReact<TData> {...props} suppressMovableColumns enableFilterHandlers localeText={gridLocaleRu}
      onGridReady={(event) => { setApi(event.api); updateSummary(event.api); props.onGridReady?.(event); }}
      onCellMouseDown={(event) => { selectCell(event); props.onCellMouseDown?.(event); }}
      onCellMouseOver={(event) => { extendSelection(event); props.onCellMouseOver?.(event); }}
      onBodyScroll={(event) => { paintSelection(event.api); props.onBodyScroll?.(event); }}
      onModelUpdated={(event) => { updateSummary(event.api); paintSelection(event.api); props.onModelUpdated?.(event); }}
      onFilterChanged={(event) => { updateSummary(event.api); props.onFilterChanged?.(event); }}
    /></div>
  </div>;
}
