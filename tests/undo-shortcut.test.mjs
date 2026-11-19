import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createUndoShortcutController, historyShortcut, isHistoryTextEntryTarget } from "../app/undoShortcut.ts";

const key = (overrides = {}) => ({ key: "z", code: "KeyZ", ctrlKey: true, metaKey: false, defaultPrevented: false, ...overrides });

class Element {
  parentElement = null;
  children = [];
  isConnected = true;
  visible = true;
  visibility = "visible";
  constructor(document, tag = "div", attrs = {}, classes = []) { this.ownerDocument = document; this.tag = tag; this.attrs = attrs; this.classes = new Set(classes); }
  get type() { return this.attrs.type ?? "text"; }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  contains(other) { return other === this || this.children.some(child => child.contains(other)); }
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
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  getClientRects() { return this.isConnected && this.visible && (!this.parentElement || this.parentElement.getClientRects().length) ? [{}] : []; }
}

function harness() {
  const listeners = new Map();
  const doc = {
    addEventListener(name, callback, capture = false) { const id = `${name}:${capture}`; if (!listeners.has(id)) listeners.set(id, new Set()); listeners.get(id).add(callback); },
    removeEventListener(name, callback, capture = false) { listeners.get(`${name}:${capture}`)?.delete(callback); },
    defaultView: { getComputedStyle: element => ({ visibility: element.visibility }) },
  };
  doc.body = new Element(doc, "body");
  doc.activeElement = doc.body;
  doc.querySelectorAll = selector => doc.body.querySelectorAll(selector);
  const controller = createUndoShortcutController(doc);
  const create = (parent = doc.body, tag, attrs, classes) => parent.append(new Element(doc, tag, attrs, classes));
  const event = (target = doc.body, overrides) => ({ ...key(overrides), target, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } });
  const fire = (target, overrides) => { const value = event(target, overrides); for (const listener of [...listeners.get("keydown:false") ?? []]) listener(value); return value; };
  const focus = target => { doc.activeElement = target; for (const listener of [...listeners.get("focusin:true") ?? []]) listener({ target }); };
  const pointer = target => { for (const listener of [...listeners.get("pointerdown:true") ?? []]) listener({ target }); };
  const owner = (root = create(), options = {}) => {
    const state = { root, undos: 0, redos: 0, canUndo: true, canRedo: true, disabled: false, ...options };
    state.unregister = controller.register({ root: () => state.root, undo: () => { state.undos++; return state.onUndo?.(); }, redo: () => state.redos++,
      canUndo: () => state.canUndo, canRedo: () => state.canRedo, disabled: () => state.disabled });
    return state;
  };
  return { doc, controller, create, event, fire, focus, pointer, owner, listeners };
}

test("undo and redo recognize Windows/macOS keys and Russian layout without Alt or composition", () => {
  for (const overrides of [{}, { ctrlKey: false, metaKey: true }, { key: "я" }, { key: "Я", code: undefined }, { key: "z", code: "Unidentified" }]) assert.equal(historyShortcut(key(overrides)), "undo");
  for (const overrides of [{ shiftKey: true }, { code: "KeyY", key: "y" }, { code: undefined, key: "н" }, { code: undefined, key: "Н" }]) assert.equal(historyShortcut(key(overrides)), "redo");
  for (const overrides of [{ altKey: true }, { isComposing: true }, { defaultPrevented: true }, { ctrlKey: false }, { code: "KeyA", key: "a" }]) assert.equal(historyShortcut(key(overrides)), null);
});

test("one central listener dispatches once to the nearest nested owner", () => {
  const ui = harness(), master = ui.owner(), detail = ui.owner(ui.create(master.root)), cell = ui.create(detail.root);
  assert.equal(ui.listeners.get("keydown:false").size, 1);
  const event = ui.fire(cell);
  assert.equal(detail.undos, 1); assert.equal(master.undos, 0); assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.equal(ui.controller.dispatch(event), false, "React capture + document bubble cannot undo twice");
  ui.fire(master.root, { shiftKey: true }); assert.equal(master.redos, 1); assert.equal(detail.redos, 0);
});

test("focus and pointer history route shortcuts from the footer or blank page", () => {
  const ui = harness(), first = ui.owner(), second = ui.owner(), footer = ui.create(undefined, "button");
  ui.focus(first.root); ui.focus(footer); ui.fire(footer); assert.equal(first.undos, 1); assert.equal(second.undos, 0);
  ui.pointer(second.root); ui.fire(); assert.equal(second.undos, 1); assert.equal(first.undos, 1);
});

test("an empty, disabled or busy current owner never falls back to another table", async () => {
  for (const options of [{ canUndo: false }, { disabled: true }]) {
    const ui = harness(), first = ui.owner(), second = ui.owner(undefined, options);
    ui.pointer(first.root); const event = ui.fire(second.root);
    assert.equal(first.undos, 0); assert.equal(second.undos, 0); assert.equal(event.defaultPrevented, false);
  }
  const ui = harness(); let finish;
  const active = ui.owner(undefined, { onUndo: () => new Promise(resolve => { finish = resolve; }) });
  ui.fire(active.root); ui.fire(active.root); assert.equal(active.undos, 1);
  finish(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  ui.fire(active.root); assert.equal(active.undos, 2);
});

test("disconnected, hidden and inert roots cannot receive undo; cleanup removes listeners", () => {
  for (const hide of [root => { root.isConnected = false; }, root => { root.visible = false; }, root => { root.visibility = "hidden"; }, root => { root.attrs.inert = ""; }, root => { root.attrs["aria-hidden"] = "true"; }]) {
    const ui = harness(), owner = ui.owner(); hide(owner.root); ui.fire(); assert.equal(owner.undos, 0);
    owner.unregister(); assert.equal(ui.listeners.get("keydown:false").size, 0); assert.equal(ui.listeners.get("focusin:true").size, 0); assert.equal(ui.listeners.get("pointerdown:true").size, 0);
  }
});

test("text editors keep native undo while checkbox, radio, button and closed select undo the draft", () => {
  for (const [tag, attrs] of [["input", {}], ["input", { type: "number" }], ["textarea", {}], ["div", { contenteditable: "true" }], ["div", { role: "textbox" }]]) {
    const ui = harness(), owner = ui.owner(), input = ui.create(owner.root, tag, attrs);
    assert.equal(isHistoryTextEntryTarget(input), true); ui.focus(input); ui.fire(input); assert.equal(owner.undos, 0);
  }
  for (const [tag, attrs] of [["input", { type: "checkbox" }], ["input", { type: "radio" }], ["button", {}], ["select", {}], ["button", { role: "combobox" }]]) {
    const ui = harness(), owner = ui.owner(), input = ui.create(owner.root, tag, attrs);
    assert.equal(isHistoryTextEntryTarget(input), false); ui.focus(input); ui.fire(input); assert.equal(owner.undos, 1);
  }
});

test("menus and popup editors own their keyboard before underlying history", () => {
  for (const options of [{ attrs: { role: "menu" } }, { attrs: { role: "listbox" } }, { classes: ["ag-popup-child"] }, { classes: ["ag-popup-editor"] }, { classes: ["custom-select-menu"] }, { classes: ["report-date-calendar"] }]) {
    const ui = harness(), owner = ui.owner();
    const popup = ui.create(undefined, "div", options.attrs, options.classes);
    ui.fire(owner.root); assert.equal(owner.undos, 0); popup.visible = false;
    ui.fire(owner.root); assert.equal(owner.undos, 1);
  }
});

test("modal history can undo its own draft but cannot mutate a table behind it", () => {
  const ui = harness(), table = ui.owner();
  ui.focus(table.root);
  const dialog = ui.create(undefined, "div", { role: "dialog", "aria-modal": "true" });
  ui.fire(table.root); assert.equal(table.undos, 0);
  const form = ui.owner(ui.create(dialog)), checkbox = ui.create(form.root, "input", { type: "checkbox" });
  ui.focus(checkbox); ui.fire(checkbox); assert.equal(form.undos, 1); assert.equal(table.undos, 0);
  dialog.visible = false; ui.focus(table.root); ui.fire(table.root); assert.equal(table.undos, 1);
});

test("a nonregistered read-only table blocks stale focus and history from a different table", () => {
  const ui = harness(), owner = ui.owner(), readonly = ui.create(undefined, "table"), cell = ui.create(readonly, "td");
  ui.focus(owner.root); ui.fire(cell); assert.equal(owner.undos, 0);
});

test("cancelled and composing shortcuts never reach a registered owner", () => {
  const ui = harness(), owner = ui.owner();
  for (const options of [{ defaultPrevented: true }, { isComposing: true }, { altKey: true }, { metaKey: false, ctrlKey: false }]) ui.fire(owner.root, options);
  assert.equal(owner.undos, 0);
});

test("the React hook updates callbacks without multiplying listeners and unregisters on unmount", async () => {
  const ui = harness();
  const paths = ["undoShortcut.ts", "useUndoShortcut.ts"];
  const fragments = await Promise.all(paths.map(async path => {
    const text = await readFile(new URL(`../app/${path}`, import.meta.url), "utf8");
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    return file.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(file).replace(/^export\s+/, "")).join("\n");
  }));
  const compiled = ts.transpileModule(fragments.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const slots = []; let cursor = 0;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const useRef = value => { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; };
  const useEffect = (callback, deps) => { const index = cursor++; if (!same(slots[index]?.deps, deps)) { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; } };
  const code = new Function("document", "useRef", "useEffect", "useLayoutEffect", `${compiled}; return { useUndoShortcut, dispatchUndoShortcut };`)(ui.doc, useRef, useEffect, useEffect);
  const rootRef = { current: ui.create() }; let first = 0, second = 0;
  const render = options => { cursor = 0; code.useUndoShortcut({ rootRef, ...options }); };
  render({ undo: () => first++ });
  ui.fire(rootRef.current); assert.equal(first, 1);
  render({ undo: () => second++ });
  const event = ui.event(rootRef.current);
  assert.equal(code.dispatchUndoShortcut(event), true);
  ui.fire(rootRef.current, { defaultPrevented: true });
  assert.equal(first, 1); assert.equal(second, 1); assert.equal(ui.listeners.get("keydown:false").size, 1);
  for (const slot of slots) slot.cleanup?.();
  assert.equal(ui.listeners.get("keydown:false").size, 0);
  assert.equal(code.dispatchUndoShortcut(ui.event(rootRef.current)), false);
});
