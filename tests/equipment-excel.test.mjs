import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { equipmentExcelName } from "../app/equipmentExcel.ts";

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
