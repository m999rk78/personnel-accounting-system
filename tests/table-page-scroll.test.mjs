import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement, Fragment } from "react";
import ts from "typescript";

const source = ts.createSourceFile("TablePageScroll.tsx", await readFile(new URL("../app/TablePageScroll.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const implementation = ts.transpileModule(source.statements.filter(node => ts.isFunctionDeclaration(node) && ["TablePageScroll", "AgTablePageScroll"].includes(node.name?.text)).map(node => node.getText(source).replace(/^export\s+/, "")).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement", jsxFragmentFactory: "Fragment" },
}).outputText;

function harness({ native = false, ag = false, oldMarkers = false } = {}) {
  const effects = [], frames = new Map(), resizeObservers = [], mutationObservers = [], subscribed = new Set(), apiListeners = new Map();
  const metrics = { contentHeight: 0, modelWidth: 0, scrollWidth: 0, styles: [], scrolls: [], windowScrolls: [], unsubscribed: 0 };
  let frameId = 0, cleanups = [], naturalHeight = 1800, modelWidth = 1400, currentHorizontal = false, scrollbarWidth;
  let root, viewport, stageElement, frameElement;
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    dispatch(name, extra = {}) { this.listeners.get(name)?.forEach(callback => callback({ type: name, target: this, ...extra })); }
  }
  const win = new Events();
  Object.assign(win, { innerHeight: 800, scrollY: 0, scrollTo({ top }) { metrics.windowScrolls.push(top); this.scrollY = top; } });
  class Element extends Events {
    constructor(className = "", { left = 100, top = 140, width = 600, height = 40, tag = "div" } = {}) {
      super(); this.className = className; this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.attributes = new Map();
      this.rect = { left, top, width, height }; this._clientWidth = width; this._clientHeight = height; this._scrollWidth = null; this._scrollHeight = height;
      this._scrollLeft = 0; this._scrollTop = 0; this.vnodeProps = {};
      this.classList = { contains: value => this.className.split(/\s+/).includes(value) };
      this.style = new Proxy({}, { set: (target, property, value) => { metrics.styles.push({ element: this, property, value }); target[property] = value; return true; } });
    }
    get id() { return this.getAttribute("id") ?? ""; }
    get clientWidth() { return parseFloat(this.style.width) || this._clientWidth; }
    set clientWidth(value) { this._clientWidth = value; }
    get clientHeight() { return this._clientHeight; }
    set clientHeight(value) { this._clientHeight = value; }
    get scrollWidth() {
      if (this === viewport) metrics.scrollWidth++;
      return this._scrollWidth ?? Math.max(this.clientWidth, ...this.children.map(child => parseFloat(child.style.width) || child.clientWidth));
    }
    set scrollWidth(value) { this._scrollWidth = value; }
    get scrollHeight() { return this._scrollHeight; }
    set scrollHeight(value) { this._scrollHeight = value; }
    get scrollLeft() { return this._scrollLeft; }
    set scrollLeft(value) {
      const maximum = Math.max(0, (this._scrollWidth ?? Math.max(this.clientWidth, ...this.children.map(child => parseFloat(child.style.width) || child.clientWidth))) - this.clientWidth);
      this._scrollLeft = Math.max(0, Math.min(maximum, value));
      metrics.scrolls.push({ element: this, axis: "x", value: this._scrollLeft });
    }
    get scrollTop() { return this._scrollTop; }
    set scrollTop(value) { this._scrollTop = value; metrics.scrolls.push({ element: this, axis: "y", value }); }
    get isConnected() { return Boolean(this.parentElement) || this.className === "page-content"; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    append(child) { child.parentElement = this; this.children.push(child); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    matches(selector) {
      return selector.split(",").some(part => {
        const tag = part.match(/^[a-z][\w-]*/i)?.[0].toUpperCase();
        const classes = [...part.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
        return (!tag || tag === this.tagName) && classes.every(value => this.className.split(/\s+/).includes(value));
      });
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    getBoundingClientRect() {
      const top = this === stageElement ? 140 - win.scrollY : this === frameElement ? Math.max(0, 140 - win.scrollY) : this.rect.top;
      const height = parseFloat(this.style.height) || this.rect.height, width = parseFloat(this.style.width) || this.rect.width;
      return { ...this.rect, top, width, height, right: this.rect.left + width, bottom: top + height };
    }
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnected = false; resizeObservers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; mutationObservers.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
    disconnect() { this.disconnected = true; }
  }
  const page = new Element("page-content"), wrapper = new Element("ag-root-wrapper"), owner = new Element("ag-root");
  root = new Element("ag-grid-shell", { height: 500 });
  viewport = new Element("ag-grid-viewport", { height: 440 }); viewport.scrollWidth = 1600; viewport.scrollHeight = 1800;
  const header = new Element("ag-header", { height: 60 }), headerRow = new Element("ag-header-row");
  const headerCell = new Element("ag-header-cell"), cell = new Element("ag-cell");
  const area = new Element("ag-grid-scrollable-area"), container = new Element("ag-grid-scrolling-container");
  const rail = new Element("ag-body-vertical-scroll", { width: 15 });
  root.append(wrapper); wrapper.append(owner); owner.append(header); header.append(headerRow); headerRow.append(headerCell);
  owner.append(area); area.append(container); container.append(viewport); viewport.append(cell); owner.append(rail);
  if (oldMarkers) { root.setAttribute("id", "existing-grid"); viewport.setAttribute("data-table-page-viewport", "old-viewport"); rail.setAttribute("data-table-page-native-rail", "old-rail"); }
  const columns = [{ width: 100, pinned: "left" }, { width: 300 }, { width: 700 }, { width: 50, pinned: "right" }].map(item => ({ ...item, getActualWidth() { return this.width; } }));
  const api = {
    isDestroyed: () => false,
    getGridOption: name => name === "scrollbarWidth" ? scrollbarWidth : undefined,
    getAllDisplayedColumns: () => columns.filter(column => !column.hidden),
    getDisplayedLeftColumns: () => columns.filter(column => !column.hidden && column.pinned === "left"),
    getDisplayedRightColumns: () => columns.filter(column => !column.hidden && column.pinned === "right"),
    getDisplayedRowCount: () => 2, getDisplayedRowAtIndex: () => ({ rowTop: 42, rowHeight: 42 }), getSizesForCurrentTheme: () => ({ rowHeight: 42 }),
    addEventListener(name, callback) { if (!apiListeners.has(name)) apiListeners.set(name, new Set()); apiListeners.get(name).add(callback); },
    removeEventListener(name, callback) { apiListeners.get(name)?.delete(callback); },
  };
  const sourceModel = {
    getViewport: () => viewport,
    getContentHeight: () => { metrics.contentHeight++; return naturalHeight; },
    ...(!native ? { getHorizontalContentWidth: () => { metrics.modelWidth++; return modelWidth; } } : {}),
    subscribe: callback => { subscribed.add(callback); return () => { subscribed.delete(callback); metrics.unsubscribed++; }; },
  };
  const environment = {
    createElement, Fragment, Element, ResizeObserver, MutationObserver, window: win,
    useRef: initial => ({ current: initial }), useState: initial => [initial, next => { currentHorizontal = next; }], useMemo: calculate => calculate(),
    useId: () => "test-page-scroll", useLayoutEffect: callback => { effects.push(callback); },
    requestAnimationFrame: callback => { const id = ++frameId; frames.set(id, callback); return id; }, cancelAnimationFrame: id => { frames.delete(id); },
  };
  const { runTable, runAg } = new Function(...Object.keys(environment), `${implementation}\nreturn {runTable:TablePageScroll,runAg:AgTablePageScroll};`)(...Object.values(environment));
  const gridRoot = { current: root }, gridNode = createElement("div", { "data-fixture-grid": true });
  const sourceProps = ag ? runAg({ gridRoot, api, children: gridNode }).props.source : sourceModel;
  const view = runTable({ gridRoot, source: sourceProps, children: gridNode, footer: createElement("span", null, "Footer") });
  const bind = node => {
    if (!node || typeof node !== "object") return null;
    if (node === gridNode) return root;
    const element = new Element(node.props.className ?? "", { tag: typeof node.type === "string" ? node.type : "div" });
    element.vnodeProps = node.props;
    if (node.props.ref) node.props.ref.current = element;
    for (const child of [node.props.children].flat(Infinity)) { const result = bind(child); if (result) element.append(result); }
    return element;
  };
  stageElement = bind(view); page.append(stageElement);
  frameElement = stageElement.querySelector(".table-page-scroll-frame");
  const track = stageElement.querySelector(".table-page-horizontal"), spacer = track.children[0];
  cleanups = effects.map(effect => effect()).filter(Boolean);
  const frame = () => { const callbacks = [...frames]; callbacks.forEach(([id]) => frames.delete(id)); callbacks.forEach(([, callback]) => callback()); };
  const flush = () => { let count = 0; while (frames.size && count++ < 15) frame(); assert.equal(frames.size, 0, "The scroll layout must settle instead of feeding back into another frame"); };
  flush();
  return {
    page, root, viewport, wrapper, owner, header, headerCell, cell, area, container, rail, stage: stageElement, frameElement, track, spacer, metrics, frames, resizeObservers, mutationObservers, apiListeners, columns, sourceProps, flush, frame, win,
    get horizontal() { return currentHorizontal; },
    setWidth: value => { modelWidth = value; }, setHeight: value => { naturalHeight = value; },
    setScrollbarWidth: value => { scrollbarWidth = value; },
    geometry: () => { subscribed.forEach(callback => callback()); },
    emit: name => { apiListeners.get(name)?.forEach(callback => callback()); },
    external: value => { track.scrollLeft = value; track.dispatch("scroll"); },
    internal: value => { viewport.scrollLeft = value; viewport.dispatch("scroll"); },
    resize: () => { resizeObservers.forEach(observer => { if (!observer.disconnected) observer.callback([]); }); },
    mutateCells: () => { mutationObservers.forEach(observer => { if (!observer.disconnected) observer.callback([{ target: cell, type: "attributes", attributeName: "style" }]); }); },
    mountTable: () => { const table = new Element("timesheet-table", { tag: "table", height: 1800 }); viewport.append(table); return table; },
    key: key => { let prevented = false; track.vnodeProps.onKeyDown({ key, currentTarget: track, preventDefault() { prevented = true; } }); return prevented; },
    cleanup: () => { cleanups.forEach(dispose => dispose()); cleanups = []; },
  };
}

test("horizontal scrolling and virtual cell changes synchronise offsets without measuring or resizing the page", () => {
  const ui = harness();
  assert.equal(ui.track.getAttribute("aria-valuemax"), "800");
  const contentReads = ui.metrics.contentHeight, widthReads = ui.metrics.modelWidth, styleWrites = ui.metrics.styles.length;
  for (const position of [40, 150, 380, 510, 760, 260, 0]) {
    ui.viewport.scrollWidth = position % 3 ? 2200 : 1500;
    ui.external(position);
    ui.viewport.dispatch("scroll");
    ui.mutateCells();
    assert.equal(ui.viewport.scrollLeft, position);
    assert.equal(ui.track.scrollLeft, position);
    assert.equal(ui.track.getAttribute("aria-valuenow"), String(position));
    assert.equal(ui.track.getAttribute("aria-valuemax"), "800");
    assert.equal(ui.frames.size, 0, "Horizontal input and virtual cell styling must not trigger a page geometry pass");
  }
  assert.equal(ui.metrics.contentHeight, contentReads);
  assert.equal(ui.metrics.modelWidth, widthReads);
  assert.equal(ui.metrics.styles.length, styleWrites);
  assert.equal(ui.viewport.scrollTop, 0);
  assert.deepEqual(ui.metrics.windowScrolls, []);
  assert.equal(ui.resizeObservers.some(observer => observer.targets.has(ui.headerCell)), false, "Virtual header cells are not stable layout boundaries");
  assert.equal(ui.resizeObservers.some(observer => observer.targets.has(ui.track)), false, "Writing the external scrollbar width must not observe itself and feed back");
});

test("model width stays authoritative during DOM virtualization and real column changes clamp the range", () => {
  const ui = harness();
  ui.external(700);
  ui.viewport.scrollWidth = 2100;
  ui.geometry(); ui.flush();
  assert.equal(ui.track.getAttribute("aria-valuemax"), "800");
  assert.equal(ui.viewport.scrollLeft, 700);
  ui.setWidth(900);
  ui.geometry(); ui.flush();
  assert.equal(ui.track.getAttribute("aria-valuemax"), "300");
  assert.equal(ui.spacer.style.width, "900px");
  assert.equal(ui.viewport.scrollLeft, 300, "A smaller model range wins before AG Grid shrinks its virtual DOM");
  assert.equal(ui.track.scrollLeft, 300);
  ui.setWidth(1700); ui.geometry(); ui.flush();
  assert.equal(ui.track.getAttribute("aria-valuemax"), "1100");
  ui.external(900);
  assert.equal(ui.viewport.scrollLeft, 900);
  ui.setWidth(500); ui.geometry(); ui.flush();
  assert.equal(ui.track.getAttribute("aria-valuemax"), "0");
  assert.equal(ui.viewport.scrollLeft, 0);
  assert.equal(ui.horizontal, false);
});

test("queued viewport and external events cannot undo newer input on the other scrollbar", () => {
  const ui = harness();
  ui.external(200);
  ui.track.scrollLeft = 560;
  ui.viewport.dispatch("scroll");
  assert.equal(ui.viewport.scrollLeft, 560);
  assert.equal(ui.track.scrollLeft, 560);
  ui.track.dispatch("scroll");
  assert.equal(ui.viewport.scrollLeft, 560);
  ui.viewport.scrollLeft = 620;
  ui.track.dispatch("scroll");
  assert.equal(ui.track.scrollLeft, 620);
  assert.equal(ui.viewport.scrollLeft, 620);
  ui.track.scrollLeft = 710;
  ui.geometry(); ui.flush();
  assert.equal(ui.viewport.scrollLeft, 710, "A geometry pass must also respect pending page-control input when no clamp is needed");
  assert.equal(ui.track.getAttribute("aria-valuenow"), "710");
});

test("native tables retain DOM width fallback and observe a table mounted after loading", () => {
  const ui = harness({ native: true });
  assert.equal(ui.track.getAttribute("aria-valuemax"), "1000");
  ui.external(700);
  ui.viewport.scrollWidth = 900;
  ui.geometry(); ui.flush();
  assert.equal(ui.track.getAttribute("aria-valuemax"), "300");
  assert.equal(ui.viewport.scrollLeft, 300);
  const table = ui.mountTable();
  ui.geometry(); ui.flush();
  assert.equal(ui.resizeObservers.some(observer => observer.targets.has(table)), true);
  table.remove(); ui.geometry(); ui.flush();
  assert.equal(ui.resizeObservers.some(observer => observer.targets.has(table)), false);
  ui.setHeight(2500); ui.resize(); ui.flush();
  assert.equal(ui.stage.style.height, "2600px");
  assert.equal(ui.metrics.modelWidth, 0);
});

test("the actual AG source measures displayed column models and subscribes only to real geometry events", () => {
  const ui = harness({ ag: true });
  assert.equal(ui.sourceProps.getHorizontalContentWidth(), 1165, "Pinned and off-screen displayed columns plus the native rail determine the total width");
  ui.viewport.scrollWidth = 4200;
  assert.equal(ui.sourceProps.getHorizontalContentWidth(), 1165);
  assert.equal(ui.track.getAttribute("aria-valuemax"), "565");
  for (const event of ["virtualColumnsChanged", "bodyScrollEnd"]) {
    assert.equal(ui.apiListeners.get(event)?.size ?? 0, 0, `${event} is scrolling work, not a page resize`);
    ui.emit(event);
    assert.equal(ui.frames.size, 0);
  }
  for (const event of ["columnResized", "displayedColumnsChanged", "gridSizeChanged", "modelUpdated", "rowDataUpdated", "firstDataRendered"]) assert.ok(ui.apiListeners.get(event)?.size, event);
  ui.columns[2].hidden = true;
  ui.emit("displayedColumnsChanged"); ui.flush();
  assert.equal(ui.track.getAttribute("aria-valuemax"), "0");
  ui.columns[2].hidden = false; ui.columns[2].width = 900;
  ui.emit("columnResized"); ui.flush();
  assert.equal(ui.track.getAttribute("aria-valuemax"), "765");
  ui.columns[0].width = 600;
  assert.equal(ui.sourceProps.getHorizontalContentWidth(), 0, "A viewport entirely occupied by pinned columns has no movable horizontal pane");
});

test("overlay scrollbar hitboxes add no layout gap while a visible configured rail reserves only its configured width", () => {
  for (const { configured, overlay, expected } of [
    { configured: 0, overlay: true, expected: 1150 },
    { configured: undefined, overlay: true, expected: 1150 },
    { configured: 7, overlay: true, expected: 1157 },
    { configured: 7, overlay: false, expected: 1157 },
    { configured: undefined, overlay: false, expected: 1166 },
  ]) {
    const ui = harness({ ag: true });
    ui.rail.rect.width = 16;
    ui.rail.className = `ag-body-vertical-scroll${overlay ? " ag-scrollbar-invisible" : ""}`;
    ui.setScrollbarWidth(configured);
    ui.emit("gridSizeChanged"); ui.flush();
    assert.equal(ui.sourceProps.getHorizontalContentWidth(), expected, `configured=${configured}, overlay=${overlay}`);
    assert.equal(ui.track.getAttribute("aria-valuemax"), String(expected - 600));
    ui.rail.rect.width = 0;
    ui.emit("gridSizeChanged"); ui.flush();
    assert.equal(ui.sourceProps.getHorizontalContentWidth(), 1150, "A hidden rail reserves no width even when a positive scrollbar width is configured");
  }
  const ui = harness({ ag: true });
  ui.rail.rect.width = 16;
  ui.rail.className += " ag-scrollbar-invisible";
  ui.setScrollbarWidth(0);
  ui.columns[0].width = 540;
  assert.equal(ui.sourceProps.getHorizontalContentWidth(), 1590, "An overlay hitbox must not falsely classify the remaining movable pane as fully pinned");
});

test("keyboard controls preserve exact offsets and cleanup cancels stale layout work and restores markers", () => {
  for (const oldMarkers of [false, true]) {
    const ui = harness({ oldMarkers });
    assert.equal(ui.key("End"), true);
    assert.equal(ui.viewport.scrollLeft, 800);
    ui.key("ArrowLeft");
    assert.equal(ui.viewport.scrollLeft, 760);
    ui.key("Home");
    assert.equal(ui.viewport.scrollLeft, 0);
    assert.equal(ui.key("Enter"), false);
    ui.geometry();
    const staleFrames = [...ui.frames.values()], staleResize = ui.resizeObservers.map(observer => observer.callback);
    ui.cleanup();
    assert.equal(ui.frames.size, 0);
    assert.equal(ui.resizeObservers.every(observer => observer.disconnected), true);
    for (const target of [ui.root, ui.viewport, ui.track, ui.win]) assert.equal([...target.listeners.values()].every(callbacks => callbacks.size === 0), true);
    assert.equal(ui.metrics.unsubscribed, 1);
    assert.equal(ui.root.id, oldMarkers ? "existing-grid" : "");
    assert.equal(ui.viewport.getAttribute("data-table-page-viewport"), oldMarkers ? "old-viewport" : null);
    assert.equal(ui.rail.getAttribute("data-table-page-native-rail"), oldMarkers ? "old-rail" : null);
    const writes = ui.metrics.styles.length, scrolls = ui.metrics.scrolls.length;
    staleResize.forEach(callback => callback([])); staleFrames.forEach(callback => callback());
    ui.key("End");
    assert.equal(ui.frames.size, 0);
    assert.equal(ui.metrics.styles.length, writes);
    assert.equal(ui.metrics.scrolls.length, scrolls);
  }
});
