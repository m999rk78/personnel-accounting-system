import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createIdlePageRefresh } from "../app/idlePageRefresh.ts";

function page() {
  const pageWindow = new EventTarget();
  const pageDocument = new EventTarget();
  pageDocument.visibilityState = "visible";
  let nextTimer = 0;
  const timers = new Map();
  pageWindow.setTimeout = callback => { const id = ++nextTimer; timers.set(id, callback); return id; };
  pageWindow.clearTimeout = id => timers.delete(id);
  pageWindow.location = { replace() {} };
  return { pageWindow, pageDocument,
    focus: () => pageWindow.dispatchEvent(new Event("focus")),
    visible(value) { pageDocument.visibilityState = value ? "visible" : "hidden"; pageDocument.dispatchEvent(new Event("visibilitychange")); },
    async tick() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } for (let step = 0; step < 12; step++) await Promise.resolve(); },
  };
}

test("page return coalesces focus/visibility and defers refresh during editing or writes", async () => {
  const env = page(); let busy = true, count = 0;
  const refresh = createIdlePageRefresh({ ...env, isBusy: () => busy, refresh: async () => { count++; } });
  env.focus(); env.visible(false); env.visible(true); await env.tick(); assert.equal(count, 0);
  busy = false; refresh.flush(); env.focus(); await env.tick(); assert.equal(count, 1);
  env.visible(false); env.focus(); await env.tick(); assert.equal(count, 1, "hidden pages do not fetch");
  env.visible(true); env.focus(); await env.tick(); assert.equal(count, 2, "one GET for a visible return");
  refresh.dispose(); env.focus(); env.visible(true); await env.tick(); assert.equal(count, 2);
});

test("duplicate focus while loading does not refetch; a real hide/return queues one newer snapshot", async () => {
  const env = page(); const pending = [];
  const refresh = createIdlePageRefresh({ ...env, isBusy: () => false, refresh: () => new Promise(resolve => pending.push(resolve)) });
  env.focus(); await env.tick(); assert.equal(pending.length, 1);
  env.focus(); env.focus(); await env.tick(); assert.equal(pending.length, 1);
  env.visible(false); env.visible(true); env.focus(); await env.tick(); assert.equal(pending.length, 1);
  pending[0](); await env.tick(); await env.tick(); assert.equal(pending.length, 2);
  refresh.dispose(); pending[1](); await env.tick(); assert.equal(pending.length, 2);
});

const path = new URL("../app/TimesheetView.tsx", import.meta.url);
const source = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let refreshEffect, pasteDeclaration, singleDeclaration;
function visit(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect"
    && node.arguments[0]?.getText(source).includes("const control = createIdlePageRefresh")) refreshEffect = node.arguments[0];
  if (ts.isFunctionDeclaration(node) && node.name?.text === "pasteTimesheetCells") pasteDeclaration = node;
  if (ts.isFunctionDeclaration(node) && node.name?.text === "persistMark") singleDeclaration = node;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(refreshEffect, "Expected actual page-return fetch effect");
assert.ok(pasteDeclaration, "Expected actual bulk write callback");
assert.ok(singleDeclaration, "Expected actual individual mark callback");
const effectCode = ts.transpileModule(`const run = ${refreshEffect.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const pasteCode = ts.transpileModule(pasteDeclaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const singleCode = ts.transpileModule(singleDeclaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const env = page();
  const requests = [];
  const original = { employees: [{ id: 7 }], entries: [{ employeeId: 7, workDate: "2026-11-01", hours: 8 }], marks: [] };
  let payload = structuredClone(original), error = "", refreshError = "";
  const refs = { refreshBusy: { current: false }, markWrites: { current: 0 }, markRevision: { current: 0 }, refreshControl: { current: null } };
  const bindings = { createIdlePageRefresh, window: env.pageWindow, document: env.pageDocument, AbortController,
    ...refs, siteId: 2, month: "2026-11", setPayload(value) { payload = value; }, setError(value) { error = value; }, setRefreshError(value) { refreshError = value; },
    fetch(url, options) { return new Promise(resolve => requests.push({ url, options, resolve })); },
  };
  const cleanup = new Function(...Object.keys(bindings), `${effectCode}; return run();`)(...Object.values(bindings));
  return { ...env, ...refs, requests, original, cleanup,
    result: () => ({ payload, error, refreshError }),
    respond(index, value, status = 200) { requests[index].resolve({ status, ok: status >= 200 && status < 300, async json() { return value; } }); },
  };
}
const moved = { employees: [{ id: 7 }], entries: [{ employeeId: 7, workDate: "2026-11-02", hours: 8 }], marks: [] };

test("an existing monthly timesheet receives current source/target hours on page return without a loading reset", async () => {
  const state = harness(); state.focus(); await state.tick();
  assert.equal(state.requests.length, 1); assert.equal(state.requests[0].url, "/api/timesheet?siteId=2&month=2026-11");
  assert.equal(state.requests[0].options.cache, "no-store");
  state.respond(0, moved); await state.tick();
  assert.deepEqual(state.result().payload, moved);
  assert.equal(state.result().payload.entries.some(row => row.workDate === "2026-11-01"), false);
  assert.equal(state.result().payload.entries.find(row => row.workDate === "2026-11-02").hours, 8);
  assert.equal(state.result().error, ""); state.cleanup();
});

test("a date refresh arriving during an editor stays deferred and does not replace pending values", async () => {
  const state = harness(); state.focus(); await state.tick(); state.refreshBusy.current = true;
  state.respond(0, moved); await state.tick();
  assert.deepEqual(state.result().payload, state.original); assert.equal(state.requests.length, 1);
  state.refreshBusy.current = false; state.refreshControl.current.flush(); await state.tick();
  assert.equal(state.requests.length, 2); state.respond(1, moved); await state.tick();
  assert.deepEqual(state.result().payload, moved); state.cleanup();
});

test("a local mark acknowledged while a date refresh is in flight cannot be overwritten by its earlier snapshot", async () => {
  const state = harness(); state.focus(); await state.tick(); state.markRevision.current++;
  state.respond(0, moved); await state.tick(); assert.deepEqual(state.result().payload, state.original);
  await state.tick(); assert.equal(state.requests.length, 2);
  const latest = { ...moved, marks: [{ employeeId: 7, workDate: "2026-11-03", hours: 4, code: null }] };
  state.respond(1, latest); await state.tick(); assert.deepEqual(state.result().payload, latest); state.cleanup();
});

test("leaving the month or project aborts the old GET and prevents its late response", async () => {
  const state = harness(); state.focus(); await state.tick(); state.cleanup();
  assert.equal(state.requests[0].options.signal.aborted, true);
  state.respond(0, moved); await state.tick(); assert.deepEqual(state.result().payload, state.original);
});

test("a failed background read keeps visible data, allows retry, and revoked access hides the previous project", async () => {
  const state = harness(); state.focus(); await state.tick();
  state.respond(0, { error: "Временная ошибка" }, 500); await state.tick();
  assert.deepEqual(state.result().payload, state.original); assert.equal(state.result().refreshError, "Временная ошибка");
  state.refreshControl.current.request(); await state.tick(); state.respond(1, moved); await state.tick();
  assert.deepEqual(state.result().payload, moved); assert.equal(state.result().refreshError, "");
  state.focus(); await state.tick(); state.respond(2, { error: "Доступ закрыт" }, 403); await state.tick();
  assert.equal(state.result().payload, null); assert.equal(state.result().error, "Доступ закрыт"); state.cleanup();
});

test("bulk marks hold the refresh guard until all requests settle, including partial failures", async () => {
  const pending = []; let requested = 0, bulkSaving = false, settled = false;
  const markWrites = { current: 0 }, markRevision = { current: 0 };
  const bindings = { payload: { canEdit: true, canCreate: true, canDelete: true, canUpdate: true, siteId: 2, month: "2026-11" }, activeScope: { current: "2:2026-11" }, activeScopeVersion: { current: 0 },
    visibleEmployees: [{ id: 7 }], days: [1, 2], month: "2026-11", dateForDay: (month, day) => `${month}-${String(day).padStart(2, "0")}`,
    CODE_VALUES: new Set(), marksByCell: new Map(), cellKey: (id, date) => `${id}:${date}`, markWrites, markRevision,
    setSavingBulkMarks(value) { bulkSaving = value; }, refreshControl: { current: { request() { requested++; }, flush() {} } },
    setPayload() { assert.fail("A partial batch must re-read actual saved marks before replacing its snapshot"); },
    fetch() { return new Promise(resolve => pending.push(resolve)); }, window: { location: { replace() {} } },
  };
  const paste = new Function(...Object.keys(bindings), `${pasteCode}; return pasteTimesheetCells;`)(...Object.values(bindings));
  const result = paste([{ rowIndex: 0, columnIndex: 0, value: "8" }, { rowIndex: 0, columnIndex: 1, value: "6" }]);
  result.finally(() => { settled = true; }).catch(() => {});
  assert.equal(markWrites.current, 1); assert.equal(bulkSaving, true); assert.equal(markRevision.current, 1);
  pending[0]({ status: 409, ok: false, json: async () => ({ error: "Конфликт" }) });
  for (let step = 0; step < 8; step++) await Promise.resolve();
  assert.equal(settled, false); assert.equal(markWrites.current, 1);
  pending[1]({ status: 200, ok: true, json: async () => ({ mark: { employeeId: 7, workDate: "2026-11-02", hours: 6 } }) });
  await assert.rejects(result, /Конфликт/);
  assert.equal(requested, 1); assert.equal(markWrites.current, 0); assert.equal(bulkSaving, false);
});

function writeHarness() {
  const sourcePayload = { canEdit: true, canCreate: true, canDelete: true, canUpdate: true, siteId: 2, month: "2026-11", marks: [] };
  let current = structuredClone(sourcePayload);
  const requests = [], undo = [];
  const activeScope = { current: "2:2026-11" }, activeScopeVersion = { current: 0 };
  const bindings = { payload: sourcePayload, activeScope, activeScopeVersion, markWrites: { current: 0 }, markRevision: { current: 0 },
    visibleEmployees: [{ id: 7 }], days: [1, 2], month: "2026-11", dateForDay: (month, day) => `${month}-${String(day).padStart(2, "0")}`,
    CODE_VALUES: new Set(), marksByCell: new Map(), cellKey: (id, date) => `${id}:${date}`,
    markValue: mark => String(mark?.hours ?? mark?.code ?? ""), setSavingMark() {}, setSavingBulkMarks() {},
    refreshControl: { current: { request() {}, flush() {} } },
    setPayload(update) { current = update(current); }, rememberTimesheetUndo(value) { undo.push(value); },
    fetch(url, options) { return new Promise(resolve => requests.push({ body: JSON.parse(options.body), resolve })); }, window: { location: { replace() {} } },
  };
  const single = new Function(...Object.keys(bindings), `${singleCode}; return persistMark;`)(...Object.values(bindings));
  const bulk = new Function(...Object.keys(bindings), `${pasteCode}; return pasteTimesheetCells;`)(...Object.values(bindings));
  return { single, bulk, requests, undo, result: () => current,
    scope(siteId, month) {
      activeScope.current = `${siteId}:${month}`; activeScopeVersion.current++;
      current = { ...structuredClone(sourcePayload), siteId, month, marks: [{ employeeId: 7, workDate: `${month}-01`, hours: 3 }] };
      return structuredClone(current);
    },
    respond(index) { requests[index].resolve({ status: 200, ok: true, json: async () => ({ mark: { employeeId: 7, workDate: "2026-11-01", hours: 8 } }) }); },
  };
}

for (const [siteId, month] of [[3, "2026-11"], [2, "2026-12"]]) {
  test(`late individual mark from the previous scope cannot alter ${siteId}/${month} or its undo`, async () => {
    const state = writeHarness();
    const write = state.single({ employeeId: 7, workDate: "2026-11-01" }, "8");
    assert.equal(state.requests[0].body.siteId, 2); assert.equal(state.requests[0].body.workDate, "2026-11-01");
    const destination = state.scope(siteId, month); state.respond(0);
    assert.equal(await write, false); assert.deepEqual(state.result(), destination); assert.deepEqual(state.undo, []);
  });
  test(`late bulk marks from the previous scope cannot alter ${siteId}/${month} or create undo indices`, async () => {
    const state = writeHarness();
    const write = state.bulk([{ rowIndex: 0, columnIndex: 0, value: "8" }]);
    const destination = state.scope(siteId, month); state.respond(0);
    assert.equal(await write, 0, "zero suppresses clipboard undo for a no-longer-visible scope");
    assert.deepEqual(state.result(), destination); assert.deepEqual(state.undo, []);
  });
}

test("leaving a scope and returning before its old response still invalidates old merge and undo", async () => {
  const state = writeHarness(); const write = state.single({ employeeId: 7, workDate: "2026-11-01" }, "8");
  state.scope(3, "2026-12"); const latest = state.scope(2, "2026-11"); state.respond(0);
  assert.equal(await write, false); assert.deepEqual(state.result(), latest); assert.deepEqual(state.undo, []);
});

test("an individual write in the current scope still updates the mark and records undo", async () => {
  const state = writeHarness(); const write = state.single({ employeeId: 7, workDate: "2026-11-01" }, "8"); state.respond(0);
  assert.equal(await write, true); assert.equal(state.result().marks[0].hours, 8);
  assert.deepEqual(state.undo, [[{ rowIndex: 0, columnIndex: 0, value: "", note: "" }]]);
});
