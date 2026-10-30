import assert from "node:assert/strict";
import test from "node:test";
import { personnelExcelWorkTypePairs, personnelReportExcelRows } from "../app/personnelReportExcel.ts";
import { createPlacementTemplateXlsx } from "../app/placementXlsx.ts";

const approved = (key, date = "2026-10-28", patch = {}) => ({
  rowKey: key, workDate: date, status: "approved", draftGroupKey: `entry-${key}`,
  entry: { id: Number(key) || 1, employeeName: key, hours: 8, note: "Сохранённая запись" }, ...patch,
});

test("personnel export uses the current grid order and selected visible approved rows only", () => {
  const rows = [approved("1"), approved("2", "2026-10-27"), approved("3"), { ...approved("4"), status: "draft" }];
  assert.deepEqual(personnelReportExcelRows(rows, ["3", "4", "2", "missing"], [], []).map(row => [row.id, row.workDate]), [[3, "2026-10-28"], [2, "2026-10-27"]]);
  assert.deepEqual(personnelReportExcelRows(rows, ["3", "2"], ["2", "1"], []).map(row => row.id), [2]);
  assert.deepEqual(personnelReportExcelRows(rows, null, [], []).map(row => row.id), [1, 2, 3]);
});

test("personnel export never falls back to other workflow views or hidden rows", () => {
  const currentView = [approved("1")];
  assert.throws(() => personnelReportExcelRows(currentView, ["2"], [], []), /нет подтверждённых записей/);
  assert.throws(() => personnelReportExcelRows(currentView, [], [], []), /нет подтверждённых записей/);
  assert.throws(() => personnelReportExcelRows(currentView, ["1"], ["2"], []), /выбранных видимых/);
  assert.throws(() => personnelReportExcelRows([{ ...approved("1"), status: "submitted" }], null, [], []), /нет подтверждённых записей/);
});

test("approved export requires saving edited entries and reports before using their snapshots", () => {
  const entries = [approved("1"), approved("2", "2026-10-28", { proposalId: 45 })];
  assert.throws(() => personnelReportExcelRows(entries, null, [], ["entry-1"]), /несохранённые изменения/);
  assert.throws(() => personnelReportExcelRows(entries, null, [], ["45"]), /несохранённые изменения/);
  assert.deepEqual(personnelReportExcelRows(entries, ["2"], [], ["entry-1"]).map(row => row.id), [2]);
  assert.deepEqual(personnelReportExcelRows(entries, ["1", "1", "2"], [], ["new:2026-10-29"]).map(row => row.id), [1, 2]);
});

test("personnel workbook references keep repeated child names under the right parents", async () => {
  const pairs = personnelExcelWorkTypePairs([
    { id: 20, name: "Земляные работы" }, { id: 10, name: "Вспомогательные" }, { id: 30, name: "Пустой вид" },
  ], [
    { id: 1, name: "Подготовка", mainWorkTypeId: 10 }, { id: 2, name: "Подготовка", mainWorkTypeId: 20 },
    { id: 3, name: "Уборка территории", mainWorkTypeId: 10 }, { id: 4, name: "Не назначен", mainWorkTypeId: null },
    { id: 5, name: "Другой проект", mainWorkTypeId: 999 },
  ]);
  assert.deepEqual(pairs, [
    { mainWorkTypeName: "Земляные работы", subworkTypeName: "Подготовка" },
    { mainWorkTypeName: "Вспомогательные", subworkTypeName: "Подготовка" },
    { mainWorkTypeName: "Вспомогательные", subworkTypeName: "Уборка территории" },
    { mainWorkTypeName: "Пустой вид", subworkTypeName: "" },
  ]);
  const blob = createPlacementTemplateXlsx("Тестовый проект", "2026-10-29", {
    employees: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], workTypePairs: pairs,
  });
  const text = new TextDecoder().decode(await blob.arrayBuffer());
  assert.match(text, /Земляные работы/);
  assert.match(text, /Уборка территории/);
  assert.match(text, /Пустой вид/);
  assert.doesNotMatch(text, /Другой проект/);
});
