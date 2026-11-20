import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function source(path) {
  return ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function find(file, predicate) {
  let result;
  const visit = node => {
    if (predicate(node)) { result = node; return; }
    if (!result) ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(result, "Missing actual statistics declaration or JSX element");
  return result;
}

function declaration(file, name) {
  return find(file, node => ts.isVariableDeclaration(node) && node.name.getText(file) === name).initializer.getText(file);
}

function evaluate(expression, environment = {}) {
  const compiled = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), compiled)(...Object.values(environment));
}

const tableSource = await source("../app/StatisticsZoneTable.tsx");
const viewSource = await source("../app/StatisticsView.tsx");
const rowId = evaluate(declaration(tableSource, "rowId"));
const hooks = { useMemo: callback => callback(), useCallback: callback => callback };
const hours = Object.freeze({ welders: 2, installers: 8, other: 0, productive: 0, downtime: 0, total: 10 });
const counts = Object.freeze({ welders: 1, installers: 2, other: 0, total: 3 });
const north = Object.freeze({ zoneId: 1, zone: "Север", ...hours, personnelCounts: counts });
const south = Object.freeze({ zoneId: 2, zone: "Юг", ...hours, total: 20, personnelCounts: counts });
const unassigned = Object.freeze({ zoneId: null, zone: "Без зоны", ...hours });
const zoneRows = Object.freeze([north, south, unassigned]);
const node = (row, flags = {}) => Object.freeze({ data: Object.freeze({ ...row, kind: "entry" }), ...flags });

function publisher(rows, onFilteredRowsChange, setFiltersActive = () => {}) {
  const sourceById = evaluate(declaration(tableSource, "sourceById"), { ...hooks, rows, rowId });
  return evaluate(declaration(tableSource, "publishFilteredRows"), { ...hooks, sourceById, onFilteredRowsChange, setFiltersActive, rowId });
}

function grid(nodes, destroyed = false, filtered = false) {
  const methods = {
    isDestroyed: () => destroyed,
    isAnyFilterPresent: () => filtered,
    forEachNodeAfterFilterAndSort: callback => nodes.forEach(callback),
  };
  return new Proxy(methods, {
    get(target, key) {
      assert.ok(Object.hasOwn(target, key), `Filtered rows must not mutate the grid through ${String(key)}`);
      return target[key];
    },
    set() { throw new Error("Filtered rows must not mutate grid state"); },
  });
}

test("table publishes filtered display order using original rows and their personnel headcounts", () => {
  const before = JSON.stringify(zoneRows);
  const published = [];
  const publish = publisher(zoneRows, rows => published.push(rows));
  publish(grid([
    node(south), node(north, { group: true }), Object.freeze({ data: null }),
    node(unassigned), node(north, { footer: true }), node(north, { detail: true }),
    node({ ...north, zoneId: 999 }), node(north),
  ]));
  assert.deepEqual(published, [[south, unassigned, north]]);
  assert.strictEqual(published[0][0], south);
  assert.strictEqual(published[0][2].personnelCounts, counts);
  assert.equal(JSON.stringify(zoneRows), before);
});

test("day/equipment filtering can publish zero matches and restore every original day", () => {
  const first = Object.freeze({ workDate: "2026-11-17", ...hours, productive: 8, downtime: 2 });
  const second = Object.freeze({ workDate: "2026-11-18", ...hours, productive: 5.5, downtime: 4.5 });
  const sourceRows = Object.freeze([first, second]);
  const published = [];
  const publish = publisher(sourceRows, rows => published.push(rows));
  publish(grid([node(second)]));
  publish(grid([]));
  publish(grid([node(first), node(second)]));
  assert.deepEqual(published, [[second], [], [first, second]]);
  assert.strictEqual(published[0][0], second);
  assert.deepEqual(sourceRows, [first, second]);
});

test("destroyed grids emit nothing and an unsubscribed table still updates its reset action without inspecting rows", () => {
  let calls = 0;
  const active = [];
  const inaccessibleModel = { isDestroyed: () => true, forEachNodeAfterFilterAndSort: () => { throw new Error("Destroyed grid was read"); } };
  publisher(zoneRows, () => calls++, value => active.push(value))(inaccessibleModel);
  const unsubscribed = publisher(zoneRows, undefined, value => active.push(value));
  unsubscribed({ isDestroyed: () => false, isAnyFilterPresent: () => true, forEachNodeAfterFilterAndSort() { throw new Error("Unsubscribed model was read"); } });
  unsubscribed({ isDestroyed: () => false, isAnyFilterPresent: () => false, forEachNodeAfterFilterAndSort() { throw new Error("Unsubscribed model was read"); } });
  assert.equal(calls, 0);
  assert.deepEqual(active, [true, false]);
});

function parentState() {
  let state = null;
  let changes = 0;
  const updateFor = (rows, search = "") => evaluate(declaration(viewSource, "updateFilteredRows"), {
    ...hooks, rows, search, setTableRows: update => {
      const next = update(state);
      if (next !== state) changes++;
      state = next;
    },
  });
  return {
    updateFor,
    resolve: (rows, search = "") => {
      const visibleRows = evaluate(declaration(viewSource, "visibleRows"), { ...hooks, rows, search });
      return evaluate(declaration(viewSource, "filteredRows"), { rows, search, visibleRows, tableRows: state });
    },
    get state() { return state; },
    get changes() { return changes; },
  };
}

test("parent deduplicates identical model events while updating order, zero matches and reset", () => {
  const parent = parentState();
  const update = parent.updateFor(zoneRows);
  update([south, north]);
  const initialState = parent.state;
  update([south, north]);
  assert.strictEqual(parent.state, initialState);
  assert.equal(parent.changes, 1);
  assert.deepEqual(parent.resolve(zoneRows), [south, north]);
  update([north, south]);
  assert.equal(parent.changes, 2);
  assert.deepEqual(parent.resolve(zoneRows), [north, south]);
  update([]);
  const emptyState = parent.state;
  update([]);
  assert.strictEqual(parent.state, emptyState);
  assert.deepEqual(parent.resolve(zoneRows), []);
  update([...zoneRows]);
  assert.deepEqual(parent.resolve(zoneRows), zoneRows);
});

test("request source changes discard earlier filtered rows including reused zone identifiers", () => {
  const parent = parentState();
  parent.updateFor(zoneRows)([south]);
  const searchedRows = Object.freeze([north]);
  assert.strictEqual(parent.resolve(searchedRows), searchedRows);
  parent.updateFor(searchedRows)([]);
  assert.deepEqual(parent.resolve(searchedRows), []);
  assert.strictEqual(parent.resolve(zoneRows), zoneRows);
  const replacement = Object.freeze([{ ...south, total: 99, personnelCounts: Object.freeze({ ...counts, total: 8 }) }]);
  assert.strictEqual(parent.resolve(replacement), replacement);
  parent.updateFor(replacement)([replacement[0]]);
  assert.strictEqual(parent.resolve(replacement)[0], replacement[0]);
  assert.equal(parent.resolve(replacement)[0].personnelCounts.total, 8);
  assert.equal(parent.resolve(null), null);
  const prior = parent.state;
  parent.updateFor(null)([]);
  assert.strictEqual(parent.state, prior);
});

test("top search scopes filtered results independently while retaining the same full data source", () => {
  const parent = parentState();
  parent.updateFor(zoneRows)([south]);
  assert.deepEqual(parent.resolve(zoneRows, "  СЕВЕР  "), [north]);
  parent.updateFor(zoneRows, "  СЕВЕР  ")([]);
  assert.deepEqual(parent.resolve(zoneRows, "  СЕВЕР  "), []);
  assert.strictEqual(parent.state.source, zoneRows);
  assert.strictEqual(parent.resolve(zoneRows), zoneRows);
  parent.updateFor(zoneRows)([south]);
  assert.deepEqual(parent.resolve(zoneRows), [south]);
  assert.deepEqual(parent.resolve(zoneRows, "нет такой зоны"), []);
  const previous = parent.state;
  parent.updateFor(zoneRows, "нет такой зоны")([]);
  assert.notStrictEqual(parent.state, previous);
  assert.equal(parent.state.search, "нет такой зоны");
  assert.strictEqual(parent.state.source, zoneRows);
  assert.strictEqual(parent.resolve(zoneRows), zoneRows);
});

test("external zone search intersects column filters without removing rows or changing the native filter model", () => {
  const nativeModel = Object.freeze({ zone: Object.freeze({ values: Object.freeze(["Юг"]) }) });
  const before = JSON.stringify(nativeModel);
  const external = (zoneSearch, byDay = false) => {
    const search = evaluate(declaration(tableSource, "search"), { zoneSearch, byDay });
    return {
      present: evaluate(declaration(tableSource, "hasSearch"), { ...hooks, search }),
      matches: evaluate(declaration(tableSource, "matchesSearch"), { ...hooks, search }),
    };
  };
  const nativeMatches = row => nativeModel.zone.values.includes(row.zone);
  const filteredBy = filter => zoneRows.filter(row => nativeMatches(row) && (!filter.present() || filter.matches(node(row))));
  const northSearch = external("  СеВеР  ");
  assert.equal(northSearch.present(), true);
  assert.equal(northSearch.matches(node(north)), true);
  assert.equal(northSearch.matches(node(south)), false);
  assert.deepEqual(filteredBy(northSearch), []);
  assert.deepEqual(filteredBy(external("")), [south]);
  assert.equal(external("Север", true).present(), false, "day grouping must ignore the earlier zone search");
  assert.equal(JSON.stringify(nativeModel), before);
  assert.deepEqual(zoneRows, [north, south, unassigned]);
});

function component(file, name) {
  return find(file, node => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(file) === name);
}
function attribute(element, name) {
  return element.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.text === name);
}

test("clear action resets both the column model and top search in the current project scope", () => {
  const searches = [];
  const models = [];
  const scopeQuery = "siteId=7&kind=personnel&from=2026-11-01&to=2026-11-20";
  const clearSearch = evaluate(declaration(viewSource, "clearSearch"), { ...hooks, scopeQuery, setZoneSearch: value => searches.push(value) });
  const button = find(tableSource, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(tableSource) === "button"
    && node.children.some(child => ts.isJsxText(child) && child.text.trim() === "Сбросить фильтры"));
  const clear = evaluate(attribute(button.openingElement, "onClick").initializer.expression.getText(tableSource), {
    api: { setFilterModel: model => models.push(model) }, onClearFilters: clearSearch,
  });
  clear();
  assert.deepEqual(models, [null]);
  assert.deepEqual(searches, [{ requestKey: scopeQuery, text: "" }]);
});

test("the actual view keeps the full filterable table mounted at zero matches while chart and totals use its filtered output", () => {
  const table = component(viewSource, "StatisticsBreakdownTable");
  assert.equal(attribute(table, "rows").initializer.expression.getText(viewSource), "rows");
  assert.equal(attribute(table, "zoneSearch").initializer.expression.getText(viewSource), "search");
  assert.equal(attribute(table, "onClearFilters").initializer.expression.getText(viewSource), "clearSearch");
  assert.equal(attribute(table, "key").initializer.expression.getText(viewSource), "requestKey");
  assert.equal(attribute(table, "onFilteredRowsChange").initializer.expression.getText(viewSource), "updateFilteredRows");
  assert.ok(ts.isBinaryExpression(table.parent));
  assert.equal(evaluate(table.parent.left.getText(viewSource), { rows: zoneRows, visibleRows: [], filteredRows: [] }), true);
  for (const name of ["StatisticsChart", "StatisticsTotals"]) {
    assert.equal(attribute(component(viewSource, name), "rows").initializer.expression.getText(viewSource), "filteredRows");
  }
  const localized = component(tableSource, "LocalizedGrid");
  const emitted = [];
  const onModelUpdated = evaluate(attribute(localized, "onModelUpdated").initializer.expression.getText(tableSource), { publishFilteredRows: api => emitted.push(api) });
  const api = grid([node(north)]);
  onModelUpdated({ api });
  assert.deepEqual(emitted, [api]);
  assert.equal(attribute(localized, "domLayout").initializer.text, "normal");
  assert.equal(attribute(localized, "isExternalFilterPresent").initializer.expression.getText(tableSource), "hasSearch");
  assert.equal(attribute(localized, "doesExternalFilterPass").initializer.expression.getText(tableSource), "matchesSearch");
});
