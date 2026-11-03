import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { MAINTENANCE_READY_EVENT } from "../app/maintenanceClient.ts";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const source = await readFile(new URL("../app/AuthGate.tsx", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Executes the actual auth effect with isolated hooks and request/timer queues. */
async function harness() {
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
    const events=new EventTarget(), doc=new EventTarget();let timer=0;const timers=new Map();export const requests=[],redirects=[];
    export const setTimeout=callback=>{timers.set(++timer,callback);return timer;}; export const clearTimeout=id=>timers.delete(id);
    export const window={location:{replace:url=>redirects.push(url)},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),setInterval:()=>1,clearInterval:()=>{}};
    export const document={visibilityState:'visible',addEventListener:doc.addEventListener.bind(doc),removeEventListener:doc.removeEventListener.bind(doc)};
    export function fetch(input,init){return new Promise((resolve,reject)=>requests.push({input,init,resolve,reject}));}
    export function runTimers(){const list=[...timers.values()];timers.clear();for(const callback of list)callback();}
    export function timerCount(){return timers.size;}
  `);
  const stubUrl = dataUrl(`export default function PersonnelApp(){};export function useProjectToday(today){return today;}export function permissionSetsEqual(){return true;}`);
  const jsxUrl = dataUrl(`export const Fragment='fragment';export const jsx=(type,props)=>({type,props});export const jsxs=jsx;`);
  const input = `import {window,document,fetch,setTimeout,clearTimeout} from ${JSON.stringify(environmentUrl)};\n${source
    .replace('"react"', JSON.stringify(hooksUrl))
    .replace('"./PersonnelApp"', JSON.stringify(stubUrl))
    .replaceAll('"./permissionModel"', JSON.stringify(stubUrl))
    .replace('"./useProjectToday"', JSON.stringify(stubUrl))
    .replace('"./maintenanceClient"', JSON.stringify(new URL("../app/maintenanceClient.ts", import.meta.url).href))}`;
  const compiled = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText.replace('"react/jsx-runtime"', JSON.stringify(jsxUrl));
  const { default: AuthGate } = await import(dataUrl(compiled));
  const hooks = await import(hooksUrl); const environment = await import(environmentUrl);
  return { ...environment, render() { hooks.begin(); const value = AuthGate({ initialToday: "2026-11-02" }); hooks.commit(); return value; }, state: hooks.read, unmount: hooks.unmount };
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
  ui.requests.shift().resolve(Response.json({ authenticated: true, user: { id: 7, role: "engineer", assignedSiteId: null } })); await flush();
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
