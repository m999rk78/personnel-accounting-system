import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { columnFilterVisibility } from "../app/columnFilterToggle.ts";
import { gridFilterPopupGeometry } from "../app/gridFilterPopupGeometry.ts";

const geometry = changes => gridFilterPopupGeometry({ anchor: { top: 307, bottom: 331, left: 451 }, width: 334, height: 395, preferredHeight: 540, viewportWidth: 1000, viewportHeight: 720, ...changes });
test("a tall filter in the middle of a short viewport shrinks below its trigger instead of covering it", () => {
  const result = geometry();
  assert.deepEqual(result, { left: 451, top: 337, maxHeight: 371 });
  assert.ok(result.top > 331);
  assert.ok(result.top + Math.min(395, result.maxHeight) <= 708);
});

test("lower triggers use the space above; horizontal clamping and growth retain a reachable trigger", () => {
  const result = geometry({ anchor: { top: 610, bottom: 634, left: 970 } });
  assert.deepEqual(result, { left: 654, top: 209, maxHeight: 540 });
  assert.ok(result.top + 395 < 610);
  assert.deepEqual(geometry({ viewportWidth: 360, width: 334, viewportHeight: 1000 }), { left: 14, top: 337, maxHeight: 540 });
  // Expanding the state checklist may increase the content height, but not
  // move its upper edge over the column's filter button.
  assert.deepEqual(geometry({ height: 620 }), { left: 451, top: 337, maxHeight: 371 });
});

const source = ts.createSourceFile("useGridFilterPopup.ts", await readFile(new URL("../app/useGridFilterPopup.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useGridFilterPopup");
assert.ok(hook);
const implementation = ts.transpileModule(hook.getText(source).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("the actual popup hook restores anchored placement after AG positioning, resize and page scroll, with cleanup", () => {
  const frames = new Map(), events = new Map(), observers = [], effects = [];
  let nextFrame = 0;
  class FakeNode {}
  const anchor = new FakeNode();
  Object.assign(anchor, { isConnected: true, getBoundingClientRect: () => ({ top: 307, bottom: 331, left: 451 }) });
  const popup = new FakeNode();
  Object.assign(popup, {
    isConnected: true,
    style: { top: "313px", left: "451px", visibility: "", maxHeight: "", position: "fixed" },
    getBoundingClientRect() { return { top: Number.parseFloat(this.style.top), left: Number.parseFloat(this.style.left), width: 334, height: Math.min(395, Number.parseFloat(this.style.maxHeight) || 540) }; },
    contains: target => target === popup,
  });
  const window = {
    innerWidth: 1000, innerHeight: 720,
    addEventListener(name, callback) { events.set(name, callback); },
    removeEventListener(name, callback) { if (events.get(name) === callback) events.delete(name); },
  };
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  }
  const api = { isDestroyed: () => false, addEventListener() {}, removeEventListener() {} };
  columnFilterVisibility(api).setAnchor("fullName", anchor);
  const environment = {
    useRef: initial => ({ current: initial }), useCallback: callback => callback, useEffect: effect => { effects.push(effect); },
    columnFilterVisibility, gridFilterPopupGeometry, window, Node: FakeNode,
    getComputedStyle: () => ({ maxHeight: "540px" }), ResizeObserver: Observer, MutationObserver: Observer,
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
  };
  const usePopup = new Function(...Object.keys(environment), `${implementation}; return useGridFilterPopup;`)(...Object.values(environment));
  const result = usePopup({ api, column: { getColId: () => "fullName" } });
  result.root.current = { closest: () => popup };
  const dispose = effects.map(effect => effect());
  const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  result.attach();
  assert.equal(popup.style.visibility, "hidden"); flush();
  assert.equal(popup.style.top, "337px"); assert.equal(popup.style.maxHeight, "371px");
  assert.ok(observers[0].targets.includes(anchor), "button size changes are observed too");
  popup.style.top = "313px"; observers[1].callback(); flush();
  assert.equal(popup.style.top, "337px", "AG's late clamp must not cover the trigger");
  window.innerHeight = 480; events.get("resize")(); flush();
  assert.equal(popup.style.top, "12px"); assert.equal(popup.style.maxHeight, "289px");
  assert.ok(popup.getBoundingClientRect().top + popup.getBoundingClientRect().height < 307);
  window.innerHeight = 1000; events.get("scroll")({ target: anchor }); flush();
  assert.equal(popup.style.top, "337px"); assert.equal(popup.style.maxHeight, "540px", "a larger viewport restores list space");
  events.get("scroll")({ target: popup }); assert.equal(frames.size, 0, "list scrolling does not schedule page positioning");
  dispose.forEach(cleanup => cleanup?.());
  assert.ok(observers.every(observer => observer.disconnected)); assert.equal(events.size, 0); assert.equal(frames.size, 0);
});
