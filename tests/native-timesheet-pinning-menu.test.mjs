import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import ts from "typescript";

async function functionImplementation(file, name, environment) {
  const source = ts.createSourceFile(file, await readFile(new URL(`../app/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration);
  const implementation = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement" },
  }).outputText;
  return new Function(...Object.keys(environment), `${implementation}\nreturn ${name};`)(...Object.values(environment));
}

async function menuHarness(id, initialPin, allowed = () => true) {
  const calls = [], effects = [], states = [];
  let cursor = 0;
  const listeners = new Map();
  const table = {}, trigger = {};
  const header = {
    isConnected: true,
    closest: () => table,
    getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 180, width: 120 }),
    querySelector: selector => selector.includes("data-resize-owner") ? { dataset: { resizeOwner: id } }
      : selector.includes("heading-label") ? { innerText: "Заголовок" } : trigger,
  };
  class ElementMock { closest() { return header; } }
  const root = { querySelector: () => table, contains: () => true, addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: () => {} };
  const pinning = {
    getPin: () => initialPin,
    setPin: (...args) => calls.push(["pin", ...args]),
    canPin: allowed,
    resetPins: () => calls.push(["reset"]),
  };
  const hook = await functionImplementation("useNativeTimesheetColumnMenu.tsx", "useNativeTimesheetColumnMenu", {
    createElement, useCallback: callback => callback,
    useEffect: callback => effects.push(callback),
    useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
    Element: ElementMock, window: { innerWidth: 1200, innerHeight: 900 }, TableContextMenu: () => null,
  });
  const options = { month: "2026-11", scope: "workers:1:2026-11", pinning,
    columns: { canSort: () => true, getSort: () => null, sort: (...args) => calls.push(["sort", ...args]), openFilter: (...args) => calls.push(["filter", ...args]) },
    widths: { autoSize: (...args) => calls.push(["size", ...args]), resetWidths: () => {} },
  };
  const render = () => { cursor = 0; return hook({ current: root }, options); };
  assert.equal(render(), null);
  effects[0]();
  listeners.get("contextmenu")({ target: new ElementMock(), clientX: 150, clientY: 150, preventDefault() {}, stopPropagation() {} });
  return { view: render(), calls, render, options };
}

test("native header menu offers left/right/unpin with the current and locked options disabled", async () => {
  const ui = await menuHarness("department", "left", (_id, side) => side !== "right");
  const submenu = ui.view.props.actions.find(action => action.label === "Закрепить столбец");
  assert.ok(submenu);
  assert.deepEqual(submenu.children.map(action => [action.label, action.disabled]), [
    ["Закрепить слева", true], ["Закрепить справа", true], ["Открепить", false],
  ]);
  submenu.children[2].onSelect();
  assert.deepEqual(ui.calls, [["pin", "department", null]]);
  assert.equal(ui.render(), null, "Choosing a pin action closes the menu");
});

test("native date menu pins the semantic day ID while filtering still uses the full date", async () => {
  const left = await menuHarness("day-19", null);
  left.view.props.actions.find(action => action.label === "Закрепить столбец").children[0].onSelect();
  assert.deepEqual(left.calls, [["pin", "day-19", "left"]]);
  const right = await menuHarness("day-19", null);
  right.view.props.actions.find(action => action.label === "Закрепить столбец").children[1].onSelect();
  assert.deepEqual(right.calls, [["pin", "day-19", "right"]]);
  const filter = await menuHarness("day-19", null);
  filter.view.props.actions.find(action => action.label === "Фильтр…").onSelect();
  assert.equal(filter.calls[0][1], "2026-11-19");
});

test("native header menu resets pinning independently of widths and stays optional", async () => {
  const ui = await menuHarness("total", "right");
  ui.view.props.actions.find(action => action.label === "Сбросить закрепление").onSelect();
  assert.deepEqual(ui.calls, [["reset"]]);
  const original = await menuHarness("total", null);
  delete original.options.pinning;
  assert.ok(original.render().props.actions.every(action => !/закреп/i.test(action.label)));
});
