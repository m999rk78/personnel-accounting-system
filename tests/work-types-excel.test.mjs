import test from "node:test";
import assert from "node:assert/strict";
import { WORK_TYPES_EXCEL_HEADERS, WORK_TYPES_EXCEL_SHEET, workTypesTemplateRows, workTypesExcelValues } from "../app/workTypesExcel.ts";

test("work-types template always has two named columns and a descriptive worksheet", () => {
  assert.deepEqual(WORK_TYPES_EXCEL_HEADERS, ["Вид работы", "Подвид работы"]);
  assert.equal(WORK_TYPES_EXCEL_SHEET, "Виды и подвиды работ");
  const rows = workTypesTemplateRows();
  assert.equal(rows.length, 25);
  assert.ok(rows.every(row => row.length === 2 && row.every(value => value === "")));
  rows[0][0] = "Вспомогательные работы";
  assert.equal(rows[1][0], "");
});

test("work-type export preserves pairs, empty parents, unassigned subtypes and displayed order", () => {
  const parents = [{ key: "p2", name: "Монтаж" }, { key: "p1", name: "Вспомогательные работы" }, { key: "unassigned", name: "Без вида", unassigned: true }];
  const children = new Map([["p1", [{ name: "Уборка территории" }, { name: "Перевозка персонала" }]], ["unassigned", [{ name: "Старый подвид" }]]]);
  assert.deepEqual(workTypesExcelValues(parents, parent => children.get(parent.key) ?? []), [["Монтаж", ""], ["Вспомогательные работы", "Уборка территории"], ["Вспомогательные работы", "Перевозка персонала"], ["", "Старый подвид"]]);
  assert.deepEqual(workTypesExcelValues([], () => []), []);
});
