import assert from "node:assert/strict";
import test from "node:test";
import { createGridPreferences } from "../app/gridPreferences.ts";
import { createPersonnelReportGridPreferences, personnelReportGridPreferencesKey } from "../app/personnelReportGridPreferences.ts";
import { createEmployeeGridPreferences, employeeGridPreferencesKey } from "../app/useEmployeeGridPreferences.ts";

function storage() {
  const values = new Map(), reads = [];
  return { values, reads, getItem(key) { reads.push(key); return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); } };
}

function grid() {
  const state = [
    { colId: "fullName", width: 250, minWidth: 180, maxWidth: 1000, flex: 2 },
    { colId: "department", width: 160, minWidth: 120, maxWidth: 500, flex: 1 },
    { colId: "position", width: 240, minWidth: 180, maxWidth: 1000, flex: 1.5 },
    { colId: "ag-Grid-SelectionColumn", width: 44, minWidth: 44, maxWidth: 44, resizable: false },
  ];
  const applied = [];
  const columns = new Map(state.map(item => [item.colId, {
    getColId: () => item.colId, getActualWidth: () => item.width,
    getMinWidth: () => item.minWidth, getMaxWidth: () => item.maxWidth,
    isVisible: () => true, getColDef: () => ({ resizable: item.resizable }),
  }]));
  return { state, applied, isDestroyed: () => false, getColumn: id => columns.get(id), getColumnState: () => state.map(item => ({ ...item })),
    applyColumnState(input) {
      applied.push(input);
      for (const item of state) {
        const patch = input.state.find(value => value.colId === item.colId) ?? input.defaultState;
        if (patch) Object.assign(item, patch);
      }
      return true;
    },
  };
}

function resize(controller, api, width) {
  api.state.find(column => column.colId === "fullName").width = width;
  controller.onColumnResized({ source: "uiColumnResized", finished: true, column: api.getColumn("fullName") });
}

test("employee preferences survive visits independently of report project preferences", () => {
  const store = storage(), employee = grid();
  const directory = createEmployeeGridPreferences({ userId: 17, storage: store }); directory.attach(employee);
  resize(directory, employee, 560);
  employee.state.find(column => column.colId === "department").sort = "desc";
  directory.onSortChanged();
  assert.deepEqual(JSON.parse(store.values.get(employeeGridPreferencesKey(17))), { version: 1, widths: { fullName: 560 }, sorts: [{ colId: "department", sort: "desc" }] });

  for (const siteId of [1, 2]) {
    const report = grid(), preferences = createPersonnelReportGridPreferences({ userId: 17, siteId, storage: store });
    preferences.attach(report);
    assert.equal(report.state[0].width, 250, "a report cannot inherit general-directory widths");
    assert.equal(report.state[1].sort, undefined);
    resize(preferences, report, 700 + siteId);
  }
  const reopened = grid(); createEmployeeGridPreferences({ userId: 17, storage: store }).attach(reopened);
  assert.equal(reopened.state[0].width, 560);
  assert.equal(reopened.state[1].sort, "desc");
  assert.equal(reopened.state[2].flex, 1.5, "untouched columns stay flexible");
  assert.deepEqual([...store.values.keys()].sort(), [employeeGridPreferencesKey(17), personnelReportGridPreferencesKey(17, 1), personnelReportGridPreferencesKey(17, 2)].sort());
});

test("employee preferences are isolated per user and invalid identities never read or write a fallback key", () => {
  const store = storage();
  store.setItem(employeeGridPreferencesKey(17), JSON.stringify({ version: 1, widths: { fullName: 800 }, sorts: [] }));
  const other = grid(); createEmployeeGridPreferences({ userId: 18, storage: store }).attach(other);
  assert.equal(other.state[0].width, 250);
  store.reads.length = 0;
  for (const userId of [0, -1, NaN, 1.5]) {
    const api = grid(), preferences = createEmployeeGridPreferences({ userId, storage: store }); preferences.attach(api);
    resize(preferences, api, 900); preferences.onSortChanged();
    assert.equal(preferences.getSnapshot(), false);
  }
  const disabled = grid(), preferences = createEmployeeGridPreferences({ userId: 17, enabled: false, storage: store });
  preferences.attach(disabled); resize(preferences, disabled, 600); preferences.onSortChanged();
  assert.deepEqual(store.reads, []); assert.equal(store.values.size, 1);
});

test("employee sorting waits for table order and retains manually resized columns", () => {
  const store = storage();
  store.setItem(employeeGridPreferencesKey(17), JSON.stringify({ version: 1, widths: { fullName: 540 }, sorts: [{ colId: "department", sort: "asc" }] }));
  const api = grid(), preferences = createEmployeeGridPreferences({ userId: 17, ready: false, storage: store });
  preferences.attach(api);
  assert.equal(api.state[0].width, 540);
  assert.equal(api.state[1].sort, undefined);
  preferences.onSortChanged();
  assert.deepEqual(JSON.parse(store.values.get(employeeGridPreferencesKey(17))).sorts, [{ colId: "department", sort: "asc" }]);
  preferences.setReady(true);
  assert.equal(api.state[1].sort, "asc");
  assert.equal(api.state[0].width, 540);
  api.state[1].sort = null; preferences.onSortChanged();
  const next = grid(); createEmployeeGridPreferences({ userId: 17, storage: store }).attach(next);
  assert.ok(next.state.every(column => !column.sort), "explicitly cleared sorting is remembered");
});

test("corrupt employee storage cannot change visibility, utility columns, or selection", () => {
  const store = storage();
  store.setItem(employeeGridPreferencesKey(17), JSON.stringify({ version: 1, widths: { fullName: 400, "ag-Grid-SelectionColumn": 900, department: -1 }, hide: ["fullName"], selectedRows: [1, 2], sorts: [{ colId: "ag-Grid-SelectionColumn", sort: "asc" }] }));
  const api = grid(); createEmployeeGridPreferences({ userId: 17, storage: store }).attach(api);
  assert.equal(api.state[0].width, 400); assert.equal(api.state[3].width, 44);
  assert.equal(api.state[1].width, 160); assert.ok(api.state.every(column => !column.hide && !column.sort));
  assert.deepEqual(api.applied[0], { state: [{ colId: "fullName", width: 400, flex: null }] });
  store.setItem(employeeGridPreferencesKey(18), "not JSON");
  const other = grid(); assert.doesNotThrow(() => createEmployeeGridPreferences({ userId: 18, storage: store }).attach(other));
  assert.equal(other.state[0].width, 250);
});

test("blocked browser storage keeps the table usable and still reports a user-chosen sort", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  const api = grid(), preferences = createEmployeeGridPreferences({ userId: 17, storage: blocked });
  let notifications = 0; const unsubscribe = preferences.subscribe(() => notifications++);
  assert.doesNotThrow(() => { preferences.attach(api); resize(preferences, api, 600); });
  api.state[0].sort = "asc"; assert.doesNotThrow(() => preferences.onSortChanged());
  assert.equal(preferences.getSnapshot(), true); assert.equal(notifications, 1);
  unsubscribe(); api.state[0].sort = null; preferences.onSortChanged();
  assert.equal(notifications, 1);
});

test("the shared controller requires an explicit active storage scope", () => {
  const store = storage();
  for (const args of [{ storageKey: "", active: true }, { storageKey: "employees-grid:v1:17", active: false }]) {
    const api = grid(), preferences = createGridPreferences({ ...args, storage: store });
    preferences.attach(api); resize(preferences, api, 600); preferences.onSortChanged();
  }
  assert.deepEqual(store.reads, []); assert.equal(store.values.size, 0);
});
