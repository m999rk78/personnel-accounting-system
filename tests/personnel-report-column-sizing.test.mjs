import assert from "node:assert/strict";
import test from "node:test";
import { PERSONNEL_REPORT_COLUMN_SIZING, personnelReportColumnWidths } from "../app/personnelReportColumnSizing.ts";

const measure = (text, bold = false) => [...text].length * (bold ? 8 : 7);

test("initial report widths fit every header while hours and short codes stay compact", () => {
  const widths = personnelReportColumnWidths([{ hours: 10, employmentType: "ОПР", shift: "день" }], measure);
  assert.equal(widths.workDate, 125);
  assert.ok(widths.hours >= measure("Часы", true) + 52);
  assert.ok(widths.hours < 100);
  assert.ok(widths.employmentType <= 90);
  assert.ok(widths.employeeName > widths.hours * 2);
  for (const [id, column] of Object.entries(PERSONNEL_REPORT_COLUMN_SIZING)) {
    assert.ok(widths[id] >= measure(column.header, true) + 52, `${column.header} is readable`);
  }
});

test("long names and work descriptions outside the first visible rows determine their own widths", () => {
  const name = "Абдуллаев Мухаммад Абдурахманович Абдурахманов";
  const work = "Монтаж технологических трубопроводов высокого давления";
  const rows = Array.from({ length: 1200 }, () => ({ employeeName: "Иван", mainWork: "Монтаж", hours: 8 }));
  rows.push({ employeeName: name, mainWork: work, hours: 10 });
  const widths = personnelReportColumnWidths(rows, measure);
  assert.ok(widths.employeeName > personnelReportColumnWidths([], measure).employeeName);
  assert.ok(widths.employeeName >= measure(name) + PERSONNEL_REPORT_COLUMN_SIZING.employeeName.cellPadding);
  assert.ok(widths.mainWork >= measure(work) + PERSONNEL_REPORT_COLUMN_SIZING.mainWork.cellPadding);
  assert.equal(widths.hours, personnelReportColumnWidths([{ hours: 8 }], measure).hours);
  assert.equal(widths.zone, personnelReportColumnWidths([], measure).zone, "unrelated columns are not stretched to fill a viewport");
});

test("exceptional notes and descriptions are bounded without changing the supplied data", () => {
  const row = Object.freeze({ note: "Примечание ".repeat(500), position: "Длинная должность ".repeat(200), hours: 10 });
  const rows = Object.freeze([row]);
  const widths = personnelReportColumnWidths(rows, measure);
  assert.equal(widths.note, PERSONNEL_REPORT_COLUMN_SIZING.note.max);
  assert.equal(widths.position, PERSONNEL_REPORT_COLUMN_SIZING.position.max);
  assert.equal(row.note.length, "Примечание ".length * 500);
  assert.equal(rows[0], row);
});

test("empty cells and malformed unfinished text retain readable column defaults", () => {
  const defaults = personnelReportColumnWidths([], measure);
  assert.deepEqual(personnelReportColumnWidths([{ employeeName: null, note: "   ", zone: "", hours: "" }], measure), defaults);
  const pending = "Значение пока не найдено в справочнике проекта";
  const widths = personnelReportColumnWidths([{ zone: pending }], measure);
  assert.ok(widths.zone >= measure(pending) + PERSONNEL_REPORT_COLUMN_SIZING.zone.cellPadding);
});

test("repeated values use bounded measurement work and saturated columns stop being measured", () => {
  let calls = 0;
  const repeated = Array.from({ length: 5000 }, () => ({ employeeName: "Иван Иванович Иванов", zone: "Сборочная площадка", mainWork: "Монтаж", note: "X".repeat(3000) }));
  const widths = personnelReportColumnWidths(repeated, text => { calls++; return measure(text); });
  assert.equal(widths.note, PERSONNEL_REPORT_COLUMN_SIZING.note.max);
  assert.ok(calls < 30, `repeated strings need only ${calls} measurements`);
});

test("non-finite font measurements fall back to bounded usable widths", () => {
  for (const broken of [NaN, Infinity, -1]) {
    const widths = personnelReportColumnWidths([{ employeeName: "Сотрудник со сложным именем", hours: 7 }], () => broken);
    for (const [id, column] of Object.entries(PERSONNEL_REPORT_COLUMN_SIZING)) {
      assert.ok(Number.isFinite(widths[id])); assert.ok(widths[id] >= column.min); assert.ok(widths[id] <= column.max);
    }
  }
});
