import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { prependUnrankedReportDrafts } from "../app/reportNewRowOrder.ts";
import { orderRowsByIds } from "../app/tableRowOrder.ts";
import { groupPersonnelReportDates } from "../app/personnelReportRowOrder.ts";
import { groupEquipmentReportDates } from "../app/equipmentReportRowOrder.ts";

const source = ts.createSourceFile("GridFilters.tsx", await readFile(new URL("../app/GridFilters.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
const visit = node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "orderedRowData") declaration = node;
  ts.forEachChild(node, visit);
};
visit(source);
assert.ok(declaration, "Use the actual shared grid's row ordering implementation");
const compiled = ts.transpileModule(`const ${declaration.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const getRowOrderId = row => `${row.workDate}/${row.rowKey}`;
function render(rows, ids, scope, hasSavedOrder = false) {
  const rowOrder = { ids, scope, hasSavedOrder, order: (rows, getId) => orderRowsByIds(rows, ids, getId) };
  return new Function("useMemo", "rowOrder", "props", "getRowOrderId", "prependUnrankedReportDrafts", `${compiled}\nreturn orderedRowData;`)(
    callback => callback(), rowOrder, { rowData: rows }, getRowOrderId, prependUnrankedReportDrafts);
}
const uuid = number => `${String(number).padStart(8, "0")}-0000-4000-8000-000000000000`;
const saved = [
  { rowKey: "report-1-11", workDate: "2026-11-20", hours: 4 },
  { rowKey: "report-1-12", workDate: "2026-11-20", hours: 6 },
  { rowKey: "report-2-21", workDate: "2026-11-19", hours: 8 },
];

for (const [scope, groupDates] of [["personnel-report-rows", groupPersonnelReportDates], ["equipment-report-rows", groupEquipmentReportDates]]) {
  test(`${scope}: five consecutive Add clicks appear before today's saved rows immediately`, () => {
    let rows = [...saved];
    const ids = saved.map(getRowOrderId);
    for (let number = 1; number <= 5; number++) {
      rows = [{ rowKey: uuid(number), workDate: "2026-11-20", hours: null }, ...rows];
      const actual = render(rows, ids, scope);
      groupDates(actual, row => row.workDate);
      assert.deepEqual(actual.map(row => row.rowKey), [...Array.from({ length: number }, (_, index) => uuid(number - index)), ...saved.map(row => row.rowKey)]);
      assert.equal(actual.length, saved.length + number);
    }
  });

  test(`${scope}: existing manual placement of a UUID is retained while a newly added row goes first`, () => {
    const moved = { rowKey: uuid(1), workDate: "2026-11-20" }, fresh = { rowKey: uuid(2), workDate: "2026-11-20" };
    const ids = [getRowOrderId(saved[1]), getRowOrderId(moved), getRowOrderId(saved[0]), getRowOrderId(saved[2])];
    const actual = render([fresh, moved, ...saved], ids, scope, true);
    groupDates(actual, row => row.workDate);
    assert.deepEqual(actual.map(getRowOrderId), [getRowOrderId(fresh), ...ids]);
  });

  test(`${scope}: explicit report dates stay grouped and copied batches retain their input order`, () => {
    const batch = [{ rowKey: uuid(2), workDate: "2026-11-19" }, { rowKey: uuid(3), workDate: "2026-11-19" }];
    const input = [...batch, ...saved], before = structuredClone(input);
    const actual = render(input, saved.map(getRowOrderId), scope);
    groupDates(actual, row => row.workDate);
    assert.deepEqual(actual.map(row => row.rowKey), [saved[0].rowKey, saved[1].rowKey, uuid(2), uuid(3), saved[2].rowKey]);
    assert.deepEqual(input, before, "Ordering cannot mutate draft contents or report dates");
  });
}

test("catalogs, monthly timesheets and other scopes retain their established append behavior", () => {
  const fresh = { rowKey: uuid(4), workDate: "2026-11-20" };
  for (const scope of ["employees", "project-personnel", "project-equipment", null]) {
    assert.deepEqual(render([fresh, ...saved], saved.map(getRowOrderId), scope).map(row => row.rowKey), [...saved.map(row => row.rowKey), fresh.rowKey]);
  }
});

test("without new local UUIDs the helper retains the original array and unknown saved records append normally", () => {
  const other = { rowKey: "report-3-31", workDate: "2026-11-20" };
  const rows = [...saved, other];
  assert.equal(prependUnrankedReportDrafts(rows, saved.map(getRowOrderId), getRowOrderId, "personnel-report-rows"), rows);
});
