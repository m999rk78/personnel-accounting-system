import { filterDateKey, normalizeFilterText } from "./gridFilterModel.ts";

export const dateFilterMonths = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"] as const;
const invalidPrefix = "!invalid:";

/** Paths are presentation only. Filter models must retain each original value. */
export function dateFilterPath(value: unknown): string[] {
  const raw = String(value ?? "").trim();
  const key = filterDateKey(raw);
  return key ? key.split("-") : [raw ? `${invalidPrefix}${raw}` : ""];
}

export function dateFilterTreeLabel(key: string | null, depth: number, parents: (string | null)[]): string {
  if (!key) return "(Пустые)";
  if (key.startsWith(invalidPrefix)) return key.slice(invalidPrefix.length);
  if (depth === 1) return dateFilterMonths[Number(key) - 1] ?? key;
  if (depth === 2) return `${key}.${parents[1]}.${parents[0]}`;
  return key;
}

/** Native renderers receive a label, not a path. Keep month labels unique by year. */
export function dateFilterNativeLabel(key: string | null, depth: number, parents: (string | null)[]): string {
  const label = dateFilterTreeLabel(key, depth, parents);
  if (key?.startsWith(invalidPrefix)) return `Неверная дата: ${label}`;
  return depth === 1 ? `${label} ${parents[0]}` : label;
}

export function dateFilterNativeDisplayLabel(label: string): string {
  return dateFilterMonths.some(month => label.startsWith(`${month} `) && /^\d{4}$/.test(label.slice(month.length + 1)))
    ? label.slice(0, label.lastIndexOf(" ")) : label;
}

/** The native mini-filter compares formatted labels, including ISO search input. */
export function dateFilterSearchText(value: string): string {
  const key = filterDateKey(value);
  if (key) return `${key.slice(8, 10)}.${key.slice(5, 7)}.${key.slice(0, 4)}`;
  const month = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (month && Number(month[2]) >= 1 && Number(month[2]) <= 12) return normalizeFilterText(`${dateFilterMonths[Number(month[2]) - 1]} ${month[1]}`);
  return normalizeFilterText(value);
}

export function matchesDateFilterSearch(value: unknown, search: string): boolean {
  const needle = normalizeFilterText(search);
  if (!needle) return true;
  const path = dateFilterPath(value);
  const labels = path.map((key, depth) => dateFilterNativeLabel(key, depth, path.slice(0, depth)));
  return normalizeFilterText([value ?? "", ...labels, path.length === 3 ? path.join("-") : ""].join(" ")).includes(needle);
}

/** Count raw values first, then aggregate paths; work scales with rows + unique dates. */
export function dateFilterTreeCounts(values: ReadonlyMap<string, number>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [value, count] of values) {
    const path = dateFilterPath(value);
    path.forEach((key, depth) => {
      const label = dateFilterNativeLabel(key, depth, path.slice(0, depth));
      counts.set(label, (counts.get(label) ?? 0) + count);
    });
  }
  return counts;
}
