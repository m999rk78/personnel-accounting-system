import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { EQUIPMENT_REPORT_COLUMN_SIZING, equipmentReportColumnWidths } from "../app/equipmentReportColumnSizing.ts";
import { equipmentOptionFields, equipmentSpreadsheetName } from "../app/equipmentSpreadsheet.ts";
import { personnelActivityTime } from "../app/personnelReportSorting.ts";

const measure = (text, bold = false) => [...text].length * (bold ? 8 : 7);

test("equipment defaults keep all headings readable and numeric hours compact", () => {
  const widths = equipmentReportColumnWidths([{ hours: 10, shift: "день" }], measure);
  assert.equal(widths.workDate, 125);
  assert.ok(widths.hours < 100);
  for (const [id, column] of Object.entries(EQUIPMENT_REPORT_COLUMN_SIZING)) {
    assert.ok(widths[id] >= measure(column.header, true) + 52, `${column.header} is readable`);
  }
});

test("late equipment, organizations, model names and work descriptions size independently of the viewport", () => {
  const defaults = equipmentReportColumnWidths([], measure);
  const row = {
    equipment: "Подъёмник телескопический самоходный HAULOTTE H43TPX — 43 метра",
    organization: "Трубопроводные производственные системы",
    model: "Телескопический подъёмник с рабочей высотой 43 метра",
    mainWork: "Монтаж технологических трубопроводов высокого давления",
  };
  const rows = Array.from({ length: 1500 }, () => ({ equipment: "Кран", organization: "ТПС", model: "32м", mainWork: "Монтаж" }));
  rows.push(row);
  const widths = equipmentReportColumnWidths(rows, measure);
  for (const [id, value] of Object.entries(row)) {
    const column = EQUIPMENT_REPORT_COLUMN_SIZING[id];
    assert.ok(widths[id] > defaults[id]);
    assert.equal(widths[id], Math.min(column.max, Math.max(column.min, measure(value) + column.cellPadding)));
  }
  assert.equal(widths.hours, defaults.hours);
  assert.equal(widths.registrationNumber, defaults.registrationNumber);
});

test("large equipment reports reuse repeated measurements and bound exceptional notes safely", () => {
  let calls = 0;
  const row = Object.freeze({ equipment: "Кран SANY 80 тонн", zone: "Технологическая площадка", note: "Очень длинное примечание ".repeat(500) });
  const rows = Object.freeze(Array.from({ length: 5000 }, () => row));
  const widths = equipmentReportColumnWidths(rows, (text, bold) => { calls++; return measure(text, bold); });
  assert.equal(widths.note, EQUIPMENT_REPORT_COLUMN_SIZING.note.max);
  assert.ok(calls < 30);
  assert.equal(rows[4999], row);
  for (const broken of [NaN, Infinity, -1]) {
    const fallback = equipmentReportColumnWidths([row], () => broken);
    for (const [id, column] of Object.entries(EQUIPMENT_REPORT_COLUMN_SIZING)) {
      assert.ok(Number.isFinite(fallback[id]) && fallback[id] >= column.min && fallback[id] <= column.max);
    }
  }
});

// Exercise the real display getter used by both sizing and grid cells: sizing
// must retain published snapshots when catalogue labels have since changed.
const url = new URL("../app/EquipmentReportGrid.tsx", import.meta.url);
const file = ts.createSourceFile(url.pathname, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "valueFor");
assert.ok(declaration);
const source = ts.transpileModule(declaration.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const valueFor = new Function("equipmentSpreadsheetName", "optionFields", "personnelActivityTime", "displayDate", "statusLabels", `${source}; return valueFor;`)(equipmentSpreadsheetName, equipmentOptionFields, personnelActivityTime, date => date.split("-").reverse().join("."), { approved: "Подтверждён" });

test("indexed sizing values match visible snapshots, changed equipment and unfinished draft text", () => {
  const unit = { id: 1, name: "Новый каталог", organization: "Новая организация", equipmentType: "Кран", model: "80 тонн", registrationNumber: "А001АА", brand: "SANY" };
  const props = { units: [unit], shifts: [], zones: [{ id: 5, name: "Новое название зоны" }], mainWorkTypes: [], subworkTypes: [] };
  const index = { units: new Map([[1, unit]]), options: Object.fromEntries(["shifts", "zones", "mainWorkTypes", "subworkTypes"].map(field => [field, new Map(props[field].map(option => [option.id, option]))])) };
  const entry = { equipmentId: 1, equipmentName: "Опубликованная техника", organization: "Старая организация", zoneId: 5, zoneName: "Опубликованная зона", hours: 8 };
  const published = { workDate: "2026-11-09", status: "approved", entry, draft: { equipmentId: "1", zoneId: "5", hours: "8" } };
  for (const field of Object.keys(EQUIPMENT_REPORT_COLUMN_SIZING)) assert.equal(valueFor(published, field, props, index), valueFor(published, field, props), field);
  assert.equal(valueFor(published, "organization", props, index), "Старая организация");
  assert.equal(valueFor(published, "zone", props, index), "Опубликованная зона");
  const changed = { ...published, entry: { ...entry, equipmentId: 2 }, draft: { ...published.draft, inputValues: { zone: "Ещё не найденное значение" }, hours: "ошибка" } };
  assert.equal(valueFor(changed, "organization", props, index), unit.organization);
  assert.equal(valueFor(changed, "zone", props, index), "Ещё не найденное значение");
  assert.equal(valueFor(changed, "hours", props, index), "ошибка");
});
