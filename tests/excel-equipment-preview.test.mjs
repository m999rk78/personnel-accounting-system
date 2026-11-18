import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = await readFile(new URL("../app/ExcelExportPreview.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("ExcelExportPreview.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let equipmentTable;
const visit = node => {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "table"
    && node.openingElement.getText(ast).includes('className="excel-timesheet-preview-table equipment"')) equipmentTable = node;
  ts.forEachChild(node, visit);
};
visit(ast);
assert.ok(equipmentTable, "Expected the actual equipment export preview table");
const compiled = ts.transpileModule(`const Preview = () => (${equipmentTable.getText(ast)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText;

test("equipment preview displays the same work, downtime, manual zero and empty cells as its workbook", () => {
  const environment = {
    React, timesheetDayCount: 5, timesheetDates: [], periodText: () => "Период",
    equipmentTimesheetWorkbook: { monthLabel: "Ноябрь", rows: [{
      equipmentName: "Кран // Тест // А001", equipmentType: "Кран", registrationNumber: "А001",
      dailyValues: ["6 / П 2", "П 8", 4, 0, ""],
      dailyProductiveHours: [6, 0, 4, 0, 0], dailyDowntimeHours: [2, 8, 0, 0, 0],
      productiveHours: 10, downtimeHours: 10, reportHours: 18, totalHours: 20,
    }] },
  };
  const Preview = new Function(...Object.keys(environment), `${compiled}\nreturn Preview;`)(...Object.values(environment));
  const html = renderToStaticMarkup(React.createElement(Preview));
  const days = [...html.matchAll(/<td class="excel-timesheet-day">(.*?)<\/td>/g)].map(match => match[1]);
  assert.deepEqual(days, ["6 / П 2", "П 8", "4", "0", ""]);
});
