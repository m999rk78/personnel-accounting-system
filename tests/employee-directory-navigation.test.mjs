import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { compareGridValues } from "../app/gridFilterModel.ts";

const source = await readFile(new URL("../app/EmployeeDirectoryGrid.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("EmployeeDirectoryGrid.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const variables = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
function bind(names, result, environment) {
  const code = names.map(name => { assert.ok(variables.has(name), `Missing implementation: ${name}`); return `const ${variables.get(name)};`; }).join("\n");
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), `${compiled}\nreturn ${result};`)(...Object.values(environment));
}
const rows = [{ id: 7, fullName: "Иван Петров" }, { id: 8, fullName: "Иван Петров" }, { id: 9, fullName: "Анна Иванова" }];
const hooks = { useMemo: create => create(), useCallback: callback => callback };
function labels(props) {
  return bind(["draftsById", "employeeFilterLabels"], "employeeFilterLabels", { ...hooks, props });
}

test("employee directory navigation keeps every saved record and uses the shared resettable filter", () => {
  const props = { rows, drafts: [], focusedEmployeeId: 7, loading: false, onClearEmployeeFocus() {} };
  const result = bind(["draftsById", "rowData", "navigation"], "({ rowData, navigation })", {
    ...hooks, props, draftStructure: "", pageApi: null, useGridNavigationFilter: options => options,
  });
  assert.deepEqual(result.rowData.map(row => row.employee.id), [7, 8, 9]);
  assert.equal(result.rowData[0].employee, rows[0]);
  assert.deepEqual(result.navigation.navigationFilter, {
    columnId: "fullName", value: "7", ready: true, onCleared: props.onClearEmployeeFocus,
  });
  const loading = bind(["navigation"], "navigation", { props: { ...props, loading: true }, pageApi: null, useGridNavigationFilter: options => options });
  assert.equal(loading.navigationFilter.ready, false);
  const cleared = bind(["navigation"], "navigation", { props: { ...props, focusedEmployeeId: null }, pageApi: null, useGridNavigationFilter: options => options });
  assert.equal(cleared.navigationFilter, undefined);
});

test("employee identity filters distinguish equal names, keep labels live and never alter copied cell names", () => {
  const props = { rows, drafts: [] };
  const latest = { current: { ...props, employeeFilterLabels: labels(props), draftsById: new Map(), draftsByKey: new Map() } };
  const { filter, summary, valueFor } = bind(["formatEmployeeFilterValue", "employeeIdentityFilter", "formatFilterSummaryValue", "valueFor"],
    "({ filter: employeeIdentityFilter, summary: formatFilterSummaryValue, valueFor })", { ...hooks, latest, compareGridValues });
  assert.equal(filter.filterValueGetter({ data: { employee: rows[0] } }), "7");
  assert.equal(filter.filterValueGetter({ data: { employee: rows[1] } }), "8");
  assert.equal(filter.filterParams.valueFormatter({ value: "7" }), "Иван Петров (№7)");
  assert.equal(filter.filterParams.valueFormatter({ value: "8" }), "Иван Петров (№8)");
  assert.equal(summary("fullName", "9"), "Анна Иванова");
  assert.equal(summary("fullName", "99"), "Сотрудник №99");
  assert.equal(filter.filterParams.defaultToNothingSelected, true, "A sole record must still have an active resettable filter");
  assert.equal(valueFor({ employee: rows[0] }, "fullName"), "Иван Петров", "Copy/export values remain the actual full name");

  const draft = { key: "employee-7", id: 7, fullName: "Иван Сидоров" };
  latest.current = { ...latest.current, drafts: [draft], draftsById: new Map([[7, draft]]), employeeFilterLabels: labels({ rows, drafts: [draft] }) };
  assert.equal(filter.filterParams.valueFormatter({ value: "7" }), "Иван Сидоров", "The same formatter reads refreshed draft labels");
  assert.equal(filter.filterParams.valueFormatter({ value: "8" }), "Иван Петров");
  assert.equal(valueFor({ employee: rows[0] }, "fullName"), "Иван Сидоров");
  assert.equal(filter.filterValueGetter({ data: { employee: rows[0], draft } }), "7", "Editing a name preserves its filter identity");
});

test("employee export scope stays empty while navigation is pending or failed and republishes once filtered", () => {
  const reported = [], navigationVisibility = { current: { pending: true, error: "" } };
  const latest = { current: { onVisibleIdsChange: ids => reported.push(ids) } };
  const reportVisibleRows = bind(["reportVisibleRows"], "reportVisibleRows", { ...hooks, latest, navigationVisibility });
  let visible = rows;
  const pageApi = { isDestroyed: () => false, forEachNodeAfterFilterAndSort: visit => visible.forEach(employee => visit({ data: { employee } })) };
  reportVisibleRows(pageApi);
  assert.deepEqual(reported.pop(), [], "The unfiltered first model cannot leak into export");

  const effects = [];
  function collect(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useLayoutEffect" && node.arguments[0].getText(ast).includes("navigationVisibility.current")) effects.push(node.arguments[0].getText(ast));
    ts.forEachChild(node, collect);
  }
  collect(ast);
  assert.equal(effects.length, 1);
  const code = ts.transpileModule(`const apply = ${effects[0]};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const publishStatus = navigation => new Function("navigation", "navigationVisibility", "pageApi", "reportVisibleRows", `${code}; apply();`)(navigation, navigationVisibility, pageApi, reportVisibleRows);
  visible = [rows[0]];
  reportVisibleRows(pageApi);
  assert.deepEqual(reported.pop(), [], "A final model event during pending still stays protected");
  publishStatus({ pending: false, error: "" });
  assert.deepEqual(reported.pop(), [7], "Settling the pending state republishes the actual filtered rows without another model event");
  publishStatus({ pending: false, error: "Filter failed" });
  assert.deepEqual(reported.pop(), []);
  visible = rows;
  publishStatus({ pending: false, error: "" });
  assert.deepEqual(reported.pop(), [7, 8, 9], "Reset restores the normal full export scope");
});
