"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useGridFilterDisplay, type CustomFilterDisplayProps } from "ag-grid-react";
import type { ColumnFilter, ISetFilterParams, SetFilterHandler, SetFilterModel } from "ag-grid-community";
import { VirtualChoiceList } from "./VirtualChoiceList";
import { DateFilterTree } from "./DateFilterTree";
import { matchesDateFilterSearch } from "./dateFilterTreeModel";
import { useGridFilterPopup } from "./useGridFilterPopup";
import { buildCompactFilterValues, filterCompactFilterValues, type CompactFilterValue } from "./compactFilterValues";
import "./checklistSetFilter.css";

type ChecklistProps = CustomFilterDisplayProps<unknown, unknown, SetFilterModel>
  & Pick<ISetFilterParams<unknown, unknown>, "valueFormatter" | "comparator" | "caseSensitive" | "suppressSorting">
  & { isStateChecklist?: boolean; kind?: "text" | "number" | "date" };

export function ChecklistFilterHeader(props: CustomFilterDisplayProps) {
  const { root, attach } = useGridFilterPopup<HTMLDivElement>(props);
  useGridFilterDisplay({ afterGuiAttached: attach });
  return <header ref={root} className="grid-checklist-filter-heading">
    <strong>{props.colDef.headerName || props.column.getColId()}</strong>
    <button type="button" aria-label="Закрыть фильтр" title="Закрыть" onClick={() => props.api.hideColumnFilter()}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
    </button>
  </header>;
}

function SelectionCheckbox({ checked, mixed = false, label, children, onChange }: {
  checked: boolean; mixed?: boolean; label?: string; children: React.ReactNode; onChange: (checked: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <label className="grid-checklist-option"><input ref={input} type="checkbox" aria-label={label} checked={checked} onChange={event => onChange(event.target.checked)} />{children}</label>;
}

function ChecklistSetFilter(props: ChecklistProps) {
  const { api, column, getValue, doesRowPassOtherFilter, valueFormatter, comparator } = props;
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [stateOpen, setStateOpen] = useState(Boolean(props.model));
  const searchInput = useRef<HTMLInputElement>(null);
  const frame = useRef(0);
  const refreshFrame = useRef(0);
  const handler = props.getHandler() as unknown as SetFilterHandler<unknown>;
  const nativeKeys = handler.getFilterKeys();
  const nativeValues = handler.getFilterValues();
  const values = useMemo(() => buildCompactFilterValues({ api, getValue, doesRowPassOtherFilter }, {
    keys: nativeKeys, values: nativeValues, comparator: props.suppressSorting ? () => 0 : comparator, caseSensitive: props.caseSensitive,
    includeUnavailable: props.isStateChecklist,
    valueFormatter: value => valueFormatter ? valueFormatter({ value, api, column, colDef: props.colDef, context: props.context, data: undefined, node: null }) : value == null || value === "" ? "(Пустые)" : String(value),
  // Native keys and counts are refreshed on the grid's data/filter events.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [api, getValue, doesRowPassOtherFilter, valueFormatter, comparator, props.caseSensitive, props.isStateChecklist, props.suppressSorting, revision]);
  const matchingValues = (query: string) => props.kind === "date"
    ? values.filter(item => matchesDateFilterSearch(item.key, query))
    : filterCompactFilterValues(values, query);
  const matching = matchingValues(search);
  const keyId = (key: string | null) => key === null ? null : props.caseSensitive ? key : key.toLocaleUpperCase("en-US");
  const model = props.state.model ?? props.model;
  // No model means no restriction on rows, but no explicit checkbox selection.
  // Start the first selection with just the value the user chose.
  const selectedKeys = model?.values ?? [];
  const selected = new Set(selectedKeys.map(keyId));
  const checkedCount = matching.filter(item => selected.has(keyId(item.key))).length;

  useGridFilterDisplay({ afterGuiAttached: () => {
    handler.refreshFilterValues();
    setSearch("");
    setStateOpen(Boolean(props.model));
    setRevision(value => value + 1);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { setRevision(value => value + 1); searchInput.current?.focus({ preventScroll: true }); });
  }, afterGuiDetached: () => { cancelAnimationFrame(frame.current); } });
  useEffect(() => {
    const refresh = () => {
      setRevision(value => value + 1);
      // Native Set handlers finish synchronising new keys after the data event.
      // Re-read on the next frame so an already open list also gets new values.
      cancelAnimationFrame(refreshFrame.current);
      refreshFrame.current = requestAnimationFrame(() => setRevision(value => value + 1));
    };
    const refreshData = () => { handler.refreshFilterValues(); refresh(); };
    api.addEventListener("rowDataUpdated", refreshData);
    api.addEventListener("cellValueChanged", refreshData);
    api.addEventListener("filterChanged", refresh);
    return () => {
      cancelAnimationFrame(frame.current); cancelAnimationFrame(refreshFrame.current);
      if (api.isDestroyed()) return;
      api.removeEventListener("rowDataUpdated", refreshData);
      api.removeEventListener("cellValueChanged", refreshData);
      api.removeEventListener("filterChanged", refresh);
    };
  }, [api, handler]);

  const apply = (keys: (string | null)[], keepEmpty = false) => {
    // Retain an explicit full selection so "Select found" stays checked.
    // Only an empty search result needs an empty Set model (show no rows).
    props.onModelChange(keys.length || keepEmpty ? { filterType: "set", values: keys } : null);
  };
  const toggle = (item: CompactFilterValue, checked: boolean) => {
    const keys = selectedKeys.filter(key => keyId(key) !== keyId(item.key));
    if (checked) keys.push(item.key);
    apply(keys);
  };
  const renderValue = (item: CompactFilterValue) => <div className={selected.has(keyId(item.key)) ? "grid-checklist-row selected" : "grid-checklist-row"}>
    <SelectionCheckbox label={item.label} checked={selected.has(keyId(item.key))} onChange={checked => toggle(item, checked)}>
      <span className="grid-checklist-label">{item.label}</span><small className="grid-checklist-count" aria-label={`${item.count} записей`}>{item.count}</small>
    </SelectionCheckbox>
  </div>;

  if (props.isStateChecklist) return <section className="grid-checklist-states" aria-label="Состояние ячейки">
    <button type="button" className="grid-checklist-state-toggle" aria-expanded={stateOpen} onClick={() => setStateOpen(value => !value)}>
      <span>Состояние ячейки</span><small>{model ? `Выбрано: ${model.values.length}` : "Любое"}</small><svg viewBox="0 0 16 16" aria-hidden="true"><path d={stateOpen ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} /></svg>
    </button>
    {stateOpen && <div className="grid-checklist-state-options">{values.map(item => <div key={JSON.stringify(item.key)}>{renderValue(item)}</div>)}</div>}
  </section>;

  const valueById = new Map(matching.map(item => [JSON.stringify(item.key), item]));
  return <section className="grid-checklist-values" aria-label={`Значения: ${props.colDef.headerName || column.getColId()}`}>
    <label className="grid-checklist-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
      <input ref={searchInput} aria-label="Поиск значений фильтра" placeholder="Найти значение…" value={search} onChange={event => {
        const next = event.target.value;
        setSearch(next);
        if (next.trim()) apply(matchingValues(next).map(item => item.key), true);
        else props.onModelChange(null);
      }} />
    </label>
    <div className="grid-checklist-actions">
      <SelectionCheckbox label="Выбрать найденные значения" checked={matching.length > 0 && checkedCount === matching.length} mixed={checkedCount > 0 && checkedCount < matching.length} onChange={checked => {
        const matchingKeys = new Set(matching.map(item => keyId(item.key)));
        const remaining = selectedKeys.filter(key => !matchingKeys.has(keyId(key)));
        apply(checked ? [...remaining, ...matching.map(item => item.key)] : remaining);
      }}><span>Выбрать найденные</span></SelectionCheckbox>
      <button type="button" onClick={() => {
        setSearch("");
        void api.setColumnFilterModel(column, null).then(() => { if (!api.isDestroyed()) { api.onFilterChanged(); searchInput.current?.focus({ preventScroll: true }); } });
      }}>Сбросить фильтр</button>
    </div>
    {props.kind === "date" ? <DateFilterTree key={search}
      values={values.map(item => ({ value: item.key ?? "", count: item.count }))}
      selected={new Set(selectedKeys.map(key => key ?? ""))}
      onChange={selection => apply([...selection].map(value => value === "" ? null : value))}
      search={search} />
      : <VirtualChoiceList key={search} items={[...valueById.keys()]} emptyText="Ничего не найдено" renderItem={id => renderValue(valueById.get(id)!)} />}
  </section>;
}

/** Keep AG Grid's native filtering and compatible Set models; replace only the UI. */
export const checklistValuesChild: ColumnFilter = { component: ChecklistSetFilter, handler: "agSetColumnFilterHandler" };
