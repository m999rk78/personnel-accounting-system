export type FilterCondition = { type: string; value: string; to?: string };
export type PersonnelFilterModel = {
  filterType: "personnel";
  kind: "text" | "number";
  values: string[] | null;
  conditions: FilterCondition[];
  operator: "AND" | "OR";
};

export const textOperations = [
  ["contains", "Содержит"], ["notContains", "Не содержит"],
  ["equals", "Равно"], ["notEqual", "Не равно"],
  ["startsWith", "Начинается с"], ["endsWith", "Заканчивается на"],
  ["blank", "Пусто"], ["notBlank", "Не пусто"],
] as const;
export const numberOperations = [
  ["equals", "Равно"], ["notEqual", "Не равно"],
  ["greaterThan", "Больше"], ["greaterThanOrEqual", "Больше или равно"],
  ["lessThan", "Меньше"], ["lessThanOrEqual", "Меньше или равно"],
  ["inRange", "В диапазоне"], ["blank", "Пусто"], ["notBlank", "Не пусто"],
] as const;

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
      case "endsWith": return text.endsWith(needle);
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
  const operations = model.kind === "number" ? numberOperations : textOperations;
  if (model.conditions.length) parts.push(model.conditions.map((condition) => {
    const label = operations.find(([key]) => key === condition.type)?.[1] ?? "Условие";
    return condition.type === "blank" || condition.type === "notBlank" ? label :
      `${label} «${condition.value}»${condition.type === "inRange" ? ` — «${condition.to}»` : ""}`;
  }).join(model.operator === "AND" ? " И " : " ИЛИ "));
  return parts.join("; ");
}
