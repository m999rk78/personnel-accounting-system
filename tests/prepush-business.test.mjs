import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { currentProjectDate, projectDayCheckDelay } from "../app/projectClock.ts";
import { personnelReportNewKey, personnelReportSaveIdentity } from "../app/personnelReportSessions.ts";
import { equipmentReportNewKey, equipmentReportSaveIdentity } from "../app/equipmentReportSessions.ts";
import { personnelReportYesterday } from "../app/personnelReportCarryOver.ts";
import { equipmentReportYesterday } from "../app/equipmentReportCarryOver.ts";

test("the project clock changes to November at Moscow midnight, before the UTC date changes", () => {
  assert.equal(currentProjectDate(new Date("2026-10-31T20:59:59.999Z")), "2026-10-31");
  assert.equal(currentProjectDate(new Date("2026-10-31T21:00:00.000Z")), "2026-11-01");
  assert.equal(projectDayCheckDelay(new Date("2026-10-31T20:59:59.999Z")), 26);
  assert.equal(projectDayCheckDelay(new Date("2026-10-31T20:59:30.000Z")), 30_025);
  assert.equal(projectDayCheckDelay(new Date("2026-10-31T21:00:00.000Z")), 60_000);
});

test("project calendar handles new year and leap day without the device timezone", () => {
  assert.equal(currentProjectDate(new Date("2026-12-31T21:00:00.000Z")), "2027-01-01");
  assert.equal(currentProjectDate(new Date("2028-02-28T21:00:00.000Z")), "2028-02-29");
  assert.equal(currentProjectDate(new Date("2028-02-29T21:00:00.000Z")), "2028-03-01");
});

for (const [domain, newKey, identity, yesterday] of [
  ["personnel", personnelReportNewKey, personnelReportSaveIdentity, personnelReportYesterday],
  ["equipment", equipmentReportNewKey, equipmentReportSaveIdentity, equipmentReportYesterday],
]) {
  test(`${domain}: midnight keeps unfinished October rows on October and creates new rows on November`, () => {
    const oldKey = newKey("2026-10-31");
    const today = currentProjectDate(new Date("2026-10-31T21:00:00.000Z"));
    assert.deepEqual(identity(oldKey, {}, 7, today), { siteId: 7, workDate: "2026-10-31" });
    assert.deepEqual(identity(newKey(today), {}, 7, today), { siteId: 7, workDate: "2026-11-01" });
    assert.equal(yesterday(today), "2026-10-31");
    const session = { id: 17, siteId: 7, workDate: "2026-10-30", revision: 5 };
    assert.deepEqual(identity("17", { 17: session }, 7, today), { siteId: 7, workDate: "2026-10-30", reportId: 17, revision: 5 });
  });
}

test("the live project-day hook updates across midnight and waking a tab, then cleans up timers/listeners", async context => {
  // Exercise the hook's real timer/effect code without a browser or a running database.
  const reactUrl = `data:text/javascript;base64,${Buffer.from(`
    export let state;
    export let cleanup;
    export function useState(initial) { state = initial; return [state, next => { state = next; }]; }
    export function useEffect(effect) { cleanup = effect(); }
  `).toString("base64")}`;
  let source = ts.transpileModule(await readFile(new URL("../app/useProjectToday.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  source = source.replace('from "react"', `from ${JSON.stringify(reactUrl)}`)
    .replace('from "./projectClock"', `from ${JSON.stringify(new URL("../app/projectClock.ts", import.meta.url).href)}`);
  const hook = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const react = await import(reactUrl);
  const timers = new Map(), windowListeners = new Map(), documentListeners = new Map();
  let nextTimer = 0;
  const originalWindow = globalThis.window, originalDocument = globalThis.document;
  globalThis.window = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    removeEventListener(name, callback) { if (windowListeners.get(name) === callback) windowListeners.delete(name); },
  };
  globalThis.document = {
    visibilityState: "visible",
    addEventListener(name, callback) { documentListeners.set(name, callback); },
    removeEventListener(name, callback) { if (documentListeners.get(name) === callback) documentListeners.delete(name); },
  };
  try {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-31T20:59:59.999Z") });
    assert.equal(hook.useProjectToday("2026-10-31"), "2026-10-31");
    const runNext = () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); };
    runNext();
    assert.equal(react.state, "2026-10-31");
    assert.equal([...timers.values()][0].delay, 26);
    context.mock.timers.tick(26);
    runNext();
    assert.equal(react.state, "2026-11-01");
    assert.equal(timers.size, 1);
    context.mock.timers.tick(86_400_000);
    globalThis.document.visibilityState = "hidden";
    documentListeners.get("visibilitychange")();
    assert.equal(react.state, "2026-11-01");
    globalThis.document.visibilityState = "visible";
    windowListeners.get("focus")();
    assert.equal(react.state, "2026-11-02");
    assert.equal(timers.size, 1);
    react.cleanup();
    assert.equal(timers.size, 0);
    assert.equal(windowListeners.size, 0);
    assert.equal(documentListeners.size, 0);
  } finally {
    react.cleanup?.();
    context.mock.timers.reset();
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  }
});
