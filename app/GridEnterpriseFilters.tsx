"use client";

import { useEffect, useRef, useState } from "react";
import { useGridFilterDisplay, type CustomFilterDisplayProps } from "ag-grid-react";
import type { ColumnFilter, GridApi, IFilterParams, ISetFilterParams, IMultiFilterDef, IMultiFilterParams } from "ag-grid-community";
import { CustomSelect } from "./CustomSelect";
import { useGridFilterPopup } from "./useGridFilterPopup";
import { compareGridValues, filterDateKey, normalizeFilterText, type PersonnelFilterModel } from "./gridFilterModel";
import { IMPORT_ORDER_COLUMN, importOrderSortOption } from "./importOrderSorting";
import { dateTreeSetFilterParams } from "./DateTreeSetFilter";
import { ChecklistFilterHeader, checklistValuesChild } from "./ChecklistSetFilter";
import "./compactGridFilters.css";

type Sort = { columnId: string; sort: "asc" | "desc" | null };
type SortOption = Sort & { label: string };
export type EnterpriseFilterOptions = {
  presentation?: "full" | "compact" | "checklist";
  includeConditions?: boolean;
  kind?: PersonnelFilterModel["kind"];
  rowSortOptions?: readonly SortOption[];
  valueFormatter?: ISetFilterParams["valueFormatter"];
  stateFilter?: {
    values: readonly { value: string; label: string }[];
    getValue: (data: unknown) => string[];
  };
};
type SortProps = CustomFilterDisplayProps & EnterpriseFilterOptions;
const keyOf = (sort: Sort) => `${sort.columnId}:${sort.sort ?? "none"}`;
type SortLevel = { columnId: string; sort: "asc" | "desc" };
const readSorts = (api: GridApi): SortLevel[] => api.getColumnState()
  .filter((item): item is typeof item & { sort: "asc" | "desc" } => item.sort === "asc" || item.sort === "desc")
  .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
  .map(item => ({ columnId: item.colId, sort: item.sort }));

/** A UI-only child of Multi Filter. The actual filtering is done by AG Grid. */
function EnterpriseFilterSorting(props: SortProps) {
  const { root: popupRef, attach: attachPopup } = useGridFilterPopup<HTMLDivElement>(props);
  const { api, column, colDef } = props;
  const pending = useRef<SortLevel[] | null>(null);
  const [levels, setLevels] = useState<SortLevel[]>(() => readSorts(api));
  const presets = props.rowSortOptions ?? (api.getColumn(IMPORT_ORDER_COLUMN) ? [importOrderSortOption, { label: "Ручной порядок", columnId: "", sort: null }] : undefined);
  const available = (api.getColumns() ?? []).filter(item => item.isSortable()).map(item => ({
    value: item.getColId(), label: item.getColDef().headerName || item.getColId(),
  }));
  const update = (next: SortLevel[]) => {
    setLevels(next);
    pending.current = next;
    props.onUiChange();
  };
  const changeCurrentSort = (sort: "asc" | "desc" | null) => {
    const index = levels.findIndex(item => item.columnId === column.getColId());
    if (!sort) update(levels.filter(item => item.columnId !== column.getColId()));
    else if (index < 0) update([...levels, { columnId: column.getColId(), sort }]);
    else update(levels.map((item, itemIndex) => itemIndex === index ? { ...item, sort } : item));
  };
  const currentSort = levels.find(item => item.columnId === column.getColId())?.sort;
  const preset = levels.length === 0 ? { columnId: "", sort: null } : levels.length === 1 ? levels[0] : null;
  const presetValue = preset && presets?.some(option => keyOf(option) === keyOf(preset)) ? keyOf(preset) : "keep";
  const remaining = available.filter(item => !levels.some(level => level.columnId === item.value));
  const directionLabels = props.kind === "date"
    ? { asc: "Сначала ранние даты", desc: "Сначала поздние даты" }
    : props.kind === "number" ? { asc: "От меньшего к большему", desc: "От большего к меньшему" }
      : { asc: "По алфавиту: от А до Я", desc: "По алфавиту: от Я до А" };
  useGridFilterDisplay({ afterGuiAttached: () => { attachPopup(); pending.current = null; setLevels(readSorts(api)); } });
  useEffect(() => {
    const applySort = (event: { source?: string; columns?: typeof column[]; fromAction?: string }) => {
      if (event.source !== "columnFilter" || event.fromAction !== "apply" || !event.columns?.includes(column) || !pending.current) return;
      const sorts = pending.current;
      pending.current = null;
      api.applyColumnState({ state: sorts.map((sort, sortIndex) => ({ colId: sort.columnId, sort: sort.sort, sortIndex })), defaultState: { sort: null, sortIndex: null } });
    };
    api.addEventListener("filterChanged", applySort);
    return () => { if (!api.isDestroyed()) api.removeEventListener("filterChanged", applySort); };
  }, [api, column]);
  // Keep this non-filtering child in slot zero so an existing Multi Filter
  // model still addresses values/conditions at the same indices in both views.
  if (props.presentation === "compact") return <span ref={popupRef} className="grid-compact-filter-anchor" aria-hidden="true" />;
  const moveLevel = (index: number, offset: number) => {
    const next = [...levels];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    update(next);
  };
  return <div ref={popupRef} className="grid-enterprise-filter-intro">
    <header className="grid-filter-heading"><div><strong>{colDef.headerName}</strong><span>Сортировка и фильтры</span></div><button type="button" className="grid-filter-close" aria-label="Закрыть без применения" onClick={() => { pending.current = null; api.doFilterAction({ colId: column.getColId(), action: "cancel" }); api.hideColumnFilter(); }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button></header>
    <section className="grid-filter-sort" aria-label="Сортировка строк">
      <div className="grid-enterprise-sort-heading"><strong>Сортировка</strong><button type="button" disabled={!levels.length} onClick={() => update([])}>Сбросить сортировку</button></div>
      {presets && <div className="grid-filter-field"><span>Порядок строк</span><CustomSelect ariaLabel="Порядок строк" value={presetValue} options={[
        ...(presetValue === "keep" ? [{ value: "keep", label: "По нескольким столбцам / текущий порядок" }] : []),
        ...presets.map(option => ({ value: keyOf(option), label: option.label })),
      ]} onChange={value => { const option = presets.find(item => keyOf(item) === value); if (option) update(option.columnId && option.sort ? [{ columnId: option.columnId, sort: option.sort }] : []); }} /></div>}
      <div className="grid-enterprise-sort-actions" aria-label={`Сортировка столбца ${colDef.headerName}`}>
        <button type="button" aria-pressed={currentSort === "asc"} title={directionLabels.asc} onClick={() => changeCurrentSort("asc")}>↑ По возрастанию</button>
        <button type="button" aria-pressed={currentSort === "desc"} title={directionLabels.desc} onClick={() => changeCurrentSort("desc")}>↓ По убыванию</button>
        <button type="button" disabled={!currentSort} onClick={() => changeCurrentSort(null)}>Убрать</button>
      </div>
      {levels.length > 0 && <ol className="grid-enterprise-sort-levels" aria-label="Уровни сортировки">{levels.map((level, index) => <li key={`${index}:${level.columnId}`} className="grid-enterprise-sort-level">
        <span className="grid-enterprise-sort-priority" aria-label={`Приоритет ${index + 1}`}>{index + 1}</span>
        <CustomSelect ariaLabel={`Столбец сортировки ${index + 1}`} value={level.columnId} options={available.filter(item => item.value === level.columnId || !levels.some(other => other.columnId === item.value))} onChange={columnId => update(levels.map((item, itemIndex) => itemIndex === index ? { ...item, columnId } : item))}/>
        <CustomSelect ariaLabel={`Направление сортировки ${index + 1}`} value={level.sort} options={[{ value: "asc", label: "↑ По возрастанию" }, { value: "desc", label: "↓ По убыванию" }]} onChange={sort => update(levels.map((item, itemIndex) => itemIndex === index ? { ...item, sort: sort as "asc" | "desc" } : item))}/>
        <div className="grid-enterprise-sort-level-actions"><button type="button" aria-label={`Повысить приоритет уровня ${index + 1}`} title="Выше" disabled={index === 0} onClick={() => moveLevel(index, -1)}>↑</button><button type="button" aria-label={`Понизить приоритет уровня ${index + 1}`} title="Ниже" disabled={index === levels.length - 1} onClick={() => moveLevel(index, 1)}>↓</button><button type="button" aria-label={`Удалить уровень ${index + 1}`} title="Удалить уровень" onClick={() => update(levels.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>
      </li>)}</ol>}
      <button className="grid-enterprise-sort-add" type="button" disabled={!remaining.length} onClick={() => { if (remaining[0]) update([...levels, { columnId: remaining[0].value, sort: "asc" }]); }}>+ Добавить уровень</button>
      <p className="grid-enterprise-sort-help">{props.rowSortOptions ? "В отчёте даты остаются сгруппированы. Уровни задают порядок внутри даты." : "Уровни применяются сверху вниз."} Изменения вступят в силу после «Применить».</p>
    </section>
    <div className="grid-enterprise-values-heading">Показать значения</div>
  </div>;
}
const sortingChild: ColumnFilter = { component: EnterpriseFilterSorting, doesFilterPass: () => true };
const checklistHeaderChild: ColumnFilter = { component: ChecklistFilterHeader, doesFilterPass: () => true };

function dateComparator(filter: Date, value: unknown) {
  const key = filterDateKey(value);
  const target = `${filter.getFullYear()}-${String(filter.getMonth() + 1).padStart(2, "0")}-${String(filter.getDate()).padStart(2, "0")}`;
  return key.localeCompare(target);
}

// AG Set Filter virtualises equal-height items. Measure a safe height for the
// longest label so wrapped values remain readable, including on narrow screens.
function setCellHeight(api: GridApi, columnId: string, compact = false) {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return 110;
  // Slightly larger than our 13–14px grid font, with space for the checkbox,
  // padding and scrollbar. Account for word breaks and unbroken identifiers.
  context.font = `${compact ? 13 : 15}px Inter, Arial, sans-serif`;
  const width = Math.max(120, Math.min(compact ? 286 : 400, window.innerWidth - 24) - (compact ? 80 : 108));
  const space = context.measureText(" ").width;
  const labels = new Set<string>();
  api.forEachNode(node => labels.add(String(api.getCellValue({ rowNode: node, colKey: columnId, useFormatter: true }) ?? "")));
  let longest = 1;
  for (const label of labels) {
    let lines = 1;
    let used = 0;
    for (const word of label.split(/\s+/)) {
      const size = context.measureText(word).width;
      if (used && used + space + size > width) { lines++; used = 0; }
      if (size <= width) { used += (used ? space : 0) + size; continue; }
      for (const char of word) {
        const size = context.measureText(char).width;
        if (used + size > width) { lines++; used = 0; }
        used += size;
      }
    }
    longest = Math.max(longest, lines);
  }
  return compact ? Math.max(26, longest * 16 + 4) : Math.max(34, longest * 19 + 14);
}

export function enterpriseFilterParams(params: IFilterParams, options: EnterpriseFilterOptions): IMultiFilterParams & { buttons: string[]; closeOnApply: boolean } {
  const kind = options.kind ?? "text";
  const checklist = options.presentation === "checklist";
  const compact = options.presentation === "compact" || checklist;
  const conditions = kind === "date" ? "agDateColumnFilter" : kind === "number" ? "agNumberColumnFilter" : "agTextColumnFilter";
  const formatter = options.valueFormatter ?? (!params.colDef.filterValueGetter && typeof params.colDef.valueFormatter === "function" ? params.colDef.valueFormatter : undefined);
  const setParams: ISetFilterParams & { kind?: PersonnelFilterModel["kind"] } = {
    ...(checklist ? { kind } : {}),
    // The compact view applies search results immediately; the full view keeps
    // its existing Excel-style Apply/Cancel boundary.
    ...(compact ? { applyMiniFilterWhileTyping: true } : { excelMode: "windows" as const }),
    refreshValuesOnOpen: true, suppressClearModelOnRefreshValues: true,
    showTooltips: true, cellHeight: kind === "date" ? 36 : checklist ? 34 : setCellHeight(params.api, params.column.getColId(), compact),
    textFormatter: normalizeFilterText,
    comparator: kind === "date" ? (a, b) => filterDateKey(b).localeCompare(filterDateKey(a)) : compareGridValues,
    valueFormatter: formatter ?? (({ value }) => value === null || value === undefined || value === "" ? "(Пустые)" : String(value)),
  };
  const stateFilter = options.stateFilter;
  const stateDefinition: IMultiFilterDef[] = stateFilter ? [{
    filter: checklist ? checklistValuesChild : "agSetColumnFilter", title: "Состояние ячейки", display: checklist ? "inline" : compact ? "subMenu" : "accordion",
    filterValueGetter: params => stateFilter.getValue(params.data),
    filterParams: {
      ...(checklist ? { ...setParams, kind: "text" as const, isStateChecklist: true } : {}),
      ...(compact ? { applyMiniFilterWhileTyping: true } : { excelMode: "windows" as const }),
      values: stateFilter.values.map(item => item.value), suppressSorting: true, showTooltips: true, cellHeight: compact ? 28 : 34,
      textFormatter: normalizeFilterText,
      valueFormatter: ({ value }: { value: unknown }) => stateFilter.values.find(item => item.value === value)?.label ?? String(value ?? ""),
    } satisfies ISetFilterParams & { kind?: PersonnelFilterModel["kind"]; isStateChecklist?: boolean },
  }] : [];
  return {
    buttons: compact ? [] : ["clear", "cancel", "apply"], closeOnApply: !compact,
    filters: [
      { filter: checklist ? checklistHeaderChild : sortingChild, filterParams: { kind, rowSortOptions: options.rowSortOptions, presentation: options.presentation } },
      { filter: checklist ? checklistValuesChild : "agSetColumnFilter", filterParams: kind === "date" && !checklist
        // Child params also account for this column's sibling date conditions.
        ? (child: IFilterParams) => ({ ...setParams, ...dateTreeSetFilterParams(child) }) : setParams },
      ...stateDefinition,
      ...(checklist || options.includeConditions === false ? [] : [{ filter: conditions, title: compact ? kind === "date" ? "Фильтр по дате" : kind === "number" ? "Числовой фильтр" : "Текстовый фильтр" : kind === "date" ? "Период и условия" : "Дополнительные условия", display: compact ? "subMenu" : "accordion", filterParams: {
        maxNumConditions: 4, numAlwaysVisibleConditions: 1,
        ...(kind === "date" ? { browserDatePicker: true, comparator: dateComparator, isValidDate: (value: unknown) => Boolean(filterDateKey(value)), inRangeInclusive: true, defaultOption: "inRange" } : {}),
        ...(kind === "number" ? { allowedCharPattern: "\\d\\-\\+\\.,\\s", numberParser: (text: string | null) => {
          if (text == null || !text.trim()) return null;
          const value = Number(text.replace(/\s/g, "").replace(",", "."));
          return Number.isFinite(value) ? value : null;
        } } : {}),
        ...(kind === "text" ? { textFormatter: normalizeFilterText, filterOptions: ["contains", "notContains", "equals", "notEqual", "startsWith", "endsWith", "blank", "notBlank",
          { displayKey: "containsAllWords", displayName: "Содержит все слова", predicate: ([needle]: string[], value: unknown) => normalizeFilterText(needle).split(" ").every(word => normalizeFilterText(value).includes(word)) },
          { displayKey: "containsAnyWord", displayName: "Содержит любое слово", predicate: ([needle]: string[], value: unknown) => normalizeFilterText(needle).split(" ").some(word => normalizeFilterText(value).includes(word)) },
          { displayKey: "notStartsWith", displayName: "Не начинается с", predicate: ([needle]: string[], value: unknown) => !normalizeFilterText(value).startsWith(normalizeFilterText(needle)) },
          { displayKey: "notEndsWith", displayName: "Не заканчивается на", predicate: ([needle]: string[], value: unknown) => !normalizeFilterText(value).endsWith(normalizeFilterText(needle)) },
        ] } : {}),
      } } satisfies IMultiFilterDef]),
    ],
  };
}
