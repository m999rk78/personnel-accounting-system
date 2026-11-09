import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createLatestRequest } from "../app/latestRequest.ts";
import { emptyDataSet } from "../app/workspace/model.ts";

const source = ts.createSourceFile("useWorkspaceData.ts", await readFile(new URL("../app/workspace/useWorkspaceData.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useWorkspaceData");
assert.ok(hook);
const implementation = ts.transpileModule(hook.getText(source).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));

const app = ts.createSourceFile("PersonnelApp.tsx", await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let busyExpression, workTypesLoading;
function readApp(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(app) === "settingsBusy") busyExpression = node.initializer;
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === "WorkTypesDirectory") workTypesLoading = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(app) === "loading")?.initializer?.expression;
  ts.forEachChild(node, readApp);
}
readApp(app); assert.ok(busyExpression); assert.ok(workTypesLoading);
const loadingWorkTypes = new Function("loading", "saving", "importing", "settingsReady", `const settingsBusy = ${busyExpression.getText(app)}; return ${workTypesLoading.getText(app)};`);
const workTypesLocked = result => loadingWorkTypes(result.loading, false, false, result.settingsReady);

/** Run the real hook across renders, retaining state/refs and deferred GETs. */
function harness() {
  const hooks = [], pendingEffects = [], timers = new Map(), requests = [];
  let cursor = 0, nextTimer = 0;
  const same = (left, right) => left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const useState = initial => {
    const index = cursor++;
    hooks[index] ??= { value: typeof initial === "function" ? initial() : initial };
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
      const previous = hooks[index];
      hooks[index] = { dependencies, cleanup: previous?.cleanup };
      pendingEffects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = effect(); });
    }
  };
  const window = { setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); }, location: { replace() {} } };
  const fetch = (url, options) => new Promise(resolve => { requests.push({ url, ...options, respond(status, body) { resolve({ status, ok: status >= 200 && status < 300, json: async () => body }); } }); });
  const environment = { useState, useRef, useMemo: memo, useCallback: (callback, dependencies) => memo(() => callback, dependencies), useEffect, createLatestRequest, emptyDataSet, window, fetch };
  const run = new Function(...Object.keys(environment), `${implementation}; return useWorkspaceData;`)(...Object.values(environment));
  const permissions = {}, viewAllowed = () => true;
  let props = { siteId: 1, workDate: "2026-11-09", view: "directories", effectivePermissions: permissions, viewAllowed };
  const render = (changes = {}) => { props = { ...props, ...changes }; cursor = 0; return run(props); };
  const commit = () => { for (const effect of pendingEffects.splice(0)) effect(); };
  const runTimers = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); };
  return { render, commit, runTimers, requests, async load(status = 200, body = { ...emptyDataSet(), zones: [{ id: 10, name: "Первый проект" }] }) {
    render(); commit(); runTimers(); requests.at(-1).respond(status, body); await settle(); return render();
  }, dispose() { hooks.forEach(hook => hook?.cleanup?.()); } };
}

test("settings remain locked on the first new-project render and after a failed load without discarding the prior snapshot", async t => {
  const ui = harness(); t.after(() => ui.dispose());
  const loaded = await ui.load();
  assert.equal(loaded.settingsReady, true); assert.equal(loaded.loading, false);
  assert.equal(workTypesLocked(loaded), false);
  const first = ui.render({ siteId: 2 });
  assert.equal(first.loading, false, "the GET effect has not raised loading yet");
  assert.equal(first.settingsReady, false, "old project rows cannot be edited in that first paint");
  assert.equal(workTypesLocked(first), true, "work-type editors use the same first-paint scope guard as the other directories");
  assert.equal(first.data, loaded.data, "readable data is preserved instead of deleting local state");
  ui.commit(); ui.runTimers();
  assert.match(ui.requests.at(-1).url, /siteId=2/);
  ui.requests.at(-1).respond(503, { error: "Временно недоступно" }); await settle();
  const failed = ui.render();
  assert.equal(failed.loading, false); assert.equal(failed.settingsReady, false);
  assert.equal(workTypesLocked(failed), true, "a failed project GET cannot unlock stale work types");
  assert.equal(failed.data, loaded.data); assert.equal(failed.error, "Временно недоступно");
});

test("late project responses cannot unlock another project's settings", async t => {
  const ui = harness(); t.after(() => ui.dispose()); await ui.load();
  ui.render({ siteId: 2 }); ui.commit(); ui.runTimers(); const old = ui.requests.at(-1);
  assert.equal(ui.render({ siteId: 3 }).settingsReady, false); ui.commit(); ui.runTimers(); const latest = ui.requests.at(-1);
  assert.equal(old.signal.aborted, true);
  old.respond(200, { ...emptyDataSet(), zones: [{ id: 20, name: "Опоздавший ответ" }] }); await settle();
  assert.equal(ui.render().settingsReady, false);
  latest.respond(200, { ...emptyDataSet(), zones: [{ id: 30, name: "Третий проект" }] }); await settle();
  const result = ui.render();
  assert.equal(result.settingsReady, true); assert.equal(result.data.zones[0].id, 30);
});

test("section and permission revisions need a successful matching settings read", async t => {
  const ui = harness(); t.after(() => ui.dispose()); await ui.load();
  assert.equal(ui.render({ view: "positions" }).settingsReady, false); ui.commit(); ui.runTimers();
  ui.requests.at(-1).respond(200, emptyDataSet()); await settle();
  assert.equal(ui.render().settingsReady, true);
  assert.equal(ui.render({ effectivePermissions: { employees: { view: true } } }).settingsReady, false); ui.commit(); ui.runTimers();
  ui.requests.at(-1).respond(403, { error: "Нет доступа" }); await settle();
  assert.equal(ui.render().settingsReady, false);
  const recovering = ui.render(); const reload = recovering.loadData();
  ui.requests.at(-1).respond(200, emptyDataSet()); await reload;
  assert.equal(ui.render().settingsReady, true);
  ui.render().invalidateCatalogs();
  assert.equal(ui.render().settingsReady, false);
  assert.equal(ui.render({ view: "placement" }).settingsReady, false, "report catalogue reads are not settings readiness");
});
