import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { makeFilterPopupResizable, constrainResizedFilterPopup } from "../app/filterPopupResize.ts";

// The browser owns resizing. Simulate its inline style writes, then exercise
// the real adapter without a custom drag algorithm, browser or database.
class Events {
  listeners = new Map();
  addEventListener(name, callback, capture = false) {
    const key = `${name}:${capture}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(callback);
  }
  removeEventListener(name, callback, capture = false) { this.listeners.get(`${name}:${capture}`)?.delete(callback); }
  emit(name, changes = {}, capture = true) {
    const event = { button: 0, isPrimary: true, clientX: 0, clientY: 0,
      defaultPrevented: false, propagationStopped: false, ...changes,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
    for (const callback of [...this.listeners.get(`${name}:${capture}`) ?? []]) callback(event);
    return event;
  }
  get listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}

function harness({ initial = { left: 80, top: 100, width: 334, height: 390 }, viewport = { innerWidth: 1000, innerHeight: 800 }, title = null, condition = false } = {}) {
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
    flush() { if (!this.disconnected) this.callback([{ target: this.target, attributeName: "style" }]); }
  }
  const view = Object.assign(new Events(), viewport, { MutationObserver: Observer, MouseEvent: class { constructor(type) { this.type = type; } } });
  const search = { value: "Стык", checkedValues: ["ОП1/1", "ОП1/2"] };
  const doc = { defaultView: view, activeElement: search };
  const popup = Object.assign(new Events(), { ownerDocument: doc, children: [], attrs: {}, classes: new Set(), initial });
  const panel = condition ? { dispatched: [], dispatchEvent(event) { this.dispatched.push(event.type); } } : null;
  if (panel) popup.children.push(panel);
  popup.matches = selector => selector === ".ag-filter-menu" && !condition;
  popup.querySelector = selector => selector === ".ag-filter-body-wrapper" ? panel : null;
  popup.style = { width: "", height: "", setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
  popup.classList = { add: (...names) => names.forEach(name => popup.classes.add(name)), remove: (...names) => names.forEach(name => popup.classes.delete(name)), contains: name => popup.classes.has(name) };
  popup.getAttribute = name => popup.attrs[name] ?? null;
  popup.setAttribute = (name, value) => { popup.attrs[name] = value; };
  popup.removeAttribute = name => { delete popup.attrs[name]; };
  Object.defineProperty(popup, "title", { get: () => popup.attrs.title ?? "", set: value => { popup.attrs.title = value; } });
  if (title !== null) popup.setAttribute("title", title);
  popup.getBoundingClientRect = () => {
    const rect = Object.fromEntries(Object.entries(popup.initial).map(([key, value]) => [key, Number.parseFloat(popup.style[key]) || value]));
    return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height };
  };
  const cleanup = makeFilterPopupResizable(popup);
  const rect = () => { const { left, top, width, height } = popup.getBoundingClientRect(); return { left, top, width, height }; };
  const corner = overrides => { const { right, bottom } = popup.getBoundingClientRect(); return popup.emit("pointerdown", { clientX: right - 3, clientY: bottom - 3, ...overrides }); };
  const browserSize = (width, height, observe = true) => {
    popup.style.width = `${width}px`; popup.style.height = `${height}px`;
    if (observe) observers[0].flush();
  };
  return { popup, panel, view, doc, search, observers, cleanup, rect, corner, browserSize };
}

test("native resize uses CSS both without custom grip, drag service or keyboard handler", async () => {
  const ui = harness();
  assert.equal(constrainResizedFilterPopup(ui.popup), false);
  assert.deepEqual(ui.rect(), { left: 80, top: 100, width: 334, height: 390 });
  assert.equal(ui.popup.style["--filter-popup-min-width"], "260px");
  assert.equal(ui.popup.style["--filter-popup-min-height"], "220px");
  assert.match(ui.popup.title, /Потяните за край или угол/);
  assert.equal(ui.popup.children.length, 0);
  assert.deepEqual([...ui.popup.listeners.keys()], ["mouseenter:false", "pointerdown:true"]);
  assert.equal(ui.doc.activeElement, ui.search);
  assert.deepEqual(ui.observers[0].options, { attributes: true, attributeFilter: ["style"] });
  const css = await readFile(new URL("../app/filterPopupResize.css", import.meta.url), "utf8");
  assert.match(css, /\.ag-popup-child\.resizable-filter-popup\s*\{[^}]*resize:\s*both;/);
  assert.doesNotMatch(css, /filter-popup-resize-handle/);
  ui.cleanup();
});

test("only lower-right corner preparation releases the anchored cap without preventing native input", () => {
  const ui = harness();
  for (const changes of [
    { clientX: 200, clientY: 250 }, { clientX: 413, clientY: 250 }, { clientX: 200, clientY: 489 },
    { clientX: 413, clientY: 489, button: 2 }, { clientX: 413, clientY: 489, isPrimary: false },
  ]) {
    const event = ui.popup.emit("pointerdown", changes);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
    assert.equal(constrainResizedFilterPopup(ui.popup), false);
  }
  const event = ui.corner();
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.propagationStopped, false);
  assert.equal(ui.popup.style.maxHeight, "776px");
  assert.equal(ui.popup.classList.contains("filter-popup-manually-sized"), true);
  assert.deepEqual(ui.rect(), { left: 80, top: 100, width: 334, height: 390 });
  ui.cleanup();
});

test("native style changes grow and shrink the window while retaining search, selection and focus", () => {
  const ui = harness(), criteria = structuredClone(ui.search);
  ui.corner();
  ui.browserSize(584, 570);
  assert.deepEqual(ui.rect(), { left: 80, top: 100, width: 584, height: 570 });
  ui.browserSize(280, 240);
  assert.deepEqual(ui.rect(), { left: 80, top: 100, width: 280, height: 240 });
  assert.equal(ui.doc.activeElement, ui.search);
  assert.deepEqual(ui.search, criteria);
  ui.cleanup();
});

test("AG positioning adopts native dimensions before the MutationObserver callback", () => {
  const ui = harness();
  ui.browserSize(520, 470, false);
  assert.equal(constrainResizedFilterPopup(ui.popup), true);
  assert.deepEqual(ui.rect(), { left: 80, top: 100, width: 520, height: 470 });
  ui.observers[0].flush();
  assert.deepEqual(ui.rect(), { left: 80, top: 100, width: 520, height: 470 });
  ui.cleanup();
});

test("automatic width-only positioning does not claim the window as manually resized", () => {
  const ui = harness();
  ui.popup.style.width = "334px";
  ui.observers[0].flush();
  assert.equal(constrainResizedFilterPopup(ui.popup), false);
  assert.equal(ui.popup.classList.contains("filter-popup-manually-sized"), false);
  assert.equal(ui.popup.style.height, "");
  ui.cleanup();
});

test("native dimensions fit the viewport and retain the chosen size after shrinking and restoring it", () => {
  const ui = harness();
  ui.browserSize(584, 570);
  const chosen = ui.rect();
  Object.assign(ui.view, { innerWidth: 360, innerHeight: 300 });
  ui.view.emit("resize", {}, false);
  assert.deepEqual(ui.rect(), { left: 12, top: 12, width: 336, height: 276 });
  ui.observers[0].flush();
  Object.assign(ui.view, { innerWidth: 1000, innerHeight: 800 });
  ui.view.emit("resize", {}, false);
  assert.deepEqual(ui.rect(), chosen);
  ui.browserSize(4000, 4000);
  assert.deepEqual(ui.rect(), { left: 12, top: 12, width: 976, height: 776 });
  ui.cleanup();
});

test("late React content mounting cannot leave a two-pixel minimum on the resized popup", () => {
  const ui = harness({ initial: { left: 80, top: 100, width: 2, height: 2 } });
  assert.equal(ui.popup.style["--filter-popup-min-width"], "260px");
  assert.equal(ui.popup.style["--filter-popup-min-height"], "220px");
  ui.popup.initial = { left: 80, top: 100, width: 334, height: 400 };
  ui.corner();
  assert.equal(ui.popup.style["--filter-popup-min-width"], "260px");
  assert.equal(ui.popup.style["--filter-popup-min-height"], "220px");
  assert.deepEqual(ui.rect(), { left: 80, top: 100, width: 334, height: 400 });
  ui.cleanup();
});

test("small condition windows can widen without extra height or a custom submenu grip", () => {
  const ui = harness({ initial: { left: 80, top: 100, width: 224, height: 82 }, condition: true });
  ui.corner();
  assert.equal(ui.popup.style["--filter-popup-min-width"], "224px");
  assert.equal(ui.popup.style["--filter-popup-min-height"], "82px");
  ui.browserSize(370, 82);
  assert.deepEqual(ui.rect(), { left: 80, top: 100, width: 370, height: 82 });
  assert.equal(ui.popup.children.length, 1, "only the pre-existing AG condition panel remains");
  ui.popup.emit("mouseenter", {}, false);
  assert.deepEqual(ui.panel.dispatched, ["mouseenter"], "hovering the native outer corner preserves AG's existing submenu hover guard");
  ui.cleanup();
  ui.popup.emit("mouseenter", {}, false);
  assert.deepEqual(ui.panel.dispatched, ["mouseenter"], "cleanup also removes the hover bridge");
});

test("cleanup removes observers, listeners, CSS minimums and manual state, and restores the title", () => {
  for (const title of [null, "Существующая подсказка"]) {
    const ui = harness({ title });
    ui.browserSize(400, 450);
    ui.cleanup();
    assert.equal(ui.observers[0].disconnected, true);
    assert.equal(ui.popup.listenerCount, 0);
    assert.equal(ui.view.listenerCount, 0);
    assert.equal(ui.popup.classList.contains("resizable-filter-popup"), false);
    assert.equal(ui.popup.classList.contains("filter-popup-manually-sized"), false);
    assert.equal(ui.popup.style["--filter-popup-min-width"], undefined);
    assert.equal(ui.popup.style["--filter-popup-min-height"], undefined);
    assert.equal(ui.popup.getAttribute("title"), title);
    assert.equal(constrainResizedFilterPopup(ui.popup), false);
  }
});
