import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createIdlePageRefresh } from "../app/idlePageRefresh.ts";
import { createTimesheetBatchSave } from "../app/timesheetBatchSave.ts";
import { equipmentDisplayName as unitTitle } from "../app/equipmentDisplayName.ts";

const file = new URL("../app/EquipmentAccountingView.tsx", import.meta.url);
const source = ts.createSourceFile(file.pathname, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = []; const collect = node => { nodes.push(node); ts.forEachChild(node, collect); }; collect(source);
const js = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function declaration(name) {
  const node = nodes.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `Actual equipment callback ${name} exists`); return node.getText(source);
}
const effect = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
  && node.arguments[0]?.getText(source).includes("const control = createIdlePageRefresh"))?.arguments[0];
const options = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(source) === "useTimesheetBatchSave")?.arguments[0];
assert.ok(effect && options, "Equipment month uses actual idle refresh and shared save lifecycle");
function bind(code, result, env) { return new Function(...Object.keys(env), `${js(code)}\nreturn ${result};`)(...Object.values(env)); }
const helpers = bind(["equipmentCellKey", "formatEquipmentHours", "parseEquipmentClipboardHours"].map(declaration).join("\n"), "{equipmentCellKey,formatEquipmentHours,parseEquipmentClipboardHours,unitTitle}", { unitTitle });

function page() {
  const pageWindow = new EventTarget(), pageDocument = new EventTarget(); pageDocument.visibilityState = "visible";
  const timers = new Map(); let next = 0;
  pageWindow.setTimeout = callback => { const id = ++next; timers.set(id, callback); return id; };
  pageWindow.clearTimeout = id => timers.delete(id); pageWindow.location = { replace() {} };
  return { pageWindow, pageDocument, focus() { pageWindow.dispatchEvent(new Event("focus")); },
    visible(value) { pageDocument.visibilityState = value ? "visible" : "hidden"; pageDocument.dispatchEvent(new Event("visibilitychange")); },
    async tick() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } for (let i = 0; i < 14; i++) await Promise.resolve(); },
  };
}
function readHarness(section = "month") {
  const env = page(), requests = [];
  const original = { siteId: 2, month: "2026-11", units: [{ id: 7 }], entries: [{ equipmentId: 7, workDate: "2026-11-01", hours: 8 }], marks: [] };
  let payload = structuredClone(original), error = "", refreshError = "";
  const refs = { refreshBusy: { current: false }, markWrites: { current: 0 }, markRevision: { current: 0 }, refreshControl: { current: null } };
  const cleanup = bind(`const run = ${effect.getText(source)};`, "run()", {
    ...refs, createIdlePageRefresh, window: env.pageWindow, document: env.pageDocument, AbortController,
    siteId: 2, month: "2026-11", workDate: "2026-11-09", section,
    setPayload(value) { payload = value; }, setError(value) { error = value; }, setRefreshError(value) { refreshError = value; },
    fetch(url, options) { return new Promise(resolve => requests.push({ url, options, resolve })); },
  });
  return { ...env, ...refs, requests, original, cleanup, result: () => ({ payload, error, refreshError }),
    respond(index, value, status = 200) { requests[index].resolve({ status, ok: status >= 200 && status < 300, json: async () => value }); },
  };
}
const moved = { siteId: 2, month: "2026-11", units: [{ id: 7 }], entries: [{ equipmentId: 7, workDate: "2026-11-02", hours: 8 }], marks: [] };

test("equipment page return coalesces events, refreshes moved report dates, and skips non-month sections", async () => {
  const state = readHarness(); state.focus(); state.visible(false); state.visible(true); state.focus(); await state.tick();
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].url, "/api/equipment?siteId=2&date=2026-11-09&month=2026-11&scope=project&view=timesheet&section=month");
  assert.equal(state.requests[0].options.cache, "no-store"); state.respond(0, moved); await state.tick();
  assert.deepEqual(state.result().payload, moved); state.cleanup();
  const registry = readHarness("registry"); registry.focus(); await registry.tick(); assert.equal(registry.requests.length, 0);
});

test("equipment refresh waits for editors and writes, including a busy state entered while reading", async () => {
  const state = readHarness(); state.refreshBusy.current = true; state.focus(); await state.tick(); assert.equal(state.requests.length, 0);
  state.refreshBusy.current = false; state.markWrites.current = 1; state.refreshControl.current.flush(); await state.tick(); assert.equal(state.requests.length, 0);
  state.markWrites.current = 0; state.refreshControl.current.flush(); await state.tick(); assert.equal(state.requests.length, 1);
  state.refreshBusy.current = true; state.respond(0, moved); await state.tick(); assert.deepEqual(state.result().payload, state.original);
  state.refreshBusy.current = false; state.refreshControl.current.flush(); await state.tick(); assert.equal(state.requests.length, 2);
  state.respond(1, moved); await state.tick(); assert.deepEqual(state.result().payload, moved); state.cleanup();
});

test("equipment local mark revisions discard stale background snapshots and request current data", async () => {
  const state = readHarness(); state.focus(); await state.tick(); state.markRevision.current++;
  state.respond(0, moved); await state.tick(); assert.deepEqual(state.result().payload, state.original);
  await state.tick(); assert.equal(state.requests.length, 2);
  const latest = { ...moved, marks: [{ equipmentId: 7, workDate: "2026-11-03", productiveHours: 4, downtimeHours: 2 }] };
  state.respond(1, latest); await state.tick(); assert.deepEqual(state.result().payload, latest); state.cleanup();
});

test("equipment scope cleanup aborts a pending read and its late response cannot overwrite data", async () => {
  const state = readHarness(); state.focus(); await state.tick(); state.cleanup();
  assert.equal(state.requests[0].options.signal.aborted, true); state.respond(0, moved); await state.tick();
  assert.deepEqual(state.result().payload, state.original);
});

test("equipment refresh errors retain visible hours, retry clears the warning, and revoked access hides data", async () => {
  const state = readHarness(); state.focus(); await state.tick(); state.respond(0, { error: "Временная ошибка" }, 500); await state.tick();
  assert.deepEqual(state.result().payload, state.original); assert.equal(state.result().refreshError, "Временная ошибка");
  state.refreshControl.current.request(); await state.tick(); state.respond(1, moved); await state.tick(); assert.equal(state.result().refreshError, "");
  state.focus(); await state.tick(); state.respond(2, { error: "Доступ закрыт" }, 403); await state.tick();
  assert.equal(state.result().payload, null); assert.equal(state.result().error, "Доступ закрыт"); state.cleanup();
});

function writeHarness({ visibleDays = [1, 2], marks = [] } = {}) {
  const payload = { canEditTimesheet: true, canCreateTimesheet: true, canDeleteTimesheet: true, canUpdateTimesheet: true, siteId: 2, month: "2026-11", marks };
  let current = structuredClone(payload), flushes = 0;
  const requests = [], undo = [], activeScope = { current: "2:month:2026-11" }, activeScopeVersion = { current: 0 };
  const clipboardViewScope = { current: `2:month:2026-11:7:days=${visibleDays.join("|")}` }, markWrites = { current: 0 }, markRevision = { current: 0 };
  const functions = bind([
    declaration("persistEquipmentTimesheetMark"), declaration("applySavedEquipmentTimesheetCells"), declaration("pasteEquipmentTimesheetCells"),
    `const batchSave = createTimesheetBatchSave(${options.getText(source)});`,
  ].join("\n"), "{single:persistEquipmentTimesheetMark,bulk:pasteEquipmentTimesheetCells,batch:batchSave}", {
    ...helpers, payload, activeScope, activeScopeVersion, clipboardViewScope, markWrites, markRevision, createTimesheetBatchSave,
    section: "month", siteId: 2, month: "2026-11", visibleMonthDays: visibleDays,
    monthRows: [{ unit: { id: 7, equipmentType: "Кран", registrationNumber: "А001" } }],
    timesheetMarksByCell: new Map(marks.map(mark => [helpers.equipmentCellKey(mark.equipmentId, mark.workDate), mark])),
    fullDate: date => date, savingBulkTimesheetMarks: false, navigationBusy: false, loading: false,
    setSavingTimesheetMark() {}, setPayload(update) { current = typeof update === "function" ? update(current) : update; },
    rememberEquipmentTimesheetUndo(value) { undo.push(value); }, forgetEquipmentTimesheetUndo() {},
    refreshControl: { current: { flush() { flushes++; } } },
    post(body) { return new Promise((resolve, reject) => requests.push({ body, resolve, reject })); },
  });
  return { ...functions, markWrites, markRevision, requests, undo, activeScope, activeScopeVersion, clipboardViewScope, result: () => current, flushes: () => flushes,
    scope(siteId, month) { functions.batch.deactivate(); activeScope.current = `${siteId}:month:${month}`; activeScopeVersion.current++; clipboardViewScope.current += ":changed";
      current = { ...structuredClone(payload), siteId, month, marks: [{ equipmentId: 7, workDate: `${month}-01`, productiveHours: 3, downtimeHours: 0 }] }; return structuredClone(current); },
    respond(index) { const { body, resolve } = requests[index]; resolve({ mark: body.clear ? undefined : { equipmentId: body.equipmentId, workDate: body.workDate, productiveHours: body.productiveHours, downtimeHours: body.downtimeHours, note: body.note } }); },
  };
}
const value = { clear: false, productiveHours: 4, downtimeHours: 2, note: "Простой" };

for (const [siteId, month] of [[3, "2026-11"], [2, "2026-12"]]) {
  test(`equipment late single write cannot change ${siteId}/${month} or its undo`, async () => {
    const state = writeHarness(); const write = state.single({ equipmentId: 7, workDate: "2026-11-01" }, value);
    assert.equal(state.requests[0].body.siteId, 2); const destination = state.scope(siteId, month); state.respond(0);
    assert.equal(await write, false); assert.deepEqual(state.result(), destination); assert.deepEqual(state.undo, []);
    assert.equal(state.markWrites.current, 0); assert.equal(state.flushes(), 1);
  });
  test(`equipment late batch cannot change ${siteId}/${month} or its undo`, async () => {
    const state = writeHarness(); const write = state.bulk([{ rowIndex: 0, columnIndex: 1, value: "8/2" }]);
    const destination = state.scope(siteId, month); state.respond(0);
    assert.deepEqual(await write, { savedChanges: [], failedChanges: [] }); assert.deepEqual(state.result(), destination); assert.deepEqual(state.undo, []);
  });
}

test("equipment leaving and returning to the same scope still invalidates a former write", async () => {
  const state = writeHarness(); const write = state.single({ equipmentId: 7, workDate: "2026-11-01" }, value);
  state.scope(3, "2026-12"); const destination = state.scope(2, "2026-11"); state.respond(0);
  assert.equal(await write, false); assert.deepEqual(state.result(), destination); assert.deepEqual(state.undo, []);
});

test("equipment writes preserve split hours, manual zero, clear and sparse-day undo positions", async () => {
  for (const markValue of [value, { clear: false, productiveHours: 0, downtimeHours: 0, note: "Ноль" }, { clear: true, productiveHours: 0, downtimeHours: 0, note: "" }]) {
    const old = { equipmentId: 7, workDate: "2026-11-10", productiveHours: 0, downtimeHours: 2, note: "Исходный простой" };
    const state = writeHarness({ visibleDays: [2, 10], marks: [old] });
    const write = state.single({ equipmentId: 7, workDate: "2026-11-10" }, markValue); state.respond(0); assert.equal(await write, true);
    assert.deepEqual(state.undo, [[{ rowIndex: 0, columnIndex: 1, value: "П 2", note: "Исходный простой" }]]);
    if (markValue.clear) assert.deepEqual(state.result().marks, []);
    else { assert.equal(state.result().marks[0].productiveHours, markValue.productiveHours); assert.equal(state.result().marks[0].downtimeHours, markValue.downtimeHours); }
  }
});

test("equipment batches hold refresh busy until every request settles and retry failed cells only", async () => {
  const state = writeHarness(); const changes = [{ rowIndex: 0, columnIndex: 0, value: "8/2" }, { rowIndex: 0, columnIndex: 1, value: "П 3" }];
  const write = state.bulk(changes); assert.equal(state.markWrites.current, 1); assert.equal(state.markRevision.current, 1);
  state.requests[0].reject(new Error("Конфликт")); for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(state.markWrites.current, 1); state.respond(1);
  assert.deepEqual(await write, { savedChanges: [changes[1]], failedChanges: [changes[0]] }); assert.equal(state.markWrites.current, 0); assert.equal(state.flushes(), 1);
  assert.equal(state.result().marks[0].downtimeHours, 3); const retry = state.batch.retry();
  assert.equal(state.requests.length, 3); assert.equal(state.markWrites.current, 1); assert.equal(state.markRevision.current, 2); state.respond(2); await retry;
  assert.equal(state.result().marks.length, 2); assert.equal(state.markWrites.current, 0); assert.equal(state.batch.getSnapshot().status.failed, 0);
});
