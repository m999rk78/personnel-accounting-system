import assert from "node:assert/strict";
import test from "node:test";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const { tableColumnMenuItems } = await import(await compileModuleGraph("app/gridColumnMenu.ts"));
function column(id, definition = {}, visible = true) {
  return { id, visible, getColId: () => id, getColDef: () => definition, isVisible() { return this.visible; }, isSortable: () => definition.sortable !== false };
}
function harness(selected, columns = [selected, column("other")], defaults = ["sortAscending", "sortDescending", "separator", "pinSubMenu", "autoSizeThis", "autoSizeAll", "separator", "columnChooser", "resetColumns"]) {
  const calls = [];
  let destroyed = false;
  const api = { isDestroyed: () => destroyed, getColumns: () => columns,
    setColumnsVisible: (items, visible) => { calls.push(["visible", items.map(item => item.id), visible]); items.forEach(item => { item.visible = visible; }); },
    autoSizeColumns: items => calls.push(["size", items.map(item => item.id)]),
    autoSizeAllColumns: () => calls.push(["sizeAll"]), resetColumnState: () => calls.push(["reset"]),
  };
  return { items: tableColumnMenuItems({ api, column: selected, defaultItems: defaults }), calls, destroy() { destroyed = true; } };
}
const action = (items, name) => items.find(item => typeof item !== "string" && item.name === name);

test("column menu preserves native pin/chooser capabilities without introducing grouping", () => {
  const { items } = harness(column("name"));
  assert.ok(items.includes("pinSubMenu")); assert.ok(items.includes("columnChooser"));
  assert.ok(!items.includes("rowGroup"));
  assert.equal(action(items, "Сбросить сортировку").disabled, true);
  const withGroup = harness(column("department", { enableRowGroup: true }), undefined, ["rowGroup", "columnChooser"]).items;
  assert.ok(withGroup.includes("rowGroup"));
});

test("hide is a real visibility action and remains before the column chooser", () => {
  const { items, calls } = harness(column("department"));
  const hide = action(items, "Скрыть столбец");
  assert.equal(hide.disabled, false);
  assert.ok(items.indexOf(hide) < items.indexOf("columnChooser"));
  hide.action(); assert.deepEqual(calls, [["visible", ["department"], false]]);
});

test("technical columns cannot be hidden and are not counted as remaining data", () => {
  const selected = column("name");
  const state = harness(selected, [selected, column("number"), column("internal", { suppressColumnsToolPanel: true })]);
  assert.equal(action(state.items, "Скрыть столбец").disabled, true);
  action(state.items, "Скрыть столбец").action(); assert.deepEqual(state.calls, []);
  assert.equal(action(harness(column("number")).items, "Скрыть столбец"), undefined);
  assert.equal(action(harness(column("private", { suppressColumnsToolPanel: true })).items, "Скрыть столбец"), undefined);
});

test("locked visibility, last-column changes and destroyed grids are rechecked on selection", () => {
  const locked = harness(column("name", { lockVisible: true }));
  assert.equal(action(locked.items, "Скрыть столбец").disabled, true);
  action(locked.items, "Скрыть столбец").action(); assert.deepEqual(locked.calls, []);
  const other = column("other"), selected = column("name"), late = harness(selected, [selected, other]);
  other.visible = false; action(late.items, "Скрыть столбец").action(); assert.deepEqual(late.calls, []);
  const dead = harness(column("name")); dead.destroy(); action(dead.items, "Скрыть столбец").action(); assert.deepEqual(dead.calls, []);
});

test("auto-sizing uses public APIs, allowing existing preference handlers to save widths", () => {
  const { items, calls } = harness(column("name"));
  action(items, "Ширина по содержимому").action(); action(items, "Подобрать ширину всех").action();
  assert.deepEqual(calls, [["size", ["name"]], ["sizeAll"]]);
});

test("a blank header retains chooser/reset recovery and reset invokes the real grid", () => {
  const { items, calls } = harness(null, [], ["columnChooser", "resetColumns"]);
  assert.ok(items.includes("columnChooser")); assert.equal(action(items, "Скрыть столбец"), undefined);
  action(items, "Сбросить столбцы").action(); assert.deepEqual(calls, [["reset"]]);
});
