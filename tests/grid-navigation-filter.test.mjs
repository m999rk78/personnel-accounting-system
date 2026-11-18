import assert from "node:assert/strict";
import test from "node:test";
import { createGridNavigationFilter } from "../app/gridNavigationFilter.ts";

const settle = () => new Promise(resolve => setImmediate(resolve));
const selection = values => ({ filterType: "multi", filterModels: [null, { filterType: "set", values }] });
function harness({ native = true, keys = ["7", "8"], delay = false, normalizeToNull = false } = {}) {
  const model = {}, listeners = new Map(), calls = [], statuses = [], pending = [];
  const emit = (name, event = {}) => { for (const callback of listeners.get(name) ?? []) callback(event); };
  const api = {
    isDestroyed: () => false,
    getColumn: () => ({ getColDef: () => ({ filter: native ? "agMultiColumnFilter" : "fallback" }) }),
    getColumnFilterModel: id => model[id] ?? null,
    async setColumnFilterModel(id, value) {
      calls.push([id, structuredClone(value)]);
      if (delay) await new Promise((resolve, reject) => pending.push({ resolve, reject }));
      // Native Set validation keeps an explicit empty selection for a missing ID.
      if (value && normalizeToNull) model[id] = null;
      else if (value && keys.length) model[id] = selection(value.filterModels[1].values.filter(key => keys.includes(key)));
      else model[id] = structuredClone(value);
    },
    onFilterChanged: () => emit("filterChanged", { source: "api" }),
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  };
  const controller = createGridNavigationFilter(api, (key, status) => statuses.push({ key, ...status }));
  return { controller, model, calls, statuses, pending, emit, set native(value) { native = value; }, set keys(value) { keys = value; }, set delay(value) { delay = value; } };
}

test("navigation waits for data and native column definitions, then seeds the normal filter once", async () => {
  const ui = harness({ native: false });
  ui.model.department = selection(["Монтаж"]);
  ui.controller.update({ columnId: "fullName", value: "7", ready: false });
  ui.emit("rowDataUpdated");
  await settle();
  assert.equal(ui.calls.length, 0);
  ui.controller.update({ columnId: "fullName", value: "7", ready: true });
  assert.equal(ui.calls.length, 0);
  ui.native = true;
  ui.emit("newColumnsLoaded");
  await settle();
  assert.deepEqual(ui.model.fullName, selection(["7"]));
  assert.deepEqual(ui.model.department, selection(["Монтаж"]));
  for (const event of ["rowDataUpdated", "newColumnsLoaded", "filterChanged"]) ui.emit(event);
  ui.controller.update({ columnId: "fullName", value: "7", ready: true });
  await settle();
  assert.equal(ui.calls.length, 1, "Background refresh and rerender cannot reapply the request");
  assert.equal(ui.statuses.at(-1).pending, false);
});

test("column reset and a changed selection clear URL focus without overwriting the user's filter", async () => {
  for (const next of [null, selection(["8"]), selection(["7", "8"])]) {
    const ui = harness();
    let cleared = 0;
    const target = { columnId: "fullName", value: "7", ready: true, onCleared: () => { cleared++; } };
    ui.controller.update(target);
    await settle();
    ui.model.fullName = next;
    ui.emit("filterChanged");
    assert.equal(cleared, 1);
    ui.controller.update(target);
    ui.emit("rowDataUpdated");
    await settle();
    assert.equal(ui.calls.length, 1);
    ui.controller.update(undefined);
    await settle();
    assert.deepEqual(ui.model.fullName, next);
  }
});

test("missing and sole targets remain explicit filters when the roster refreshes", async () => {
  for (const [keys, expected] of [[["8"], []], [["7"], ["7"]], [[], ["7"]]]) {
    const ui = harness({ keys });
    let cleared = 0;
    ui.controller.update({ columnId: "fullName", value: "7", ready: true, onCleared: () => { cleared++; } });
    await settle();
    assert.deepEqual(ui.model.fullName, selection(expected));
    ui.keys = ["7", "8"];
    ui.emit("rowDataUpdated");
    await settle();
    assert.equal(ui.calls.length, 1);
    assert.equal(cleared, 0);
    assert.equal(ui.statuses.at(-1).error, "");
  }
});

test("a missing-ID normalization to an empty selection does not look like user reset", async () => {
  const ui = harness();
  let cleared = 0;
  ui.controller.update({ columnId: "fullName", value: "7", ready: true, onCleared: () => { cleared++; } });
  await settle();
  ui.model.fullName = selection([]);
  ui.emit("filterChanged");
  assert.equal(cleared, 0);
  assert.deepEqual(ui.model.fullName, selection([]));
});

test("reset while a target is applying cannot let its late result restore the restriction", async () => {
  const ui = harness({ delay: true });
  ui.controller.update({ columnId: "fullName", value: "7", ready: true });
  ui.controller.update(undefined);
  ui.pending.shift().resolve();
  await settle();
  assert.deepEqual(ui.calls.at(-1), ["fullName", null]);
  ui.pending.shift().resolve();
  await settle();
  assert.equal(ui.model.fullName, null);
  assert.equal(ui.statuses.at(-1).pending, false);
});

test("a rejected old apply cannot prevent a newer target from applying", async () => {
  const ui = harness({ delay: true });
  ui.controller.update({ columnId: "fullName", value: "7", ready: true });
  ui.controller.update({ columnId: "fullName", value: "8", ready: true });
  ui.pending.shift().reject(new Error("Old request failed"));
  await settle();
  assert.deepEqual(ui.calls.at(-1), ["fullName", selection(["8"])]);
  ui.pending.shift().resolve();
  await settle();
  assert.deepEqual(ui.model.fullName, selection(["8"]));
  assert.equal(ui.statuses.at(-1).pending, false);
  assert.equal(ui.statuses.at(-1).error, "");
});

test("failed or silently discarded filters surface an error instead of showing the whole roster", async () => {
  const ui = harness({ normalizeToNull: true });
  ui.controller.update({ columnId: "fullName", value: "7", ready: true });
  await settle();
  assert.match(ui.statuses.at(-1).error, /Не удалось применить фильтр/);
  ui.emit("rowDataUpdated");
  await settle();
  assert.equal(ui.calls.length, 1, "A failed request must not loop on every refresh");
});
