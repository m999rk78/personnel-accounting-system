import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Exercise the real dispatcher, eligibility guard and hook together. Only the
// DOM/React lifecycle and AG's API boundary are replaced; no database is used.
const source = await Promise.all(["useTableEscapeSelection.ts", "tableFilterEscape.ts", "useGridFilterEscape.ts"].map(async name => {
  const path = new URL(`../app/${name}`, import.meta.url);
  const file = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
  return file.statements.filter(statement => !ts.isImportDeclaration(statement))
    .map(statement => statement.getText(file).replace(/^export\s+/, "")).join("\n");
}));
const compiled = ts.transpileModule(source.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

class Events {
  listeners = new Map();
  addEventListener(name, callback, capture = false) {
    const key = `${name}:${Boolean(capture)}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(callback);
  }
  removeEventListener(name, callback, capture = false) { this.listeners.get(`${name}:${Boolean(capture)}`)?.delete(callback); }
  emit(name, event, capture = true) { for (const callback of [...this.listeners.get(`${name}:${capture}`) ?? []]) callback(event); }
  count(name, capture = true) { return this.listeners.get(`${name}:${capture}`)?.size ?? 0; }
}

class FakeNode {
  parentElement = null;
  children = [];
  connected = true;
  get isConnected() { return this.connected && (!this.parentElement || this.parentElement.isConnected); }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
}
class FakeElement extends FakeNode {
  constructor(tag = "div", { classes = [], attrs = {}, visible = true, visibility = "visible" } = {}) {
    super(); this.tag = tag; this.attrs = attrs; this.classes = new Set(classes); this.visible = visible; this.visibility = visibility;
    this.classList = { contains: name => this.classes.has(name), add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
  }
  get type() { return this.attrs.type ?? "text"; }
  matches(selector) {
    return selector.split(",").some(part => {
      let query = part.trim();
      const excluded = query.match(/:not\(([^)]+)\)/)?.[1];
      if (excluded && this.matches(excluded)) return false;
      query = query.replace(/:not\([^)]+\)/g, "");
      const tag = query.match(/^[a-z]+/i)?.[0];
      if (tag && tag !== this.tag) return false;
      if ([...query.matchAll(/\.([\w-]+)/g)].some(match => !this.classes.has(match[1]))) return false;
      return [...query.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]+)['"]?)?\]/g)]
        .every(([, name, value]) => Object.hasOwn(this.attrs, name) && (value === undefined || this.attrs[name] === value));
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) && child.isConnected ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getClientRects() {
    return this.isConnected && this.visible && !this.closest("[hidden]") && (!this.parentElement || this.parentElement.getClientRects().length) ? [{}] : [];
  }
  focus() { this.document.activeElement = this; }
}

function harness() {
  const doc = new Events(), view = new Events();
  const resizeCalls = [], constrainCalls = [];
  doc.body = new FakeElement("body"); doc.body.document = doc;
  doc.activeElement = doc.body; doc.defaultView = view;
  doc.querySelectorAll = selector => doc.body.querySelectorAll(selector);
  const create = (parent = doc.body, tag = "div", options) => { const element = new FakeElement(tag, options); element.document = doc; return parent.append(element); };
  const slots = [];
  let cursor = 0;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const useRef = value => { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; };
  const useEffect = (callback, deps) => { const index = cursor++; if (!same(slots[index]?.deps, deps)) { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; } };
  const useCallback = (callback, deps) => { const index = cursor++; if (!same(slots[index]?.deps, deps)) slots[index] = { deps, callback }; return slots[index].callback; };
  const environment = {
    Node: FakeNode, Element: FakeElement, document: doc,
    getComputedStyle: element => ({ visibility: element.visibility }),
    useRef, useEffect, useLayoutEffect: useEffect, useCallback,
    columnFilterVisibility: () => ({ getAnchor: () => null }),
    makeFilterPopupResizable: popup => { resizeCalls.push(["install", popup]); return () => resizeCalls.push(["cleanup", popup]); },
    constrainResizedFilterPopup: popup => { constrainCalls.push(popup); return Boolean(popup.manuallySized); },
  };
  const code = new Function(...Object.keys(environment), `${compiled}; return { createTableFilterEscapeController, useGridFilterEscape, useTableEscapeSelection };`)(...Object.values(environment));
  const controller = code.createTableFilterEscapeController(doc);
  const fire = (name = "keydown", target = doc.body, overrides = {}) => {
    const event = { key: "Escape", target, defaultPrevented: false, stopped: false, ...overrides,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    view.emit(name, event);
    if (!event.stopped) doc.emit(name, event);
    if (!event.stopped) doc.emit(name, event, false);
    return event;
  };
  const owner = (root = create(), filters = true) => {
    const state = { root, filters, editing: false, resets: 0 };
    state.unregister = controller.register({ root: () => state.root, hasFilters: () => state.filters,
      isEditing: () => state.editing, reset: () => { state.resets++; state.filters = false; } });
    return state;
  };
  const renderHook = options => { cursor = 0; return code.useGridFilterEscape(options); };
  return { doc, view, create, fire, owner, renderHook, code, resizeCalls, constrainCalls, cleanup: () => slots.forEach(slot => slot.cleanup?.()) };
}

test("one Escape resets the active table, consumes the event, and the next reaches selection", () => {
  const ui = harness(), table = ui.owner(), cell = ui.create(table.root);
  let selectionClears = 0;
  ui.code.useTableEscapeSelection({ hasSelection: () => true, clearSelection: () => selectionClears++ });
  const first = ui.fire("keydown", cell);
  assert.equal(table.resets, 1); assert.equal(first.defaultPrevented, true); assert.equal(selectionClears, 0);
  ui.fire("keydown", cell);
  assert.equal(table.resets, 1); assert.equal(selectionClears, 1);
});

test("visible filter, calendar, context menu and dialogs own Escape before filter reset", () => {
  for (const options of [
    { classes: ["ag-menu", "ag-filter-menu"] }, { attrs: { role: "dialog" } },
    { attrs: { role: "alertdialog" } }, { attrs: { role: "menu" } }, { attrs: { role: "listbox" } },
    { classes: ["custom-select-menu"] }, { classes: ["ag-popup-editor"] },
  ]) {
    const ui = harness(), table = ui.owner(), popup = ui.create(undefined, "div", options);
    const event = ui.fire("keydown", table.root);
    assert.equal(table.resets, 0); assert.equal(event.defaultPrevented, false);
    popup.connected = false;
    ui.fire("keydown", table.root); assert.equal(table.resets, 1);
  }
});

test("editing input, native editor, and an editor whose focus moved outside preserve filters", () => {
  for (const [tag, options] of [["input", {}], ["textarea", {}], ["select", {}], ["div", { attrs: { contenteditable: "true" } }], ["div", { attrs: { role: "combobox" } }]]) {
    const ui = harness(), table = ui.owner(), input = ui.create(table.root, tag, options);
    ui.fire("keydown", input); assert.equal(table.resets, 0);
  }
  for (const className of ["ag-cell-inline-editing", "timesheet-cell-inline-editor"]) {
    const ui = harness(), table = ui.owner(), editor = ui.create(table.root, "div", { classes: [className] });
    ui.fire(); assert.equal(table.resets, 0);
    editor.connected = false; ui.fire(); assert.equal(table.resets, 1);
  }
  const ui = harness(), table = ui.owner(); table.editing = true;
  ui.fire(); assert.equal(table.resets, 0); table.editing = false; ui.fire(); assert.equal(table.resets, 1);
});

test("nested details win over master and an unfiltered current table never resets another table", () => {
  for (const reverse of [false, true]) {
    const ui = harness(), masterRoot = ui.create(), detailRoot = ui.create(masterRoot);
    const registered = reverse ? [ui.owner(detailRoot), ui.owner(masterRoot)] : [ui.owner(masterRoot), ui.owner(detailRoot)];
    const master = registered.find(owner => owner.root === masterRoot), detail = registered.find(owner => owner.root === detailRoot);
    ui.fire("keydown", ui.create(detailRoot));
    assert.equal(detail.resets, 1); assert.equal(master.resets, 0);
    ui.fire("keydown", detailRoot); assert.equal(master.resets, 0);
    ui.fire("keydown", masterRoot); assert.equal(master.resets, 1);
  }
});

test("focus and most recent table interaction choose an owner when focus is in the toolbar", () => {
  const ui = harness(), first = ui.owner(), second = ui.owner(), toolbar = ui.create();
  ui.fire("keydown", toolbar); assert.equal(first.resets + second.resets, 0, "an ambiguous page never guesses");
  ui.fire("pointerdown", ui.create(second.root));
  ui.fire("keydown", toolbar); assert.equal(second.resets, 1); assert.equal(first.resets, 0);
  ui.fire("focusin", first.root); ui.fire("keydown", toolbar); assert.equal(first.resets, 1);
  first.filters = second.filters = true;
  ui.doc.activeElement = second.root; ui.fire("keydown", toolbar);
  assert.equal(second.resets, 2, "actual focused table takes precedence over an old interaction");
});

test("hidden, detached, null and unregistered roots cannot receive reset", () => {
  for (const hide of [root => { root.attrs["aria-hidden"] = "true"; }, root => { root.attrs.hidden = ""; }, root => { root.visible = false; }, root => { root.visibility = "hidden"; }, root => { root.connected = false; }]) {
    const ui = harness(), table = ui.owner();
    ui.fire("focusin", table.root); hide(table.root); ui.fire(); assert.equal(table.resets, 0);
  }
  const ui = harness(), table = ui.owner(); table.root = null; ui.fire(); assert.equal(table.resets, 0);
  table.unregister(); assert.equal(ui.view.count("keydown"), 0); assert.equal(ui.doc.count("pointerdown"), 0);
  assert.equal(ui.doc.count("focusin"), 0); assert.equal(ui.doc.count("dragstart"), 0);
});

test("repeat, IME, handled events and modifier shortcuts cannot reset filters", () => {
  for (const flags of [{ repeat: true }, { isComposing: true }, { defaultPrevented: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { key: "Enter" }]) {
    const ui = harness(), table = ui.owner(); ui.fire("keydown", table.root, flags); assert.equal(table.resets, 0);
  }
});

test("drag and column resize keep their Escape; drop, dragend and blur release drag ownership", () => {
  for (const end of ["dragend", "drop", "blur"]) {
    const ui = harness(), table = ui.owner();
    ui.fire("dragstart", table.root); ui.fire("keydown", table.root); assert.equal(table.resets, 0);
    if (end === "blur") ui.view.emit("blur", {}, false); else ui.fire(end, table.root);
    ui.fire("keydown", table.root); assert.equal(table.resets, 1);
  }
  const ui = harness(), table = ui.owner(); ui.doc.body.classList.add("timesheet-column-resizing");
  ui.fire(); assert.equal(table.resets, 0); ui.doc.body.classList.remove("timesheet-column-resizing");
  ui.fire(); assert.equal(table.resets, 1);
});

test("AG Grid mouse-driven drag and column resize own Escape without native dragstart", () => {
  for (const className of ["ag-column-resizing", "ag-dnd-ghost"]) {
    const ui = harness(), table = ui.owner(), gesture = ui.create(undefined, "div", { classes: [className] });
    const event = ui.fire("keydown", table.root);
    assert.equal(table.resets, 0); assert.equal(event.defaultPrevented, false);
    gesture.connected = false;
    ui.fire("keydown", table.root); assert.equal(table.resets, 1);
  }
});

function grid(ui) {
  const events = new Events();
  const state = { destroyed: false, filters: { fullName: { filterType: "set", values: ["Сотрудник"] }, hours: { filterType: "number", type: "greaterThan", filter: 4 } }, editing: [], popup: null, calls: [], sort: [{ colId: "hours", sort: "desc" }] };
  const api = {
    addEventListener: (name, callback) => events.addEventListener(name, callback),
    removeEventListener: (name, callback) => events.removeEventListener(name, callback),
    isDestroyed: () => state.destroyed, getFilterModel: () => state.filters, getEditingCells: () => state.editing,
    setFilterModel: value => { state.calls.push(["setFilterModel", value]); state.filters = value ?? {}; },
    doFilterAction: action => state.calls.push(["doFilterAction", action]),
    hideColumnFilter: () => { state.calls.push(["hideColumnFilter"]); if (state.popup) state.popup.connected = false; events.emit("columnMenuVisibleChanged", { visible: false, key: "columnFilter" }, false); },
  };
  const open = (track, anchor, checklist = true) => {
    state.popup = ui.create(undefined, "div", { classes: ["ag-menu", "ag-filter-menu"] });
    if (checklist) ui.create(state.popup, "div", { classes: ["grid-checklist-filter-heading"] });
    track({ api, column: { getColId: () => "fullName" }, ePopup: state.popup, eventSource: anchor }, anchor);
    return ui.create(state.popup, "input");
  };
  return { state, api, open, events };
}

test("popup resize lifecycle cleans up on close and can attach again to a reused popup", () => {
  const ui = harness(), root = ui.create(), anchor = ui.create(root, "button"), ag = grid(ui);
  const track = ui.renderHook({ api: ag.api, getRoot: () => root });
  ag.open(track, anchor);
  const popup = ag.state.popup, params = { api: ag.api, column: { getColId: () => "fullName" }, ePopup: popup };
  track(params, anchor);
  assert.deepEqual(ui.resizeCalls.map(([action]) => action), ["install"], "repeated AG placement must not duplicate the grip");
  ag.api.hideColumnFilter();
  assert.deepEqual(ui.resizeCalls.map(([action]) => action), ["install", "cleanup"]);
  popup.connected = true;
  track(params, anchor);
  assert.deepEqual(ui.resizeCalls.map(([action]) => action), ["install", "cleanup", "install"]);
  ui.cleanup();
  assert.deepEqual(ui.resizeCalls.map(([action]) => action), ["install", "cleanup", "install", "cleanup"]);
  assert.equal(ag.events.count("columnMenuVisibleChanged", false), 0);
});

test("compact condition submenus receive one resize grip and clean up with their owning filter", () => {
  for (const ending of ["close", "unmount"]) {
    const ui = harness(), root = ui.create(), anchor = ui.create(root, "button"), ag = grid(ui);
    const track = ui.renderHook({ api: ag.api, getRoot: () => root });
    ag.open(track, anchor, false);
    const popup = ui.create(undefined, "div", { classes: ["ag-menu"] });
    ui.create(popup, "div", { classes: ["ag-filter-body-wrapper"] });
    const params = { api: ag.api, type: "subMenu", ePopup: popup };
    track(params); track(params);
    assert.deepEqual(ui.resizeCalls.map(([action]) => action), ["install", "install"]);
    assert.equal(ui.resizeCalls[1][1], popup);
    assert.deepEqual(ui.constrainCalls, [popup, popup], "every AG placement must reapply the child popup's chosen geometry");
    if (ending === "close") ag.api.hideColumnFilter(); else ui.cleanup();
    assert.deepEqual(ui.resizeCalls.map(([action]) => action), ["install", "install", "cleanup", "cleanup"]);
    assert.deepEqual(ui.resizeCalls.filter(([action]) => action === "cleanup").map(([, popup]) => popup), [ag.state.popup, popup]);
    ui.cleanup();
    assert.equal(ui.resizeCalls.length, 4, "unmounting a closed filter cannot clean the same grip twice");
  }
});

test("AG's delayed condition-menu positioning reconstrains an already resized child without replacing its grip", () => {
  const ui = harness(), root = ui.create(), anchor = ui.create(root, "button"), ag = grid(ui);
  const track = ui.renderHook({ api: ag.api, getRoot: () => root });
  ag.open(track, anchor, false);
  const child = ui.create(undefined, "div", { classes: ["ag-menu"] });
  ui.create(child, "div", { classes: ["ag-filter-body-wrapper"] });
  const params = { api: ag.api, type: "subMenu", ePopup: child };
  track(params);
  child.manuallySized = true;
  track(params);
  assert.deepEqual(ui.constrainCalls, [child, child]);
  assert.equal(ui.resizeCalls.filter(([action, popup]) => action === "install" && popup === child).length, 1);
  assert.deepEqual(ag.state.calls, [], "positioning a resized condition popup must not apply or cancel its criteria");
  ui.cleanup();
});

test("opening another compact condition popup releases detached child listeners", () => {
  const ui = harness(), root = ui.create(), anchor = ui.create(root, "button"), ag = grid(ui);
  const track = ui.renderHook({ api: ag.api, getRoot: () => root });
  ag.open(track, anchor, false);
  const first = ui.create(undefined, "div", { classes: ["ag-menu"] });
  ui.create(first, "div", { classes: ["ag-filter-body-wrapper"] });
  track({ api: ag.api, type: "subMenu", ePopup: first });
  first.connected = false;
  const next = ui.create(undefined, "div", { classes: ["ag-menu"] });
  ui.create(next, "div", { classes: ["ag-filter-body-wrapper"] });
  track({ api: ag.api, type: "subMenu", ePopup: next });
  assert.deepEqual(ui.resizeCalls.slice(1), [["install", first], ["cleanup", first], ["install", next]]);
  ui.cleanup();
  assert.equal(ui.resizeCalls.filter(([action, popup]) => action === "cleanup" && popup === first).length, 1);
  assert.equal(ui.resizeCalls.filter(([action, popup]) => action === "cleanup" && popup === next).length, 1);
});

test("ordinary option dropdowns, column menus and context menus do not get filter resize controls", () => {
  const ui = harness(), root = ui.create(), ag = grid(ui);
  const track = ui.renderHook({ api: ag.api, getRoot: () => root });
  for (const [type, className] of [["subMenu", "ag-select-list"], ["columnMenu", "ag-menu-list"], ["contextMenu", "ag-filter-body-wrapper"]]) {
    const popup = ui.create(undefined, "div", { classes: ["ag-menu"], attrs: { role: "menu" } });
    ui.create(popup, "div", { classes: [className] });
    track({ api: ag.api, type, ePopup: popup });
  }
  assert.deepEqual(ui.resizeCalls, []);
  ui.cleanup();
});

test("Escape in a separate condition popup or its resize grip belongs to the child before its parent filter", () => {
  const ui = harness(), root = ui.create(), anchor = ui.create(root, "button"), ag = grid(ui);
  const track = ui.renderHook({ api: ag.api, getRoot: () => root });
  const parentInput = ag.open(track, anchor, false);
  // AG's condition wrapper is role=presentation, so the generic menu/dialog
  // exclusions do not identify it. The resize controller's own class does.
  const child = ui.create(undefined, "div", { classes: ["ag-menu", "resizable-filter-popup"], attrs: { role: "presentation" } });
  ui.create(child, "div", { classes: ["ag-filter-body-wrapper"] });
  track({ api: ag.api, type: "subMenu", ePopup: child });
  const childInput = ui.create(child, "input"), grip = ui.create(child, "button", { classes: ["filter-popup-resize-handle"] });
  for (const target of [childInput, grip]) {
    const escape = ui.fire("keydown", target);
    assert.equal(escape.defaultPrevented, false, "the parent's capture handler must leave Escape for AG's child menu");
    assert.deepEqual(ag.state.calls, []);
    assert.equal(ag.state.popup.isConnected, true);
    assert.equal(Object.keys(ag.state.filters).length, 2);
  }
  child.connected = false;
  ui.fire("keydown", parentInput);
  assert.deepEqual(ag.state.calls, [["doFilterAction", { colId: "fullName", action: "cancel" }], ["hideColumnFilter"]]);
  ui.cleanup();
});

test("real hook closes checklist first, restores focus, then clears all column filters without changing sorts", () => {
  const ui = harness(), root = ui.create(), anchor = ui.create(root, "button"), ag = grid(ui);
  const track = ui.renderHook({ api: ag.api, getRoot: () => root });
  const input = ag.open(track, anchor);
  ui.fire("keydown", input);
  assert.equal(ag.state.popup.isConnected, false); assert.equal(ui.doc.activeElement, anchor);
  assert.deepEqual(ag.state.calls, [["hideColumnFilter"]]);
  assert.equal(Object.keys(ag.state.filters).length, 2);
  ui.fire("keydown", anchor, { repeat: true }); assert.equal(ag.state.calls.length, 1);
  ui.fire("keydown", anchor);
  assert.deepEqual(ag.state.calls, [["hideColumnFilter"], ["setFilterModel", null]]);
  assert.deepEqual(ag.state.sort, [{ colId: "hours", sort: "desc" }]);
  ui.cleanup(); assert.equal(ui.view.count("keydown"), 0); assert.equal(ui.doc.count("keydown"), 0);
});

test("full filter cancels only its pending values; a nested picker owns the earlier Escape", () => {
  const ui = harness(), root = ui.create(), anchor = ui.create(root, "button"), ag = grid(ui);
  const track = ui.renderHook({ api: ag.api, getRoot: () => root });
  const input = ag.open(track, anchor, false);
  const picker = ui.create(ag.state.popup, "div", { classes: ["custom-select-toggle"], attrs: { "aria-expanded": "true" } });
  ui.fire("keydown", input); assert.deepEqual(ag.state.calls, []);
  picker.attrs["aria-expanded"] = "false";
  ui.fire("keydown", input);
  assert.deepEqual(ag.state.calls, [["doFilterAction", { colId: "fullName", action: "cancel" }], ["hideColumnFilter"]]);
  assert.equal(Object.keys(ag.state.filters).length, 2);
  ui.fire("keydown", anchor); assert.deepEqual(ag.state.calls.at(-1), ["setFilterModel", null]);
});

test("hook uses its latest root and never queries a destroyed or replaced grid", () => {
  const ui = harness(), firstRoot = ui.create(), nextRoot = ui.create(), old = grid(ui), replacement = grid(ui);
  ui.renderHook({ api: old.api, getRoot: () => firstRoot });
  ui.renderHook({ api: old.api, getRoot: () => nextRoot });
  firstRoot.connected = false; ui.fire("keydown", nextRoot); assert.equal(old.state.calls.length, 1);
  ui.renderHook({ api: replacement.api, getRoot: () => nextRoot });
  ui.fire("keydown", nextRoot); assert.equal(replacement.state.calls.length, 1); assert.equal(old.state.calls.length, 1);
  replacement.state.destroyed = true;
  replacement.api.getFilterModel = () => { throw new Error("destroyed grid cannot be read"); };
  ui.fire("keydown", nextRoot); assert.equal(replacement.state.calls.length, 1);
  ui.cleanup(); assert.equal(ui.view.count("keydown"), 0);
});
