import assert from "node:assert/strict";
import test from "node:test";
import { equipmentCellErrors, equipmentImportedUnitOrder, equipmentSpreadsheetName, equipmentUnavailableFor, pasteEquipmentCells, timestampEquipmentDraft } from "../app/equipmentSpreadsheet.ts";
import { equipmentExcelName } from "../app/equipmentExcel.ts";

const unit = { id: 1, organization: "Подрядчик", equipmentType: "Кран", brand: "Ивановец", model: "КС-45717", registrationNumber: "А123АА", note: "" };
const catalogs = {
  units: [unit], shifts: [{ id: 1, name: "День" }], zones: [{ id: 2, name: "Зона А" }],
  mainWorkTypes: [{ id: 3, name: "Монтаж" }, { id: 4, name: "Вспомогательные" }],
  subworkTypes: [{ id: 5, name: "Установка конструкций", mainWorkTypeId: 3 }, { id: 6, name: "Уборка территории", mainWorkTypeId: 4 }],
};
const blank = { key: "one", equipmentId: "", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", hours: "", note: "" };
const complete = { ...blank, equipmentId: "1", shiftId: "1", zoneId: "2", mainWorkTypeId: "3", subworkTypeId: "5", hours: "8" };

test("saving one imported equipment date retains workbook order and later resolved identities from other dates", () => {
  const batches = [{ id: "workbook", rows: [{ key: "day-one", equipmentId: "2" }, { key: "day-two", equipmentId: "" }, { key: "again", equipmentId: "2" }, { key: "last", equipmentId: "3" }] }];
  const dayOne = [{ ...complete, key: "day-one", equipmentId: "2", importBatchId: "workbook" }];
  const dayTwo = { ...complete, key: "day-two", equipmentId: "1", importBatchId: "workbook" };
  assert.deepEqual(equipmentImportedUnitOrder(dayOne, batches, [...dayOne, dayTwo]), [2, 1, 3]);
  assert.equal(equipmentImportedUnitOrder([{ ...complete }], batches), undefined);
  assert.equal(batches[0].rows[1].equipmentId, "", "Reading import order never mutates the source workbook snapshot");
});

test("equipment import order uses only the latest relevant workbook and ignores unresolved or invalid identities", () => {
  const batches = [{ id: "old", rows: [{ key: "old-row", equipmentId: "9" }] }, { id: "latest", rows: [{ key: "new-row", equipmentId: "7" }, { key: "missing", equipmentId: "" }, { key: "invalid", equipmentId: "bad" }, { key: "zero", equipmentId: "0" }] }, { id: "unrelated", rows: [{ key: "else", equipmentId: "99" }] }];
  const drafts = [{ ...complete, key: "old-row", equipmentId: "9", importBatchId: "old" }, { ...complete, key: "new-row", equipmentId: "7", importBatchId: "latest" }];
  assert.deepEqual(equipmentImportedUnitOrder(drafts, batches), [7]);
});

test("equipment paste accepts the full exported identity, but never guesses ambiguous display names", () => {
  const duplicateTitle = { ...unit, id: 2, organization: "Другая организация" };
  const references = { ...catalogs, units: [unit, duplicateTitle] };
  const ambiguous = pasteEquipmentCells(blank, { equipment: equipmentSpreadsheetName(unit) }, references);
  assert.equal(ambiguous.equipmentId, "");
  assert.equal(ambiguous.inputValues.equipment, equipmentSpreadsheetName(unit));
  assert.ok(equipmentCellErrors(ambiguous, references).equipment);
  const resolved = pasteEquipmentCells(ambiguous, { equipment: equipmentExcelName(duplicateTitle) }, references);
  assert.equal(resolved.equipmentId, "2");
  assert.equal(resolved.inputValues.equipment, undefined);
  assert.equal(resolved.equipmentQuery, equipmentSpreadsheetName(duplicateTitle));
  assert.equal(pasteEquipmentCells(blank, { equipment: "1" }, references).equipmentId, "1");
});

test("short equipment labels reject collisions while previously copied full labels still identify the unit", () => {
  const sameShortLabel = { ...unit, id: 2, equipmentType: "Автокран", brand: "Другая марка" };
  const references = { ...catalogs, units: [unit, sameShortLabel] };
  const ambiguous = pasteEquipmentCells(blank, { equipment: "КС-45717 // А123АА" }, references);
  assert.equal(ambiguous.equipmentId, "");
  assert.ok(equipmentCellErrors(ambiguous, references).equipment);
  for (const equipment of ["Кран Ивановец КС-45717 • А123АА", "Кран Ивановец КС-45717 • А123АА · Подрядчик"]) {
    const pasted = pasteEquipmentCells(blank, { equipment }, references);
    assert.equal(pasted.equipmentId, "1");
    assert.equal(pasted.equipmentQuery, "КС-45717 // А123АА");
    assert.equal(pasted.inputValues.equipment, undefined);
  }
});

test("a mixed paste preserves invalid text without dropping valid neighbouring values", () => {
  const pasted = pasteEquipmentCells(blank, { equipment: "Неизвестный кран", shift: "день", zone: "Нет такой зоны", hours: "15", note: "Сохранить примечание" }, catalogs);
  assert.equal(pasted.shiftId, "1");
  assert.equal(pasted.note, "Сохранить примечание");
  assert.equal(pasted.inputValues.zone, "Нет такой зоны");
  assert.deepEqual(Object.keys(equipmentCellErrors(pasted, catalogs)).sort(), ["equipment", "hours", "zone"]);
  const repaired = pasteEquipmentCells(pasted, { equipment: equipmentSpreadsheetName(unit), zone: "Зона А", hours: "7,0" }, catalogs);
  assert.equal(repaired.equipmentId, "1");
  assert.equal(repaired.hours, "7");
  assert.deepEqual(equipmentCellErrors(repaired, catalogs), {});
  assert.equal(blank.note, "");
});

test("changing the parent work type clears an incompatible child, while a combined paste resolves the new pair", () => {
  const parentOnly = pasteEquipmentCells(complete, { mainWork: "Вспомогательные" }, catalogs);
  assert.equal(parentOnly.mainWorkTypeId, "4");
  assert.equal(parentOnly.subworkTypeId, "");
  const both = pasteEquipmentCells(complete, { mainWork: "Вспомогательные", subwork: "Уборка территории" }, catalogs);
  assert.equal(both.subworkTypeId, "6");
  assert.deepEqual(equipmentCellErrors(both, catalogs, true), {});
  const badPair = pasteEquipmentCells(complete, { mainWork: "Вспомогательные", subwork: "Установка конструкций" }, catalogs);
  assert.equal(badPair.inputValues.subwork, "Установка конструкций");
  assert.ok(equipmentCellErrors(badPair, catalogs, true).subwork);
});

test("availability warnings apply only to the affected unit and date, and mixed work marks stay available", () => {
  const references = { ...catalogs, workDate: "2026-10-30", dailyTimesheetMarks: [
    { equipmentId: 1, workDate: "2026-10-30", productiveHours: 0, downtimeHours: 8, note: "В ремонте" },
    { equipmentId: 1, workDate: "2026-10-29", productiveHours: 8, downtimeHours: 2, note: "Частичный простой" },
  ] };
  assert.match(equipmentCellErrors(complete, references).equipment, /В ремонте/);
  assert.deepEqual(equipmentCellErrors(complete, references, false, "2026-10-29"), {});
  assert.equal(equipmentUnavailableFor(references, 2, "2026-10-30"), undefined);
  assert.equal(equipmentUnavailableFor(references, 1, "2026-10-28"), undefined);
});

test("locked historic equipment stays unchanged during paste, required cells and note limits stay enforced", () => {
  const historic = { ...complete, equipmentId: "99", lockedEquipment: true };
  const pasted = pasteEquipmentCells(historic, { equipment: "1", hours: "5" }, catalogs);
  assert.equal(pasted.equipmentId, "99");
  assert.equal(pasted.hours, "5");
  assert.deepEqual(equipmentCellErrors(pasted, catalogs, true), {});
  assert.equal(Object.keys(equipmentCellErrors(blank, catalogs, true)).length, 6);
  assert.ok(equipmentCellErrors({ ...complete, note: "x".repeat(4001) }, catalogs).note);
});

test("no-op commits preserve timestamps, but a content edit updates only its modification time", () => {
  const previous = { ...complete, createdAt: "2026-10-29T10:00:00Z", updatedAt: "2026-10-29T11:00:00Z" };
  assert.equal(timestampEquipmentDraft(previous, { ...previous }), previous);
  const changed = timestampEquipmentDraft(previous, { ...previous, hours: "5" }, "2026-10-30T08:00:00Z");
  assert.equal(changed.createdAt, previous.createdAt);
  assert.equal(changed.updatedAt, "2026-10-30T08:00:00Z");
  assert.equal(previous.hours, "8");
});

test("approved snapshots permit unchanged archived references, without permitting new historical combinations", () => {
  const archived = { ...complete, equipmentId: "99", shiftId: "91", zoneId: "92", mainWorkTypeId: "93", subworkTypeId: "95", referenceIds: { equipmentId: 99, shiftId: 91, zoneId: 92, mainWorkTypeId: 93, subworkTypeId: 95 } };
  assert.deepEqual(equipmentCellErrors({ ...archived, note: "Исправление старого отчёта" }, catalogs, true), {});
  assert.ok(equipmentCellErrors({ ...archived, shiftId: "96" }, catalogs, true).shift);
  assert.ok(equipmentCellErrors({ ...archived, mainWorkTypeId: "4" }, catalogs, true).subwork);
  assert.ok(equipmentCellErrors({ ...archived, inputValues: { shift: "Неверное значение" } }, catalogs, true).shift);
  const { referenceIds, ...fresh } = archived;
  assert.ok(referenceIds);
  assert.deepEqual(Object.keys(equipmentCellErrors(fresh, catalogs, true)).sort(), ["equipment", "mainWork", "shift", "subwork", "zone"]);
});
