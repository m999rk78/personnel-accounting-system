import assert from "node:assert/strict";
import test from "node:test";
import { createRowDropIndicator, rowDropIndicatorGeometry, rowDropPlacement } from "../app/rowDropIndicator.ts";

const bounds = { left: 100, right: 900, top: 150, bottom: 650 };

test("drop placement changes at the row midpoint, including fractional browser coordinates", () => {
  const row = { top: 210.5, height: 43 };
  assert.equal(rowDropPlacement(210.5, row), "before");
  assert.equal(rowDropPlacement(231.999, row), "before");
  assert.equal(rowDropPlacement(232, row), "after");
  assert.equal(rowDropPlacement(253.5, row), "after");
});

test("indicator spans the visible table width and uses the selected row edge", () => {
  const row = { top: 300, bottom: 344 };
  assert.deepEqual(rowDropIndicatorGeometry(row, bounds, "before"), { left: 103, top: 300, width: 794, labelBelow: false });
  assert.deepEqual(rowDropIndicatorGeometry(row, bounds, "after"), { left: 103, top: 344, width: 794, labelBelow: true });
});

test("edge labels face into the visible body and subpixel overflow is clamped", () => {
  assert.deepEqual(rowDropIndicatorGeometry({ top: 149.5, bottom: 193.5 }, bounds, "before"), { left: 103, top: 150, width: 794, labelBelow: true });
  assert.deepEqual(rowDropIndicatorGeometry({ top: 606.5, bottom: 650.5 }, bounds, "after"), { left: 103, top: 650, width: 794, labelBelow: false });
  assert.equal(rowDropIndicatorGeometry({ top: 150, bottom: 179.5 }, bounds, "before").labelBelow, true);
  assert.equal(rowDropIndicatorGeometry({ top: 620.5, bottom: 650 }, bounds, "after").labelBelow, false);
});

test("offscreen edges, unusable viewports and nonfinite geometry do not produce an indicator", () => {
  const row = { top: 300, bottom: 344 };
  assert.equal(rowDropIndicatorGeometry({ top: 148, bottom: 192 }, bounds, "before"), null);
  assert.equal(rowDropIndicatorGeometry({ top: 608, bottom: 652 }, bounds, "after"), null);
  for (const invalid of [{ ...bounds, right: 119 }, { ...bounds, bottom: 150 }, { ...bounds, bottom: 149 }]) {
    assert.equal(rowDropIndicatorGeometry(row, invalid, "before"), null);
  }
  for (const field of ["left", "right", "top", "bottom"]) {
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.equal(rowDropIndicatorGeometry(row, { ...bounds, [field]: value }, "after"), null);
    }
  }
  assert.equal(rowDropIndicatorGeometry({ ...row, top: NaN }, bounds, "before"), null);
  assert.equal(rowDropIndicatorGeometry({ ...row, bottom: Infinity }, bounds, "after"), null);
});

class DomTarget extends EventTarget {
  listeners = [];
  addEventListener(type, callback, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    this.listeners.push({ type, callback, capture });
    super.addEventListener(type, callback, { capture });
  }
  removeEventListener(type, callback, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    this.listeners = this.listeners.filter(item => item.type !== type || item.callback !== callback || item.capture !== capture);
    super.removeEventListener(type, callback, { capture });
  }
}

class Element {
  children = [];
  parentElement = null;
  attributes = new Map();
  selectors = new Map();
  style = {};
  dataset = {};
  hidden = false;
  textContent = "";
  className = "";
  offsetHeight = 0;
  constructor(doc, rect = {}) { this.ownerDocument = doc; this.rect = rect; }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentElement?.isConnected; }
  append(element) { element.remove(); this.children.push(element); element.parentElement = this; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  contains(element) { for (let current = element; current; current = current.parentElement) if (current === this) return true; return false; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  getBoundingClientRect() { return { ...this.rect, height: this.rect.bottom - this.rect.top, width: this.rect.right - this.rect.left }; }
  querySelector(selector) { return this.selectors.get(selector) ?? null; }
  matches(selector) { return selector === `.${this.className}`; }
}

function fixture() {
  const frames = new Map(); let sequence = 0;
  const view = Object.assign(new DomTarget(), {
    innerWidth: 1000, innerHeight: 800,
    requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const doc = Object.assign(new DomTarget(), { defaultView: view, createElement: () => new Element(doc) });
  doc.body = new Element(doc);
  const owner = new Element(doc, { left: 100, right: 900, top: 100, bottom: 700 });
  doc.body.append(owner);
  const row = new Element(doc, { left: 100, right: 900, top: 300, bottom: 344 });
  row.setAttribute("data-row-drop-id", "employee:42"); owner.append(row);
  const indicator = createRowDropIndicator(owner);
  const line = doc.body.children.find(child => child.className === "table-row-drop-indicator");
  const label = line.children[0];
  return {
    doc, view, owner, row, indicator, line, label, frames,
    show(changes = {}) { indicator.show({ row, placement: "before", count: 2, rowNumber: 8, ...changes }); },
    step() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
    query(selector, rect, className = "") {
      const element = new Element(doc, rect); element.className = className; owner.append(element); owner.selectors.set(selector, element); return element;
    },
  };
}

test("show and clear maintain a single accessible overlay with the current destination and selected count", () => {
  const f = fixture();
  assert.equal(f.line.hidden, true);
  assert.equal(f.line.getAttribute("role"), "status");
  assert.equal(f.line.getAttribute("aria-live"), "polite");
  f.show();
  assert.equal(f.line.hidden, false);
  assert.equal(f.label.textContent, "Перед строкой 8 · строк: 2");
  assert.deepEqual(f.line.dataset, { placement: "before", labelSide: "above" });
  f.show({ placement: "after", count: 3, rowNumber: 9 });
  assert.equal(f.label.textContent, "После строки 9 · строк: 3");
  assert.equal(f.line.style.top, "344px");
  assert.equal(f.doc.body.children.filter(child => child.className === "table-row-drop-indicator").length, 1);
  f.indicator.clear();
  assert.equal(f.line.hidden, true); assert.equal(f.label.textContent, "");
  f.show(); assert.equal(f.line.hidden, false);
  f.indicator.destroy();
});

test("native sticky headings and footers clip the line instead of covering controls", () => {
  const f = fixture();
  f.query("thead", { left: 100, right: 900, top: 100, bottom: 160 });
  f.query("tfoot", { left: 100, right: 900, top: 650, bottom: 700 });
  f.row.rect = { left: 100, right: 900, top: 130, bottom: 174 };
  f.show(); assert.equal(f.line.hidden, true);
  f.show({ placement: "after" }); assert.equal(f.line.style.top, "174px"); assert.equal(f.line.hidden, false);
  f.row.rect = { left: 100, right: 900, top: 620, bottom: 664 };
  f.show({ placement: "after" }); assert.equal(f.line.hidden, true);
  f.show(); assert.equal(f.line.style.top, "620px"); assert.equal(f.line.hidden, false);
  f.indicator.destroy();
});

test("AG Grid body clipping keeps the overlay across pinned columns while excluding pinned summary rows", () => {
  const f = fixture();
  f.query(".ag-grid-viewport, .ag-body-viewport", { left: 350, right: 850, top: 150, bottom: 650 }, "ag-grid-viewport");
  f.query(".ag-grid-pinned-top-rows", {}).offsetHeight = 40;
  f.query(".ag-grid-pinned-bottom-rows", {}).offsetHeight = 30;
  f.row.rect = { left: 350, right: 850, top: 170, bottom: 214 };
  f.show(); assert.equal(f.line.hidden, true);
  f.show({ placement: "after" });
  assert.equal(f.line.hidden, false); assert.equal(f.line.style.left, "103px"); assert.equal(f.line.style.width, "794px");
  f.row.rect = { left: 350, right: 850, top: 590, bottom: 634 };
  f.show({ placement: "after" }); assert.equal(f.line.hidden, true);
  f.show(); assert.equal(f.line.style.top, "590px"); assert.equal(f.line.hidden, false);
  f.indicator.destroy();
});

test("an AG body viewport already excluding pinned rows is not clipped a second time", () => {
  const f = fixture();
  f.query(".ag-grid-viewport, .ag-body-viewport", { left: 350, right: 850, top: 190, bottom: 620 }, "ag-body-viewport");
  f.query(".ag-grid-pinned-top-rows", {}).offsetHeight = 40;
  f.query(".ag-grid-pinned-bottom-rows", {}).offsetHeight = 30;
  f.row.rect = { left: 350, right: 850, top: 190, bottom: 234 };
  f.show(); assert.equal(f.line.hidden, false); assert.equal(f.line.style.top, "190px");
  f.row.rect = { left: 350, right: 850, top: 576, bottom: 620 };
  f.show({ placement: "after" }); assert.equal(f.line.hidden, false); assert.equal(f.line.style.top, "620px");
  f.indicator.destroy();
});

test("scroll and resize coalesce positioning, follow the target and respect browser viewport edges", () => {
  const f = fixture(); f.show();
  f.row.rect.top = 250; f.row.rect.bottom = 294;
  f.doc.dispatchEvent(new Event("scroll")); f.doc.dispatchEvent(new Event("scroll")); f.view.dispatchEvent(new Event("resize"));
  assert.equal(f.frames.size, 1); assert.equal(f.line.style.top, "300px");
  f.step(); assert.equal(f.line.style.top, "250px"); assert.equal(f.frames.size, 0);
  f.owner.rect.left = -100; f.owner.rect.right = 1200; f.view.innerWidth = 700;
  f.view.dispatchEvent(new Event("resize")); f.step();
  assert.equal(f.line.style.left, "3px"); assert.equal(f.line.style.width, "694px");
  f.view.innerHeight = 200; f.view.dispatchEvent(new Event("resize")); f.step();
  assert.equal(f.line.hidden, true);
  f.view.innerHeight = 800; f.view.dispatchEvent(new Event("resize")); f.step();
  assert.equal(f.line.hidden, false, "a merely clipped target can return without starting another gesture");
  f.indicator.destroy();
});

test("removed, moved and recycled rows invalidate the old target instead of pointing at another record", () => {
  for (const invalidate of [f => f.row.remove(), f => f.owner.remove(), f => f.doc.body.append(f.row), f => f.row.setAttribute("data-row-drop-id", "employee:99")]) {
    const f = fixture(); f.show(); invalidate(f);
    f.doc.dispatchEvent(new Event("scroll")); f.step();
    assert.equal(f.line.hidden, true); assert.equal(f.label.textContent, "");
    f.doc.body.append(f.owner); f.owner.append(f.row); f.row.setAttribute("data-row-drop-id", "employee:42");
    f.view.dispatchEvent(new Event("resize")); f.step();
    assert.equal(f.line.hidden, true, "restoring a DOM node must not revive an invalidated gesture");
    f.indicator.destroy();
  }
});

test("AG Grid row-id changes invalidate recycled virtual rows even if the native attribute is unchanged", () => {
  const f = fixture(); f.row.setAttribute("row-id", "grid:42"); f.show();
  f.row.setAttribute("row-id", "grid:99"); f.doc.dispatchEvent(new Event("scroll")); f.step();
  assert.equal(f.line.hidden, true); assert.equal(f.label.textContent, "");
  f.indicator.destroy();
});

test("Escape, dragend and window blur clear the preview and queued frames cannot revive it", () => {
  for (const end of [f => f.doc.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" })), f => f.doc.dispatchEvent(new Event("dragend")), f => f.view.dispatchEvent(new Event("blur"))]) {
    const f = fixture(); f.show();
    f.doc.dispatchEvent(Object.assign(new Event("keydown"), { key: "Shift" })); assert.equal(f.line.hidden, false);
    f.doc.dispatchEvent(new Event("scroll")); end(f); f.step();
    assert.equal(f.line.hidden, true); assert.equal(f.label.textContent, "");
    f.view.dispatchEvent(new Event("resize")); assert.equal(f.frames.size, 0);
    f.indicator.destroy();
  }
});

test("destroy removes the overlay, every listener and a pending animation frame exactly once", () => {
  const f = fixture(); f.show(); f.doc.dispatchEvent(new Event("scroll"));
  assert.equal(f.frames.size, 1); assert.ok(f.doc.listeners.length > 0); assert.ok(f.view.listeners.length > 0);
  f.indicator.destroy(); f.indicator.destroy();
  assert.equal(f.frames.size, 0); assert.equal(f.doc.listeners.length, 0); assert.equal(f.view.listeners.length, 0);
  assert.equal(f.line.isConnected, false);
  f.show(); f.doc.dispatchEvent(new Event("scroll")); f.view.dispatchEvent(new Event("resize")); f.step();
  assert.equal(f.frames.size, 0); assert.equal(f.line.hidden, true); assert.equal(f.line.isConnected, false);
});

test("showing a new destination while scroll positioning is pending does not lose the frame cleanup", () => {
  const f = fixture(); f.show(); f.doc.dispatchEvent(new Event("scroll"));
  f.show({ placement: "after", rowNumber: 9 });
  assert.equal(f.line.style.top, "344px");
  f.indicator.destroy();
  assert.equal(f.frames.size, 0, "destroy must cancel a scroll frame even after a synchronous preview update");
});
