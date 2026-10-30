import assert from "node:assert/strict";
import test from "node:test";
import { compareGridValues, matchesPersonnelFilter as matches, isConditionValid, normalizeFilterText, filterValueKey, filterDateKey, describePersonnelFilter, describeGridFilter } from "../app/gridFilterModel.ts";

const model = (overrides = {}) => ({ filterType: "personnel", kind: "text", values: null, conditions: [], operator: "AND", ...overrides });

test("text conditions ignore case, repeated spaces and ё/е", () => {
  const filter = model({ conditions: [{ type: "contains", value: "  ФЕДОР   ПЕТРОВ " }] });
  assert.equal(matches("Фёдор Петрович", filter), true);
  assert.equal(matches("Фёдор Сидорович", filter), false);
  assert.equal(normalizeFilterText("  ФЁДОР  "), "федор");
});

test("checklist selection combines with conditions without partial name matches", () => {
  const filter = model({ values: ["Иванов", "Иванов Иван"], conditions: [{ type: "endsWith", value: "иван" }] });
  assert.equal(matches("Иванов", filter), false);
  assert.equal(matches("Иванов Иван", filter), true);
  assert.equal(matches("Петров Иван", filter), false);
  assert.equal(matches("Иванов Иван", model({ values: [] })), false);
  assert.equal(matches("Новый сотрудник", null), true);
});

test("И and ИЛИ combine conditions within a column", () => {
  const conditions = [{ type: "startsWith", value: "Иван" }, { type: "endsWith", value: "Петр" }];
  assert.equal(matches("Иванов Петр", model({ conditions })), true);
  assert.equal(matches("Сидоров Петр", model({ conditions })), false);
  assert.equal(matches("Сидоров Петр", model({ conditions, operator: "OR" })), true);
  assert.equal(matches("Сидоров Алексей", model({ conditions, operator: "OR" })), false);
});

test("extended text filters support exclusions and word searches", () => {
  assert.equal(matches("Монтажник технологических трубопроводов", model({ conditions: [{ type: "containsAllWords", value: "монтажник трубопроводов" }] })), true);
  assert.equal(matches("Монтажник металлоконструкций", model({ conditions: [{ type: "containsAllWords", value: "монтажник трубопроводов" }] })), false);
  assert.equal(matches("Электрогазосварщик", model({ conditions: [{ type: "containsAnyWord", value: "сварщик электрогазосварщик" }] })), true);
  assert.equal(matches("Иванов Пётр", model({ conditions: [{ type: "notStartsWith", value: "петров" }] })), true);
  assert.equal(matches("Иванов Пётр", model({ conditions: [{ type: "notEndsWith", value: "петр" }] })), false);
});

test("empty values are explicit and zero is not empty", () => {
  const empty = model({ conditions: [{ type: "blank", value: "" }] });
  for (const value of [null, undefined, "", "  "]) assert.equal(matches(value, empty), true);
  assert.equal(matches(0, empty), false);
  assert.equal(matches("—", empty), false);
  assert.equal(matches(null, model({ conditions: [{ type: "notContains", value: "x" }] })), false);
  assert.equal(matches(undefined, model({ values: [""] })), true);
  assert.equal(filterValueKey(0), "0");
});

test("number comparisons are numeric, support decimal commas and inclusive ranges", () => {
  const range = model({ kind: "number", conditions: [{ type: "inRange", value: "2", to: "10" }] });
  for (const value of [2, 3, 10, "3,5"]) assert.equal(matches(value, range), true);
  for (const value of [1, 11, "", null, "не число"]) assert.equal(matches(value, range), false);
  assert.equal(matches(10, model({ kind: "number", conditions: [{ type: "greaterThan", value: "9" }] })), true);
  assert.equal(matches(0, model({ kind: "number", conditions: [{ type: "equals", value: "0" }] })), true);
});

test("incomplete and reversed numeric ranges cannot be applied", () => {
  for (const condition of [{ type: "inRange", value: "5", to: "2" }, { type: "inRange", value: "2", to: "" }, { type: "equals", value: "" }, { type: "equals", value: "NaN" }]) {
    assert.equal(isConditionValid(condition, "number"), false);
  }
  assert.equal(isConditionValid({ type: "inRange", value: "2", to: "2" }, "number"), true);
  assert.equal(isConditionValid({ type: "blank", value: "" }, "number"), true);
});

test("filters on separate columns intersect, and explicit values do not grow with new data", () => {
  const rows = [{ name: "Петров", hours: 3 }, { name: "Петров", hours: 8 }, { name: "Сидоров", hours: 8 }];
  const names = model({ values: ["Петров"] });
  const hours = model({ kind: "number", conditions: [{ type: "greaterThanOrEqual", value: "5" }] });
  assert.deepEqual(rows.filter((row) => matches(row.name, names) && matches(row.hours, hours)), [{ name: "Петров", hours: 8 }]);
  assert.equal(matches("Новый сотрудник", names), false);
});

test("grid values use natural Russian sorting", () => {
  const values = ["Кран 10", "кран 2", "Ёлка", "Ель", "Кран 1"];
  assert.deepEqual(values.sort(compareGridValues), ["Ёлка", "Ель", "Кран 1", "кран 2", "Кран 10"]);
  assert.equal(compareGridValues(2, 10) < 0, true);
  assert.equal(compareGridValues("", "Значение") > 0, true);
});

test("calendar ranges compare displayed dates across months and include both boundaries", () => {
  const period = model({ kind: "date", conditions: [{ type: "inRange", value: "2026-09-30", to: "2026-10-02" }] });
  for (const date of ["30.09.2026", "01.10.2026", "02.10.2026", "2026-10-01"]) assert.equal(matches(date, period), true);
  for (const date of ["29.09.2026", "03.10.2026", "", "31.09.2026"]) assert.equal(matches(date, period), false);
  assert.equal(describePersonnelFilter(period), "За период «30.09.2026» — «02.10.2026»");
});

test("date filters validate real calendar days and reject incomplete or reversed periods", () => {
  assert.equal(filterDateKey("29.02.2024"), "2024-02-29");
  for (const date of ["29.02.2026", "2026-02-30", "2026-13-01", "not-a-date"]) assert.equal(filterDateKey(date), "");
  for (const condition of [{ type: "inRange", value: "2026-10-02", to: "2026-09-30" }, { type: "inRange", value: "2026-10-01" }, { type: "equals", value: "2026-02-29" }]) assert.equal(isConditionValid(condition, "date"), false);
  assert.equal(isConditionValid({ type: "inRange", value: "2026-10-01", to: "2026-10-01" }, "date"), true);
});

test("date comparisons combine with exact checklist selection and empty values", () => {
  const after = model({ kind: "date", values: ["30.09.2026", "01.10.2026"], conditions: [{ type: "greaterThan", value: "2026-09-30" }] });
  assert.equal(matches("30.09.2026", after), false);
  assert.equal(matches("01.10.2026", after), true);
  assert.equal(matches("02.10.2026", after), false);
  assert.equal(matches(null, model({ kind: "date", conditions: [{ type: "blank", value: "" }] })), true);
});

test("Enterprise filter chips describe the selected values and all date range boundaries", () => {
  const filter = { filterType: "multi", filterModels: [null,
    { filterType: "set", values: ["Иванов", "Петров"] },
    { filterType: "date", type: "inRange", dateFrom: "2026-09-30 00:00:00", dateTo: "2026-10-02 00:00:00" },
  ] };
  assert.equal(describeGridFilter(filter), "Иванов, Петров; За период «30.09.2026» — «02.10.2026»");
  assert.equal(describeGridFilter({ filterType: "set", values: [] }), "Ничего не выбрано");
  assert.equal(describeGridFilter({ filterType: "multi", filterModels: [null, null, null] }), "Все значения");
});

test("Enterprise combined conditions retain AND/OR and numeric zero in the summary", () => {
  assert.equal(describeGridFilter({ filterType: "number", operator: "OR", conditions: [
    { filterType: "number", type: "equals", filter: 0 },
    { filterType: "number", type: "inRange", filter: 5, filterTo: 10 },
  ] }), "Равно «0» ИЛИ В диапазоне «5» — «10»");
});
