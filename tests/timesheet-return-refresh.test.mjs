import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { isPersonnelTimesheetValue } from "../app/personnelTimesheetValues.ts";
import { createIdlePageRefresh } from "../app/idlePageRefresh.ts";
import { createTimesheetBatchSave } from "../app/timesheetBatchSave.ts";

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
let refreshEffect, pasteDeclaration, singleDeclaration, savedDeclaration, batchOptions;
const removalDeclarations = [];
function visit(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect"
    && node.arguments[0]?.getText(source).includes("const control = createIdlePageRefresh")) refreshEffect = node.arguments[0];
  if (ts.isFunctionDeclaration(node) && node.name?.text === "pasteTimesheetCells") pasteDeclaration = node;
  if (ts.isFunctionDeclaration(node) && node.name?.text === "persistMark") singleDeclaration = node;
  if (ts.isFunctionDeclaration(node) && node.name?.text === "applySavedTimesheetCells") savedDeclaration = node;
  if (ts.isFunctionDeclaration(node) && ["planRosterMarkRemovals", "confirmRosterMarkRemoval", "retryTimesheetMarks"].includes(node.name?.text)) removalDeclarations.push(node.getText(source));
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useTimesheetBatchSave") batchOptions = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(refreshEffect, "Expected actual page-return fetch effect");
assert.ok(pasteDeclaration, "Expected actual bulk write callback");
assert.ok(singleDeclaration, "Expected actual individual mark callback");
assert.ok(savedDeclaration && batchOptions, "Expected actual shared batch lifecycle and successful-cell merge");
const effectCode = ts.transpileModule(`const run = ${refreshEffect.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const pasteCode = ts.transpileModule(pasteDeclaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const singleCode = ts.transpileModule(singleDeclaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const savedCode = ts.transpileModule(savedDeclaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const batchCode = ts.transpileModule(`const batchSave = createTimesheetBatchSave(${batchOptions.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const removalCode = ts.transpileModule(removalDeclarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const env = page();
  const requests = [];
  const original = { employees: [{ id: 7 }], entries: [{ employeeId: 7, workDate: "2026-11-01", hours: 8 }], marks: [] };
  let payload = structuredClone(original), error = "", refreshError = "", rosterRemovalCount = 0;
  const refs = { refreshBusy: { current: false }, markWrites: { current: 0 }, markRevision: { current: 0 }, refreshControl: { current: null }, rosterDeletionCandidates: { current: new Set() } };
  const bindings = { createIdlePageRefresh, window: env.pageWindow, document: env.pageDocument, AbortController,
    ...refs, siteId: 2, month: "2026-11", setPayload(value) { payload = value; }, setError(value) { error = value; }, setRefreshError(value) { refreshError = value; },
    setRefreshLoading() {}, setRosterRefreshPending() {},
    setRosterRemovalCount(value) { rosterRemovalCount = value; },
    fetch(url, options) { return new Promise(resolve => requests.push({ url, options, resolve })); },
  };
  const cleanup = new Function(...Object.keys(bindings), `${effectCode}; return run();`)(...Object.values(bindings));
  return { ...env, ...refs, requests, original, cleanup,
    result: () => ({ payload, error, refreshError }), rosterRemovalCount: () => rosterRemovalCount,
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

test("a settled last-mark deletion announces the row removal from the refreshed roster", async () => {
  const state = harness();
  state.rosterDeletionCandidates.current.add(7);
  state.refreshControl.current.request(); await state.tick();
  state.respond(0, { employees: [], entries: [], marks: [] }); await state.tick();
  assert.deepEqual(state.result().payload.employees, []);
  assert.equal(state.rosterRemovalCount(), 1);
  assert.equal(state.rosterDeletionCandidates.current.size, 0);
  state.cleanup();
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
  const state = writeHarness(); let settled = false;
  const changes = [{ rowIndex: 0, columnIndex: 0, value: "8" }, { rowIndex: 0, columnIndex: 1, value: "6" }];
  const result = state.bulk(changes);
  result.finally(() => { settled = true; }).catch(() => {});
  assert.equal(state.markWrites.current, 1); assert.equal(state.batch.getSnapshot().busy, true); assert.equal(state.markRevision.current, 1);
  state.requests[0].resolve({ status: 409, ok: false, json: async () => ({ error: "Конфликт" }) });
  for (let step = 0; step < 8; step++) await Promise.resolve();
  assert.equal(settled, false); assert.equal(state.markWrites.current, 1);
  state.respond(1);
  assert.deepEqual(await result, { savedChanges: [changes[1]], failedChanges: [changes[0]], revisions: [{ rowIndex: 0, columnIndex: 1, expectedRevision: null, previousRevision: null }] });
  assert.equal(state.markWrites.current, 0); assert.equal(state.batch.getSnapshot().busy, false);
  assert.deepEqual(state.result().marks, [{ employeeId: 7, workDate: "2026-11-02", hours: 6 }], "Acknowledged successes are merged even when a sibling fails");
  assert.equal(state.batch.getCellState("7:2026-11-01").state, "error");
  assert.equal(state.batch.getCellState("7:2026-11-02").state, "saved");
  assert.equal(state.flushes(), 1, "Deferred page refresh is released after the entire batch settles");

  const retry = state.batch.retry();
  assert.equal(state.requests.length, 3, "Only the failed cell is retried");
  assert.equal(state.markWrites.current, 1); assert.equal(state.markRevision.current, 2);
  state.respond(2); await retry;
  assert.equal(state.result().marks.length, 2); assert.equal(state.markWrites.current, 0);
  assert.equal(state.batch.getSnapshot().status.failed, 0);
});

function writeHarness({ visibleDays = [1, 2], employees = [{ id: 7, fullName: "Учебный сотрудник" }], marks = [], entries = [] } = {}) {
  const sourcePayload = { canEdit: true, canCreate: true, canDelete: true, canUpdate: true, siteId: 2, month: "2026-11", employees, entries, marks };
  let current = structuredClone(sourcePayload);
  const requests = [], undo = [], confirmations = [], conflicts = []; let flushes = 0;
  const activeScope = { current: "2:2026-11" }, activeScopeVersion = { current: 0 };
  const clipboardViewScope = { current: `2:2026-11:7:days=${visibleDays.join("|")}` };
  const markWrites = { current: 0 }, markRevision = { current: 0 };
  const cellKey = (id, date) => `${id}:${date}`;
  const marksByCell = new Map(marks.map(mark => [cellKey(mark.employeeId, mark.workDate), mark]));
  const bindings = { payload: sourcePayload, activeScope, activeScopeVersion, clipboardViewScope, markWrites, markRevision,
    // Display coordinates use filtered days, not the full month's date list.
    visibleEmployees: employees,
    days: Array.from({ length: 30 }, (_, index) => index + 1), visibleDays: [...visibleDays], month: "2026-11", siteId: 2,
    savingBulkMarks: false, navigationBusy: false, loading: false, createTimesheetBatchSave,
    dateForDay: (month, day) => `${month}-${String(day).padStart(2, "0")}`, dateLabel: date => date,
    isPersonnelTimesheetValue, marksByCell, cellKey,
    markValue: mark => String(mark?.hours ?? mark?.code ?? ""), setSavingMark() {}, setSavingBulkMarks() {},
    setRosterRefreshPending() {}, setMarkConflict(message) { conflicts.push(message); },
    refreshControl: { current: { request() {}, flush() { flushes++; } } },
    pendingMarkRemoval: { current: false }, retryMarkChanges: { current: new Map() }, rosterDeletionCandidates: { current: new Set() },
    confirm(options) { return new Promise(resolve => confirmations.push({ options, resolve })); },
    setPayload(update) { current = update(current); }, rememberTimesheetUndo(value) { undo.push(value); },
    forgetTimesheetUndo() {},
    fetch(url, options) { return new Promise(resolve => requests.push({ body: JSON.parse(options.body), resolve })); }, window: { location: { replace() {} } },
  };
  const { single, bulk, batch, retry, setPayloadSnapshot } = new Function(...Object.keys(bindings), `${singleCode}\n${savedCode}\n${pasteCode}\n${batchCode}\n${removalCode}; return { single: persistMark, bulk: pasteTimesheetCells, batch: batchSave, retry: retryTimesheetMarks, setPayloadSnapshot: snapshot => { payload = snapshot; } };`)(...Object.values(bindings));
  return { single, bulk, batch, retry, markWrites, markRevision, requests, confirmations, conflicts, undo, flushes: () => flushes, result: () => current,
    refreshSnapshot() {
      setPayloadSnapshot(current);
      marksByCell.clear();
      for (const mark of current.marks) marksByCell.set(cellKey(mark.employeeId, mark.workDate), mark);
    },
    scope(siteId, month) {
      // The actual hook deactivates its old controller when scopeKey changes.
      batch.deactivate();
      activeScope.current = `${siteId}:${month}`; activeScopeVersion.current++;
      clipboardViewScope.current = `${siteId}:${month}:7:days=${visibleDays.join("|")}`;
      current = { ...structuredClone(sourcePayload), siteId, month, marks: [{ employeeId: 7, workDate: `${month}-01`, hours: 3 }] };
      return structuredClone(current);
    },
    changeView() { clipboardViewScope.current += ":changed"; },
    respond(index, revision) {
      const { employeeId, workDate, value } = requests[index].body;
      const result = value ? { mark: { employeeId, workDate, hours: Number(value), ...(revision ? { revision } : {}) } } : { deleted: true, employeeId, workDate };
      requests[index].resolve({ status: 200, ok: true, json: async () => result });
    },
  };
}

test("batch retries preserve the original expected revision and ordinary paste preserves the existing note", async () => {
  const state = writeHarness({ marks: [{ employeeId: 7, workDate: "2026-11-01", hours: 4, note: "Сохранённый комментарий", revision: "v1" }] });
  const change = { rowIndex: 0, columnIndex: 0, value: "8" };
  const saving = state.bulk([change]);
  assert.equal(state.requests[0].body.expectedRevision, "v1");
  assert.equal(state.requests[0].body.note, "Сохранённый комментарий");
  const conflict = { status: 409, ok: false, json: async () => ({ error: "Отметка уже изменена" }) };
  state.requests[0].resolve(conflict);
  assert.deepEqual((await saving).failedChanges, [change]);
  assert.deepEqual(state.conflicts, ["Отметка уже изменена"]);
  state.result().marks[0] = { ...state.result().marks[0], hours: 6, revision: "v2" };
  state.refreshSnapshot();
  const retrying = state.retry();
  assert.equal(state.requests[1].body.expectedRevision, "v1", "A retry cannot silently overwrite revision v2");
  state.requests[1].resolve(conflict);
  await retrying;
  assert.equal(state.result().marks[0].hours, 6);
});

test("a single-cell undo rejects a foreign mark that was loaded by a later refresh", async () => {
  const state = writeHarness({ marks: [{ employeeId: 7, workDate: "2026-11-01", hours: 4, note: "Исходная отметка", revision: "v1" }] });
  const saving = state.single({ employeeId: 7, workDate: "2026-11-01" }, "8");
  state.respond(0, "v2");
  assert.equal(await saving, true);
  const undo = state.undo[0];
  assert.equal(undo[0].expectedRevision, "v2");
  state.result().marks[0] = { ...state.result().marks[0], hours: 6, revision: "v3" };
  state.refreshSnapshot();
  const undoing = state.bulk(undo, { operation: "undo", historyId: "test" });
  assert.equal(state.requests[1].body.expectedRevision, "v2");
  state.requests[1].resolve({ status: 409, ok: false, json: async () => ({ error: "Отметка уже изменена" }) });
  assert.deepEqual((await undoing).failedChanges, undo);
  assert.equal(state.result().marks[0].hours, 6);
});

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
    assert.deepEqual(await write, { savedChanges: [], failedChanges: [] }, "No successful coordinates from a no-longer-visible scope enter clipboard undo");
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
  assert.deepEqual(state.undo, [[{ rowIndex: 0, columnIndex: 0, value: "", note: "", expectedRevision: null, previousRevision: null }]]);
});

test("individual mark undo uses the filtered display column rather than the day of the month", async () => {
  const state = writeHarness({ visibleDays: [2, 10] });
  const write = state.single({ employeeId: 7, workDate: "2026-11-10" }, "8");
  state.respond(0);
  assert.equal(await write, true);
  assert.equal(state.result().marks[0].workDate, "2026-11-10");
  assert.deepEqual(state.undo, [[{ rowIndex: 0, columnIndex: 1, value: "", note: "", expectedRevision: null, previousRevision: null }]]);
});

test("bulk paste and retries retain filtered day identities and visible undo coordinates", async () => {
  const state = writeHarness({ visibleDays: [2, 10] });
  const change = { rowIndex: 0, columnIndex: 1, value: "6" };
  const write = state.bulk([change]);
  assert.equal(state.requests[0].body.workDate, "2026-11-10");
  state.requests[0].resolve({ status: 409, ok: false, json: async () => ({ error: "Конфликт" }) });
  assert.deepEqual(await write, { savedChanges: [], failedChanges: [change] });
  const retry = state.batch.retry();
  assert.equal(state.requests[1].body.workDate, "2026-11-10");
  state.respond(1); await retry;
  assert.equal(state.result().marks[0].workDate, "2026-11-10");
  assert.deepEqual(state.undo, [[{ rowIndex: 0, columnIndex: 1, value: "", note: "", expectedRevision: null, previousRevision: null }]]);
});

test("changing the displayed columns during an individual save preserves data but skips stale undo coordinates", async () => {
  const state = writeHarness();
  const write = state.single({ employeeId: 7, workDate: "2026-11-01" }, "8");
  state.changeView(); state.respond(0);
  assert.equal(await write, true);
  assert.equal(state.result().marks[0].hours, 8);
  assert.deepEqual(state.undo, []);
});

test("retry after a display change still saves the original cell without creating undo in a different view", async () => {
  const state = writeHarness();
  const change = { rowIndex: 0, columnIndex: 1, value: "6" };
  const write = state.bulk([change]);
  state.requests[0].resolve({ status: 409, ok: false, json: async () => ({ error: "Конфликт" }) });
  assert.deepEqual(await write, { savedChanges: [], failedChanges: [change] });
  state.changeView();
  const retry = state.batch.retry();
  assert.equal(state.requests[1].body.workDate, "2026-11-02");
  state.respond(1); await retry;
  assert.equal(state.result().marks[0].hours, 6);
  assert.deepEqual(state.undo, []);
});

const historyEmployee = { id: 7, fullName: "Исторический сотрудник", roster: { reason: "history" } };
const historyMark = day => ({ employeeId: 7, workDate: `2026-11-${String(day).padStart(2, "0")}`, hours: 8 });
const clearCell = columnIndex => ({ rowIndex: 0, columnIndex, value: "" });
const firstHistoryCell = { employeeId: 7, workDate: "2026-11-01" };
const settleConfirmation = async (state, confirmed) => {
  state.confirmations.at(-1).resolve(confirmed);
  for (let step = 0; step < 4; step++) await Promise.resolve();
};

test("individual removal of the final history mark warns before writing and cannot enter undo", async () => {
  const state = writeHarness({ employees: [historyEmployee], marks: [historyMark(1)] });
  const cancelled = state.single(firstHistoryCell, "");
  assert.match(state.confirmations[0].options.description, /Строка сотрудника исчезнет.*Ctrl\+Z/);
  assert.equal(state.requests.length, 0);
  await settleConfirmation(state, false);
  assert.equal(await cancelled, false);
  assert.equal(state.requests.length, 0);
  const confirmed = state.single(firstHistoryCell, "");
  await settleConfirmation(state, true);
  state.respond(0);
  assert.equal(await confirmed, true);
  assert.deepEqual(state.result().marks, []);
  assert.deepEqual(state.undo, []);
});

test("a report or a mark hidden by filters keeps the history row and ordinary undo", async () => {
  const cases = [
    { employees: [historyEmployee], marks: [historyMark(1), historyMark(28)] },
    { employees: [{ ...historyEmployee, reportDates: ["2026-11-25"] }], marks: [historyMark(1)] },
    { employees: [historyEmployee], entries: [historyMark(25)], marks: [historyMark(1)] },
  ];
  for (const options of cases) {
    const state = writeHarness(options);
    const write = state.single(firstHistoryCell, "");
    assert.equal(state.confirmations.length, 0);
    state.respond(0);
    assert.equal(await write, true);
    assert.equal(state.undo.length, 1);
  }
});

test("bulk clearing projects all deletions and preserves undo eligibility for other rows", async () => {
  const state = writeHarness({ employees: [historyEmployee, { id: 8, roster: { reason: "assignment" } }],
    marks: [historyMark(1), historyMark(2), { ...historyMark(1), employeeId: 8 }] });
  const ordinary = { rowIndex: 1, columnIndex: 0, value: "" };
  const changes = [clearCell(0), clearCell(1), ordinary];
  const write = state.bulk(changes);
  assert.equal(state.confirmations.length, 1);
  assert.equal(state.requests.length, 0);
  await settleConfirmation(state, true);
  assert.equal(state.requests.length, 3);
  state.respond(0); state.respond(1); state.respond(2);
  const outcome = await write;
  assert.deepEqual(outcome.savedChanges, changes);
  assert.deepEqual(outcome.failedChanges, []);
  assert.deepEqual(outcome.undoableChanges, [ordinary]);
});

test("bulk replacement of the last history mark requests two operations before any writes", async () => {
  const state = writeHarness({ employees: [historyEmployee], marks: [historyMark(1)] });
  await assert.rejects(state.bulk([clearCell(0), { rowIndex: 0, columnIndex: 1, value: "8" }]), /Сначала добавьте новую отметку/);
  assert.equal(state.confirmations.length, 0);
  assert.equal(state.requests.length, 0);
});

test("changing the displayed month or columns while confirming prevents stale writes", async () => {
  const state = writeHarness({ employees: [historyEmployee], marks: [historyMark(1)] });
  const write = state.bulk([clearCell(0)]);
  state.changeView();
  await settleConfirmation(state, true);
  assert.equal((await write).cancelled, true);
  assert.equal(state.requests.length, 0);

  const individual = state.single(firstHistoryCell, "");
  state.scope(2, "2026-12");
  await settleConfirmation(state, true);
  assert.equal(await individual, false);
  assert.equal(state.requests.length, 0);
});

test("a retry confirms a failed deletion that has since become the final history mark", async () => {
  const state = writeHarness({ employees: [historyEmployee], marks: [historyMark(1), historyMark(2)] });
  const first = state.bulk([clearCell(0)]);
  state.requests[0].resolve({ status: 409, ok: false, json: async () => ({ error: "Конфликт" }) });
  await first;
  const second = state.single({ employeeId: 7, workDate: "2026-11-02" }, "");
  state.respond(1);
  assert.equal(await second, true);
  state.refreshSnapshot();
  const retry = state.retry();
  assert.equal(state.confirmations.length, 1);
  assert.equal(state.requests.length, 2);
  await settleConfirmation(state, true);
  state.respond(2);
  await retry;
  assert.deepEqual(state.result().marks, []);
  assert.equal(state.undo.length, 1, "Only the earlier reversible deletion has undo history");
});
