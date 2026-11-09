import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import postcss from "postcss";
import { emptyColumnGridBackground, emptyColumnRegion } from "../app/emptyColumnGrid.ts";

const source = ts.createSourceFile("useEmptyGridRows.ts", await readFile(new URL("../app/useEmptyGridRows.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useEmptyGridRows");
assert.ok(hook);
const implementation = ts.transpileModule(hook.getText(source).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const css = postcss.parse(await readFile(new URL("../app/gridEmptyRows.css", import.meta.url), "utf8"));
function declarations(selector) {
  const found = new Map();
  css.walkRules(rule => { if (rule.selector === selector) rule.walkDecls(declaration => found.set(declaration.prop, declaration.value)); });
  return found;
}

function harness() {
  const writes = [], created = [], frames = new Map(), apiListeners = new Map(), resizeObservers = [], mutationObservers = [], dataWrites = [];
  let nextFrame = 0, cleanup, destroyed = false, headerReads = 0;
  class Element {
    constructor(className = "", rect = {}) {
      this.className = className; this.rect = { left: 0, top: 0, width: 600, height: 30, ...rect };
      this.children = []; this.parentElement = null; this.attributes = new Map(); this.dataset = {}; this.listeners = new Map(); this.removed = false;
      this.clientWidth = this.rect.width; this.clientHeight = this.rect.height; this.scrollLeft = 0;
      this.style = new Proxy({ setProperty(name, value) { this[name] = value; } }, {
        set: (target, name, value) => { writes.push({ element: this, name, value }); target[name] = value; return true; },
      });
      this.classList = {
        contains: value => this.className.split(/\s+/).includes(value),
        add: value => { this.className = `${this.className} ${value}`.trim(); },
        remove: value => { this.className = this.className.split(/\s+/).filter(item => item !== value).join(" "); },
      };
    }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; this.removed = true; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    getBoundingClientRect() { if (this.classList.contains("ag-header-cell")) headerReads++; return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
    matches(selector) {
      return selector.split(",").some(part => {
        const classes = [...part.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
        return classes.every(value => this.classList.contains(value)) && (!part.includes("[col-id]") || this.attributes.has("col-id"));
      });
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    dispatch(name, values = {}) { this.listeners.get(name)?.forEach(callback => callback({ type: name, target: this, ...values })); }
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; resizeObservers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; mutationObservers.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
    disconnect() { this.disconnected = true; }
  }
  const outer = new Element("ag-grid-shell"), wrapper = new Element("ag-root-wrapper"), header = new Element("ag-header");
  const viewport = new Element("ag-grid-viewport", { left: 120, top: 100, width: 600, height: 500 });
  const rows = new Element("ag-grid-scrolling-rows", { left: 120, top: 100, width: 1524, height: 500 });
  outer.append(wrapper); wrapper.append(header, viewport); viewport.append(rows);
  const columns = new Map([
    ["select", { width: 44, pinned: "left" }], ["employee", { width: 180, pinned: "left" }],
    ["date", { width: 120 }], ["zone", { width: 200 }], ["code", { width: 300 }], ["note", { width: 500 }],
    ["hours", { width: 80, pinned: "right" }], ["status", { width: 100, pinned: "right" }],
  ].map(([id, column]) => [id, { ...column, getColId: () => id, getActualWidth() { return this.width; } }]));
  let order = [...columns.keys()], records = [{ rowTop: 0, rowHeight: 45 }];
  const headerCells = new Map();
  for (const id of ["select", "employee", "date", "zone", "hours", "status"]) {
    const cell = new Element("ag-header-cell"); cell.setAttribute("col-id", id); headerCells.set(id, cell); header.append(cell);
  }
  const lane = side => order.map(id => columns.get(id)).filter(column => !column.hidden && (column.pinned ?? null) === side);
  const api = {
    isDestroyed: () => destroyed,
    getDisplayedRowCount: () => records.length, getDisplayedRowAtIndex: index => records[index],
    getDisplayedLeftColumns: () => lane("left"), getDisplayedCenterColumns: () => lane(null), getDisplayedRightColumns: () => lane("right"),
    getAllDisplayedColumns: () => order.map(id => columns.get(id)).filter(column => !column.hidden), getColumn: id => columns.get(id),
    addEventListener(name, callback) { if (!apiListeners.has(name)) apiListeners.set(name, new Set()); apiListeners.get(name).add(callback); },
    removeEventListener(name, callback) { apiListeners.get(name)?.delete(callback); },
    setGridOption: (...args) => dataWrites.push(args), applyTransaction: (...args) => dataWrites.push(args), setRowData: (...args) => dataWrites.push(args),
  };
  const environment = {
    useEffect: effect => { cleanup = effect(); }, ResizeObserver, MutationObserver,
    document: { createElement: tag => { const element = new Element(); element.tagName = tag.toUpperCase(); created.push(element); return element; } },
    performance: { now: () => 0 },
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; }, cancelAnimationFrame: id => { frames.delete(id); },
    emptyColumnGridBackground, emptyColumnRegion,
  };
  const runHook = new Function(...Object.keys(environment), `${implementation}\nreturn useEmptyGridRows;`)(...Object.values(environment));
  runHook({ current: outer }, api, 42);
  const layer = created[0], surfaces = Object.fromEntries(["left", "center", "right"].map(side => [side, layer.querySelector(`.ag-empty-grid-region-${side}`)]));
  const frame = () => { const callbacks = [...frames]; callbacks.forEach(([id]) => frames.delete(id)); callbacks.forEach(([, callback]) => callback()); };
  return {
    outer, wrapper, header, viewport, rows, columns, headerCells, layer, surfaces, created, frames, writes, apiListeners, resizeObservers, mutationObservers, dataWrites, frame,
    get headerReads() { return headerReads; },
    edges: side => JSON.parse(surfaces[side].dataset.columnBoundaries),
    emit: name => { apiListeners.get(name)?.forEach(callback => callback({ type: name })); },
    mutateHeaders: () => mutationObservers.forEach(observer => { if (!observer.disconnected) observer.callback([{ target: headerCells.get("employee"), type: "attributes", attributeName: "style" }]); }),
    resize: () => resizeObservers.forEach(observer => { if (!observer.disconnected) observer.callback([]); }),
    setOrder: next => { order = next; }, setRecords: next => { records = next; }, destroyApi: () => { destroyed = true; }, cleanup: () => cleanup?.(),
  };
}

test("native column regions use the entire displayed model, including off-screen columns", () => {
  const ui = harness(); ui.frame();
  assert.deepEqual(ui.edges("left"), [44, 224]);
  assert.deepEqual(ui.edges("center"), [120, 320, 620, 1120]);
  assert.deepEqual(ui.edges("right"), [80, 180]);
  assert.equal(ui.surfaces.left.style.width, "224px");
  assert.equal(ui.surfaces.center.style.width, "1120px");
  assert.equal(ui.surfaces.right.style.width, "180px");
  assert.equal(ui.headerCells.has("code"), false);
  assert.equal(ui.headerCells.has("note"), false);
  assert.equal(ui.headerReads, 0, "Virtualized header DOM must never determine model lane boundaries");
  for (const side of ["left", "center", "right"]) assert.equal(ui.surfaces[side].style["--empty-grid-column-background"], emptyColumnGridBackground(ui.edges(side)));
});

test("horizontal scrolling moves native surfaces without RAF, geometry reads or style compensation", () => {
  const ui = harness(); ui.frame();
  const writes = ui.writes.length;
  for (const name of ["bodyScroll", "bodyScrollEnd", "virtualColumnsChanged"]) assert.equal(ui.apiListeners.get(name)?.size ?? 0, 0, name);
  for (const position of [0, 34, 117, 333, 700, 20, 0]) {
    ui.viewport.scrollLeft = position; ui.rows.rect.left = 120 - position;
    for (const cell of ui.headerCells.values()) cell.rect.left = 120 - position;
    ui.emit("bodyScroll"); ui.emit("virtualColumnsChanged"); ui.mutateHeaders();
    assert.equal(ui.frames.size, 0, "Scrolling/virtual header changes must not schedule a chase-the-scroll paint");
    assert.equal(ui.writes.length, writes);
    assert.deepEqual(ui.edges("left"), [44, 224]); assert.deepEqual(ui.edges("center"), [120, 320, 620, 1120]); assert.deepEqual(ui.edges("right"), [80, 180]);
  }
  assert.equal(ui.layer.style.left, undefined); assert.equal(ui.layer.style.width, undefined);
  assert.equal(ui.surfaces.left.style.left, undefined); assert.equal(ui.surfaces.right.style.right, undefined);
  assert.equal(ui.headerReads, 0);
  assert.equal(ui.mutationObservers.length, 0, "No observer may turn header virtualization into an asynchronous scroll correction");
});

test("CSS delegates fixed lanes to the same native sticky offsets as AG Grid and leaves a flexible center gap", () => {
  const layer = declarations(".ag-empty-grid-columns"), region = declarations(".ag-empty-grid-region");
  assert.equal(layer.get("position"), "absolute"); assert.equal(layer.get("left"), "0"); assert.equal(layer.get("width"), "100%"); assert.equal(layer.get("display"), "flex");
  assert.equal(layer.get("pointer-events"), "none"); assert.equal(region.get("flex"), "0 0 auto");
  const left = declarations(".ag-empty-grid-region-left"), right = declarations(".ag-empty-grid-region-right");
  assert.equal(left.get("position"), "sticky"); assert.equal(left.get("left"), "var(--ag-internal-pinned-left-sticky-offset, 0px)");
  assert.equal(right.get("position"), "sticky"); assert.equal(right.get("right"), "var(--ag-internal-pinned-right-sticky-offset, 0px)"); assert.equal(right.get("order"), "1");
  assert.equal(declarations(".ag-empty-grid-columns::after").get("flex"), "1 0 0");
});

test("hide, move, pin and resize events update lane-local widths without relying on stale headers", () => {
  const ui = harness(); ui.frame();
  for (const event of ["columnVisible", "columnMoved", "columnPinned", "columnResized", "displayedColumnsChanged"]) assert.ok(ui.apiListeners.get(event)?.size, event);
  ui.columns.get("zone").hidden = true; ui.emit("columnVisible"); ui.frame();
  assert.equal(ui.headerCells.has("zone"), true, "The disappearing DOM header may still be mounted");
  assert.deepEqual(ui.edges("center"), [120, 420, 920]);
  ui.columns.get("zone").hidden = false;
  ui.setOrder(["select", "employee", "note", "date", "zone", "code", "hours", "status"]);
  ui.emit("columnMoved"); ui.frame();
  assert.deepEqual(ui.edges("center"), [500, 620, 820, 1120]);
  ui.columns.get("zone").pinned = "left";
  ui.emit("columnPinned"); ui.frame();
  assert.deepEqual(ui.edges("left"), [44, 224, 424]);
  assert.deepEqual(ui.edges("center"), [500, 620, 920]);
  ui.columns.get("code").pinned = "right";
  ui.emit("columnPinned"); ui.frame();
  assert.deepEqual(ui.edges("right"), [300, 380, 480]);
  assert.deepEqual(ui.edges("center"), [500, 620]);
  ui.columns.get("employee").width = 250;
  ui.emit("columnResized"); ui.frame();
  assert.equal(ui.surfaces.left.style.width, "494px");
  assert.deepEqual(ui.edges("left"), [44, 294, 494]);
  assert.equal(ui.headerReads, 0); assert.deepEqual(ui.dataWrites, []);
});

test("empty regions hide and model event bursts need only one paint without an animation-following loop", () => {
  const ui = harness(); ui.frame();
  for (const column of ui.columns.values()) if (column.pinned) column.pinned = null;
  ui.wrapper.classList.add("ag-column-moving");
  ui.header.classList.add("ag-animate-autosize");
  for (const event of ["columnPinned", "columnResized", "displayedColumnsChanged"]) ui.emit(event);
  assert.equal(ui.frames.size, 1);
  ui.frame();
  assert.equal(ui.frames.size, 0, "Native browser scrolling/stickiness needs no animation-following RAF loop");
  assert.equal(ui.surfaces.left.hidden, true); assert.equal(ui.surfaces.right.hidden, true);
  assert.equal(ui.surfaces.left.style.width, "0px"); assert.equal(ui.surfaces.left.style["--empty-grid-column-background"], "none");
  assert.equal(ui.surfaces.center.style.width, "1524px");
  assert.equal([...ui.wrapper.listeners.values()].every(callbacks => callbacks.size === 0), true, "The decorative surfaces do not subscribe to scrolling/header transitions");
});

test("decorations remain four non-interactive divs and data/import/filter changes update only blank height", () => {
  const ui = harness(); ui.frame();
  assert.equal(ui.created.length, 4); assert.equal(ui.rows.children.length, 1); assert.equal(ui.layer.children.length, 3);
  assert.equal(ui.layer.getAttribute("aria-hidden"), "true"); assert.equal(ui.layer.getAttribute("role"), "presentation");
  for (const element of ui.created) { assert.equal(element.tagName, "DIV"); assert.equal(element.getAttribute("tabindex"), null); assert.equal(element.getAttribute("role") === "row" || element.getAttribute("role") === "gridcell", false); }
  assert.equal(ui.layer.style.top, "45px"); assert.equal(ui.layer.style.height, "455px");
  assert.equal(ui.outer.style["--empty-grid-row-height"], "42px"); assert.equal(ui.outer.style["--empty-grid-row-offset"], "3px");
  ui.setRecords([{ rowTop: 0, rowHeight: 42 }, { rowTop: 42, rowHeight: 42 }]); ui.emit("modelUpdated"); ui.frame();
  assert.equal(ui.layer.style.top, "84px"); assert.equal(ui.layer.style.height, "416px");
  ui.setRecords([]); ui.emit("firstDataRendered"); ui.frame();
  assert.equal(ui.layer.style.top, "0px"); assert.equal(ui.layer.style.height, "500px");
  ui.rows.clientHeight = 300; ui.resize(); ui.frame();
  assert.equal(ui.layer.style.height, "300px"); assert.equal(ui.surfaces.center.style.width, "1120px");
  ui.setRecords([{ rowTop: 0, rowHeight: 600 }]); ui.emit("modelUpdated"); ui.frame();
  assert.equal(ui.layer.hidden, true); assert.equal(ui.layer.style.height, "0px");
  assert.deepEqual(ui.dataWrites, []);
});

test("cleanup cancels pending paint and prevents stale model/resize/RAF callbacks from mutating removed surfaces", () => {
  const ui = harness(); ui.frame();
  ui.emit("columnVisible");
  const staleFrames = [...ui.frames.values()], staleEvents = [...ui.apiListeners.values()].flatMap(callbacks => [...callbacks]);
  const staleResize = ui.resizeObservers.map(observer => observer.callback);
  ui.cleanup(); const writes = ui.writes.length;
  assert.equal(ui.layer.removed, true); assert.equal(ui.rows.children.length, 0); assert.equal(ui.frames.size, 0);
  assert.equal(ui.resizeObservers.every(observer => observer.disconnected), true);
  assert.equal([...ui.apiListeners.values()].every(callbacks => callbacks.size === 0), true);
  staleEvents.forEach(callback => callback()); staleResize.forEach(callback => callback([])); staleFrames.forEach(callback => callback());
  assert.equal(ui.frames.size, 0); assert.equal(ui.writes.length, writes); assert.deepEqual(ui.dataWrites, []);
});

test("lane boundaries ignore invalid widths while keeping valid fractional and off-screen widths intact", () => {
  const values = Object.freeze([44, 66.5, 0, NaN, Infinity, -1, undefined, null, "20", 50]);
  assert.deepEqual(emptyColumnRegion(values), { width: 160.5, edges: [44, 110.5, 160.5] });
  assert.deepEqual(emptyColumnRegion([]), { width: 0, edges: [] });
  assert.deepEqual(emptyColumnRegion([NaN, -1, Infinity]), { width: 0, edges: [] });
  assert.deepEqual(emptyColumnRegion([1000, 2000, 3000]), { width: 6000, edges: [1000, 3000, 6000] });
});
