import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { buildEquipmentTimesheetRange, monthKeysInRange } from "../app/timesheetExportRange.ts";

const source = await readFile(new URL("../app/ExcelExportPreview.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("ExcelExportPreview.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
const visit = node => {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
};
visit(ast);
const code = ["rangeInsideDates", "dateHeaders", "loadExportRange"].map(name => {
  assert.ok(functions.has(name), `Expected actual implementation: ${name}`);
  return functions.get(name);
}).join("\n");
const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

const unit = id => ({ id, organization: "Организация", equipmentType: "Кран", brand: "Марка", model: String(id), registrationNumber: `ГРЗ-${id}` });
const monthData = date => ({
  units: [unit(7), unit(8)],
  entries: [7, 8, 9].map(equipmentId => ({ ...unit(equipmentId), equipmentId, workDate: date, hours: 8, subworkTypeName: "Работа" })),
  marks: [7, 8, 9].map(equipmentId => ({ equipmentId, workDate: date, productiveHours: 4, downtimeHours: 2, note: "", updatedBy: "Инженер" })),
});

async function expandPreview(equipmentIds) {
  const original = {
    source: { kind: "equipment-timesheet", siteId: 1, siteName: "Проект", equipmentIds },
    workbook: { kind: "equipment-timesheet", siteName: "Проект", dates: ["2026-11-01", "2026-11-30"] },
  };
  const requests = [], errors = [], results = [];
  const months = { "2026-11": monthData("2026-11-30"), "2026-12": monthData("2026-12-01") };
  const before = structuredClone(months);
  const environment = {
    payload: original, baseTimesheetPayload: original, buildEquipmentTimesheetRange, monthKeysInRange,
    setRangeLoading() {}, setRangeError: error => { if (error) errors.push(error); }, setDownloadError() {}, setDownloaded() {},
    setWaitingForEnd() {}, setCalendarOpen() {}, setPayload: result => results.push(result),
    periodText: (start, end) => `${start} — ${end}`, excelFileName: () => "Табель.xlsx",
    fetch: async url => {
      requests.push(url);
      const month = new URL(url, "http://localhost").searchParams.get("month");
      return { ok: true, json: async () => months[month] };
    },
  };
  const loadRange = new Function(...Object.keys(environment), `${compiled}\nreturn loadExportRange;`)(...Object.values(environment));
  await loadRange("2026-11-30", "2026-12-01");
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 2);
  assert.equal(results.length, 1);
  assert.deepEqual(months, before, "A scoped export must not mutate the complete month data");
  return results[0];
}

test("equipment export keeps its selected unit when expanding the date range", async () => {
  const result = await expandPreview([7]);
  assert.deepEqual(result.workbook.rows.map(row => row.registrationNumber), ["ГРЗ-7"]);
  assert.deepEqual(result.workbook.dates, ["2026-11-30", "2026-12-01"]);
  assert.deepEqual(result.workbook.dayTotals, [6, 6]);
  assert.equal(result.workbook.totalHours, 12);
  assert.equal(result.workbook.rows[0].reportHours, 16);
  assert.deepEqual(result.source.equipmentIds, [7]);
});

test("equipment export preserves an empty selection and the unfiltered roster distinctly", async () => {
  const empty = await expandPreview([]);
  assert.deepEqual(empty.workbook.rows, []);
  assert.deepEqual(empty.workbook.dayTotals, [0, 0]);
  assert.equal(empty.workbook.totalHours, 0);
  const full = await expandPreview(undefined);
  assert.deepEqual(full.workbook.rows.map(row => row.registrationNumber), ["ГРЗ-7", "ГРЗ-8", "ГРЗ-9"]);
  assert.deepEqual(full.workbook.dayTotals, [18, 18]);
  assert.equal(full.workbook.totalHours, 36);
});
