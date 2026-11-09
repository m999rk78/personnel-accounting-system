"use client";

import { useSyncExternalStore } from "react";
import type { FilterOpenedEvent, IFilterParams, ISetFilterParams } from "ag-grid-community";
import { dateFilterNativeDisplayLabel, dateFilterNativeLabel, dateFilterPath, dateFilterSearchText, dateFilterTreeCounts } from "./dateFilterTreeModel";
import "./dateTreeSetFilter.css";

/** One lazy count cache per date filter, shared by all virtualised tree items. */
function dateCountStore(params: IFilterParams) {
  let dirty = true;
  let counts = new Map<string, number>();
  const listeners = new Set<() => void>();
  const invalidate = () => { dirty = true; listeners.forEach(listener => listener()); };
  const opened = (event: FilterOpenedEvent) => { if (event.column === params.column) invalidate(); };
  const events = ["rowDataUpdated", "cellValueChanged", "filterChanged"] as const;
  return {
    count(label: string) {
      if (dirty && !params.api.isDestroyed()) {
        dirty = false;
        const values = new Map<string, number>();
        params.api.forEachNode(node => {
          if (!node.data || node.group || !params.doesRowPassOtherFilter(node)) return;
          const value = String(params.getValue(node) ?? "").trim();
          values.set(value, (values.get(value) ?? 0) + 1);
        });
        counts = dateFilterTreeCounts(values);
      }
      return counts.get(label);
    },
    subscribe(listener: () => void) {
      if (!listeners.size && !params.api.isDestroyed()) {
        dirty = true;
        events.forEach(event => params.api.addEventListener(event, invalidate));
        params.api.addEventListener("filterOpened", opened);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && !params.api.isDestroyed()) {
          events.forEach(event => params.api.removeEventListener(event, invalidate));
          params.api.removeEventListener("filterOpened", opened);
        }
      };
    },
  };
}

export function dateTreeSetFilterParams(params: IFilterParams): ISetFilterParams {
  const store = dateCountStore(params);
  function DateTreeValue({ value, valueFormatted }: { value: unknown; valueFormatted?: string | null }) {
    const label = String(valueFormatted ?? value ?? "(Пустые)");
    const count = useSyncExternalStore(store.subscribe, () => store.count(label), () => undefined);
    return <span className="grid-date-set-filter-value">
      <span>{dateFilterNativeDisplayLabel(label)}</span>
      {count !== undefined && <small aria-label={`${count} записей`}>{count}</small>}
    </span>;
  }
  return {
    treeList: true,
    treeListPathGetter: dateFilterPath,
    treeListFormatter: dateFilterNativeLabel,
    textFormatter: dateFilterSearchText,
    cellHeight: 36,
    cellRenderer: DateTreeValue,
  };
}
