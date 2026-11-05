import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement, Fragment } from "react";
import ts from "typescript";
import * as filterModel from "../app/gridFilterModel.ts";

const source = ts.createSourceFile("GridFilters.tsx", await readFile(new URL("../app/GridFilters.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) return node.getText(source);
    if (ts.isVariableStatement(node)) {
      const value = node.declarationList.declarations.find(item => item.name.getText(source) === name);
      if (value) return `const ${value.getText(source)};`;
    }
  }
  assert.fail(`Expected actual filter implementation: ${name}`);
}
const implementation = ts.transpileModule(["ValueCheckbox", "sortKey", "PersonnelFilter"].map(declaration).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: "createElement", jsxFragmentFactory: "Fragment" },
}).outputText;
const clone = value => structuredClone(value);
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const textOf = node => Array.isArray(node) ? node.map(textOf).join("") : node?.props ? textOf(node.props.children) : String(node ?? "");
function find(tree, predicate) {
  const node = nodes(tree).find(predicate);
  assert.ok(node, "Expected actual rendered filter control");
  return node;
}

/** Mount the actual filter with the same controlled draft/apply boundary as AG Grid. */
function filterHarness(values, initialModel = null, kind = "text") {
  const states = [];
  let cursor = 0, lifecycle, pending = clone(initialModel), applied = clone(initialModel);
  const actions = [];
  function useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], next => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
  }
  function useRef(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = { current: initial };
    return states[index];
  }
  const VirtualChoiceList = () => null;
  const environment = {
    ...filterModel, createElement, Fragment, useState, useRef,
    useEffect() { cursor++; }, useMemo(create) { cursor++; return create(); },
    useGridFilterPopup() { return { root: useRef(null), attach() {} }; },
    useGridFilterDisplay(value) { lifecycle = value; },
    CustomSelect() { return null; }, VirtualChoiceList, IMPORT_ORDER_COLUMN: "__import_order__",
  };
  const { PersonnelFilter, ValueCheckbox } = new Function(...Object.keys(environment), `${implementation}\nreturn { PersonnelFilter, ValueCheckbox };`)(...Object.values(environment));
  const rows = values.map(value => ({ data: { kind: "entry", value } }));
  const api = { getColumnState: () => [], getColumn: () => null, isDestroyed: () => false, forEachNode: callback => rows.forEach(callback) };
  function render() {
    cursor = 0;
    return PersonnelFilter({
      api, column: { getColId: () => "value" }, colDef: { headerName: "Значение" }, kind,
      getValue: node => node.data.value, doesRowPassOtherFilter: () => true, model: applied, state: { model: pending },
      onStateChange(next) { pending = clone(next.model); },
      onAction(action) {
        actions.push(action);
        if (action === "apply") applied = clone(pending);
        if (action === "cancel") pending = clone(applied);
      },
    });
  }
  const search = value => find(render(), node => node.type === "input" && node.props["aria-label"] === "Поиск значений").props.onChange({ target: { value } });
  const choices = () => find(render(), node => node.type === VirtualChoiceList);
  const check = (value, checked) => choices().props.renderItem(value).props.onChange(checked);
  const checkFound = checked => find(render(), node => node.type === ValueCheckbox && textOf(node) === "Все найденные").props.onChange(checked);
  const apply = () => render().props.onSubmit({ preventDefault() {} });
  const cancel = () => find(render(), node => node.type === "button" && textOf(node) === "Отмена").props.onClick();
  render(); lifecycle.afterGuiAttached();
  return { render, search, check, checkFound, apply, cancel, actions,
    get choices() { return choices().props.items; },
    get pending() { return pending; }, get applied() { return applied; },
    get visible() { return values.filter(value => filterModel.matchesPersonnelFilter(value, applied)); },
  };
}

const people = ["Иванов Иван", "Иванов Пётр", "Петров Павел"];
const model = overrides => ({ filterType: "personnel", kind: "text", values: null, conditions: [], operator: "AND", ...overrides });

test("search, an individual checkbox and Apply retain only the chosen matching rows", () => {
  const ui = filterHarness(people);
  ui.search("  ИВАН  ");
  assert.deepEqual(ui.choices, ["Иванов Иван", "Иванов Пётр"]);
  assert.deepEqual(ui.pending.values, ["Иванов Иван", "Иванов Пётр"]);
  ui.check("Иванов Пётр", false);
  assert.deepEqual(ui.pending.values, ["Иванов Иван"]);
  assert.equal(ui.applied, null, "Searching and toggling must remain an unapplied draft");
  assert.deepEqual(ui.visible, people);
  ui.apply();
  assert.deepEqual(ui.visible, ["Иванов Иван"]);
  assert.deepEqual(ui.actions, ["apply"]);
});

test("All found never revives hidden values and Cancel restores the previous selection and conditions", () => {
  const previous = model({ values: ["Петров Павел"], conditions: [{ type: "notContains", value: "Иванов Пётр" }] });
  const ui = filterHarness(people, previous);
  ui.search("иван");
  ui.checkFound(false);
  assert.deepEqual(ui.pending.values, []);
  ui.checkFound(true);
  assert.deepEqual(ui.pending.values, ["Иванов Иван", "Иванов Пётр"]);
  assert.deepEqual(ui.pending.conditions, previous.conditions);
  ui.cancel();
  assert.deepEqual(ui.pending, previous);
  assert.deepEqual(ui.applied, previous);
  assert.deepEqual(ui.visible, ["Петров Павел"]);
  assert.deepEqual(ui.actions, ["cancel"]);
});

test("clearing search selects all values without dropping conditions or applying early", () => {
  const previous = model({ conditions: [{ type: "notContains", value: "Иванов Пётр" }] });
  const ui = filterHarness(people, previous);
  ui.search("иван");
  ui.check("Иванов Иван", false);
  ui.search("");
  assert.equal(ui.pending.values, null);
  assert.deepEqual(ui.pending.conditions, previous.conditions);
  assert.deepEqual(ui.applied, previous);
  ui.apply();
  assert.deepEqual(ui.visible, ["Иванов Иван", "Петров Павел"]);
});

test("clearing search in a reopened filter restores applied values and preserves draft conditions", () => {
  const previous = model({ values: ["Петров Павел"], conditions: [{ type: "notContains", value: "Иванов Пётр" }] });
  const ui = filterHarness(people, previous);
  ui.search("иван");
  assert.deepEqual(ui.pending.values, ["Иванов Иван", "Иванов Пётр"]);
  find(ui.render(), node => node.type === "input" && node.props["aria-label"] === "Значение условия 1").props.onChange({ target: { value: "Иванов Иван" } });
  ui.search("");
  assert.deepEqual(ui.pending.values, ["Петров Павел"]);
  assert.deepEqual(ui.pending.conditions, [{ type: "notContains", value: "Иванов Иван" }]);
  assert.deepEqual(ui.applied, previous, "Clearing search must not apply changed conditions early");
  ui.apply();
  assert.deepEqual(ui.applied.values, ["Петров Павел"]);
  assert.deepEqual(ui.applied.conditions, [{ type: "notContains", value: "Иванов Иван" }]);
  assert.deepEqual(ui.visible, ["Петров Павел"]);
});

test("clearing an initially inactive filter restores All values", () => {
  const ui = filterHarness(people);
  ui.search("иван");
  ui.search("");
  assert.equal(ui.pending, null);
  ui.apply();
  assert.equal(ui.applied, null);
  assert.deepEqual(ui.visible, people);
});

test("searching an absent value remains an empty selection through Apply", () => {
  const ui = filterHarness(people);
  ui.search("нет такого пользователя");
  assert.deepEqual(ui.choices, []);
  assert.deepEqual(ui.pending.values, []);
  ui.apply();
  assert.deepEqual(ui.visible, []);
});

test("search selection preserves numeric zero, date values and the explicit blank key", () => {
  for (const { kind, values, search, selected, visible } of [
    { kind: "number", values: [0, 8, 9], search: "0", selected: ["0"], visible: [0] },
    { kind: "date", values: ["01.11.2026", "02.11.2026"], search: "02.11", selected: ["02.11.2026"], visible: ["02.11.2026"] },
    { kind: "text", values: [null, "Иванов"], search: "ПУСТЫЕ", selected: [""], visible: [null] },
  ]) {
    const ui = filterHarness(values, null, kind);
    ui.search(search);
    assert.deepEqual(ui.pending.values, selected);
    ui.apply();
    assert.deepEqual(ui.visible, visible);
  }
});
