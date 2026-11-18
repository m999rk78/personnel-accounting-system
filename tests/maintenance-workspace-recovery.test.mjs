import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createLatestRequest } from "../app/latestRequest.ts";
import { createMaintenanceClient, MAINTENANCE_READY_EVENT, MAINTENANCE_STATUS_PATH } from "../app/maintenanceClient.ts";
import { emptyDataSet } from "../app/workspace/model.ts";

const source = ts.createSourceFile("useWorkspaceData.ts", await readFile(new URL("../app/workspace/useWorkspaceData.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useWorkspaceData");
assert.ok(hook);
const implementation = ts.transpileModule(hook.getText(source).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
const payload = name => ({ ...emptyDataSet([{ id: 1, name }]), zones: [{ id: 10, name }] });

/** Real workspace hook and optional maintenance client; all requests/timers stay in memory. */
function harness({ view = "directories", guarded = false } = {}) {
  const hooks = [], effects = [], timers = new Map(), requests = [], redirects = [], events = new EventTarget();
  let cursor = 0, nextTimer = 0;
  const same = (a, b) => a && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const stateHook = initial => {
    const index = cursor++;
    hooks[index] ??= { value: initial };
    return [hooks[index].value, next => { hooks[index].value = typeof next === "function" ? next(hooks[index].value) : next; }];
  };
  const useRef = initial => { const index = cursor++; hooks[index] ??= { current: initial }; return hooks[index]; };
  const memo = (calculate, dependencies) => {
    const index = cursor++;
    if (!same(hooks[index]?.dependencies, dependencies)) hooks[index] = { value: calculate(), dependencies };
    return hooks[index].value;
  };
  const useEffect = (effect, dependencies) => {
    const index = cursor++;
    if (!same(hooks[index]?.dependencies, dependencies)) {
      const previous = hooks[index]; hooks[index] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = effect(); });
    }
  };
  const window = {
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout(id) { timers.delete(id); },
    location: { replace(url) { redirects.push(url); } },
  };
  const emitReady = () => events.dispatchEvent(new Event(MAINTENANCE_READY_EVENT));
  const request = (url, options) => new Promise((resolve, reject) => requests.push({ url: String(url), ...options, resolve, reject,
    respond(status = 200, body = payload("Проект")) { resolve(Response.json(body, { status })); },
  }));
  const client = guarded ? createMaintenanceClient({ request, origin: "https://fixture.invalid", onChange() {}, onReady: emitReady }) : null;
  const environment = { useState: stateHook, useRef, useMemo: memo, useCallback: (callback, dependencies) => memo(() => callback, dependencies), useEffect,
    createLatestRequest, MAINTENANCE_READY_EVENT, emptyDataSet, window, fetch: client?.fetch ?? request };
  const run = new Function(...Object.keys(environment), `${implementation}; return useWorkspaceData;`)(...Object.values(environment));
  let props = { siteId: 1, workDate: "2026-11-17", view, effectivePermissions: {}, viewAllowed: () => true };
  const render = (changes = {}) => {
    props = { ...props, ...changes }; cursor = 0;
    // PersonnelApp owns editable drafts alongside this hook, outside server data.
    const [draft, setDraft] = stateHook("");
    return { ...run(props), draft, setDraft };
  };
  const commit = () => effects.splice(0).forEach(effect => effect());
  const runTimers = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); };
  return { requests, redirects, render, commit, runTimers, emitReady, client,
    start() { render(); commit(); runTimers(); },
    dataRequests: () => requests.filter(item => item.url.startsWith("/api/data?")),
    async recover() {
      if (!client) { emitReady(); return; }
      const checking = client.check();
      assert.ok(requests.at(-1).url.endsWith(MAINTENANCE_STATUS_PATH));
      requests.at(-1).respond(200, { maintenance: false, phase: "ready" });
      await checking;
    },
    dispose() { hooks.forEach(entry => entry?.cleanup?.()); client?.stop(); },
  };
}

for (const [view, scope] of [["directories", "settings"], ["placement", "report-catalog"], ["personnelTimesheet", "navigation"]]) {
  for (const failure of ["503", "network"]) test(`${scope}: initial ${failure} recovers projects through the maintenance client's ready event`, async t => {
    const ui = harness({ view, guarded: true }); t.after(() => ui.dispose()); ui.start();
    ui.render().setDraft("Незавершённый ввод");
    if (failure === "network") ui.requests[0].reject(new TypeError("Offline"));
    else ui.requests[0].respond(503, { error: "Временно недоступно" });
    await settle();
    assert.equal(ui.render().data, null); assert.equal(ui.render().loading, false);
    assert.notEqual(ui.client.snapshot().kind, null);
    await ui.recover();
    const reads = ui.dataRequests(); assert.equal(reads.length, 2);
    assert.match(reads[1].url, new RegExp(`scope=${scope}`));
    ui.emitReady(); ui.emitReady();
    assert.equal(ui.dataRequests().length, 2, "duplicate ready events do not restart the recovery GET");
    assert.equal(reads[1].signal.aborted, false);
    reads[1].respond(200, payload("Восстановленный проект")); await settle();
    const recovered = ui.render();
    assert.equal(recovered.data.sites[0].name, "Восстановленный проект");
    assert.equal(recovered.loading, false); assert.equal(recovered.error, "");
    assert.equal(recovered.draft, "Незавершённый ввод");
    assert.equal(ui.client.snapshot().kind, null); assert.deepEqual(ui.redirects, []);
    ui.emitReady(); assert.equal(ui.dataRequests().length, 2, "a successful read is not replayed");
  });
}

test("a failed refresh preserves loaded rows and unfinished input, then retries only its GET", async t => {
  const ui = harness({ guarded: true }); t.after(() => ui.dispose()); ui.start();
  ui.requests[0].respond(); await settle();
  const loaded = ui.render(); loaded.setDraft("Изменённая должность");
  ui.emitReady(); assert.equal(ui.dataRequests().length, 1, "loaded workspace is left intact");
  const refresh = loaded.loadData();
  ui.dataRequests()[1].respond(503, { error: "Работы" }); await refresh;
  assert.equal(ui.render().data, loaded.data);
  await ui.recover();
  assert.equal(ui.render().data, loaded.data, "rows stay visible while the retry is pending");
  assert.equal(ui.render().draft, "Изменённая должность");
  assert.equal(ui.dataRequests().length, 3);
  assert.ok(ui.dataRequests().every(read => !read.method || read.method === "GET"));
  ui.dataRequests()[2].respond(200, payload("Обновлённый проект")); await settle();
  assert.equal(ui.render().data.sites[0].name, "Обновлённый проект");
  assert.equal(ui.render().draft, "Изменённая должность");
});

for (const changes of [{ siteId: 2 }, { view: "positions" }]) test(`recovery ignores an aborted previous scope after ${JSON.stringify(changes)}`, async t => {
  const ui = harness(); t.after(() => ui.dispose()); ui.start();
  const previous = ui.requests[0];
  ui.emitReady(); // Queue recovery only if this pending read fails.
  ui.render(changes); ui.commit();
  assert.equal(previous.signal.aborted, true);
  ui.emitReady(); assert.equal(ui.requests.length, 1, "ready cannot revive the cancelled request before the new effect's timer");
  ui.runTimers(); const current = ui.requests[1];
  previous.respond(503, { error: "Опоздавший ответ" }); await settle();
  assert.equal(ui.requests.length, 2); assert.equal(ui.render().data, null);
  current.respond(503, { error: "Временно недоступно" }); await settle();
  ui.emitReady();
  assert.equal(ui.requests.length, 3); assert.equal(ui.requests[2].url, current.url);
  assert.match(current.url, changes.siteId ? /siteId=2/ : /section=positions/);
  ui.requests[2].respond(200, payload("Текущий контекст")); await settle();
  assert.equal(ui.render().data.sites[0].name, "Текущий контекст");
  assert.equal(ui.render().settingsReady, true);
});

test("ready during a pending read waits for success and does not duplicate it", async t => {
  const ui = harness(); t.after(() => ui.dispose()); ui.start();
  ui.emitReady(); ui.emitReady();
  assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].signal.aborted, false);
  ui.requests[0].respond(); await settle();
  assert.equal(ui.requests.length, 1); assert.ok(ui.render().data);
});

test("a read failing after ready retries once; repeated ready does not queue another in-flight recovery", async t => {
  const ui = harness(); t.after(() => ui.dispose()); ui.start();
  ui.emitReady(); ui.emitReady();
  ui.requests[0].respond(503, { error: "Временно недоступно" }); await settle();
  assert.equal(ui.requests.length, 2);
  ui.emitReady(); ui.emitReady();
  ui.requests[1].respond(503, { error: "Ещё недоступно" }); await settle();
  assert.equal(ui.requests.length, 2, "duplicate recovery notifications cannot cause a request loop");
  ui.emitReady(); assert.equal(ui.requests.length, 3, "a later recovery can retry a failed recovery GET");
  ui.requests[2].respond(); await settle(); assert.equal(ui.render().error, "");
});

test("unmount removes recovery listener and ignores a delayed failed read", async () => {
  const ui = harness(); ui.start(); ui.emitReady(); ui.dispose();
  ui.requests[0].respond(503, { error: "Временно недоступно" }); await settle();
  ui.emitReady(); assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].signal.aborted, true);
});
