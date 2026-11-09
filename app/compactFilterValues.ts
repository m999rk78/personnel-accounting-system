import type { IFilterParams } from "ag-grid-community";
import { compareGridValues, normalizeFilterText } from "./gridFilterModel.ts";

export type CompactFilterKey = string | null;
export type CompactFilterValue = { key: CompactFilterKey; label: string; count: number };
export type CompactFilterValuesOptions = {
  /** Pair native handler values and keys so the UI uses its canonical model keys. */
  values?: readonly unknown[];
  keys?: readonly CompactFilterKey[];
  valueFormatter?: (value: unknown) => string;
  comparator?: (left: unknown, right: unknown) => number;
  caseSensitive?: boolean;
  includeUnavailable?: boolean;
};

/** AG Set Filter merges empty strings with null, while preserving zero and spaces. */
export function compactFilterValueKey(value: unknown): CompactFilterKey {
  return value === null || value === undefined || value === "" ? null : String(value);
}

/** Counts are per record, ignoring this column's own filter and structural rows. */
export function buildCompactFilterValues<T>(
  params: Pick<IFilterParams<T>, "api" | "getValue" | "doesRowPassOtherFilter">,
  options: CompactFilterValuesOptions = {},
): CompactFilterValue[] {
  const fold = (key: CompactFilterKey) => options.caseSensitive ? key : key?.toUpperCase() ?? null;
  const canonical = new Map<CompactFilterKey, CompactFilterKey>();
  const values = new Map<CompactFilterKey, { value: unknown; count: number }>();
  const supplied = options.values !== undefined || options.keys !== undefined;
  const add = (key: CompactFilterKey, value: unknown) => {
    const folded = fold(key);
    if (!canonical.has(folded)) {
      canonical.set(folded, key);
      values.set(key, { value, count: 0 });
    }
  };
  if (supplied) {
    const suppliedValues = options.values ?? options.keys ?? [];
    suppliedValues.forEach((value, index) => {
      add(options.keys?.[index] === undefined ? compactFilterValueKey(value) : options.keys[index], value);
    });
  }
  params.api.forEachNode(node => {
    if (!node.data || node.group || node.footer || !params.doesRowPassOtherFilter(node)) return;
    const kind = typeof node.data === "object" && "kind" in node.data ? node.data.kind : undefined;
    if (kind === "group" || kind === "blank" || kind === "summary") return;
    const raw = params.getValue(node);
    const rowValues = Array.isArray(raw) ? raw.length ? raw : [null] : [raw];
    const rowKeys = new Set<CompactFilterKey>();
    for (const value of rowValues) {
      const rawKey = compactFilterValueKey(value);
      const folded = fold(rawKey);
      if (!canonical.has(folded)) {
        if (supplied) continue;
        add(rawKey, value);
      }
      rowKeys.add(canonical.get(folded)!);
    }
    rowKeys.forEach(key => { values.get(key)!.count++; });
  });
  return [...values].filter(([, item]) => options.includeUnavailable || item.count > 0)
    .sort(([, left], [, right]) => (options.comparator ?? compareGridValues)(left.value, right.value))
    .map(([key, item]) => ({ key, label: options.valueFormatter?.(item.value) ?? (key === null ? "(Пустые)" : String(item.value)), count: item.count }));
}

/** Search presentation text and stored scalar keys without mutating selection. */
export function filterCompactFilterValues(values: readonly CompactFilterValue[], search: string): CompactFilterValue[] {
  const needle = normalizeFilterText(search);
  return values.filter(item => !needle || normalizeFilterText(item.label).includes(needle) || normalizeFilterText(item.key).includes(needle));
}
