import test from "node:test";
import assert from "node:assert/strict";
import { excelFileName, excelRowsInOrder } from "../app/excelFiles.ts";

test("Excel filenames identify the table, project and period without unsafe path characters", () => {
  assert.equal(excelFileName("Шаблон видов и подвидов работ", ["Проект / Север: 1"]), "Шаблон_видов_и_подвидов_работ_Проект_Север_1.xlsx");
  assert.equal(excelFileName("Табель персонала", ["Объект", "2026-10"]), "Табель_персонала_Объект_2026-10.xlsx");
  assert.equal(excelFileName("Сотрудники.xlsx"), "Сотрудники.xlsx");
  assert.equal(excelFileName("...", ["???"]), "Таблица.xlsx");
  assert.equal(excelFileName("CON"), "Таблица_CON.xlsx");
  assert.ok(Array.from(excelFileName("Очень длинное название ".repeat(30))).length <= 185);
});

test("Excel exports retain the grid's order and exclude filtered rows without dropping zero IDs", () => {
  const rows = [{ id: 1, name: "А" }, { id: 2, name: "Б" }, { id: 0, name: "В" }];
  assert.deepEqual(excelRowsInOrder(rows, [2, 0]), [rows[1], rows[2]]);
  assert.deepEqual(excelRowsInOrder(rows, []), []);
  assert.deepEqual(excelRowsInOrder(rows, null), rows);
  assert.deepEqual(excelRowsInOrder(rows, [99, 1]), [rows[0]]);
});
