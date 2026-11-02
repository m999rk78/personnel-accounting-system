import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const source = await readFile(new URL("../app/TableRowMoves.tsx", import.meta.url), "utf8");
const hookSource = source.slice(source.indexOf("const EMPTY_ORDER"), source.indexOf("\nconst TableOrderContext"));
const initial = { ids: [1, 2, 3], canWrite: true, hasSavedOrder: true, importIds: [2, 1, 3], hasImportOrder: true };
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Exercise the real hook with deferred, abort-ignoring requests and React-like effect cleanup. */
async function harness() {
  const hooksUrl = dataUrl(`// isolated hooks ${Math.random()}
    let values=[],cursor=0,pending=[];
    const same=(left,right)=>left&&right&&left.length===right.length&&left.every((value,index)=>Object.is(value,right[index]));
    export function begin(){cursor=0;pending=[];}
    export function useState(initial){const key=cursor++;if(!(key in values))values[key]=typeof initial==='function'?initial():initial;return[values[key],next=>{values[key]=typeof next==='function'?next(values[key]):next;}];}
    export function useRef(initial){const key=cursor++;if(!(key in values))values[key]={current:initial};return values[key];}
    export function useMemo(create,deps){const key=cursor++;if(!values[key]||!same(values[key].deps,deps))values[key]={deps,value:create()};return values[key].value;}
    export function useCallback(callback,deps){return useMemo(()=>callback,deps);}
    export function useEffect(effect,deps){const key=cursor++;const old=values[key];if(!old||!same(old.deps,deps)){const entry={effect:true,deps,cleanup:old?.cleanup};values[key]=entry;pending.push(()=>{entry.cleanup?.();entry.cleanup=effect();});}}
    export function commit(){for(const effect of pending)effect();pending=[];}
    export function unmount(){for(const entry of values)if(entry?.effect)entry.cleanup?.();}
  `);
  const environmentUrl = dataUrl(`// isolated browser/request queue ${Math.random()}
    const target=new EventTarget();let frameId=0;const frames=new Map();export const requests=[];
    export const window={addEventListener:target.addEventListener.bind(target),removeEventListener:target.removeEventListener.bind(target),dispatchEvent:target.dispatchEvent.bind(target),setTimeout:()=>1,clearTimeout:()=>{}};
    export const requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId;};
    export const cancelAnimationFrame=id=>frames.delete(id);
    export function runFrames(){const ready=[...frames.values()];frames.clear();for(const callback of ready)callback();}
    export function fetch(url,init){return new Promise((resolve,reject)=>requests.push({url,init,resolve,reject}));}
  `);
  const compiled = ts.transpileModule(`
    import {useState,useRef,useEffect,useCallback,useMemo} from ${JSON.stringify(hooksUrl)};
    import {window,fetch,requestAnimationFrame,cancelAnimationFrame} from ${JSON.stringify(environmentUrl)};
    import {orderRowsByIds} from ${JSON.stringify(new URL("../app/tableRowOrder.ts", import.meta.url).href)};
    ${hookSource}
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { useTableRowOrder, notifyTableImportOrder } = await import(dataUrl(compiled));
  const hooks = await import(hooksUrl);
  const environment = await import(environmentUrl);
  let props = { scope: "employees", siteId: 1, canReorder: true };
  const RenderTableOrder = (next = {}) => {
    props = { ...props, ...next };
    hooks.begin();
    const value = useTableRowOrder(props.scope, props.siteId, props.canReorder);
    hooks.commit();
    return value;
  };
  const render = RenderTableOrder;
  const request = () => { const value = environment.requests.shift(); assert.ok(value, "Expected an isolated request"); return value; };
  const ready = async () => {
    render(); environment.runFrames();
    request().resolve(Response.json(initial)); await flush();
    return render();
  };
  return { ...environment, render, ready, request, notify: notifyTableImportOrder, unmount: hooks.unmount };
}

for (const action of ["move", "remap"]) for (const success of [true, false]) {
  test(`${action} ${success ? "success" : "failure"} cannot be overwritten by a late GET or a refresh during its write`, async () => {
    const ui = await harness();
    let state = await ui.ready();
    const refreshing = state.refresh();
    const stale = ui.request();
    const writing = action === "move" ? state.move({ movingIds: [3], placement: "start" }) : state.remap({ 3: 4 });
    const mutation = ui.request();
    assert.equal(stale.init.signal.aborted, true);
    state = ui.render();
    assert.equal(state.busy, true);
    assert.equal(await state.refresh(), false);
    ui.notify("employees", 1); await flush();
    assert.equal(ui.requests.length, 0, "A busy notify must not fetch or activate import sorting");
    assert.equal(ui.render().importOrderRevision, 0);
    mutation.resolve(Response.json(success ? { ids: [3, 1, 2] } : { error: "Write rejected" }, { status: success ? 200 : 409 }));
    assert.equal(await writing, success);
    stale.resolve(Response.json({ ids: [9], importIds: [9], canWrite: false, hasSavedOrder: false, hasImportOrder: false }));
    assert.equal(await refreshing, false);
    state = ui.render(); ui.runFrames();
    assert.equal(ui.requests.length, 0, "An already loaded table does not need another GET after a write");
    assert.deepEqual(state.ids, success ? [3, 1, 2] : initial.ids);
    assert.deepEqual(state.importIds, initial.importIds);
    assert.equal(state.hasImportOrder, true);
    assert.equal(state.hasSavedOrder, true);
    assert.equal(state.canWrite, true);
    assert.equal(state.busy, false);
    assert.equal(state.error, success ? "" : "Write rejected");
    ui.unmount();
  });
}

test("overlapping, failed and aborted refreshes return false without erasing current state or errors", async () => {
  const ui = await harness();
  let state = await ui.ready();
  const first = state.refresh(); const old = ui.request();
  const second = state.refresh(); const latest = ui.request();
  assert.equal(old.init.signal.aborted, true);
  latest.resolve(Response.json({ error: "Current read failed" }, { status: 503 }));
  assert.equal(await second, false);
  old.reject(new Error("Obsolete read failed"));
  assert.equal(await first, false);
  state = ui.render();
  assert.equal(state.error, "Current read failed");
  assert.deepEqual(state.ids, initial.ids);
  const abandoned = state.refresh(); const request = ui.request();
  ui.unmount(); request.resolve(Response.json({ ids: [9] }));
  assert.equal(await abandoned, false);
});

for (const action of ["move", "remap"]) for (const success of [true, false]) test(`a scope change loads its own baseline after ${action} ${success ? "success" : "failure"}`, async () => {
  const ui = await harness();
  let state = await ui.ready();
  const reading = state.refresh(); const old = ui.request();
  const writing = action === "move" ? state.move({ movingIds: [3], placement: "start" }) : state.remap({ 3: 4 });
  const mutation = ui.request();
  state = ui.render({ siteId: 2 }); ui.runFrames();
  assert.equal(state.ready, false);
  assert.equal(ui.requests.length, 0);
  assert.equal(await state.refresh(), false);
  mutation.resolve(Response.json(success ? { ids: [3, 1, 2] } : { error: "Old scope write failed" }, { status: success ? 200 : 409 }));
  assert.equal(await writing, success);
  state = ui.render(); ui.runFrames();
  const current = ui.request();
  assert.match(current.url, /siteId=2/);
  current.resolve(Response.json({ ...initial, ids: [101, 102], importIds: [102, 101] })); await flush();
  old.resolve(Response.json(initial)); assert.equal(await reading, false);
  state = ui.render();
  assert.deepEqual(state.ids, [101, 102]);
  assert.deepEqual(state.importIds, [102, 101]);
  assert.equal(state.ready, true);
  assert.equal(state.error, "");
  ui.unmount();
});

test("a late response from another scope never replaces a current read", async () => {
  const ui = await harness();
  const state = await ui.ready();
  const reading = state.refresh(); const old = ui.request();
  ui.render({ scope: "project-personnel", siteId: 2 }); ui.runFrames();
  const current = ui.request();
  assert.equal(old.init.signal.aborted, true);
  current.resolve(Response.json({ ...initial, ids: [101, 102] })); await flush();
  old.reject(new Error("Old scope read failed")); assert.equal(await reading, false);
  assert.deepEqual(ui.render().ids, [101, 102]);
  assert.equal(ui.render().error, "");
  ui.unmount();
});

test("import notify activates only a successful current refresh, retaining the separate manual baseline", async () => {
  const ui = await harness();
  await ui.ready();
  ui.notify("employees", 2); assert.equal(ui.requests.length, 0);
  ui.notify("employees", 1); const rejected = ui.request();
  rejected.resolve(Response.json({ error: "Read failed" }, { status: 503 })); await flush();
  assert.equal(ui.render().importOrderRevision, 0);
  ui.notify("employees", 1); const accepted = ui.request();
  accepted.resolve(Response.json({ ...initial, importIds: [3, 2, 1] })); await flush();
  const state = ui.render();
  assert.equal(state.importOrderRevision, 1);
  assert.deepEqual(state.ids, initial.ids);
  assert.deepEqual(state.importIds, [3, 2, 1]);
  ui.unmount();
});
