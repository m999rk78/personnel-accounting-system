import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { orderPersonnelTimesheetEmployees } from "../app/personnelTimesheetOrder.ts";
import { orderRowsByIds } from "../app/tableRowOrder.ts";

const source = await readFile(new URL("../app/TimesheetView.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("TimesheetView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "TimesheetView");
assert.ok(component?.body);
const statements = component.body.statements;
function declaration(name) {
  return statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => node.name.getText(ast) === name);
}
function bind(code, result, environment) {
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(environment), `${compiled}\nreturn ${result};`)(...Object.values(environment));
}
function memo(name, environment) {
  const node = declaration(name);
  assert.ok(node, `Expected actual timesheet declaration: ${name}`);
  return bind(`const value = ${node.initializer.arguments[0].getText(ast)};`, "value", environment)();
}

test("opening a timesheet groups even an existing saved order without renaming or losing employees", () => {
  const employees = [
    { id: 10, fullName: "А Рабочий", employmentType: "ОПР", department: "МУТТ" },
    { id: 20, fullName: "Я Директор", employmentType: "АУП", department: "Дирекция" },
    { id: 30, fullName: "Я Инженер", employmentType: "ИТР", department: "ПТО" },
    { id: 40, fullName: "А Инженер", employmentType: "ИТР", department: "ПТО" },
  ];
  const rowOrder = { hasSavedOrder: true, order: rows => orderRowsByIds(rows, [10, 40, 20, 30], row => row.id) };
  const grouped = memo("filterRows", { payload: { employees }, rowOrder, useManualRowOrder: false, orderPersonnelTimesheetEmployees });
  assert.deepEqual(grouped.map(row => row.id), [20, 40, 30, 10]);
  assert.equal(grouped[0], employees[1]);
  assert.deepEqual(employees.map(row => row.id), [10, 20, 30, 40]);
  const manual = memo("filterRows", { payload: { employees }, rowOrder, useManualRowOrder: true, orderPersonnelTimesheetEmployees });
  assert.deepEqual(manual.map(row => row.id), [10, 40, 20, 30]);
});

test("a late unsaved canonical order cannot alphabetize employees missing from the Excel reference", () => {
  const employees = [
    { id: 10, fullName: "Я Новый инженер", employmentType: "ИТР", department: "ПТО" },
    { id: 20, fullName: "А Новый инженер", employmentType: "ИТР", department: "ПТО" },
    { id: 30, fullName: "Директор", employmentType: "АУП", department: "Дирекция", timesheetOrder: 0 },
  ];
  const environment = { payload: { employees }, useManualRowOrder: false, orderPersonnelTimesheetEmployees };
  assert.deepEqual(memo("filterRows", { ...environment, rowOrder: null }).map(row => row.id), [30, 10, 20]);
  const rowOrder = { hasSavedOrder: false, order: rows => orderRowsByIds(rows, [20, 30, 10], row => row.id) };
  assert.deepEqual(memo("filterRows", { ...environment, rowOrder }).map(row => row.id), [30, 10, 20]);
  assert.deepEqual(memo("filterRows", { ...environment, rowOrder, useManualRowOrder: true }).map(row => row.id), [20, 30, 10]);
  assert.deepEqual(employees.map(row => row.id), [10, 20, 30]);
});

function moveHarness() {
  const calls = [], modes = [];
  let answer;
  const activeScope = { current: "7:2026-11" };
  const activeScopeVersion = { current: 1 };
  const rowOrder = {
    canWrite: true,
    move: operation => { calls.push(operation); return new Promise(resolve => { answer = resolve; }); },
  };
  const order = memo("manualRowOrder", { rowOrder, displayedRowIds: [20, 40, 30, 10], rowOrderScopeKey: activeScope.current,
    activeScope, activeScopeVersion, setRowOrderMode: mode => modes.push(mode) });
  return { order, calls, modes, activeScope, activeScopeVersion, finish: saved => answer(saved) };
}

for (const saved of [true, false]) test(`a manual move uses visible order and ${saved ? "switches mode only after saving" : "keeps the organizational default on failure"}`, async () => {
  const ui = moveHarness();
  const moving = ui.order.move({ movingIds: [10], placement: "before", targetId: 20 });
  assert.deepEqual(ui.calls, [{ movingIds: [10], placement: "before", targetId: 20, displayedIds: [20, 40, 30, 10] }]);
  assert.deepEqual(ui.modes, [], "A pending write must not reorder the displayed baseline");
  ui.finish(saved);
  assert.equal(await moving, saved);
  assert.deepEqual(ui.modes, saved ? [{ key: "7:2026-11", manual: true }] : []);
});

test("a late row move cannot activate manual order after changing month or leaving and returning", async () => {
  for (const returnToOriginalScope of [false, true]) {
    const ui = moveHarness();
    const moving = ui.order.move({ movingIds: [10], placement: "start" });
    ui.activeScope.current = returnToOriginalScope ? "7:2026-11" : "7:2026-12";
    ui.activeScopeVersion.current += returnToOriginalScope ? 2 : 1;
    ui.finish(true);
    assert.equal(await moving, true);
    assert.deepEqual(ui.modes, []);
  }
});

test("each project or month visit starts with the organizational order, including returning to an earlier month", () => {
  const first = statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === "rowOrderScopeKey"));
  const last = statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === "useManualRowOrder"));
  assert.ok(first >= 0 && last >= first);
  const code = statements.slice(first, last + 1).map(node => node.getText(ast)).join("\n");
  const open = () => {
    let state;
    const render = (siteId, month) => bind(code, "{rowOrderScopeKey,useManualRowOrder}", {
      siteId, month, useState: initial => [state ??= initial, next => { state = next; }],
    });
    return { render, move: key => { state = { key, manual: true }; } };
  };
  const page = open();
  assert.equal(page.render(7, "2026-11").useManualRowOrder, false);
  page.move("7:2026-11");
  assert.equal(page.render(7, "2026-11").useManualRowOrder, true);
  assert.equal(page.render(7, "2026-12").useManualRowOrder, false);
  assert.equal(page.render(7, "2026-11").useManualRowOrder, false);
  page.move("7:2026-11");
  assert.equal(page.render(8, "2026-11").useManualRowOrder, false);
  assert.equal(page.render(7, "2026-11").useManualRowOrder, false);
  assert.equal(open().render(7, "2026-11").useManualRowOrder, false);
});

test("the personnel timesheet retains explicit filters but never automatically replaces the default with import sorting", () => {
  const rows = [{ id: 20 }], columns = [{ colId: "fullName" }];
  const node = declaration("filters");
  assert.ok(node);
  const config = bind(`const config = ${node.initializer.getText(ast)};`, "config", {
    useTimesheetFilters: options => options, filterRows: rows, filterColumns: columns,
    employeeFilterRowId: row => String(row.id), siteId: 7, month: "2026-11", importRank: () => 0,
    rowOrder: { ready: true, importOrderRevision: 50, hasImportOrder: true, hasSavedOrder: false },
  });
  assert.equal(config.rows, rows);
  assert.equal(config.columns, columns);
  assert.equal(config.resetKey, "7:2026-11");
  assert.equal(config.importOrder.defaultSort, false);
  assert.equal(config.importOrder.activation, 0);
  assert.equal(config.importOrder.ready, true);
});
