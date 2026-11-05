import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Evaluate the real column factories without mounting React or a database.
async function reportColumns(name) {
  const path = new URL(`../app/${name}.tsx`, import.meta.url);
  const file = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let factory;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "columns" && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(file) === "useMemo") factory = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(factory, `${name}: real column factory exists`);
  const code = ts.transpileModule(`const factory = ${factory.getText(file)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const environment = { valueGetter: () => () => "", renderCell() {}, FilterHeader() {}, activityComparator() {}, personnelFilterParams: {}, personnelReportImportSortOptions: [], personnelReportSortOptions: [], props: { groupByDate: false } };
  return new Function(...Object.keys(environment), `${code}; return factory();`)(...Object.values(environment));
}

for (const [name, primary, initialWidth] of [["PersonnelReportGrid", "employeeName", 250], ["EquipmentReportGrid", "equipment", 280]]) {
  test(`${name} only initializes widths and flex; editor redraws must preserve manual sizes`, async () => {
    const definitions = await reportColumns(name);
    for (const column of definitions.filter(column => column.initialFlex !== undefined)) {
      assert.equal(column.flex, undefined, `${column.colId}: no stateful flex reset`);
      assert.equal(column.width, undefined, `${column.colId}: no stateful width reset`);
      assert.ok(column.initialFlex > 0, `${column.colId}: untouched columns still initially fill the grid`);
      assert.ok(column.minWidth > 0);
    }
    assert.equal(definitions.find(column => column.colId === "zone").initialFlex, 1);
    assert.equal(definitions.find(column => column.colId === "mainWork").initialFlex, 1.3);
    const date = definitions.find(column => column.colId === "workDate");
    assert.equal(date.initialWidth, 125); assert.equal(date.width, undefined);
    assert.equal(date.initialSort, "desc"); assert.equal(date.pinned, "left");
    const identity = definitions.find(column => column.colId === primary);
    assert.equal(identity.initialWidth, initialWidth); assert.equal(identity.width, undefined);
    assert.equal(identity.pinned, "left");
  });
}
