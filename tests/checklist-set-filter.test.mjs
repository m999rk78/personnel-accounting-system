import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import ts from "typescript";
import { buildCompactFilterValues, filterCompactFilterValues } from "../app/compactFilterValues.ts";
import { dateFilterPath, dateFilterTreeLabel, matchesDateFilterSearch } from "../app/dateFilterTreeModel.ts";

const source = ts.createSourceFile("ChecklistSetFilter.tsx", await readFile(new URL("../app/ChecklistSetFilter.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ChecklistSetFilter");
const definition = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === "checklistValuesChild"));
assert.ok(component);
assert.ok(definition);
const implementation = ts.transpileModule(`${component.getText(source)}\n${definition.getText(source).replace(/^export\s+/, "")}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement" },
}).outputText;

function SelectionCheckbox() { return null; }
function VirtualChoiceList() { return null; }
function DateFilterTree() { return null; }
function DateCheckbox() { return null; }
const dateSource = ts.createSourceFile("DateFilterTree.tsx", await readFile(new URL("../app/DateFilterTree.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const dateImplementation = ts.transpileModule(dateSource.statements.filter(node => ts.isFunctionDeclaration(node) && ["buildDateTree", "DateFilterTree"].includes(node.name?.text)).map(node => node.getText(dateSource).replace(/^export\s+/, "")).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement" },
}).outputText;
const runDateTree = new Function("createElement", "VirtualChoiceList", "DateCheckbox", "dateFilterPath", "dateFilterTreeLabel", "matchesDateFilterSearch", "useState", "useMemo", `${dateImplementation}\nreturn DateFilterTree;`)(
  createElement, VirtualChoiceList, DateCheckbox, dateFilterPath, dateFilterTreeLabel, matchesDateFilterSearch,
  initial => [typeof initial === "function" ? initial() : initial, () => {}], calculate => calculate(),
);
function* elements(node) {
  if (Array.isArray(node)) { for (const child of node) yield* elements(child); return; }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  yield node;
  yield* elements(node.props.children);
  if (node.type === VirtualChoiceList) for (const item of node.props.items) yield* elements(node.props.renderItem(item));
}
const nodeText = node => typeof node === "string" ? node : Array.isArray(node) ? node.map(nodeText).join("") : node?.props ? nodeText(node.props.children) : "";

function harness({ rows, keys, values = keys, model = null, state = false, siblingState = null, valueFormatter, kind } = {}) {
  const hooks = [];
  let cursor = 0, displayCallbacks, pendingValues;
  const calls = [];
  const effects = [], listeners = new Map();
  const column = { getColId: () => "target" };
  const otherModel = { filterType: "set", values: ["Отдел А"] };
  const models = {
    department: structuredClone(otherModel),
    target: { filterType: "multi", filterModels: [null, state ? siblingState : model, state ? model : siblingState] },
  };
  let childModel = structuredClone(model);
  const childIndex = state ? 2 : 1;
  const useState = initial => {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
    return [hooks[index], update => { hooks[index] = typeof update === "function" ? update(hooks[index]) : update; }];
  };
  const useRef = initial => {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = { current: initial };
    return hooks[index];
  };
  const handler = {
    getFilterKeys: () => keys,
    getFilterValues: () => values,
    refreshFilterValues: () => {
      calls.push(["refreshValues"]);
      if (pendingValues) { keys = pendingValues.keys; values = pendingValues.values ?? keys; pendingValues = null; }
    },
  };
  const api = {
    forEachNode: callback => rows.forEach(callback),
    isDestroyed: () => false,
    setColumnFilterModel: async (targetColumn, next) => {
      calls.push(["columnModel", targetColumn, next]);
      assert.equal(targetColumn, column);
      if (next === null) { delete models.target; childModel = null; }
    },
    onFilterChanged: () => { calls.push(["filterChanged"]); },
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  };
  const environment = {
    createElement, SelectionCheckbox, VirtualChoiceList, DateFilterTree, matchesDateFilterSearch, buildCompactFilterValues, filterCompactFilterValues,
    useState, useRef, useMemo: calculate => calculate(), useEffect: setup => { effects.push(setup); },
    useGridFilterDisplay: callbacks => { displayCallbacks = callbacks; },
    requestAnimationFrame: callback => { callback(); return 1; }, cancelAnimationFrame() {},
  };
  const { runDisplay, nativeChild } = new Function(...Object.keys(environment), `${implementation}\nreturn {runDisplay:ChecklistSetFilter,nativeChild:checklistValuesChild};`)(...Object.values(environment));
  const render = () => {
    cursor = 0;
    return runDisplay({
      api, column, colDef: { headerName: "Сотрудник" }, context: {},
      getValue: node => node.value, doesRowPassOtherFilter: node => node.available !== false,
      getHandler: () => handler, model: childModel, state: { model: childModel }, isStateChecklist: state,
      suppressSorting: state, valueFormatter, kind,
      onModelChange: next => {
        calls.push(["childModel", structuredClone(next)]);
        childModel = structuredClone(next);
        const current = models.target ?? { filterType: "multi", filterModels: [null, null, null] };
        models.target = { ...current, filterModels: current.filterModels.map((value, index) => index === childIndex ? structuredClone(next) : value) };
      },
    });
  };
  const find = predicate => {
    const matches = [...elements(render())].filter(predicate);
    assert.equal(matches.length, 1, "UI target must be unique");
    return matches[0];
  };
  return {
    calls, models, nativeChild, runDisplay, render,
    get model() { return childModel; },
    search: value => find(node => node.type === "input" && node.props.placeholder === "Найти значение…").props.onChange({ target: { value } }),
    toggle: (label, checked) => find(node => node.type === SelectionCheckbox && node.props.label === label).props.onChange(checked),
    checkbox: label => find(node => node.type === SelectionCheckbox && node.props.label === label).props,
    openStates: () => find(node => node.type === "button" && node.props.className === "grid-checklist-state-toggle").props.onClick(),
    dateTree: () => find(node => node.type === DateFilterTree).props,
    reset: () => find(node => node.type === "button" && nodeText(node) === "Сбросить фильтр").props.onClick(),
    attach: () => { render(); displayCallbacks.afterGuiAttached(); },
    mount: () => { effects.length = 0; render(); effects.forEach(setup => setup()); },
    updateRows: next => { rows = next.rows; pendingValues = next; },
    emit: name => { listeners.get(name)?.forEach(callback => callback()); },
  };
}
const row = (value, available = true) => ({ data: { kind: "entry" }, value, available });
const selected = values => ({ filterType: "set", values });
function dateCheckbox(ui, label) {
  const matches = [...elements(runDateTree(ui.dateTree()))].filter(node => node.type === DateCheckbox && node.props.label === label);
  assert.equal(matches.length, 1);
  return matches[0].props;
}

test("an inactive filter shows every value unchecked and selecting the first value restricts only to it", () => {
  const ui = harness({ rows: [row("А"), row("Б"), row(null)], keys: ["А", "Б", null] });
  assert.equal(ui.model, null, "No model leaves the native row filter unrestricted");
  for (const label of ["А", "Б", "(Пустые)", "Выбрать найденные значения"]) assert.equal(ui.checkbox(label).checked, false, label);
  assert.equal(ui.checkbox("Выбрать найденные значения").mixed, false);
  ui.attach();
  assert.equal(ui.model, null);
  assert.equal(ui.checkbox("А").checked, false);
  ui.toggle("А", true);
  assert.deepEqual(ui.model, selected(["А"]));
  assert.equal(ui.checkbox("А").checked, true);
  assert.equal(ui.checkbox("Б").checked, false);
  assert.equal(ui.checkbox("(Пустые)").checked, false);
});

test("all checked values retain an explicit Set model until the last checkbox is cleared", () => {
  const ui = harness({ rows: [row("А"), row("Б"), row(null)], keys: ["А", "Б", null] });
  ui.toggle("А", true);
  ui.toggle("Б", true);
  ui.toggle("(Пустые)", true);
  assert.deepEqual(ui.model, selected(["А", "Б", null]), "Selecting every value must not collapse the model and clear the checkboxes");
  assert.equal(ui.checkbox("Выбрать найденные значения").checked, true);
  ui.attach();
  for (const label of ["А", "Б", "(Пустые)"]) assert.equal(ui.checkbox(label).checked, true, label);
  ui.toggle("А", false);
  ui.toggle("Б", false);
  assert.deepEqual(ui.model, selected([null]));
  ui.toggle("(Пустые)", false);
  assert.equal(ui.model, null, "Removing the last manual choice restores all records");
  for (const label of ["А", "Б", "(Пустые)", "Выбрать найденные значения"]) assert.equal(ui.checkbox(label).checked, false, label);
});

test("choose-found selects all from the empty visual selection and clearing it restores an inactive filter", () => {
  const ui = harness({ rows: [row("А"), row("Б")], keys: ["А", "Б"] });
  ui.toggle("Выбрать найденные значения", true);
  assert.deepEqual(ui.model, selected(["А", "Б"]));
  assert.equal(ui.checkbox("Выбрать найденные значения").checked, true);
  ui.toggle("Выбрать найденные значения", false);
  assert.equal(ui.model, null);
  assert.equal(ui.checkbox("Выбрать найденные значения").checked, false);
});

test("actual search handlers apply matches including zero and null, but clearing search restores the inactive child", () => {
  const sibling = selected(["mismatch"]);
  const ui = harness({ rows: [row("Иванов"), row(0), row(null)], keys: ["ИВАНОВ", "0", null], values: ["ИВАНОВ", 0, null], siblingState: sibling });
  assert.equal(ui.nativeChild.handler, "agSetColumnFilterHandler", "Filtering remains delegated to AG Grid's native Set handler");
  assert.equal(ui.nativeChild.component, ui.runDisplay);
  ui.search("  иванов  ");
  assert.deepEqual(ui.model, selected(["ИВАНОВ"]));
  ui.search("0");
  assert.deepEqual(ui.model, selected(["0"]));
  ui.toggle("0", false);
  assert.equal(ui.model, null, "Manually clearing the last search match restores all records, unlike a nonmatching search");
  ui.search("0");
  ui.toggle("Выбрать найденные значения", false);
  assert.equal(ui.model, null, "Deselecting all search matches uses the same manual clear semantics");
  ui.search("пустые");
  assert.deepEqual(ui.model, selected([null]));
  ui.search("нет совпадений");
  assert.deepEqual(ui.model, selected([]));
  ui.search("");
  assert.equal(ui.model, null, "Clearing a search restores all rows rather than selecting all native keys");
  assert.equal(ui.checkbox("ИВАНОВ").checked, false);
  ui.search("0");
  ui.search("   \t   ");
  assert.equal(ui.model, null, "Whitespace-only searches are also empty");
  assert.deepEqual(ui.models.target.filterModels[2], sibling, "Clearing search leaves the sibling state filter intact");
  assert.deepEqual(ui.models.department, selected(["Отдел А"]));
  assert.equal(ui.calls.some(([name]) => name === "columnModel"), false, "Typing changes only the Set child, not the whole Multi Filter or other columns");
});

test("toggling a displayed value preserves explicit selection of values hidden by another column", () => {
  const ui = harness({ rows: [row("А"), row("Б", false), row("В")], keys: ["А", "Б", "В"], model: selected(["А", "Б"]) });
  ui.toggle("А", false);
  assert.deepEqual(ui.model, selected(["Б"]));
  assert.deepEqual(ui.models.department, { filterType: "set", values: ["Отдел А"] });
  ui.toggle("В", true);
  assert.deepEqual(ui.model, selected(["Б", "В"]));
});

test("selecting all available values cannot broaden the model to hidden native keys", () => {
  const ui = harness({ rows: [row("А"), row("Б", false), row("В")], keys: ["А", "Б", "В"], model: selected(["А"]) });
  assert.equal(ui.checkbox("Выбрать найденные значения").mixed, true);
  ui.toggle("Выбрать найденные значения", true);
  assert.deepEqual(ui.model, selected(["А", "В"]));
  assert.equal(ui.checkbox("Выбрать найденные значения").checked, true);
  ui.toggle("Выбрать найденные значения", false);
  assert.equal(ui.model, null);
  const empty = harness({ rows: [], keys: [] });
  empty.search("несуществующее значение");
  assert.deepEqual(empty.model, selected([]), "A nonempty search without matches must still hide all rows");
  empty.search("");
  assert.equal(empty.model, null, "The empty search explicitly restores no restriction even when the dataset is empty");
});

test("inactive state choices are unchecked, the first state is exclusive and clearing the last state restores any state", () => {
  const valueModel = selected(["8"]);
  const labels = { filled: "Есть значение", empty: "Нет значения", manual: "Ручная правка", mismatch: "Расхождение" };
  const ui = harness({
    rows: [row(["filled", "manual", "mismatch"]), row(["filled"])], keys: Object.keys(labels), state: true,
    siblingState: valueModel, valueFormatter: ({ value }) => labels[value],
  });
  ui.openStates();
  for (const label of Object.values(labels)) assert.equal(ui.checkbox(label).checked, false, label);
  ui.toggle("Расхождение", true);
  assert.deepEqual(ui.model, selected(["mismatch"]));
  assert.equal(ui.checkbox("Ручная правка").checked, false);
  ui.toggle("Ручная правка", true);
  assert.deepEqual(ui.model, selected(["mismatch", "manual"]));
  ui.toggle("Расхождение", false);
  ui.toggle("Ручная правка", false);
  assert.equal(ui.model, null);
  for (const label of Object.values(labels)) assert.equal(ui.checkbox(label).checked, false, label);
  assert.deepEqual(ui.models.target.filterModels[1], valueModel);
  assert.deepEqual(ui.models.department, selected(["Отдел А"]));
});

test("checking all states stays explicit and does not clear their checkmarks on reopen", () => {
  const labels = { filled: "Есть значение", empty: "Нет значения", manual: "Ручная правка", mismatch: "Расхождение" };
  const ui = harness({ rows: [row(["filled"])], keys: Object.keys(labels), state: true, valueFormatter: ({ value }) => labels[value] });
  ui.openStates();
  for (const label of Object.values(labels)) ui.toggle(label, true);
  assert.deepEqual(ui.model, selected(Object.keys(labels)));
  ui.attach();
  for (const label of Object.values(labels)) assert.equal(ui.checkbox(label).checked, true, label);
});

test("state choices share one native Set model while preserving value selection and other columns", () => {
  const valueModel = selected(["8"]);
  const labels = { filled: "Есть значение", empty: "Нет значения", manual: "Ручная правка", mismatch: "Расхождение" };
  const ui = harness({
    rows: [row(["filled", "manual", "mismatch"]), row(["filled"])], keys: Object.keys(labels),
    model: selected(["manual"]), siblingState: valueModel, state: true,
    valueFormatter: ({ value }) => labels[value],
  });
  assert.equal(ui.checkbox("Нет значения").checked, false, "Zero-count states remain available for selection");
  ui.toggle("Расхождение", true);
  assert.deepEqual(ui.model, selected(["manual", "mismatch"]), "Alternative states are encoded as values in the same Set child, preserving native OR semantics");
  assert.deepEqual(ui.models.target.filterModels[1], valueModel);
  assert.deepEqual(ui.models.target.filterModels[2], selected(["manual", "mismatch"]));
  ui.toggle("Ручная правка", false);
  assert.deepEqual(ui.model, selected(["mismatch"]));
  assert.deepEqual(ui.models.department, { filterType: "set", values: ["Отдел А"] });
});

test("reset clears only the current column and notifies the native row model once", async () => {
  const ui = harness({ rows: [row("А")], keys: ["А", "Б"], model: selected(["А"]), siblingState: selected(["mismatch"]) });
  ui.reset();
  for (let index = 0; index < 3; index++) await Promise.resolve();
  assert.equal(ui.model, null);
  assert.equal(ui.checkbox("А").checked, false);
  assert.equal(ui.checkbox("Выбрать найденные значения").checked, false);
  assert.equal(ui.models.target, undefined);
  assert.deepEqual(ui.models.department, { filterType: "set", values: ["Отдел А"] });
  assert.equal(ui.calls.filter(([name]) => name === "columnModel").length, 1);
  assert.equal(ui.calls.filter(([name]) => name === "filterChanged").length, 1);
});

test("reopening refreshes native values without replacing an explicit applied selection", () => {
  const ui = harness({ rows: [row("А"), row("Б")], keys: ["А", "Б"], model: selected(["А"]) });
  ui.attach();
  assert.deepEqual(ui.model, selected(["А"]));
  assert.equal(ui.calls.filter(([name]) => name === "refreshValues").length, 1);
  assert.equal(ui.calls.some(([name]) => name === "childModel"), false);
  assert.equal(ui.checkbox("А").checked, true);
  assert.equal(ui.checkbox("Б").checked, false);
});

test("imported data refreshes the actual native handler before new values and counts render", () => {
  const ui = harness({ rows: [row("Иванов")], keys: ["Иванов"], model: selected(["Иванов"]) });
  ui.mount();
  ui.updateRows({ rows: [row("Иванов"), row("Новый сотрудник"), row("Новый сотрудник")], keys: ["Иванов", "Новый сотрудник"] });
  ui.emit("rowDataUpdated");
  const rendered = ui.checkbox("Новый сотрудник");
  assert.equal(rendered.checked, false, "A new import must not silently broaden an explicit employee selection");
  assert.equal([...elements(rendered.children)].find(node => node.type === "small").props.children, 2);
  assert.deepEqual(ui.model, selected(["Иванов"]));
  assert.equal(ui.calls.filter(([name]) => name === "refreshValues").length, 1);
});

test("date checklist renders the calendar tree with original native keys, counts and a reversible blank key", () => {
  const ui = harness({
    rows: [row("2026-11-07"), row("2026-11-07"), row("06.11.2026"), row("2025-11-06", false), row(null)],
    keys: ["2026-11-07", "06.11.2026", "2025-11-06", null], kind: "date",
    model: selected(["06.11.2026", "2025-11-06", null]),
  });
  const tree = ui.dateTree();
  assert.deepEqual(new Map(tree.values.map(item => [item.value, item.count])), new Map([["2026-11-07", 2], ["06.11.2026", 1], ["", 1]]));
  assert.deepEqual(tree.selected, new Set(["06.11.2026", "2025-11-06", ""]));
  tree.onChange(new Set(["2026-11-07", "2025-11-06", ""]));
  assert.deepEqual(ui.model, selected(["2026-11-07", "2025-11-06", null]));
  assert.deepEqual(ui.models.department, selected(["Отдел А"]));
  ui.dateTree().onChange(new Set([""]));
  assert.deepEqual(ui.model, selected([null]), "The blank date key is an explicit selection, distinct from no filter");
  assert.equal(dateCheckbox(ui, "(Пустые)").checked, true);
  ui.dateTree().onChange(new Set());
  assert.equal(ui.model, null, "Removing the last blank date restores the inactive filter");
  assert.deepEqual(ui.dateTree().selected, new Set());
});

test("the actual year and month checkbox callbacks preserve raw ISO and displayed date keys and hidden selections", () => {
  const ui = harness({
    rows: [row("2026-11-07"), row("07.11.2026"), row("06.11.2026"), row("2026-10-01"), row("2025-12-31", false)],
    keys: ["2026-11-07", "07.11.2026", "06.11.2026", "2026-10-01", "2025-12-31"], kind: "date",
    model: selected(["2025-12-31"]),
  });
  const checkbox = label => dateCheckbox(ui, label);
  assert.equal(checkbox("2026, Ноябрь").checked, false);
  checkbox("2026, Ноябрь").onChange(true);
  assert.deepEqual(new Set(ui.model.values), new Set(["2025-12-31", "2026-11-07", "07.11.2026", "06.11.2026"]));
  assert.equal(checkbox("2026, Ноябрь").checked, true);
  assert.equal(checkbox("2026").mixed, true);
  checkbox("2026, Ноябрь, 07.11.2026").onChange(false);
  assert.deepEqual(new Set(ui.model.values), new Set(["2025-12-31", "06.11.2026"]));
  assert.equal(checkbox("2026, Ноябрь").mixed, true);
  checkbox("2026").onChange(true);
  assert.deepEqual(new Set(ui.model.values), new Set(["2025-12-31", "2026-11-07", "07.11.2026", "06.11.2026", "2026-10-01"]), "Selecting all native dates stays explicit so date checkboxes remain checked");
  assert.equal(checkbox("2026").checked, true);
});

test("an inactive calendar has no checked branches and selecting or clearing a branch follows the same selection rules", () => {
  const ui = harness({
    rows: [row("2026-11-07"), row("06.11.2026"), row("2025-12-31")],
    keys: ["2026-11-07", "06.11.2026", "2025-12-31"], kind: "date",
  });
  assert.deepEqual(ui.dateTree().selected, new Set());
  for (const label of ["2026", "2026, Ноябрь", "2026, Ноябрь, 07.11.2026", "2025"]) {
    assert.equal(dateCheckbox(ui, label).checked, false, label);
    assert.equal(dateCheckbox(ui, label).mixed, false, label);
  }
  dateCheckbox(ui, "2026, Ноябрь").onChange(true);
  assert.deepEqual(new Set(ui.model.values), new Set(["2026-11-07", "06.11.2026"]));
  assert.equal(dateCheckbox(ui, "2025").checked, false);
  dateCheckbox(ui, "2025").onChange(true);
  assert.deepEqual(new Set(ui.model.values), new Set(["2026-11-07", "06.11.2026", "2025-12-31"]));
  ui.attach();
  assert.equal(dateCheckbox(ui, "2026").checked, true);
  assert.equal(dateCheckbox(ui, "2025").checked, true);
  dateCheckbox(ui, "2026").onChange(false);
  assert.deepEqual(ui.model, selected(["2025-12-31"]));
  dateCheckbox(ui, "2025").onChange(false);
  assert.equal(ui.model, null);
  assert.deepEqual(ui.dateTree().selected, new Set());
  assert.equal(dateCheckbox(ui, "2026").checked, false);
});

test("date search applies Russian month, year, ISO and displayed day queries to original keys", async () => {
  const ui = harness({
    rows: [row("2026-11-07"), row("06.11.2026"), row("2026-10-01"), row("2025-11-01"), row(null)],
    keys: ["2026-11-07", "06.11.2026", "2026-10-01", "2025-11-01", null], kind: "date",
  });
  for (const [query, expected] of [
    [" НОЯБРЬ 2026 ", ["2026-11-07", "06.11.2026"]],
    ["2026", ["2026-11-07", "06.11.2026", "2026-10-01"]],
    ["2026-11-07", ["2026-11-07"]],
    ["06.11.2026", ["06.11.2026"]],
    ["пустые", [null]],
    ["не существует", []],
  ]) {
    ui.search(query);
    assert.deepEqual(new Set(ui.model.values), new Set(expected), query);
    assert.equal(ui.dateTree().search, query);
  }
  ui.search("");
  assert.equal(ui.model, null);
  assert.deepEqual(ui.dateTree().selected, new Set());
  ui.search("ноябрь");
  ui.reset();
  for (let index = 0; index < 3; index++) await Promise.resolve();
  assert.equal(ui.model, null);
  assert.equal(ui.dateTree().search, "");
  assert.deepEqual(ui.dateTree().selected, new Set());
  assert.deepEqual(ui.models.department, selected(["Отдел А"]));
});
