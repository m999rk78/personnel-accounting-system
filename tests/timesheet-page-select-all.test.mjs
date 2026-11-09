import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function moduleCode(path) {
  const text = await readFile(new URL(path, import.meta.url), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map(node => node.getText(source).replace(/^export\s+/, "")).join("\n");
  return ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const code = (await Promise.all([
  "../app/tableSelectAllShortcut.ts", "../app/tablePageSelectAll.ts", "../app/useTablePageSelectAll.ts",
].map(moduleCode))).join("\n");

class ElementFixture {
  constructor(document, { tag = "div", type = "text", parent = null, attributes = {}, classes = [], visible = true, connected = true, visibility = "visible" } = {}) {
    Object.assign(this, { ownerDocument: document, tag, type, parent, attributes, classes: new Set(classes), visible, isConnected: connected, visibility, focusCalls: [] });
  }
  matches(selector) {
    if (selector === "[contenteditable]:not([contenteditable='false'])") return "contenteditable" in this.attributes && this.attributes.contenteditable !== "false";
    if (selector.startsWith(".")) return this.classes.has(selector.slice(1));
    if (selector === "dialog[open]") return this.tag === "dialog" && "open" in this.attributes;
    const attribute = selector.match(/^\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\]$/);
    if (attribute) return attribute[2] === undefined ? attribute[1] in this.attributes : this.attributes[attribute[1]] === attribute[2];
    return selector === this.tag;
  }
  closest(selectors) {
    return selectors.split(",").some(selector => this.matches(selector.trim())) ? this : this.parent?.closest(selectors) ?? null;
  }
  contains(target) { for (let element = target; element; element = element.parent) if (element === this) return true; return false; }
  getClientRects() { return this.visible && this.isConnected ? [{ x: 10, y: 20, width: 900, height: 700 }] : []; }
  focus(options) { this.focusCalls.push(options); this.ownerDocument.activeElement = this; }
}

/** This only provides DOM ownership, focus and event bubbling boundaries. The
 * production guard and hook run unchanged; no browser, backend or real data. */
function harness(options = {}) {
  const listeners = new Map(), registrations = [], overlays = [], selected = [];
  let selectionCleared = 0, pending = [], cleanups = [];
  const document = {
    defaultView: { getComputedStyle: element => ({ visibility: element.visibility }) },
    querySelectorAll: selectors => overlays.filter(element => selectors.split(",").some(selector => element.matches(selector.trim()))),
    getSelection: () => ({ removeAllRanges: () => selectionCleared++ }),
    addEventListener(type, callback, capture) {
      const entries = listeners.get(type) ?? new Set(); entries.add(callback); listeners.set(type, entries);
      registrations.push({ type, capture: typeof capture === "boolean" ? capture : Boolean(capture?.capture) });
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
  };
  const body = new ElementFixture(document, { tag: "body" });
  document.activeElement = body;
  const root = new ElementFixture(document, { parent: body, attributes: { role: "application" } });
  const settings = { rootRef: { current: root }, selectAll: () => { selected.push("headers-and-visible-data"); return true; }, ...options };
  const environment = { Element: ElementFixture, document, useEffect: callback => pending.push(callback) };
  const actual = new Function(...Object.keys(environment), `${code};return { shouldUseTablePageSelectAll, useTablePageSelectAll };`)(...Object.values(environment));
  const mount = () => {
    cleanups.forEach(cleanup => cleanup?.()); pending = [];
    actual.useTablePageSelectAll(settings); cleanups = pending.map(callback => callback());
  };
  const unmount = () => { cleanups.forEach(cleanup => cleanup?.()); cleanups = []; };
  const element = attributes => new ElementFixture(document, { parent: body, ...attributes });
  const event = fields => ({ target: body, key: "a", code: "KeyA", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...fields });
  const emit = fields => { const key = event(fields); for (const callback of listeners.get("keydown") ?? []) callback(key); return key; };
  return { body, root, document, settings, selected, overlays, registrations, listeners, element, event, emit, mount, unmount,
    guard: actual.shouldUseTablePageSelectAll, get selectionCleared() { return selectionCleared; } };
}

test("page-entry Ctrl+A and Cmd+A select the visible timesheet without a prior table click or page scrolling", () => {
  for (const keys of [{}, { ctrlKey: false, metaKey: true }, { key: "ф", code: "KeyA" }]) {
    const ui = harness(); ui.mount();
    assert.equal(ui.document.activeElement, ui.body, "the table has never received focus");
    const key = ui.emit(keys);
    assert.equal(key.defaultPrevented, true); assert.equal(key.stopped, true);
    assert.deepEqual(ui.selected, ["headers-and-visible-data"]);
    assert.deepEqual(ui.root.focusCalls, [{ preventScroll: true }]);
    assert.equal(ui.selectionCleared, 1, "any native whole-page text selection is cleared");
    assert.equal(ui.document.activeElement, ui.root, "the following native copy event belongs to the timesheet");
    assert.deepEqual(ui.registrations, [{ type: "keydown", capture: false }], "local grid and control handling runs first");
  }
});

test("page-level Ctrl+A leaves editor, search, popup targets and focused text fields in control", () => {
  for (const attributes of [
    { tag: "input", type: "text" }, { tag: "input", type: "search" }, { tag: "textarea" }, { tag: "select" },
    { attributes: { contenteditable: "" } }, { attributes: { role: "textbox" } }, { attributes: { role: "searchbox" } },
    { attributes: { role: "combobox" } }, { classes: ["custom-select-menu"] }, { classes: ["table-context-menu"] },
  ]) {
    const ui = harness(); ui.mount(); const target = ui.element(attributes);
    const key = ui.emit({ target });
    assert.equal(key.defaultPrevented, false); assert.deepEqual(ui.selected, []); assert.equal(ui.selectionCleared, 0);
    ui.document.activeElement = target;
    assert.equal(ui.emit().defaultPrevented, false, "a focused editor owns the shortcut even if the event retargets to body");
    assert.deepEqual(ui.root.focusCalls, []);
  }
});

test("visible dialogs and menus block the page shortcut; closed, hidden and disconnected overlays do not", () => {
  for (const attributes of [
    { tag: "dialog", attributes: { open: "" } }, { attributes: { role: "dialog" } }, { attributes: { role: "alertdialog" } },
    { attributes: { "aria-modal": "true" } }, { attributes: { role: "menu" } }, { attributes: { role: "listbox" } },
    { classes: ["ag-popup-child"] }, { classes: ["ag-menu"] }, { classes: ["custom-select-menu"] }, { classes: ["table-context-menu"] },
  ]) {
    const ui = harness(); ui.mount(); const popup = ui.element(attributes); ui.overlays.push(popup);
    assert.equal(ui.emit().defaultPrevented, false); assert.deepEqual(ui.selected, []);
    popup.visible = false;
    assert.equal(ui.guard(ui.event(), ui.root), true, "a display:none popup is not an active owner");
    popup.visible = true; popup.visibility = "hidden";
    assert.equal(ui.guard(ui.event(), ui.root), true);
    popup.visibility = "visible"; popup.isConnected = false;
    assert.equal(ui.guard(ui.event(), ui.root), true);
  }
  const ui = harness(); ui.mount(); ui.overlays.push(ui.element({ tag: "dialog" }));
  assert.equal(ui.emit().defaultPrevented, true, "an unopened native dialog does not block the table");
});

test("another table owns its shortcut and already-handled local events cannot select the timesheet again", () => {
  for (const attributes of [{ tag: "table" }, { attributes: { role: "grid" } }, { attributes: { role: "treegrid" } }, { attributes: { role: "application" } }]) {
    const ui = harness(); ui.mount();
    const other = ui.element(attributes), target = ui.element({ tag: "button", parent: other });
    assert.equal(ui.emit({ target }).defaultPrevented, false); assert.deepEqual(ui.selected, []);
  }
  const ui = harness(); ui.mount();
  const ownTable = ui.element({ tag: "table", parent: ui.root }), ownCell = ui.element({ tag: "td", parent: ownTable });
  assert.equal(ui.emit({ target: ownCell, defaultPrevented: true }).defaultPrevented, true);
  assert.deepEqual(ui.selected, [], "a local selection handler has priority over the document listener");
  assert.equal(ui.emit({ target: ownCell }).defaultPrevented, true);
  assert.equal(ui.selected.length, 1);
});

test("the page shortcut ignores hidden, inert, disconnected, disabled or not-yet-mounted tables", () => {
  for (const patch of [{ visible: false }, { isConnected: false }, { visibility: "hidden" }, { visibility: "collapse" },
    { attributes: { hidden: "" } }, { attributes: { inert: "" } }, { attributes: { "aria-hidden": "true" } }]) {
    const ui = harness(); Object.assign(ui.root, patch); ui.mount();
    assert.equal(ui.emit().defaultPrevented, false); assert.deepEqual(ui.selected, []);
  }
  const ancestor = harness(); ancestor.body.attributes.inert = ""; ancestor.mount();
  assert.equal(ancestor.emit().defaultPrevented, false, "an inert ancestor also disables the table");
  const disabled = harness({ enabled: false }); disabled.mount(); assert.equal(disabled.emit().defaultPrevented, false); assert.deepEqual(disabled.selected, []);
  const late = harness(); late.settings.rootRef.current = null; late.mount();
  assert.equal(late.emit().defaultPrevented, false);
  late.settings.rootRef.current = late.root;
  assert.equal(late.emit().defaultPrevented, true, "a table mounted after initial loading works without a click or listener reinstall");
});

test("unsuccessful selection and unrelated keys retain native behavior; cleanup leaves no duplicate global listeners", () => {
  const rejected = harness({ selectAll: () => false }); rejected.mount();
  assert.equal(rejected.emit().defaultPrevented, false); assert.equal(rejected.selectionCleared, 0); assert.deepEqual(rejected.root.focusCalls, []);
  const ui = harness(); ui.mount();
  for (const fields of [{ ctrlKey: false }, { key: "c", code: "KeyC" }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
    const key = ui.emit(fields); assert.equal(key.defaultPrevented, Boolean(fields.defaultPrevented));
  }
  assert.deepEqual(ui.selected, []);
  ui.mount(); assert.equal(ui.listeners.get("keydown").size, 1);
  assert.equal(ui.emit().defaultPrevented, true); assert.equal(ui.selected.length, 1);
  ui.settings.enabled = false; ui.mount(); assert.equal(ui.listeners.get("keydown").size, 0);
  ui.settings.enabled = true; ui.mount(); ui.unmount();
  assert.equal(ui.emit().defaultPrevented, false); assert.equal(ui.selected.length, 1);
});

test("the shared native-timesheet hook delegates its page shortcut to the same header-inclusive selector", async () => {
  const source = ts.createSourceFile("useTimesheetClipboard.ts", await readFile(new URL("../app/useTimesheetClipboard.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let options;
  function visit(node) { if (ts.isCallExpression(node) && node.expression.getText(source) === "useTablePageSelectAll") options = node.arguments[0]; ts.forEachChild(node, visit); }
  visit(source); assert.ok(options);
  const expression = ts.transpileModule(`return (${options.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const escapeBlocked of [false, true]) {
    const shellRef = { current: {} }, selectAllCells = () => true;
    const configured = new Function("shellRef", "selectAllCells", "escapeBlocked", expression)(shellRef, selectAllCells, escapeBlocked);
    assert.equal(configured.rootRef, shellRef); assert.equal(configured.selectAll, selectAllCells); assert.equal(configured.enabled, !escapeBlocked);
  }
});
