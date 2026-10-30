import assert from "node:assert/strict";
import test from "node:test";
import { equipmentExcelWorkTypePairs, equipmentReportExcelRows } from "../app/equipmentReportExcel.ts";
import { equipmentExcelName } from "../app/equipmentExcel.ts";

const approved = (key, date = "2026-10-30", patch = {}) => ({
  rowKey: key, workDate: date, status: "approved", draftGroupKey: `entry-${key}`,
  entry: { id: Number(key), equipmentId: 10, equipmentType: "Кран", brand: "Liebherr", model: "LTM", registrationNumber: "А001АА", organization: "Подрядчик", hours: 8, note: "Сохранённая работа" }, ...patch,
});

test("equipment export follows the filtered row order and selection without merging jobs of one unit", () => {
  const rows = [approved("1"), approved("2", "2026-10-29"), approved("3"), approved("4", "2026-10-30", { status: "submitted" })];
  assert.deepEqual(equipmentReportExcelRows(rows, ["3", "4", "2", "gone", "3"], [], []).map(row => [row.id, row.workDate]), [[3, "2026-10-30"], [2, "2026-10-29"]]);
  assert.deepEqual(equipmentReportExcelRows(rows, ["3", "2"], ["1", "2"], []).map(row => row.id), [2]);
  assert.deepEqual(equipmentReportExcelRows(rows, null, [], []).map(row => row.id), [1, 2, 3]);
  assert.equal(equipmentExcelName(equipmentReportExcelRows(rows, ["1"], [], [])[0]), "Кран // Liebherr LTM // А001АА // Подрядчик");
});

test("equipment export never falls back to hidden rows or another workflow view", () => {
  for (const visible of [[], ["gone"]]) assert.throws(() => equipmentReportExcelRows([approved("1")], visible, [], []), /нет подтверждённых записей/);
  assert.throws(() => equipmentReportExcelRows([approved("1")], ["1"], ["2"], []), /выбранных видимых/);
  for (const status of ["draft", "submitted", "rejected"]) assert.throws(() => equipmentReportExcelRows([approved("1", "2026-10-30", { status })], null, [], []), /нет подтверждённых записей/);
});

test("equipment export blocks unsaved changes only when they affect exported approved snapshots", () => {
  const rows = [approved("1"), approved("2", "2026-10-29", { proposalId: 45 })];
  assert.throws(() => equipmentReportExcelRows(rows, null, [], ["entry-1"]), /несохранённые изменения/);
  assert.throws(() => equipmentReportExcelRows(rows, null, [], ["45"]), /несохранённые изменения/);
  assert.deepEqual(equipmentReportExcelRows(rows, ["2"], [], ["entry-1"]).map(row => row.id), [2]);
  assert.deepEqual(equipmentReportExcelRows(rows, ["1", "2"], [], ["new:2026-10-30"]).map(row => row.id), [1, 2]);
});

test("equipment template references keep identical subtype names linked to their own parent", () => {
  assert.deepEqual(equipmentExcelWorkTypePairs([{ id: 1, name: "Монтаж" }, { id: 2, name: "Вспомогательные" }, { id: 3, name: "Пустой вид" }], [
    { id: 10, name: "Подготовка", mainWorkTypeId: 1 }, { id: 11, name: "Подготовка", mainWorkTypeId: 2 }, { id: 12, name: "Сирота", mainWorkTypeId: null },
  ]), [
    { mainWorkTypeName: "Монтаж", subworkTypeName: "Подготовка" }, { mainWorkTypeName: "Вспомогательные", subworkTypeName: "Подготовка" }, { mainWorkTypeName: "Пустой вид", subworkTypeName: "" },
  ]);
});
