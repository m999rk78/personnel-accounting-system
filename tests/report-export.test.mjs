import assert from "node:assert/strict";
import test from "node:test";
import { createEquipmentPlacementXlsx, createPlacementXlsx } from "../app/placementXlsx.ts";

async function workbookText(blob) {
  return new TextDecoder().decode(await blob.arrayBuffer());
}

test("exports personnel reports with the Расстановка1 template layout", async () => {
  const text = await workbookText(createPlacementXlsx("Усть-Луга ГПЗ", "2026-09-01", "2026-09-30", [{
    workDate: "2026-09-01",
    employeeName: "Иванов Иван",
    employmentType: "ОПР",
    department: "МУТТ",
    positionSnapshot: "Монтажник",
    shiftName: "день",
    zoneName: "G4",
    mainWorkTypeName: "Трубопроводы",
    subworkTypeName: "Монтаж",
    masterName: "Петров Пётр",
    hours: 8,
    note: "",
  }]));

  assert.match(text, /sheet name="Расстановка1"/);
  assert.match(text, /<dimension ref="B1:K4"/);
  assert.match(text, /<t xml:space="preserve">ИТОГО ПО ФИЛЬТРУ<\/t>/);
  assert.match(text, /<f>SUBTOTAL\(9,J4:J4\)<\/f><v>8<\/v>/);
  assert.match(text, /autoFilter ref="B3:K4"/);
  assert.match(text, /<c r="C4"[^>]*>.*?<t xml:space="preserve">Иванов Иван<\/t>/);
  assert.match(text, /<c r="K4"[^>]*>.*?<t xml:space="preserve">Монтажник<\/t>/);
});

test("exports equipment reports with the Расстановка2 template layout", async () => {
  const equipmentName = "Кран // SANY 50 т // 1234АА // РХИ";
  const text = await workbookText(createEquipmentPlacementXlsx("Усть-Луга ГПЗ", "2026-09-01", "2026-09-30", [{
    workDate: "2026-09-01",
    equipmentName,
    shiftName: "день",
    zoneName: "G4",
    mainWorkTypeName: "Перемещение",
    subworkTypeName: "Погрузка",
    note: "без замечаний",
    hours: 10,
  }]));

  assert.match(text, /sheet name="Расстановка2"/);
  assert.match(text, /<dimension ref="B1:I4"/);
  assert.match(text, /<f>SUBTOTAL\(9,I4:I4\)<\/f><v>10<\/v>/);
  assert.match(text, /autoFilter ref="B3:I4"/);
  assert.match(text, new RegExp(`<t xml:space="preserve">${equipmentName}<\\/t>`));
  assert.match(text, /<c r="H4"[^>]*>.*?<t xml:space="preserve">без замечаний<\/t>/);
  assert.match(text, /<c r="I4"[^>]*><v>10<\/v>/);
  assert.doesNotMatch(text, /<t xml:space="preserve">Организация<\/t>/);
});
