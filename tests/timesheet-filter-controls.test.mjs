import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import ts from "typescript";

const source = ts.createSourceFile("useTimesheetFilters.tsx", await readFile(new URL("../app/useTimesheetFilters.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useTimesheetFilters");
assert.ok(declaration);
const implementation = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement" },
}).outputText;

function harness(presentation = "full") {
  const states = [];
  let cursor = 0;
  const calls = [], configured = [];
  const rows = [{ id: 1 }, { id: 2 }];
  const columns = ["fullName", "2026-11-06", "2026-11-08", "difference"].map(colId => ({ colId, headerName: colId, getValue: row => row.id }));
  let model = {};
  const api = {
    isDestroyed: () => false, isModuleRegistered: () => true,
    forEachNodeAfterFilterAndSort: callback => rows.forEach(data => callback({ id: String(data.id), data })),
    getFilterModel: () => model, getColumnState: () => [],
    hideColumnFilter: () => calls.push(["hide"]), showColumnFilter: id => calls.push(["show", id]),
    setColumnFilterModel: async (id, value) => { calls.push(["set", id, value]); if (value === null) delete model[id]; else model[id] = value; },
    onFilterChanged: () => calls.push(["changed"]),
  };
  const useState = initial => {
    const key = cursor++;
    if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial;
    return [states[key], next => { states[key] = typeof next === "function" ? next(states[key]) : next; }];
  };
  const useRef = initial => {
    const key = cursor++;
    if (!(key in states)) states[key] = { current: initial };
    return states[key];
  };
  const body = {};
  const environment = {
    createElement, AgGridReact: () => null,
    useState, useRef, useCallback: callback => callback, useMemo: calculate => calculate(), useEffect() {},
    EMPTY: { keys: null, filters: [], sorts: [] }, gridTheme: {}, gridLocaleRu: {}, compareGridValues() {},
    enterpriseFilterParams: (_params, options) => { configured.push(options); return {}; },
    IMPORT_ORDER_COLUMN: "__importOrder", document: { body, activeElement: body },
    window: { innerWidth: 1200, innerHeight: 900 },
  };
  const runHook = new Function(...Object.keys(environment), `${implementation}\nreturn useTimesheetFilters;`)(...Object.values(environment));
  const render = () => { cursor = 0; return runHook({ rows, columns, getRowId: row => String(row.id), resetKey: "1:2026-11", presentation }); };
  const controller = view => view.controller.props.children.props;
  controller(render()).onGridReady({ api });
  return { render, controller, api, calls, configured, viewport: environment.window,
    set model(value) { model = structuredClone(value); controller(render()).onFilterChanged({ api }); },
    get model() { return model; },
  };
}

test("returning to the whole month removes only active day filters", async () => {
  const ui = harness("compact");
  const person = { filterType: "multi", filterModels: [null, { filterType: "set", values: ["Иванов"] }] };
  const state = { filterType: "multi", filterModels: [null, null, { filterType: "set", values: ["mismatch"] }] };
  const total = { filterType: "number", type: "notEqual", filter: 0 };
  ui.model = { fullName: person, "2026-11-08": state, "2026-11-06": state, difference: total };
  const view = ui.render();
  assert.deepEqual(view.dayFilterIds, ["2026-11-08", "2026-11-06"]);
  await view.clearDayFilters();
  assert.deepEqual(ui.model, { fullName: person, difference: total });
  assert.deepEqual(ui.render().dayFilterIds, []);
  assert.equal(ui.calls.filter(([action]) => action === "changed").length, 1);
});

test("timesheet presentation is opt-in and does not convert equipment filters", () => {
  for (const presentation of ["full", "compact"]) {
    const ui = harness(presentation);
    const view = ui.render();
    ui.controller(view).columnDefs[0].filterParams({});
    assert.equal(ui.configured[0].presentation, presentation);
    assert.equal(view.context.presentation, presentation);
  }
});

test("a repeated pointer click closes the filter even after outside mousedown detached it", () => {
  const ui = harness("compact"), trigger = { focus() {} };
  ui.render().context.open("2026-11-06", trigger, false);
  ui.calls.length = 0;
  // The button captured `true` before AG Grid's document mousedown closed it.
  ui.render().context.open("2026-11-06", trigger, true);
  assert.deepEqual(ui.calls, [["hide"]]);
  ui.render().context.open("2026-11-08", trigger, false);
  assert.deepEqual(ui.calls.slice(1), [["hide"], ["show", "2026-11-08"]]);
});

test("the popup stays beside its trigger without covering the toggle in a short viewport", () => {
  for (const rect of [{ top: 334, bottom: 348 }, { top: 620, bottom: 634 }]) {
    const ui = harness("compact");
    ui.viewport.innerHeight = 720;
    const trigger = { getBoundingClientRect: () => ({ ...rect, left: 1000 }), focus() {} };
    const ePopup = {
      style: {}, classList: { contains: name => name === "ag-filter-menu" },
      getBoundingClientRect() { return { height: Math.min(430, parseFloat(this.style.maxHeight) || 430) }; },
    };
    ui.render().context.open("2026-11-06", trigger, false);
    ui.controller(ui.render()).postProcessPopup({ ePopup });
    const top = parseFloat(ePopup.style.top), height = ePopup.getBoundingClientRect().height;
    assert.ok(top >= 12 && top + height <= 708);
    assert.ok(top >= rect.bottom + 6 || top + height <= rect.top - 6);
    assert.ok(parseFloat(ePopup.style.left) + 286 <= 1188);
  }
});
