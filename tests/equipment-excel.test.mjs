import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { equipmentExcelName } from "../app/equipmentExcel.ts";
import { buildEquipmentTimesheetRange, selectEquipmentTimesheetRange } from "../app/timesheetExportRange.ts";
import { createEquipmentTimesheetXlsx } from "../app/placementXlsx.ts";

test("equipment range export keeps manual zero numeric and leaves untouched days empty", async () => {
  const unit = { id: 7, organization: "Тест", equipmentType: "Кран", brand: "Тест", model: "К-1", registrationNumber: "А001" };
  const range = buildEquipmentTimesheetRange([
    { units: [unit], entries: [{ ...unit, equipmentId: 7, workDate: "2026-11-30", hours: 8, subworkTypeName: "Работа" }], marks: [{ equipmentId: 7, workDate: "2026-11-30", productiveHours: 0, downtimeHours: 0, note: "Проверено", updatedBy: "Инженер" }] },
    { units: [unit], entries: [], marks: [] },
  ], "2026-11-30", "2026-12-01");
  assert.deepEqual(range.rows[0].dailyValues, [0, ""]);
  assert.equal(range.totalHours, 0);
  assert.equal(range.rows[0].reportHours, 8);
  const selected = selectEquipmentTimesheetRange(range.dates, range.rows, range.dayTotals, "2026-11-30", "2026-11-30");
  assert.deepEqual(selected.rows[0].dailyValues, [0]);
  const workbook = createEquipmentTimesheetXlsx("Проект", "Период", range.dates, range.rows, range.dayTotals, range.productiveTotal, range.downtimeTotal, range.totalHours);
  const contents = new TextDecoder().decode(await workbook.arrayBuffer());
  assert.match(contents, /<c r="E6"[^>]*><v>0<\/v><\/c>/);
  assert.doesNotMatch(contents, /<c r="F6"[^>]*><v>0<\/v><\/c>/);
});

test("equipment report and template retain the full identity required by import", () => {
  const unit = {
    equipmentType: "Кран автомобильный",
    brand: "SANY",
    model: "STC250T",
    registrationNumber: "00123А",
    organization: "ООО «Техника»",
  };
  assert.equal(equipmentExcelName(unit), "Кран автомобильный // SANY STC250T // 00123А // ООО «Техника»");
  assert.equal(equipmentExcelName({ ...unit, brand: "", registrationNumber: "" }), "Кран автомобильный // STC250T // - // ООО «Техника»");
});

test("equipment exports use saved grid rows in display order and blank imports never POST", async () => {
  const view = await readFile(new URL("../app/EquipmentAccountingView.tsx", import.meta.url), "utf8");
  assert.match(view, /excelRowsInOrder\(dailyEntries, visibleDailyEntryIds\)/);
  assert.match(view, /excelRowsInOrder\(registryUnits, visibleUnitIds\)/);
  assert.match(view, /excelRowsInOrder\(payload\?\.units \?\? \[\], visibleProjectUnitIds\)/);
  assert.match(view, /const units = await parseEquipmentRegistryXlsx\(file\);\s*if \(!units\.length\) throw new Error/);
  assert.match(view, /const entries = await parseEquipmentEntriesXlsx\(file\);\s*if \(!entries\.length\) throw new Error/);
  assert.match(view, /equipmentNames: payload\.units\.map\(equipmentExcelName\)/);
  assert.match(view, /createEquipmentPlacementTemplateXlsx\(payload\.siteName, workDate, data\)/);
  assert.match(view, /\.\.\.row\.dailyValues,/);
});
