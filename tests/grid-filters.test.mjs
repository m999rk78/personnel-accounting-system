import assert from "node:assert/strict";
import test from "node:test";
import { matchesPersonnelFilter as matches, isConditionValid, normalizeFilterText, filterValueKey } from "../app/gridFilterModel.ts";

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
