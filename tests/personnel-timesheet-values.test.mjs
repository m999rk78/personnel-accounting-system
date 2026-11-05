import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  PERSONNEL_TIMESHEET_CODES, PERSONNEL_TIMESHEET_OPTIONS,
  isPersonnelTimesheetCode, isPersonnelTimesheetHours, isPersonnelTimesheetValue,
} from "../app/personnelTimesheetValues.ts";
import { buildPersonnelTimesheetRange, selectPersonnelTimesheetRange } from "../app/timesheetExportRange.ts";
import { createPersonnelTimesheetXlsx } from "../app/placementXlsx.ts";

const reference = ["10", "9", "8", "В", "Б", "МО", "ДО", "ПЕ", "УВ", "Д", "ПР", "О", "К", "Н", "7", "6", "5", "4", "3", "2", "1", "ЛН", "ЛО"];
const descriptions = {
  В: "Выходные и праздничные дни", Б: "По болезни", МО: "Межвахтовый отдых",
  ДО: "Отпуск без сохранения заработной платы", ПЕ: "Сотрудник переводится на другое СМУ",
  УВ: "Увольнение", Д: "Дорога", ПР: "Прогулы", О: "Отпуск", К: "Командировка",
  Н: "Неявки", ЛН: "Легализация неоплачиваемая", ЛО: "Легализация оплачиваемая",
};

test("the worker timesheet offers every reference value once and in reference order", () => {
  assert.deepEqual(PERSONNEL_TIMESHEET_OPTIONS.map(option => option.value), reference);
  assert.equal(new Set(PERSONNEL_TIMESHEET_OPTIONS.map(option => option.value)).size, 23);
  assert.deepEqual(Object.fromEntries(PERSONNEL_TIMESHEET_CODES.map(code => [code.value, code.label])), descriptions);
  assert.equal(PERSONNEL_TIMESHEET_OPTIONS.some(option => option.value === "0"), false);
  assert.equal(PERSONNEL_TIMESHEET_OPTIONS.find(option => option.value === "1").label, "1 час отработан");
});

test("all thirteen codes and hours one through ten are valid while zero and invalid values remain rejected", () => {
  for (let hours = 1; hours <= 10; hours++) {
    assert.equal(isPersonnelTimesheetHours(hours), true, String(hours));
    assert.equal(isPersonnelTimesheetValue(String(hours)), true, String(hours));
  }
  for (const code of Object.keys(descriptions)) {
    assert.equal(isPersonnelTimesheetCode(code), true, code);
    assert.equal(isPersonnelTimesheetValue(code), true, code);
  }
  for (const value of [0, -1, 11, 1.5, NaN, Infinity]) assert.equal(isPersonnelTimesheetHours(value), false);
  for (const value of ["0", "00", "", " ", "-1", "11", "1.5", "1,5", "1e1", "ББ", "UNKNOWN"]) assert.equal(isPersonnelTimesheetValue(value), false, value);
});

const viewUrl = new URL("../app/TimesheetView.tsx", import.meta.url);
const source = ts.createSourceFile(viewUrl.pathname, await readFile(viewUrl, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const needed = new Set(["effectiveHours", "markValue", "isReportTracked", "isMismatch", "matchesDayFilter"]);
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && needed.has(node.name?.text));
assert.equal(functions.length, needed.size, "Run the actual table value/filter functions");
const compiled = ts.transpileModule(functions.map(node => node.getText(source)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const table = new Function(`${compiled}; return {effectiveHours,markValue,isMismatch,matchesDayFilter};`)();

test("reading an existing numeric zero remains distinct from blank even though new zero input is forbidden", () => {
  const employee = { id: 1, employmentType: "ОПР" };
  const report = { employeeId: 1, hours: 8 };
  const zero = { employeeId: 1, hours: 0, code: null };
  assert.equal(table.markValue(zero, report), "0");
  assert.equal(table.effectiveHours(report, zero), 0);
  assert.equal(table.isMismatch(employee, report, zero), true);
  assert.equal(table.matchesDayFilter(["filled"], employee, undefined, zero), true);
  assert.equal(table.matchesDayFilter(["empty"], employee, undefined, zero), false);
  assert.equal(table.matchesDayFilter(["value:0"], employee, undefined, zero), true);
  assert.equal(table.matchesDayFilter(["manual"], employee, undefined, zero), true);
  assert.equal(table.markValue(undefined, undefined), "");
  assert.equal(table.markValue(undefined, report), "8", "Removing a manual zero restores the report value");
});

test("every non-working code stays visible and counts as zero hours in table filters", () => {
  const employee = { id: 1, employmentType: "ОПР" };
  for (const code of Object.keys(descriptions)) {
    const mark = { employeeId: 1, hours: null, code };
    assert.equal(table.markValue(mark, undefined), code);
    assert.equal(table.effectiveHours({ hours: 8 }, mark), 0);
    assert.equal(table.matchesDayFilter(["filled"], employee, undefined, mark), true);
    assert.equal(table.matchesDayFilter([`value:${code}`], employee, undefined, mark), true);
    assert.equal(table.matchesDayFilter(["empty"], employee, undefined, mark), false);
  }
});

test("range preview and Excel preserve every allowed code plus an existing historical zero and blank day", async () => {
  const employee = { id: 1, fullName: "Учебный сотрудник", employmentType: "ОПР", department: "Отдел", position: "Монтажник" };
  const values = [...reference.map(value => /^\d+$/.test(value) ? Number(value) : value), 0];
  const dates = values.map((_, index) => `2026-11-${String(index + 1).padStart(2, "0")}`);
  const model = buildPersonnelTimesheetRange([{
    employees: [employee],
    entries: [{ employeeId: 1, workDate: dates.at(-1), hours: 8, masters: "", zones: "" }],
    marks: values.map((value, index) => ({ employeeId: 1, workDate: dates[index],
      hours: typeof value === "number" ? value : null, code: typeof value === "string" ? value : null, note: "", updatedBy: "Проверка" })),
  }], "2026-11-01", "2026-11-25");
  assert.deepEqual(model.rows[0].dailyValues, [...values, ""]);
  assert.equal(model.rows[0].dailyTimesheetHours.at(-2), 0);
  assert.equal(model.rows[0].dailyReportHours.at(-2), 8);
  assert.equal(model.totalHours, 55);
  assert.equal(model.totalDifference, 47);
  const selected = selectPersonnelTimesheetRange(model.dates, model.rows, model.dayTotals, "2026-11-24", "2026-11-25");
  assert.deepEqual(selected.rows[0].dailyValues, [0, ""]);

  const workbook = createPersonnelTimesheetXlsx("Учебный проект", "Ноябрь 2026 г.", model.dates, model.rows, model.dayTotals, model.totalHours, model.totalDifference);
  const content = new TextDecoder().decode(await workbook.arrayBuffer());
  assert.match(content, /<c r="AD4"[^>]*><v>0<\/v><\/c>/);
  const blank = content.match(/<c r="AE4"[^>]*>.*?<\/c>/)?.[0];
  assert.ok(blank); assert.doesNotMatch(blank, /<v>/);
  for (const code of Object.keys(descriptions)) assert.ok(content.includes(`>${code}</t>`), code);
});
