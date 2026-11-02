import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Execute the actual hook callbacks with native events. React state and DOM layout
// are irrelevant here; the event target must survive bubbling from an editor.
const path = new URL("../app/useTimesheetClipboard.ts", import.meta.url);
const source = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
const declarations = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "isTimesheetInputTarget") declarations.set(node.name.text, node.getText(source));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["onCopy", "onClipboardPaste", "onKeyDown"].includes(node.name.text)) {
    declarations.set(node.name.text, node.initializer.arguments[0].getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(declarations.size, 4, "All actual editor event handlers must be covered");
const js = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

class ElementTarget extends EventTarget {
  constructor(selector, parent = null) { super(); this.selector = selector; this.parent = parent; }
  closest(selector) {
    if (selector.split(",").map(value => value.trim()).includes(this.selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }
}

function harness() {
  const calls = { paste: [], copy: [], focus: [], activate: [], type: [], clear: 0, delete: 0, undo: 0 };
  const anchor = {};
  const scope = {
    Element: ElementTarget,
    selectionRef: { current: { end: { rowIndex: 1, columnIndex: 2 } } },
    selectionBounds: () => ({ rowStart: 1, rowEnd: 1, columnStart: 2, columnEnd: 2 }),
    selectedText: () => "8",
    setStatus() {},
    pasteText: async value => { calls.paste.push(value); return 1; },
    clearSelection: () => { calls.clear++; },
    deleteSelection: async () => { calls.delete++; },
    focusSelection: (...args) => calls.focus.push(args),
    onActivate: (...args) => calls.activate.push(args),
    onType: (...args) => calls.type.push(args),
    shellRef: { current: { querySelector: () => anchor } },
    undoLastChange: async () => { calls.undo++; },
  };
  const handlers = new Function(...Object.keys(scope), `${js(declarations.get("isTimesheetInputTarget"))}
    return {
      copy: ${js(`const callback = ${declarations.get("onCopy")}`).replace(/^const callback = /, "").trim().replace(/;$/, "")},
      paste: ${js(`const callback = ${declarations.get("onClipboardPaste")}`).replace(/^const callback = /, "").trim().replace(/;$/, "")},
      keydown: ${js(`const callback = ${declarations.get("onKeyDown")}`).replace(/^const callback = /, "").trim().replace(/;$/, "")}
    };`)(...Object.values(scope));
  function event(type, fields = {}) {
    return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      clipboardData: { getData: () => "99", setData: (...args) => calls.copy.push(args) },
      ...fields,
    });
  }
  async function bubble(target, inputEvent, nativeDefault) {
    const pending = [];
    const delegated = event => { pending.push(Promise.resolve(handlers[event.type](event))); };
    target.addEventListener(inputEvent.type, delegated);
    target.dispatchEvent(inputEvent);
    target.removeEventListener(inputEvent.type, delegated);
    if (!inputEvent.defaultPrevented) nativeDefault?.();
    await Promise.all(pending);
    return inputEvent;
  }
  return { calls, event, bubble };
}

test("pasting and copying in every editor kind keeps native text editing, including nested targets", async () => {
  for (const selector of ["input", "textarea", "select", "[contenteditable='true']", "[role='textbox']", "[role='combobox']"]) {
    const env = harness();
    const editor = new ElementTarget(selector);
    const nested = new ElementTarget("span", editor);
    let buffer = "";
    for (const target of [editor, nested]) {
      const paste = await env.bubble(target, env.event("paste"), () => { buffer = "99"; });
      assert.equal(paste.defaultPrevented, false, selector);
      let nativeCopy = 0;
      const copy = await env.bubble(target, env.event("copy"), () => nativeCopy++);
      assert.equal(copy.defaultPrevented, false, selector);
      assert.equal(nativeCopy, 1);
    }
    assert.equal(buffer, "99", "The pasted invalid value remains in the input for validation and correction");
    assert.deepEqual(env.calls.paste, [], "Editor paste must never call the table mutation callback");
    assert.deepEqual(env.calls.copy, [], "Editor copy must not replace selected input text with a saved cell value");
  }
});

test("editor keyboard events cannot activate, clear, move or delete the table selection", async () => {
  const env = harness();
  const input = new ElementTarget("input");
  let nativeKeys = 0;
  for (const key of ["Enter", "F2", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete", "Backspace", "9", "z"]) {
    const event = await env.bubble(input, env.event("keydown", { key, ctrlKey: key === "z" }), () => nativeKeys++);
    assert.equal(event.defaultPrevented, false, key);
  }
  assert.equal(nativeKeys, 11);
  assert.deepEqual(env.calls, { paste: [], copy: [], focus: [], activate: [], type: [], clear: 0, delete: 0, undo: 0 });
});

test("clipboard and keyboard shortcuts on table cells retain their existing behavior", async () => {
  const env = harness();
  const cell = new ElementTarget("td");
  assert.equal((await env.bubble(cell, env.event("paste"))).defaultPrevented, true);
  assert.deepEqual(env.calls.paste, ["99"]);
  assert.equal((await env.bubble(cell, env.event("copy"))).defaultPrevented, true);
  assert.deepEqual(env.calls.copy, [["text/plain", "8"]]);
  await env.bubble(cell, env.event("keydown", { key: "ArrowDown" }));
  assert.deepEqual(env.calls.focus[0][0], { rowIndex: 2, columnIndex: 2 });
  await env.bubble(cell, env.event("keydown", { key: "Enter" }));
  assert.equal(env.calls.activate.length, 1);
  await env.bubble(cell, env.event("keydown", { key: "Delete" }));
  assert.equal(env.calls.delete, 1);
  await env.bubble(cell, env.event("keydown", { key: "z", metaKey: true }));
  assert.equal(env.calls.undo, 1);
});
