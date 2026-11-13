import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { moveRowBlock, orderRowsByIds, reconcileRowOrder, tableOrderScope } from "../app/tableRowOrder.ts";

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

const employees = [
  { id: 10, fullName: "А Рабочий", employmentType: "ОПР", department: "МУТТ" },
  { id: 20, fullName: "Я Директор", employmentType: "АУП", department: "Дирекция" },
  { id: 30, fullName: "Я Инженер", employmentType: "ИТР", department: "ПТО", timesheetOrder: 0 },
  { id: 40, fullName: "А Инженер", employmentType: "ИТР", department: "ПТО", timesheetOrder: 1 },
];
const ids = rows => rows.map(row => row.id);
const displayed = (rowOrder, roster = employees) => memo("filterRows", { payload: { employees: roster }, rowOrder, orderRowsByIds });
const loadedOrder = (saved, available = ids(employees)) => ({
  hasSavedOrder: saved !== undefined,
  order: rows => orderRowsByIds(rows, reconcileRowOrder(available, saved ?? []), row => row.id),
});

test("opening a timesheet applies a saved project order across departments", () => {
  assert.deepEqual(ids(displayed(null)), [10, 20, 30, 40]);
  const saved = [10, 40, 20, 30];
  const manual = displayed(loadedOrder(saved));
  assert.deepEqual(ids(manual), saved);
  assert.strictEqual(manual[1], employees[3]);
  assert.deepEqual(ids(employees), [10, 20, 30, 40]);
});

test("an unsaved timesheet uses the canonical project order after it loads", () => {
  const employees = [
    { id: 10, fullName: "Я Новый инженер", employmentType: "ИТР", department: "ПТО" },
    { id: 20, fullName: "А Новый инженер", employmentType: "ИТР", department: "ПТО" },
    { id: 30, fullName: "Директор", employmentType: "АУП", department: "Дирекция", timesheetOrder: 0 },
  ];
  assert.deepEqual(ids(displayed(null, employees)), [10, 20, 30]);
  assert.deepEqual(ids(displayed(loadedOrder(undefined, [20, 30, 10]), employees)), [20, 30, 10]);
  assert.deepEqual(ids(employees), [10, 20, 30]);
});

test("the first successful timesheet move seeds the displayed order; subsequent moves do not replay it", async () => {
  let saved, rejected = true;
  const requests = [];
  const operation = { movingIds: [10], placement: "before", targetId: 20 };
  const move = async change => {
    requests.push(change);
    if (rejected) return false;
    saved = moveRowBlock(reconcileRowOrder(ids(employees), saved ?? []), change);
    return true;
  };
  const open = () => {
    const rowOrder = { ...loadedOrder(saved), move };
    return memo("manualRowOrder", { rowOrder, displayedRowIds: ids(displayed(rowOrder)) });
  };
  assert.equal(await open().move(operation), false);
  assert.deepEqual(ids(displayed(loadedOrder(saved))), [10, 20, 30, 40]);
  const firstRequest = { ...operation, displayedIds: [10, 20, 30, 40], displayedIdsOnlyIfUnsaved: true };
  assert.deepEqual(requests[0], firstRequest);
  rejected = false;
  assert.equal(await open().move(operation), true);
  assert.deepEqual(requests[1], firstRequest);
  assert.deepEqual(ids(displayed(loadedOrder(saved))), [10, 20, 30, 40]);
  const next = { movingIds: [40], placement: "before", targetId: 30 };
  assert.equal(await open().move(next), true);
  assert.deepEqual(requests[2], next);
  assert.deepEqual(ids(displayed(loadedOrder(saved))), [10, 20, 40, 30]);
});

test("a move from project settings survives reopening and changing months without leaking into a different project", () => {
  const key = view => `${tableOrderScope(view, "all")}:7`;
  const stored = new Map([[key("projectEmployees"), moveRowBlock(ids(employees), { movingIds: [40, 30], placement: "start" })]]);
  assert.equal(key("timesheet"), key("projectEmployees"));
  const november = displayed(loadedOrder(stored.get(key("timesheet"))));
  assert.deepEqual(ids(november), [30, 40, 10, 20]);
  const roster = [...employees.filter(row => row.id !== 40), { id: 50, fullName: "Новый сотрудник", employmentType: "АУП", department: "Дирекция" }];
  const december = displayed(loadedOrder(stored.get(key("timesheet")), ids(roster)), roster);
  assert.deepEqual(ids(december), [30, 10, 20, 50]);
  assert.deepEqual(ids(displayed(loadedOrder(stored.get(key("timesheet"))))), ids(november));
  assert.deepEqual(ids(displayed(loadedOrder(stored.get("project-personnel:8")))), [10, 20, 30, 40]);
});

test("the personnel timesheet uses import order as its baseline and keeps explicit filters independent", () => {
  const rows = [{ id: 20 }], columns = [{ colId: "fullName" }];
  const node = declaration("filters");
  assert.ok(node);
  const config = bind(`const config = ${node.initializer.getText(ast)};`, "config", {
    useTimesheetFilters: options => options, filterRows: rows, filterColumns: columns,
    employeeFilterRowId: row => String(row.id), siteId: 7, month: "2026-11",
  });
  assert.equal(config.rows, rows);
  assert.equal(config.columns, columns);
  assert.equal(config.resetKey, "7:2026-11");
  assert.equal(config.importOrder, undefined);
  assert.deepEqual(ids(displayed({ ...loadedOrder(undefined), hasImportOrder: true, importIds: [40, 20, 10, 30] })), [40, 20, 10, 30]);
});
