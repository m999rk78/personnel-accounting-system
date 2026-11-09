import assert from "node:assert/strict";
import test from "node:test";
import { createGridPreferences, resetGridColumnPreferences } from "../app/gridPreferences.ts";

const defaults = () => [
  { colId: "name", width: 240, minWidth: 140, maxWidth: 1000, flex: 2 },
  { colId: "department", width: 160, minWidth: 100, maxWidth: 500, flex: 1, sort: "asc", sortIndex: 0 },
  { colId: "reportDateGroup", width: 100, minWidth: 80, maxWidth: 300, hide: true, lockVisible: true, resizable: false },
  { colId: "ag-Grid-SelectionColumn", width: 44, minWidth: 44, maxWidth: 44, resizable: false },
];
function grid() {
  const state = defaults();
  let resetCount = 0;
  const columns = new Map(state.map(item => [item.colId, {
    getColId: () => item.colId, getActualWidth: () => item.width,
    getMinWidth: () => item.minWidth, getMaxWidth: () => item.maxWidth,
    isVisible: () => !item.hide, getColDef: () => ({ resizable: item.resizable, lockVisible: item.lockVisible }),
  }]));
  return {
    state, onReset: null, destroyed: false,
    get resetCount() { return resetCount; },
    isDestroyed() { return this.destroyed; },
    getColumn: id => columns.get(id), getColumnState: () => state.map(item => ({ ...item })),
    applyColumnState(input) {
      for (const column of state) {
        const patch = input.state?.find(item => item.colId === column.colId) ?? input.defaultState;
        if (patch) Object.assign(column, patch);
      }
      return true;
    },
    resetColumnState() {
      resetCount++;
      defaults().forEach((item, index) => {
        Object.keys(state[index]).forEach(key => delete state[index][key]);
        Object.assign(state[index], item);
      });
      this.onReset?.();
    },
  };
}
function memoryStorage() {
  const values = new Map(), writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); values.set(key, value); } };
}
const setWidth = (controller, api, id, width) => {
  api.state.find(item => item.colId === id).width = width;
  controller.onColumnResized({ source: "uiColumnResized", finished: true, column: api.getColumn(id), columns: null });
};

test("column-menu reset clears live widths and saved sorting without touching technical-column rules", () => {
  const storage = memoryStorage(), api = grid();
  storage.setItem("user-1:project-2", JSON.stringify({ version: 1, widths: { name: 700 }, sorts: [{ colId: "name", sort: "desc" }] }));
  const controller = createGridPreferences({ storageKey: "user-1:project-2", active: true, storage });
  controller.attach(api);
  assert.equal(api.state[0].width, 700);
  assert.equal(api.state[0].sort, "desc");
  let notified = 0;
  controller.subscribe(() => notified++);
  api.state[0].hide = true;
  api.state[0].pinned = "right";
  resetGridColumnPreferences(api);
  assert.equal(api.resetCount, 1);
  assert.deepEqual(api.state, defaults(), "Only the native reset determines live visibility, ordering, pinned state and utility rules");
  assert.deepEqual(JSON.parse(storage.getItem("user-1:project-2")), { version: 1, widths: {} });
  assert.equal(controller.getSnapshot(), false);
  assert.equal(notified, 1);
  const reopened = grid();
  createGridPreferences({ storageKey: "user-1:project-2", active: true, storage }).attach(reopened);
  assert.deepEqual(reopened.state, defaults(), "Old widths and explicit sorting cannot reappear on the next visit");
});

test("reset ignores intermediate native sort and resize notifications", () => {
  const storage = memoryStorage(), api = grid();
  const controller = createGridPreferences({ storageKey: "scoped", active: true, storage });
  controller.attach(api);
  setWidth(controller, api, "name", 600);
  api.state[0].sort = "desc";
  controller.onSortChanged();
  const before = storage.writes.length;
  api.onReset = () => {
    controller.onColumnResized({ source: "autosizeColumns", finished: true, columns: [api.getColumn("name")], column: api.getColumn("name") });
    controller.onSortChanged();
  };
  resetGridColumnPreferences(api);
  assert.equal(storage.writes.length, before + 1, "Reset notifications must not cache default sizes or sorting as user choices");
  assert.deepEqual(JSON.parse(storage.getItem("scoped")), { version: 1, widths: {} });
});

test("late asynchronous reset-sort callbacks do not save defaults as user sorting", async () => {
  const storage = memoryStorage(), api = grid();
  const controller = createGridPreferences({ storageKey: "scope", active: true, storage });
  controller.attach(api);
  api.state[0].sort = "desc";
  controller.onSortChanged();
  api.onReset = () => queueMicrotask(() => controller.onSortChanged());
  resetGridColumnPreferences(api);
  const writesAfterReset = storage.writes.length;
  await Promise.resolve();
  controller.onSortChanged();
  assert.equal(storage.writes.length, writesAfterReset);
  assert.equal(controller.getSnapshot(), false);
  assert.deepEqual(JSON.parse(storage.getItem("scope")), { version: 1, widths: {} });
  api.state.forEach(item => { item.sort = null; item.sortIndex = null; });
  api.state[0].sort = "desc";
  api.state[0].sortIndex = 0;
  controller.onSortChanged();
  assert.equal(controller.getSnapshot(), true, "The next real user sort must still be stored");
  assert.deepEqual(JSON.parse(storage.getItem("scope")).sorts, [{ colId: "name", sort: "desc" }]);
});

test("reset releases both manual and default width guards, including unscoped grids", () => {
  for (const active of [true, false]) {
    const storage = memoryStorage(), api = grid();
    const controller = createGridPreferences({ storageKey: "scope", active, storage });
    controller.attach(api);
    controller.applyDefaultWidths({ name: 500 });
    setWidth(controller, api, "department", 330);
    controller.applyDefaultWidths({ name: 800, department: 450 });
    assert.equal(api.state[0].width, 500);
    assert.equal(api.state[1].width, 330);
    resetGridColumnPreferences(api);
    controller.applyDefaultWidths({ name: 520, department: 270 });
    assert.equal(api.state[0].width, 520);
    assert.equal(api.state[1].width, 270);
    if (!active) assert.equal(storage.writes.length, 0, "Unscoped grids must not write a shared preference key");
  }
});

test("reset affects only the attached actor/resource scope and not another live grid", () => {
  const storage = memoryStorage(), first = grid(), second = grid();
  const a = createGridPreferences({ storageKey: "user-1:site-1", active: true, storage });
  const b = createGridPreferences({ storageKey: "user-2:site-2", active: true, storage });
  a.attach(first); b.attach(second);
  setWidth(a, first, "name", 510); setWidth(b, second, "name", 890);
  const otherValue = storage.getItem("user-2:site-2");
  resetGridColumnPreferences(first);
  assert.equal(first.state[0].width, 240);
  assert.equal(second.state[0].width, 890);
  assert.equal(second.resetCount, 0);
  assert.equal(storage.getItem("user-2:site-2"), otherValue);
});

test("reattaching a controller detaches its former grid reset registry", () => {
  const storage = memoryStorage(), first = grid(), second = grid();
  const controller = createGridPreferences({ storageKey: "scope", active: true, storage });
  controller.attach(first); setWidth(controller, first, "name", 540);
  controller.attach(second);
  assert.equal(second.state[0].width, 540);
  const saved = storage.getItem("scope");
  resetGridColumnPreferences(first);
  assert.equal(first.resetCount, 1);
  assert.equal(second.resetCount, 0, "Resetting an old grid must never reset the new attached grid");
  assert.equal(storage.getItem("scope"), saved, "An old unmanaged grid cannot erase the new grid's preferences");
  resetGridColumnPreferences(second);
  assert.equal(second.resetCount, 1);
  assert.deepEqual(JSON.parse(storage.getItem("scope")), { version: 1, widths: {} });
});

test("an older controller reattach cannot unregister another controller using its former grid", () => {
  const storage = memoryStorage(), first = grid(), next = grid();
  const a = createGridPreferences({ storageKey: "a", active: true, storage });
  const b = createGridPreferences({ storageKey: "b", active: true, storage });
  a.attach(first); b.attach(first); setWidth(b, first, "name", 720);
  a.attach(next);
  resetGridColumnPreferences(first);
  assert.deepEqual(JSON.parse(storage.getItem("b")), { version: 1, widths: {} });
});

test("unmanaged grids use their native reset and destroyed APIs are ignored", () => {
  const unmanaged = grid();
  unmanaged.state[0].width = 850;
  resetGridColumnPreferences(unmanaged);
  assert.equal(unmanaged.resetCount, 1);
  assert.equal(unmanaged.state[0].width, 240);
  unmanaged.destroyed = true;
  resetGridColumnPreferences(unmanaged);
  assert.equal(unmanaged.resetCount, 1);
});

test("blocked storage cannot prevent resetting live grid state and its sort snapshot", () => {
  const storage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  const api = grid(), controller = createGridPreferences({ storageKey: "scope", active: true, storage });
  controller.attach(api);
  api.state[0].sort = "desc";
  controller.onSortChanged();
  assert.equal(controller.getSnapshot(), true);
  assert.doesNotThrow(() => resetGridColumnPreferences(api));
  assert.equal(controller.getSnapshot(), false);
  assert.equal(api.resetCount, 1);
});

test("legacy fake APIs without native reset remain compatible with the controller", () => {
  const api = grid();
  delete api.resetColumnState;
  const controller = createGridPreferences({ storageKey: "scope", active: false });
  controller.attach(api);
  assert.doesNotThrow(() => resetGridColumnPreferences(api));
});
