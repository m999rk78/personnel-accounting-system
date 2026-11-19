import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { MAINTENANCE_READY_EVENT } from "../app/maintenanceClient.ts";
import { emptyPermissionSet } from "../app/permissionModel.ts";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const source = await readFile(new URL("../app/AuthGate.tsx", import.meta.url), "utf8");
const coordinationSource = await readFile(new URL("../app/authClientCoordination.ts", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const currentUser = { id: 7, fullName: "Тестовый инженер", email: "auth-test@example.invalid", role: "engineer", assignedSiteId: null, permissions: emptyPermissionSet(), permissionsCustomized: false };

/** Executes the actual auth effect with isolated hooks and request/timer queues. */
async function harness(initialUser) {
  const hooksUrl = dataUrl(`// isolated auth hooks ${Math.random()}
    let values=[],cursor=0,pending=[];
    const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
    export function begin(){cursor=0;pending=[];}
    export function useState(initial){const key=cursor++;if(!(key in values))values[key]=initial;return[values[key],next=>{values[key]=typeof next==='function'?next(values[key]):next;}];}
    export function useSyncExternalStore(_subscribe,snapshot){return snapshot();}
    export function useEffect(effect,deps){const key=cursor++;const old=values[key];if(!old||!same(old.deps,deps)){const entry={effect:true,deps,cleanup:old?.cleanup};values[key]=entry;pending.push(()=>{entry.cleanup?.();entry.cleanup=effect();});}}
    export function commit(){for(const effect of pending)effect();pending=[];}
    export function read(){return values;}
    export function unmount(){for(const entry of values)if(entry?.effect)entry.cleanup?.();}
  `);
  const environmentUrl = dataUrl(`// isolated auth browser ${Math.random()}
    const events=new EventTarget(), doc=new EventTarget();let timer=0,now=10000;const timers=new Map(),intervals=new Map();export const requests=[],redirects=[];
    export const Date={now:()=>now};export const advance=ms=>{now+=ms;};
    export const setTimeout=callback=>{timers.set(++timer,callback);return timer;}; export const clearTimeout=id=>timers.delete(id);
    export const window={location:{replace:url=>redirects.push(url)},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),setInterval:callback=>{intervals.set(++timer,callback);return timer;},clearInterval:id=>intervals.delete(id)};
    export const document={visibilityState:'visible',addEventListener:doc.addEventListener.bind(doc),removeEventListener:doc.removeEventListener.bind(doc),dispatchEvent:doc.dispatchEvent.bind(doc)};
    export function fetch(input,init){return new Promise((resolve,reject)=>requests.push({input,init,resolve,reject}));}
    export function runTimers(){const list=[...timers.values()];timers.clear();for(const callback of list)callback();}
    export function timerCount(){return timers.size;}
    export function runIntervals(){for(const callback of intervals.values())callback();}
    export function intervalCount(){return intervals.size;}
  `);
  const stubUrl = dataUrl(`export default function PersonnelApp(){};export function useProjectToday(today){return today;}`);
  const jsxUrl = dataUrl(`export const Fragment='fragment';export const jsx=(type,props)=>({type,props});export const jsxs=jsx;`);
  const coordinationUrl = dataUrl(ts.transpileModule(`import {window} from ${JSON.stringify(environmentUrl)};\n${coordinationSource}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  const input = `import {window,document,fetch,setTimeout,clearTimeout,Date} from ${JSON.stringify(environmentUrl)};\n${source
    .replace('"react"', JSON.stringify(hooksUrl))
    .replace('"./PersonnelApp"', JSON.stringify(stubUrl))
    .replaceAll('"./permissionModel"', JSON.stringify(new URL("../app/permissionModel.ts", import.meta.url).href))
    .replace('"./roles"', JSON.stringify(new URL("../app/roles.ts", import.meta.url).href))
    .replace('"./useProjectToday"', JSON.stringify(stubUrl))
    .replace('"./authClientCoordination"', JSON.stringify(coordinationUrl))
    .replace('"./maintenanceClient"', JSON.stringify(new URL("../app/maintenanceClient.ts", import.meta.url).href))}`;
  const compiled = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace('"react/jsx-runtime"', JSON.stringify(jsxUrl));
  const { default: AuthGate } = await import(dataUrl(compiled));
  const hooks = await import(hooksUrl); const environment = await import(environmentUrl); const coordination = await import(coordinationUrl);
  return { ...environment, ...coordination, render() { hooks.begin(); const value = AuthGate({ initialToday: "2026-11-02", initialUser }); hooks.commit(); return value; }, state: hooks.read, unmount: hooks.unmount };
}

for (const temporary of ["maintenance", "network", "html"]) test(`initial auth ${temporary} keeps the workspace instead of redirecting and recovers on ready`, async () => {
  const ui = await harness(); ui.render();
  const first = ui.requests.shift();
  if (temporary === "network") first.reject(new TypeError("Offline"));
  else if (temporary === "html") first.resolve(new Response("<!doctype html>", { status: 503 }));
  else first.resolve(Response.json({ maintenance: true, code: "MAINTENANCE" }, { status: 503 }));
  await flush();
  assert.deepEqual(ui.redirects, []); assert.equal(ui.state()[1], true);
  assert.equal(ui.timerCount(), 1);
  ui.window.dispatchEvent(new Event(MAINTENANCE_READY_EVENT)); ui.render();
  assert.equal(ui.timerCount(), 0, "Recovery clears the old retry timer");
  assert.equal(ui.requests.length, 1);
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: currentUser })); await flush();
  assert.equal(ui.state()[0].id, 7); assert.equal(ui.state()[1], false); assert.deepEqual(ui.redirects, []);
  ui.unmount();
});

for (const explicit of ["401", "unauthenticated"]) test(`auth redirects only for explicit ${explicit}`, async () => {
  const ui = await harness(); ui.render();
  ui.requests.shift().resolve(explicit === "401" ? Response.json({ error: "Login required" }, { status: 401 }) : Response.json({ authenticated: false, user: null }));
  await flush(); assert.deepEqual(ui.redirects, ["/login"]); assert.equal(ui.timerCount(), 0); ui.unmount();
});

test("unmount ignores a delayed auth response and cancels retry without affecting writes", async () => {
  const ui = await harness(); ui.render(); const request = ui.requests.shift(); ui.unmount();
  request.resolve(Response.json({ authenticated: false, user: null })); await flush();
  assert.deepEqual(ui.redirects, []); assert.equal(ui.timerCount(), 0);
});

for (const [name, payload] of [
  ["empty object", {}], ["missing authentication flag", { user: currentUser }],
  ["maintenance JSON", { maintenance: true }], ["nonboolean authentication", { authenticated: 0, user: null }],
  ["missing user", { authenticated: true }], ["null user", { authenticated: true, user: null }],
  ["invalid identity", { authenticated: true, user: { ...currentUser, id: "7" } }],
  ["invalid permissions", { authenticated: true, user: { ...currentUser, permissions: {} } }],
  ["invalid project access", { authenticated: true, user: { ...currentUser, projectAccess: { mode: "selected", siteIds: ["1"] } } }],
]) test(`periodic auth treats ${name} as inconclusive and retains the current workspace`, async () => {
  const ui = await harness(currentUser); ui.render();
  ui.window.dispatchEvent(new Event("focus"));
  ui.requests.shift().resolve(Response.json(payload)); await flush(); ui.render();
  assert.deepEqual(ui.redirects, []); assert.equal(ui.state()[0], currentUser); assert.equal(ui.state()[1], false);
  ui.advance(5000); ui.runIntervals();
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: currentUser })); await flush();
  assert.deepEqual(ui.redirects, []); assert.equal(ui.state()[0], currentUser); ui.unmount();
});

for (const temporary of ["503", "network", "html"]) test(`periodic auth ${temporary} preserves the current user and can recover`, async () => {
  const ui = await harness(currentUser); ui.render(); ui.runIntervals();
  const request = ui.requests.shift();
  if (temporary === "network") request.reject(new TypeError("Offline"));
  else request.resolve(temporary === "html" ? new Response("<!doctype html>") : Response.json({ maintenance: true }, { status: 503 }));
  await flush();
  assert.deepEqual(ui.redirects, []); assert.equal(ui.state()[0], currentUser);
  ui.advance(5000); ui.runIntervals();
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: currentUser })); await flush();
  assert.equal(ui.state()[0], currentUser); assert.deepEqual(ui.redirects, []); ui.unmount();
});

for (const explicit of ["401", "unauthenticated"]) test(`periodic auth still redirects for explicit ${explicit}`, async () => {
  const ui = await harness(currentUser); ui.render(); ui.window.dispatchEvent(new Event("focus"));
  ui.requests.shift().resolve(explicit === "401" ? Response.json({ error: "Expired" }, { status: 401 }) : Response.json({ authenticated: false, user: null }));
  await flush(); assert.deepEqual(ui.redirects, ["/login"]); ui.unmount();
});

test("periodic auth ignores a stale 401 after effect cleanup", async () => {
  const ui = await harness(currentUser); ui.render(); ui.runIntervals();
  const request = ui.requests.shift(); ui.unmount();
  assert.equal(request.init.signal.aborted, true);
  request.resolve(Response.json({ error: "Expired old session" }, { status: 401 })); await flush();
  assert.deepEqual(ui.redirects, []); assert.equal(ui.state()[0], currentUser);
});

test("periodic auth ignores a delayed body after cleanup and never overwrites the current identity", async () => {
  const ui = await harness(currentUser); ui.render(); ui.runIntervals();
  let finishBody;
  ui.requests.shift().resolve({ status: 200, ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) });
  await flush(); ui.unmount();
  finishBody({ authenticated: true, user: { ...currentUser, id: 8 } }); await flush();
  assert.deepEqual(ui.redirects, []); assert.equal(ui.state()[0], currentUser);
});

test("valid repeated refreshes retain the workspace and apply real permission changes", async () => {
  const ui = await harness(currentUser); ui.render(); ui.runIntervals();
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: currentUser })); await flush(); ui.render();
  assert.equal(ui.state()[0], currentUser, "unchanged access does not replace the workspace state");
  const next = { ...currentUser, permissions: { ...currentUser.permissions, workers_timesheet: { view: true, create: false, update: false, delete: false } }, permissionsCustomized: true };
  ui.advance(60000); ui.runIntervals();
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: next })); await flush(); ui.render();
  assert.deepEqual(ui.state()[0], next); assert.deepEqual(ui.redirects, []);
  ui.advance(60000); ui.runIntervals();
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: currentUser })); await flush();
  assert.equal(ui.state()[0].permissions.workers_timesheet.view, false, "revocations still update controls");
  assert.deepEqual(ui.redirects, []); ui.unmount();
});

test("a server-rendered workspace checks its session immediately without a refresh loop", async () => {
  const ui = await harness(currentUser); ui.render();
  assert.equal(ui.requests.length, 1, "entry does not wait for the one-minute timer or a focus event");
  assert.equal(ui.requests[0].input, "/api/auth/status");
  ui.window.dispatchEvent(new Event("focus")); ui.runIntervals();
  assert.equal(ui.requests.length, 1, "focus and timer cannot duplicate an in-flight entry refresh");
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: currentUser })); await flush(); ui.render();
  assert.equal(ui.requests.length, 0);
  ui.advance(4999); ui.window.dispatchEvent(new Event("focus")); assert.equal(ui.requests.length, 0);
  ui.advance(1); ui.window.dispatchEvent(new Event("focus")); assert.equal(ui.requests.length, 1);
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: { ...currentUser, fullName: "Обновлённое имя" } })); await flush(); ui.render();
  assert.equal(ui.requests.length, 0, "updating user data does not mount another immediate refresh");
  assert.equal(ui.intervalCount(), 1);
  ui.unmount(); assert.equal(ui.intervalCount(), 0);
});

test("hidden workspaces do not refresh or renew sessions until the user returns", async () => {
  const ui = await harness(currentUser); ui.document.visibilityState = "hidden"; ui.render();
  ui.runIntervals(); ui.window.dispatchEvent(new Event("focus"));
  assert.equal(ui.requests.length, 0);
  ui.document.visibilityState = "visible"; ui.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(ui.requests.length, 1, "returning to the visible workspace checks immediately");
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: currentUser })); await flush(); ui.render();
  ui.document.visibilityState = "hidden"; ui.advance(60000); ui.runIntervals();
  assert.equal(ui.requests.length, 0); assert.deepEqual(ui.redirects, []); ui.unmount();
});

test("auth mutations abort a pending status request and resume with a fresh controller", async () => {
  const ui = await harness(currentUser); ui.render();
  const stale = ui.requests.shift();
  const finish = ui.beginAuthMutation();
  assert.equal(stale.init.signal.aborted, true, "status renewal is cancelled before the cookie-changing mutation");
  ui.advance(60000); ui.runIntervals(); ui.window.dispatchEvent(new Event("focus"));
  assert.equal(ui.requests.length, 0, "status checks stay paused throughout the mutation");
  finish();
  const fresh = ui.requests.shift(); assert.ok(fresh); assert.equal(fresh.init.signal.aborted, false);
  assert.notEqual(fresh.init.signal, stale.init.signal);
  stale.resolve(Response.json({ error: "Old session revoked" }, { status: 401 })); await flush();
  assert.deepEqual(ui.redirects, []);
  ui.advance(5000); ui.window.dispatchEvent(new Event("focus"));
  assert.equal(ui.requests.length, 0, "late completion cannot unlock another request while the fresh check is pending");
  fresh.resolve(Response.json({ authenticated: true, user: currentUser })); await flush(); ui.render();
  assert.equal(ui.state()[0], currentUser); assert.equal(ui.requests.length, 0); ui.unmount();
});

test("an aborted renewal response cannot replace the user or redirect after a password mutation", async () => {
  const ui = await harness(currentUser); ui.render();
  const stale = ui.requests.shift(); const finish = ui.beginAuthMutation(); finish();
  stale.resolve(Response.json({ authenticated: true, user: { ...currentUser, id: 8 } }, { headers: { "Set-Cookie": "personnel_session=synthetic-stale-token; HttpOnly; Path=/" } })); await flush();
  assert.equal(stale.init.signal.aborted, true); assert.equal(ui.state()[0], currentUser);
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: currentUser })); await flush();
  assert.deepEqual(ui.redirects, []); ui.unmount();
});

test("initial auth checks are also cancelled during mutations and resume without retrying the stale response", async () => {
  const ui = await harness(); ui.render();
  const stale = ui.requests.shift(); const finish = ui.beginAuthMutation();
  assert.equal(stale.init.signal.aborted, true);
  stale.resolve(Response.json({ authenticated: false, user: null })); await flush();
  assert.deepEqual(ui.redirects, []); assert.equal(ui.timerCount(), 0);
  finish(); assert.equal(ui.requests.length, 1);
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: currentUser })); await flush();
  assert.equal(ui.state()[0].id, currentUser.id); assert.equal(ui.state()[1], false);
  assert.deepEqual(ui.redirects, []); ui.unmount();
});

test("mutation start cancels initial retries and only the final nested completion resumes checking", async () => {
  const ui = await harness(); ui.render();
  ui.requests.shift().reject(new TypeError("Offline")); await flush();
  assert.equal(ui.timerCount(), 1);
  const firstFinish = ui.beginAuthMutation(), lastFinish = ui.beginAuthMutation();
  assert.equal(ui.timerCount(), 0); ui.runTimers(); assert.equal(ui.requests.length, 0);
  firstFinish(); firstFinish();
  assert.equal(ui.isAuthMutationInProgress(), true); assert.equal(ui.requests.length, 0);
  lastFinish(); lastFinish();
  assert.equal(ui.isAuthMutationInProgress(), false); assert.equal(ui.requests.length, 1);
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: currentUser })); await flush(); ui.unmount();
});

test("a mutation already in progress prevents mount-time checks and unmounted gates do not resume", async () => {
  const ui = await harness(currentUser); const finish = ui.beginAuthMutation(); ui.render();
  assert.equal(ui.requests.length, 0);
  ui.unmount(); finish();
  assert.equal(ui.requests.length, 0); assert.equal(ui.intervalCount(), 0);
});

test("fresh explicit auth denial after a mutation still redirects normally", async () => {
  const ui = await harness(currentUser); ui.render();
  const stale = ui.requests.shift(); const finish = ui.beginAuthMutation(); finish();
  stale.reject(new DOMException("Aborted", "AbortError")); await flush();
  ui.requests.shift().resolve(Response.json({ authenticated: false, user: null })); await flush();
  assert.deepEqual(ui.redirects, ["/login"]); ui.unmount();
});
