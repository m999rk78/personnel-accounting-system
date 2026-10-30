export type FilterCondition = { type: string; value: string; to?: string };
export type PersonnelFilterModel = {
  filterType: "personnel";
  kind: "text" | "number" | "date";
  values: string[] | null;
  conditions: FilterCondition[];
  operator: "AND" | "OR";
};

export const textOperations = [
  ["contains", "Содержит"], ["notContains", "Не содержит"],
  ["equals", "Равно"], ["notEqual", "Не равно"],
  ["startsWith", "Начинается с"], ["notStartsWith", "Не начинается с"],
  ["endsWith", "Заканчивается на"], ["notEndsWith", "Не заканчивается на"],
  ["containsAllWords", "Содержит все слова"], ["containsAnyWord", "Содержит любое слово"],
  ["blank", "Пусто"], ["notBlank", "Не пусто"],
] as const;
export const numberOperations = [
  ["equals", "Равно"], ["notEqual", "Не равно"],
  ["greaterThan", "Больше"], ["greaterThanOrEqual", "Больше или равно"],
  ["lessThan", "Меньше"], ["lessThanOrEqual", "Меньше или равно"],
  ["inRange", "В диапазоне"], ["blank", "Пусто"], ["notBlank", "Не пусто"],
] as const;

export const dateOperations = [
  ["inRange", "За период"], ["equals", "В указанную дату"], ["notEqual", "Кроме указанной даты"],
  ["greaterThan", "Позже даты"], ["greaterThanOrEqual", "Начиная с даты"],
  ["lessThan", "Раньше даты"], ["lessThanOrEqual", "По дату включительно"],
  ["blank", "Дата не указана"], ["notBlank", "Дата указана"],
] as const;

/** Calendar dates are compared independently of time zones and display format. */
export function filterDateKey(value: unknown): string {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const displayed = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  const key = match ? text : displayed ? `${displayed[3]}-${displayed[2]}-${displayed[1]}` : "";
  const date = new Date(`${key}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : "";
}

export function normalizeFilterText(value: unknown): string {
  return String(value ?? "").toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim().replace(/\s+/g, " ");
}

export function filterValueKey(value: unknown): string {
  return String(value ?? "").trim();
}

function asNumber(value: string): number {
  return value.trim() ? Number(value.replace(",", ".")) : NaN;
}

export function isConditionValid(condition: FilterCondition, kind: PersonnelFilterModel["kind"]): boolean {
  if (condition.type === "blank" || condition.type === "notBlank") return true;
  if (!condition.value.trim()) return false;
  if (kind === "text") return textOperations.some(([key]) => key === condition.type);
  if (kind === "date") return dateOperations.some(([key]) => key === condition.type) && Boolean(filterDateKey(condition.value)) &&
    (condition.type !== "inRange" || Boolean(filterDateKey(condition.to)) && filterDateKey(condition.value) <= filterDateKey(condition.to));
  if (!Number.isFinite(asNumber(condition.value))) return false;
  return numberOperations.some(([key]) => key === condition.type) && (condition.type !== "inRange" ||
    (Number.isFinite(asNumber(condition.to ?? "")) && asNumber(condition.value) <= asNumber(condition.to ?? "")));
}

function matchesCondition(value: unknown, condition: FilterCondition, kind: PersonnelFilterModel["kind"]): boolean {
  const text = normalizeFilterText(value);
  if (condition.type === "blank") return text === "";
  if (condition.type === "notBlank") return text !== "";
  if (!isConditionValid(condition, kind) || !text) return false;
  const needle = normalizeFilterText(condition.value);
  if (kind === "text") {
    switch (condition.type) {
      case "contains": return text.includes(needle);
      case "notContains": return !text.includes(needle);
      case "equals": return text === needle;
      case "notEqual": return text !== needle;
      case "startsWith": return text.startsWith(needle);
      case "notStartsWith": return !text.startsWith(needle);
      case "endsWith": return text.endsWith(needle);
      case "notEndsWith": return !text.endsWith(needle);
      case "containsAllWords": return needle.split(" ").filter(Boolean).every((word) => text.includes(word));
      case "containsAnyWord": return needle.split(" ").filter(Boolean).some((word) => text.includes(word));
      default: return false;
    }
  }
  if (kind === "date") {
    const date = filterDateKey(value);
    const target = filterDateKey(condition.value);
    if (!date) return false;
    switch (condition.type) {
      case "equals": return date === target;
      case "notEqual": return date !== target;
      case "greaterThan": return date > target;
      case "greaterThanOrEqual": return date >= target;
      case "lessThan": return date < target;
      case "lessThanOrEqual": return date <= target;
      case "inRange": return date >= target && date <= filterDateKey(condition.to);
      default: return false;
    }
  }
  const number = asNumber(text);
  const target = asNumber(condition.value);
  if (!Number.isFinite(number)) return false;
  switch (condition.type) {
    case "equals": return number === target;
    case "notEqual": return number !== target;
    case "greaterThan": return number > target;
    case "greaterThanOrEqual": return number >= target;
    case "lessThan": return number < target;
    case "lessThanOrEqual": return number <= target;
    case "inRange": return number >= target && number <= asNumber(condition.to ?? "");
    default: return false;
  }
}

const gridValueCollator = new Intl.Collator("ru-RU", { numeric: true, sensitivity: "base" });

/** Consistent natural sorting for names, identifiers and numbers in every grid. */
export function compareGridValues(left: unknown, right: unknown): number {
  const leftEmpty = left === null || left === undefined || String(left).trim() === "";
  const rightEmpty = right === null || right === undefined || String(right).trim() === "";
  if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return gridValueCollator.compare(String(left).replaceAll("ё", "е"), String(right).replaceAll("ё", "е"));
}

export function matchesPersonnelFilter(value: unknown, model: PersonnelFilterModel | null): boolean {
  if (!model) return true;
  if (model.values !== null && !model.values.includes(filterValueKey(value))) return false;
  if (!model.conditions.length) return true;
  return model.operator === "OR"
    ? model.conditions.some((condition) => matchesCondition(value, condition, model.kind))
    : model.conditions.every((condition) => matchesCondition(value, condition, model.kind));
}

export function describePersonnelFilter(model: PersonnelFilterModel): string {
  const parts: string[] = [];
  if (model.values !== null) parts.push(model.values.length === 0 ? "Ничего не выбрано" : model.values.length <= 2
    ? model.values.map((value) => value || "(Пустые)").join(", ") : `Выбрано значений: ${model.values.length}`);
  const operations = model.kind === "number" ? numberOperations : model.kind === "date" ? dateOperations : textOperations;
  if (model.conditions.length) parts.push(model.conditions.map((condition) => {
    const label = operations.find(([key]) => key === condition.type)?.[1] ?? "Условие";
    return condition.type === "blank" || condition.type === "notBlank" ? label :
      `${label} «${model.kind === "date" ? filterDateKey(condition.value).split("-").reverse().join(".") : condition.value}»${condition.type === "inRange" ? ` — «${model.kind === "date" ? filterDateKey(condition.to).split("-").reverse().join(".") : condition.to}»` : ""}`;
  }).join(model.operator === "AND" ? " И " : " ИЛИ "));
  return parts.join("; ");
}

/** Summaries support both our fallback and the native AG Grid filter models. */
export function describeGridFilter(value: unknown): string {
  if (!value || typeof value !== "object") return "Все значения";
  const model = value as { filterType?: string; filterModels?: unknown[]; values?: (string | null)[]; conditions?: unknown[]; operator?: string; type?: string; filter?: unknown; filterTo?: unknown; dateFrom?: string; dateTo?: string };
  if (model.filterType === "personnel") return describePersonnelFilter(value as PersonnelFilterModel);
  if (model.filterType === "multi") return (model.filterModels ?? []).filter(Boolean).map(describeGridFilter).filter(Boolean).join("; ") || "Все значения";
  if (model.filterType === "set") {
    const values = model.values ?? [];
    return !values.length ? "Ничего не выбрано" : values.length <= 2 ? values.map(value => value || "(Пустые)").join(", ") : `Выбрано значений: ${values.length}`;
  }
  if (model.conditions) return model.conditions.map(describeGridFilter).join(model.operator === "OR" ? " ИЛИ " : " И ");
  const operations = model.filterType === "date" ? dateOperations : model.filterType === "number" ? numberOperations : textOperations;
  const label = operations.find(([key]) => key === model.type)?.[1] ?? "Условие";
  if (model.type === "blank" || model.type === "notBlank") return label;
  const formatDate = (date: string | undefined) => filterDateKey(date?.split(" ")[0]).split("-").reverse().join(".");
  const from = model.filterType === "date" ? formatDate(model.dateFrom) : String(model.filter ?? "");
  const to = model.filterType === "date" ? formatDate(model.dateTo) : String(model.filterTo ?? "");
  return `${label} «${from}»${model.type === "inRange" ? ` — «${to}»` : ""}`;
}
