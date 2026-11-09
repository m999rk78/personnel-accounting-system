import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const moduleUrl = await compileModuleGraph("app/dateFilterTreeModel.ts");
const { dateFilterPath, dateFilterTreeLabel, dateFilterNativeLabel, dateFilterNativeDisplayLabel, dateFilterSearchText, dateFilterTreeCounts, matchesDateFilterSearch } = await import(moduleUrl);
const nativeSource = ts.createSourceFile("DateTreeSetFilter.tsx", await readFile(new URL("../app/DateTreeSetFilter.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const storeDeclaration = nativeSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "dateCountStore");
assert.ok(storeDeclaration, "Expected the actual lazy native date-count cache");
const storeCode = ts.transpileModule(storeDeclaration.getText(nativeSource), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const dateCountStore = new Function("dateFilterTreeCounts", `${storeCode}\nreturn dateCountStore;`)(dateFilterTreeCounts);

function countCacheHarness(initial) {
  let nodes = initial;
  let scans = 0;
  const listeners = new Map();
  const column = {};
  const api = {
    isDestroyed: () => false,
    forEachNode(callback) { scans++; nodes.forEach(callback); },
    addEventListener(event, listener) { const current = listeners.get(event) ?? new Set(); current.add(listener); listeners.set(event, current); },
    removeEventListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  const store = dateCountStore({ api, column, getValue: node => node.data.date, doesRowPassOtherFilter: node => node.pass !== false });
  return { store, column, get scans() { return scans; }, setNodes(next) { nodes = next; }, emit(event, detail = {}) { listeners.get(event)?.forEach(listener => listener(detail)); }, subscriptions: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0) };
}

test("date filter hierarchy preserves date-only ISO keys without timezone conversion", () => {
  assert.deepEqual(dateFilterPath("2026-11-06"), ["2026", "11", "06"]);
  assert.deepEqual(dateFilterPath("2025-01-01"), ["2025", "01", "01"]);
  assert.deepEqual(dateFilterPath("2024-02-29"), ["2024", "02", "29"]);
});

test("date tree displays years, Russian month names and complete dates", () => {
  assert.equal(dateFilterTreeLabel("2026", 0, []), "2026");
  assert.equal(dateFilterTreeLabel("11", 1, ["2026"]), "Ноябрь");
  assert.equal(dateFilterTreeLabel("06", 2, ["2026", "11"]), "06.11.2026");
  const months = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  months.forEach((month, index) => assert.equal(dateFilterTreeLabel(String(index + 1).padStart(2, "0"), 1, ["2026"]), month));
});

test("date tree retains blank and invalid values instead of silently discarding rows", () => {
  assert.deepEqual(dateFilterPath(null), [""]);
  assert.deepEqual(dateFilterPath(""), [""]);
  assert.equal(dateFilterTreeLabel("", 0, []), "(Пустые)");
  assert.equal(dateFilterTreeLabel(null, 0, []), "(Пустые)");
  assert.deepEqual(dateFilterPath("2026"), ["!invalid:2026"]);
  assert.equal(dateFilterTreeLabel("!invalid:2026", 0, []), "2026");
  assert.notDeepEqual(dateFilterPath("2026"), ["2026"], "Invalid dates must not collide with a valid year branch");
});

test("date search accepts formatted dates, raw ISO, year and Russian month", () => {
  for (const search of ["", "06.11.2026", "2026-11-06", "2026", "ноябрь", " НОЯБРЬ "]) {
    assert.equal(matchesDateFilterSearch("2026-11-06", search), true, search);
  }
  for (const search of ["2025", "октябрь", "07.11.2026"]) {
    assert.equal(matchesDateFilterSearch("2026-11-06", search), false, search);
  }
  assert.equal(matchesDateFilterSearch("неизвестно", "неизвестно"), true);
});

test("native month labels are unique by year but visually show only the month", () => {
  assert.equal(dateFilterNativeLabel("11", 1, ["2026"]), "Ноябрь 2026");
  assert.equal(dateFilterNativeLabel("11", 1, ["2025"]), "Ноябрь 2025");
  assert.equal(dateFilterNativeDisplayLabel("Ноябрь 2026"), "Ноябрь");
  assert.equal(dateFilterNativeDisplayLabel("06.11.2026"), "06.11.2026");
  assert.equal(dateFilterNativeLabel("!invalid:2026", 0, []), "Неверная дата: 2026");
});

test("native search normalizes ISO dates and ISO month input to displayed labels", () => {
  assert.equal(dateFilterSearchText("2026-11-06"), "06.11.2026");
  assert.equal(dateFilterSearchText("06.11.2026"), "06.11.2026");
  assert.equal(dateFilterSearchText("2026-11"), "ноябрь 2026");
  assert.equal(dateFilterSearchText(" НОЯБРЬ "), "ноябрь");
  assert.equal(dateFilterSearchText("06.11"), "06.11");
});

test("badges count rows, aggregate duplicate formatted dates and distinguish month years", () => {
  const counts = dateFilterTreeCounts(new Map([
    ["2026-11-06", 5], ["06.11.2026", 2], ["2026-12-01", 1], ["2025-11-06", 3], ["2026", 11], ["", 4],
  ]));
  assert.equal(counts.get("2026"), 8, "Invalid raw value '2026' must not inflate the valid year count");
  assert.equal(counts.get("Ноябрь 2026"), 7);
  assert.equal(counts.get("06.11.2026"), 7);
  assert.equal(counts.get("Ноябрь 2025"), 3);
  assert.equal(counts.get("Неверная дата: 2026"), 11);
  assert.equal(counts.get("(Пустые)"), 4);
  assert.equal(counts.get("2025"), 3);
});

test("100,000 date values retain stable paths and labels", () => {
  let count = 0;
  for (let index = 0; index < 100_000; index++) {
    const month = String(index % 12 + 1).padStart(2, "0");
    const day = String(index % 28 + 1).padStart(2, "0");
    const value = `2026-${month}-${day}`;
    const path = dateFilterPath(value);
    assert.equal(path.join("-"), value);
    assert.equal(dateFilterTreeLabel(path[2], 2, path.slice(0, 2)), `${day}.${month}.2026`);
    count++;
  }
  assert.equal(count, 100_000);
});

test("native counters exclude other-filter failures and share one scan across virtual renderers", () => {
  const cache = countCacheHarness([
    { data: { date: "2026-11-06" } }, { data: { date: "2026-11-06" }, pass: false },
    { data: { date: "2025-11-06" } }, { group: true, data: { date: "2026-11-06" } }, { data: null },
  ]);
  const offA = cache.store.subscribe(() => {});
  const offB = cache.store.subscribe(() => {});
  assert.equal(cache.subscriptions(), 4, "Grid subscriptions must be shared, not duplicated per tree renderer");
  assert.equal(cache.store.count("2026"), 1);
  assert.equal(cache.store.count("Ноябрь 2026"), 1);
  assert.equal(cache.store.count("06.11.2026"), 1);
  assert.equal(cache.store.count("Ноябрь 2025"), 1);
  assert.equal(cache.scans, 1);
  offA();
  assert.equal(cache.subscriptions(), 4);
  offB();
  assert.equal(cache.subscriptions(), 0, "Closing the last renderer must release every grid listener");
});

test("native counter cache refreshes even when available date keys do not change", () => {
  const cache = countCacheHarness([{ data: { date: "2026-11-06" } }]);
  let notified = 0;
  const off = cache.store.subscribe(() => { notified++; });
  assert.equal(cache.store.count("06.11.2026"), 1);
  cache.setNodes([{ data: { date: "2026-11-06" } }, { data: { date: "2026-11-06" } }]);
  cache.emit("rowDataUpdated");
  assert.equal(cache.store.count("06.11.2026"), 2);
  cache.emit("filterOpened", { column: {} });
  assert.equal(cache.store.count("2026"), 2);
  assert.equal(cache.scans, 2, "Opening an unrelated filter must not invalidate this cache");
  cache.emit("filterOpened", { column: cache.column });
  cache.store.count("2026");
  assert.equal(cache.scans, 3);
  cache.setNodes([{ data: { date: "2026-11-06" }, pass: false }, { data: { date: "2026-11-06" } }]);
  cache.emit("filterChanged");
  assert.equal(cache.store.count("06.11.2026"), 1);
  assert.equal(notified, 3);
  off();
});

test("100,000 native count rows are scanned once, not once per year/month/day label", () => {
  const cache = countCacheHarness(Array.from({ length: 100_000 }, (_, index) => ({ data: { date: index % 2 ? "2026-11-06" : "2026-11-05" } })));
  assert.equal(cache.store.count("2026"), 100_000);
  assert.equal(cache.store.count("Ноябрь 2026"), 100_000);
  assert.equal(cache.store.count("06.11.2026"), 50_000);
  assert.equal(cache.store.count("05.11.2026"), 50_000);
  assert.equal(cache.scans, 1);
});
