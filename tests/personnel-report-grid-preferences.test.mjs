import assert from "node:assert/strict";
import test from "node:test";
import { createPersonnelReportGridPreferences, parsePersonnelReportGridPreferences, personnelReportGridPreferencesKey } from "../app/personnelReportGridPreferences.ts";

const store = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
};
function grid(changes = {}) {
  const defaults = {
    workDate: { width: 125, minWidth: 125, maxWidth: 145, sort: "desc", sortIndex: 0 },
    employeeName: { width: 250, minWidth: 220, maxWidth: 20_000, flex: 2 },
    zone: { width: 180, minWidth: 140, maxWidth: 20_000, flex: 1 },
    note: { width: 240, minWidth: 200, maxWidth: 20_000, flex: 1.5 },
    createdAt: { width: 120, minWidth: 80, maxWidth: 20_000, hide: true },
    "ag-Grid-SelectionColumn": { width: 44, minWidth: 44, maxWidth: 44, resizable: false },
    ...changes,
  };
  const state = Object.entries(defaults).map(([colId, entry]) => ({ colId, ...entry }));
  const applied = [];
  const columns = new Map(state.map(item => [item.colId, {
    getColId: () => item.colId, getActualWidth: () => item.width,
    getMinWidth: () => item.minWidth, getMaxWidth: () => item.maxWidth,
    isVisible: () => !item.hide, getColDef: () => ({ resizable: item.resizable, sortable: item.sortable }),
  }]));
  return { state, applied, isDestroyed: () => false, getColumn: id => columns.get(id),
    getColumnState: () => state.map(item => ({ ...item })),
    applyColumnState(input) {
      applied.push(input);
      for (const column of state) {
        const patch = input.state?.find(item => item.colId === column.colId) ?? input.defaultState;
        if (patch) Object.assign(column, patch);
      }
      return true;
    },
  };
}
const save = (storage, userId, siteId, preference) => storage.setItem(personnelReportGridPreferencesKey(userId, siteId), JSON.stringify({ version: 1, widths: {}, ...preference }));

test("parsing damaged or obsolete preferences preserves usable widths without accepting utility columns", () => {
  for (const raw of [null, "not json", "null", "[]", '{"version":2,"widths":{"zone":500}}']) assert.deepEqual(parsePersonnelReportGridPreferences(raw), { version: 1, widths: {} });
  const parsed = parsePersonnelReportGridPreferences(JSON.stringify({ version: 1, widths: { zone: 480.4, note: -5, huge: 50_000, "ag-Grid-SelectionColumn": 100 }, sorts: [{ colId: "employeeName", sort: "asc" }, { colId: "employeeName", sort: "desc" }, { colId: "actions", sort: "asc" }] }));
  assert.deepEqual(parsed, { version: 1, widths: { zone: 480 }, sorts: [{ colId: "employeeName", sort: "asc" }] });
});

test("only explicitly resized columns become fixed; new and untouched flex columns stay responsive", () => {
  const storage = store();
  save(storage, 10, 1, { widths: { employeeName: 800, zone: 50, workDate: 500, createdAt: 500, removed: 900 } });
  const api = grid();
  const controller = createPersonnelReportGridPreferences({ userId: 10, siteId: 1, storage });
  controller.attach(api);
  assert.deepEqual(api.applied, [{ state: [{ colId: "employeeName", width: 800, flex: null }, { colId: "zone", width: 140, flex: null }, { colId: "workDate", width: 145, flex: null }] }]);
  assert.equal(api.state.find(column => column.colId === "note").flex, 1.5);
  assert.equal(api.state.find(column => column.colId === "createdAt").hide, true);
  assert.equal(api.state.find(column => column.colId === "workDate").sort, "desc");
});

test("initialization, flex recalculation and unfinished drags cannot replace remembered widths", () => {
  const storage = store(), api = grid();
  const controller = createPersonnelReportGridPreferences({ userId: 10, siteId: 1, storage }); controller.attach(api);
  const employee = api.getColumn("employeeName");
  for (const source of ["flex", "gridInitializing", "api", "viewportSizeFeature"]) controller.onColumnResized({ source, finished: true, column: employee, columns: [employee] });
  controller.onColumnResized({ source: "uiColumnResized", finished: false, column: employee, columns: [employee] });
  assert.equal(storage.values.size, 0);
  api.state.find(column => column.colId === "employeeName").width = 560;
  controller.onColumnResized({ source: "uiColumnResized", finished: true, column: employee, columns: [employee] });
  assert.deepEqual(JSON.parse(storage.getItem(personnelReportGridPreferencesKey(10, 1))), { version: 1, widths: { employeeName: 560 } });
  const restored = grid(); createPersonnelReportGridPreferences({ userId: 10, siteId: 1, storage }).attach(restored);
  assert.equal(restored.state.find(column => column.colId === "employeeName").width, 560);
  assert.equal(restored.state.find(column => column.colId === "zone").flex, 1);
});

test("autosizing remembers content columns only, including the single-column event form", () => {
  const storage = store(), api = grid();
  const controller = createPersonnelReportGridPreferences({ userId: 10, siteId: 1, storage }); controller.attach(api);
  controller.onColumnResized({ source: "autosizeColumns", finished: true, column: null, columns: [api.getColumn("note"), api.getColumn("createdAt"), api.getColumn("ag-Grid-SelectionColumn")] });
  controller.onColumnResized({ source: "uiColumnResized", finished: true, column: api.getColumn("zone"), columns: null });
  assert.deepEqual(JSON.parse(storage.getItem(personnelReportGridPreferencesKey(10, 1))).widths, { note: 240, zone: 180 });
});

test("sorting waits for the row-order baseline and is not overwritten by initialization", () => {
  const storage = store();
  const sorts = [{ colId: "workDate", sort: "desc" }, { colId: "employeeName", sort: "asc" }];
  save(storage, 10, 1, { widths: { zone: 400 }, sorts });
  const api = grid(), controller = createPersonnelReportGridPreferences({ userId: 10, siteId: 1, storage, ready: false });
  assert.equal(controller.getSnapshot(), true);
  controller.attach(api); controller.onSortChanged();
  assert.deepEqual(JSON.parse(storage.getItem(personnelReportGridPreferencesKey(10, 1))).sorts, sorts);
  assert.equal(api.state.find(column => column.colId === "employeeName").sort, undefined);
  controller.setReady(true);
  assert.deepEqual(api.getColumnState().filter(column => column.sort).map(({ colId, sort, sortIndex }) => ({ colId, sort, sortIndex })), [{ colId: "workDate", sort: "desc", sortIndex: 0 }, { colId: "employeeName", sort: "asc", sortIndex: 1 }]);
  assert.equal(api.state.find(column => column.colId === "zone").width, 400);
});

test("clearing a sort for manual movement is itself remembered across the next visit", () => {
  const storage = store(), api = grid();
  const controller = createPersonnelReportGridPreferences({ userId: 10, siteId: 1, storage }); controller.attach(api);
  api.state.forEach(column => { column.sort = null; column.sortIndex = null; });
  controller.onSortChanged();
  assert.deepEqual(JSON.parse(storage.getItem(personnelReportGridPreferencesKey(10, 1))).sorts, []);
  assert.equal(controller.getSnapshot(), true);
  const next = grid(); createPersonnelReportGridPreferences({ userId: 10, siteId: 1, storage }).attach(next);
  assert.ok(next.getColumnState().every(column => !column.sort));
});

test("user and project identities are isolated; disabled grids never use a shared fallback key", () => {
  const storage = store(); save(storage, 10, 1, { widths: { employeeName: 640 } });
  for (const [userId, siteId] of [[11, 1], [10, 2]]) {
    const api = grid(); createPersonnelReportGridPreferences({ userId, siteId, storage }).attach(api);
    assert.equal(api.state.find(column => column.colId === "employeeName").width, 250);
  }
  const api = grid(), controller = createPersonnelReportGridPreferences({ userId: 0, siteId: 0, storage, enabled: false }); controller.attach(api);
  controller.onColumnResized({ source: "uiColumnResized", finished: true, column: api.getColumn("employeeName"), columns: null }); controller.onSortChanged();
  assert.equal(storage.values.size, 1);
});

test("unavailable browser storage never breaks resizing or reading the report", () => {
  const storage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  const api = grid(), controller = createPersonnelReportGridPreferences({ userId: 10, siteId: 1, storage });
  assert.doesNotThrow(() => controller.attach(api));
  assert.doesNotThrow(() => controller.onColumnResized({ source: "uiColumnResized", finished: true, column: api.getColumn("employeeName"), columns: null }));
  assert.doesNotThrow(() => controller.onSortChanged());
});

test("content defaults fill untouched columns without replacing a saved narrower user width or storing defaults", () => {
  const storage = store();
  save(storage, 10, 1, { widths: { zone: 180 } });
  const cached = storage.getItem(personnelReportGridPreferencesKey(10, 1));
  const api = grid(), controller = createPersonnelReportGridPreferences({ userId: 10, siteId: 1, storage });
  controller.attach(api);
  controller.applyDefaultWidths({ zone: 600, employeeName: 470, note: 350 });
  assert.equal(api.state.find(column => column.colId === "zone").width, 180);
  assert.equal(api.state.find(column => column.colId === "employeeName").width, 470);
  assert.equal(api.state.find(column => column.colId === "note").width, 350);
  assert.equal(storage.getItem(personnelReportGridPreferencesKey(10, 1)), cached);
  assert.deepEqual(api.applied.at(-1).state.map(column => column.colId), ["employeeName", "note"]);
});

test("a manual resize before data arrives wins over later defaults even without a persisted preference scope", () => {
  const storage = store(), api = grid();
  const controller = createPersonnelReportGridPreferences({ userId: 0, siteId: 0, enabled: false, storage });
  controller.attach(api);
  const zone = api.state.find(column => column.colId === "zone");
  zone.width = 170;
  controller.onColumnResized({ source: "uiColumnResized", finished: true, column: api.getColumn("zone"), columns: null });
  controller.applyDefaultWidths({ zone: 600, note: 420 });
  assert.equal(zone.width, 170);
  assert.equal(api.state.find(column => column.colId === "note").width, 420);
  assert.equal(storage.values.size, 0);
});

test("repeated data and editor refreshes cannot resize an initialized column; a new grid can get fresh defaults", () => {
  const api = grid(), controller = createPersonnelReportGridPreferences({ userId: 0, siteId: 0, enabled: false });
  controller.attach(api);
  controller.applyDefaultWidths({ zone: 460 });
  controller.applyDefaultWidths({ zone: 800, note: 380 });
  controller.applyDefaultWidths({ zone: 900, note: 800 });
  assert.equal(api.state.find(column => column.colId === "zone").width, 460);
  assert.equal(api.state.find(column => column.colId === "note").width, 380);
  assert.equal(api.applied.length, 2);
  const next = grid(); controller.attach(next); controller.applyDefaultWidths({ zone: 630 });
  assert.equal(next.state.find(column => column.colId === "zone").width, 630);
  assert.equal(api.state.find(column => column.colId === "zone").width, 460);
});

test("default plans ignore missing or invalid values and hidden utility columns and respect declared size bounds", () => {
  const api = grid({ locked: { width: 160, minWidth: 80, maxWidth: 300, resizable: false } });
  const controller = createPersonnelReportGridPreferences({ userId: 10, siteId: 1, storage: store() });
  controller.applyDefaultWidths({ zone: 999 });
  controller.attach(api);
  controller.applyDefaultWidths(undefined); controller.applyDefaultWidths({});
  controller.applyDefaultWidths({ createdAt: 500, "ag-Grid-SelectionColumn": 200, locked: 250, removed: 500, zone: NaN, note: 0 });
  assert.equal(api.applied.length, 0);
  controller.applyDefaultWidths({ workDate: 500, zone: 480.6, note: 20 });
  assert.deepEqual(api.applied[0].state, [{ colId: "workDate", width: 145, flex: null }, { colId: "zone", width: 481, flex: null }, { colId: "note", width: 200, flex: null }]);
  assert.equal(api.state.find(column => column.colId === "workDate").sort, "desc");
  assert.equal(api.state.find(column => column.colId === "createdAt").hide, true);
  api.isDestroyed = () => true;
  controller.applyDefaultWidths({ employeeName: 500 });
  assert.equal(api.applied.length, 1);
});
