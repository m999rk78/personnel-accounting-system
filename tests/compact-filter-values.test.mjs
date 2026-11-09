import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactFilterValues, compactFilterValueKey, filterCompactFilterValues } from "../app/compactFilterValues.ts";

function params(rows) {
  return {
    api: { forEachNode: callback => rows.forEach(callback) },
    getValue: node => node.value,
    doesRowPassOtherFilter: node => node.available !== false,
  };
}
const row = (value, extra = {}) => ({ data: {}, value, ...extra });

test("native scalar keys preserve zero, blank and whitespace distinctions", () => {
  assert.equal(compactFilterValueKey(null), null);
  assert.equal(compactFilterValueKey(undefined), null);
  assert.equal(compactFilterValueKey(""), null);
  assert.equal(compactFilterValueKey(0), "0");
  assert.equal(compactFilterValueKey(" "), " ");
  const values = buildCompactFilterValues(params([row(0), row("0"), row(null), row(undefined), row(""), row(" ")]));
  assert.equal(values.find(item => item.key === "0").count, 2);
  assert.equal(values.find(item => item.key === null).count, 3);
  assert.equal(values.find(item => item.key === " ").count, 1);
});

test("native handler case aliases use the original canonical model key", () => {
  const source = params([row("Иванов"), row("ИВАНОВ"), row("иванов")]);
  const values = buildCompactFilterValues(source, { keys: ["ИВАНОВ"], values: ["ИВАНОВ"] });
  assert.deepEqual(values, [{ key: "ИВАНОВ", label: "ИВАНОВ", count: 3 }]);
  assert.deepEqual(buildCompactFilterValues(source, { caseSensitive: true }).map(item => item.count), [1, 1, 1]);
});

test("draft and edit records count alongside entries, but headers and unavailable rows do not", () => {
  const source = params([
    row("А", { data: { kind: "entry" } }), row("А", { data: { kind: "draft" } }), row("А", { data: { kind: "edit" } }), row("А"),
    row("А", { group: true }), row("А", { footer: true }), row("А", { data: undefined }), row("А", { available: false }),
    row("А", { data: { kind: "group" } }), row("А", { data: { kind: "blank" } }), row("А", { data: { kind: "summary" } }),
  ]);
  assert.deepEqual(buildCompactFilterValues(source), [{ key: "А", label: "А", count: 4 }]);
});

test("multi-valued states count each record once per value, including empty arrays", () => {
  const source = params([row(["manual", "mismatch", "manual"]), row(["manual"]), row([]), row([null, "", null])]);
  const values = buildCompactFilterValues(source, {
    keys: ["manual", "mismatch", "filled", null], values: ["manual", "mismatch", "filled", null], includeUnavailable: true,
  });
  assert.equal(values.find(item => item.key === "manual").count, 2);
  assert.equal(values.find(item => item.key === "mismatch").count, 1);
  assert.equal(values.find(item => item.key === "filled").count, 0);
  assert.equal(values.find(item => item.key === null).count, 2);
});

test("available counts are fresh without inventing keys outside the native handler", () => {
  const source = params([row("А"), row("Б", { available: false }), row("В")]);
  const keys = Object.freeze(["А", "Б"]), values = Object.freeze(["А", "Б"]);
  assert.deepEqual(buildCompactFilterValues(source, { keys, values }), [{ key: "А", label: "А", count: 1 }]);
  assert.deepEqual(buildCompactFilterValues(source, { keys, values, includeUnavailable: true }).map(item => item.count), [1, 0]);
  source.api.forEachNode = callback => [row("Б")].forEach(callback);
  assert.deepEqual(buildCompactFilterValues(source, { keys, values }), [{ key: "Б", label: "Б", count: 1 }]);
  assert.deepEqual(keys, ["А", "Б"]);
});

test("formatted labels and normalized search leave stored keys and counts unchanged", () => {
  const values = buildCompactFilterValues(params([row("2026-11-07"), row("employee")]), {
    valueFormatter: value => value === "employee" ? "Фёдор  Петров" : "07.11.2026",
  });
  assert.equal(filterCompactFilterValues(values, "  ФЕДОР   ПЕТРОВ ")[0].key, "employee");
  assert.equal(filterCompactFilterValues(values, "07.11")[0].key, "2026-11-07");
  assert.equal(filterCompactFilterValues(values, "2026-11-07")[0].key, "2026-11-07");
  assert.equal(filterCompactFilterValues(values, "нет совпадений").length, 0);
  assert.equal(filterCompactFilterValues(values, "").length, values.length);
  assert.equal(values[0].count, 1);
});
