import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import { createTableXlsx, createPlacementXlsx, createEquipmentPlacementXlsx, createPlacementTemplateXlsx, createEquipmentPlacementTemplateXlsx, createPersonnelTimesheetXlsx, createEquipmentTimesheetXlsx } from "../app/placementXlsx.ts";

// Inspect the ZIP directory rather than searching the concatenated archive text:
// every assertion therefore checks the actual worksheet Excel will open.
async function parts(blob) {
  assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const bytes = Buffer.from(await blob.arrayBuffer());
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const result = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const packedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const localAt = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString("utf8");
    assert.equal(bytes.readUInt32LE(localAt), 0x04034b50);
    const start = localAt + 30 + bytes.readUInt16LE(localAt + 26) + bytes.readUInt16LE(localAt + 28);
    const payload = bytes.subarray(start, start + packedSize);
    const unpacked = method === 8 ? inflateRawSync(payload) : payload;
    assert.equal(unpacked.length, size, `${name}: wrong ZIP size`);
    result.set(name, unpacked.toString("utf8"));
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) assert.ok(result.has(name), name);
  const styles = result.get("xl/styles.xml");
  assert.match(styles, /<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"\/><\/cellStyleXfs>/);
  assert.match(styles, /<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"\/><\/cellStyles>/);
  return result;
}

function cells(sheet) {
  return new Map([...sheet.matchAll(/<c\b[^>]*r="([A-Z]+\d+)"[^>]*>[\s\S]*?<\/c>/g)].map(([xml, reference]) => [reference, xml]));
}
const number = (value) => Number(value?.match(/<v>([^<]*)<\/v>/)?.[1]);

const person = { workDate: "2026-10-28", employeeName: "Иванов & <Иван>", employmentType: "ОПР", department: "УСР", positionSnapshot: "Монтажник", shiftName: "день", zoneName: "Зона А", mainWorkTypeName: "Монтаж", subworkTypeName: "Подготовка", masterName: "Петров", hours: 8, note: "=SUM(1,2)" };
const equipment = { workDate: "2026-10-28", equipmentName: "Кран // SANY // 00123 // ООО Техника", shiftName: "день", zoneName: "Зона А", mainWorkTypeName: "Монтаж", subworkTypeName: "Подготовка", note: "Тест", hours: 8 };

test("generic XLSX preserves literals, escapes invalid XML controls and has Excel-safe sheet names", async () => {
  const workbook = await parts(createTableXlsx("'Виды / подвиды : [очень длинное название справочника]'", "Работы", ["Название"], [["=1+2"], ["_x0041_"], ["А\u0001Б\r\nВ & <Г>"]]));
  const sheet = workbook.get("xl/worksheets/sheet1.xml");
  assert.match(sheet, /<c r="A4" t="inlineStr"[^>]*>.*?<t xml:space="preserve">=1\+2<\/t>/);
  assert.doesNotMatch(sheet, /<f>/);
  assert.match(sheet, /_x005F_x0041_/);
  assert.match(sheet, /А_x0001_Б_x000D_\nВ &amp; &lt;Г&gt;/);
  assert.doesNotMatch(sheet, /mergeCell ref="A1:A1"/);
  const name = workbook.get("xl/workbook.xml").match(/<sheet name="([^"]*)"/)?.[1];
  assert.ok(name && name.length <= 31);
  assert.ok(![...name].some((character) => "\\/?*[]:".includes(character)));
});

test("generic XLSX handles columns beyond Z, pads short rows and rejects dropping extra values", async () => {
  const headers = Array.from({ length: 35 }, (_, index) => `Колонка ${index + 1}`);
  const workbook = await parts(createTableXlsx("Таблица", "Название", headers, [["Первое", 0]]));
  const sheet = workbook.get("xl/worksheets/sheet1.xml");
  const values = cells(sheet);
  assert.equal(number(values.get("B4")), 0);
  assert.match(values.get("AI4"), /<t xml:space="preserve"><\/t>/);
  assert.match(sheet, /autoFilter ref="A3:AI4"/);
  assert.throws(() => createTableXlsx("Тест", "Тест", ["Один"], [["Один", "Лишний"]]), /больше значений/);
  assert.throws(() => createTableXlsx("Тест", "Тест", [], []), /Не указаны столбцы/);
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => createTableXlsx("Тест", "Тест", ["Часы"], [[value]]), /некорректное числовое значение/);
});

test("personnel and equipment report workbooks retain exact date serials, hours and formula caches", async () => {
  const people = await parts(createPlacementXlsx("Проект", "2026-10-28", "2026-10-28", [person]));
  const machines = await parts(createEquipmentPlacementXlsx("Проект", "2026-10-28", "2026-10-28", [equipment]));
  const peopleCells = cells(people.get("xl/worksheets/sheet1.xml"));
  const machineCells = cells(machines.get("xl/worksheets/sheet1.xml"));
  assert.equal(number(peopleCells.get("B4")), 46323);
  assert.equal(number(machineCells.get("B4")), 46323);
  assert.equal(number(peopleCells.get("J4")), 8);
  assert.equal(number(machineCells.get("I4")), 8);
  assert.match(peopleCells.get("J1"), /<f>SUBTOTAL\(9,J4:J4\)<\/f><v>8<\/v>/);
  assert.match(machineCells.get("I1"), /<f>SUBTOTAL\(9,I4:I4\)<\/f><v>8<\/v>/);
  assert.match(peopleCells.get("H4"), /t="inlineStr"[^>]*>.*?=SUM\(1,2\)/);
  assert.match(peopleCells.get("C4"), /Иванов &amp; &lt;Иван&gt;/);
});

test("both report templates contain useful linked work-type references and exactly their import columns", async () => {
  const common = { shifts: ["день"], zones: ["Зона А"], mainWorkTypes: ["Вспомогательные", "Монтаж"], subworkTypes: ["Уборка", "Подготовка"], workTypePairs: [{ mainWorkTypeName: "Монтаж", subworkTypeName: "Подготовка" }, { mainWorkTypeName: "Вспомогательные", subworkTypeName: "Уборка" }] };
  const personnel = await parts(createPlacementTemplateXlsx("Проект", "2026-10-28", { ...common, employees: [{ fullName: "Иванов", employmentType: "ОПР", department: "УСР", position: "Монтажник" }], masters: ["Петров"] }));
  const machines = await parts(createEquipmentPlacementTemplateXlsx("Проект", "2026-10-28", { ...common, equipmentNames: [equipment.equipmentName] }));
  const referenceCells = cells(personnel.get("xl/worksheets/sheet2.xml"));
  assert.match(referenceCells.get("G2"), />Монтаж<\/t>/);
  assert.match(referenceCells.get("H2"), />Подготовка<\/t>/);
  const equipmentReferenceCells = cells(machines.get("xl/worksheets/sheet2.xml"));
  assert.match(equipmentReferenceCells.get("A2"), />Кран \/\/ SANY \/\/ 00123 \/\/ ООО Техника<\/t>/);
  assert.match(equipmentReferenceCells.get("D2"), />Монтаж<\/t>/);
  assert.match(equipmentReferenceCells.get("E2"), />Подготовка<\/t>/);
  const reportCells = cells(machines.get("xl/worksheets/sheet1.xml"));
  assert.match(reportCells.get("A4"), />Дата<\/t>/);
  assert.match(reportCells.get("H4"), />Часы<\/t>/);
  assert.equal(reportCells.has("I4"), false);
  assert.match(reportCells.get("A5"), />2026-10-28<\/t>/);
  assert.match(reportCells.get("A104"), />2026-10-28<\/t>/);
});

test("equipment timesheet preserves daily downtime and mixed values with correct numeric snapshot summaries", async () => {
  const workbook = await parts(createEquipmentTimesheetXlsx("Проект", "Октябрь", ["2026-10-28", "2026-10-29", "2026-10-30"], [{ equipmentName: equipment.equipmentName, organization: "ООО Техника", equipmentType: "Кран", registrationNumber: "00123", dailyValues: ["6 / П 2", "П 8", 4], dailyProductiveHours: [6, 0, 4], dailyDowntimeHours: [2, 8, 0], dailyReportHours: [8, 8, 2], productiveHours: 10, downtimeHours: 10, reportHours: 18, totalHours: 20 }], [8, 8, 4], 10, 10, 20));
  const sheet = workbook.get("xl/worksheets/sheet1.xml");
  const values = cells(sheet);
  assert.match(values.get("E6"), />6 \/ П 2<\/t>/);
  assert.match(values.get("F6"), />П 8<\/t>/);
  assert.equal(number(values.get("G6")), 4);
  assert.equal(number(values.get("AJ6")), 10);
  assert.equal(number(values.get("AK6")), 10);
  assert.match(values.get("AL6"), /<f>AJ6\+AK6-18<\/f><v>2<\/v>/);
  assert.match(values.get("B8"), />Итого<\/t>/);
  assert.equal(number(values.get("E8")), 8);
  assert.equal(number(values.get("F8")), 8);
  assert.equal(number(values.get("G8")), 4);
  assert.match(values.get("AJ8"), /<f>SUM\(AJ6:AJ6\)<\/f><v>10<\/v>/);
  assert.match(values.get("AK8"), /<f>SUM\(AK6:AK6\)<\/f><v>10<\/v>/);
  assert.doesNotMatch(sheet, /hidden="1"/);
});

test("personnel timesheet exports day totals and differences including absence codes", async () => {
  const workbook = await parts(createPersonnelTimesheetXlsx("Проект", "Октябрь", ["2026-10-28", "2026-10-29"], [{ employmentType: "ОПР", department: "УСР", fullName: "Иванов", position: "Монтажник", positionNote: "", dailyValues: [8, "О"], dailyTimesheetHours: [8, 0], dailyReportHours: [10, 0], dailyMasters: ["Петров", ""], timesheetHours: 8, reportHours: 10, masters: "Петров" }], [8, 0], 8, -2));
  const values = cells(workbook.get("xl/worksheets/sheet1.xml"));
  assert.equal(number(values.get("G4")), 8);
  assert.match(values.get("H4"), />О<\/t>/);
  assert.match(values.get("AL4"), /<f>SUM\(G4:AK4\)<\/f><v>8<\/v>/);
  assert.match(values.get("B8"), />Итого<\/t>/);
  assert.match(values.get("G8"), /<f>SUM\(G4:G4\)<\/f><v>8<\/v>/);
  assert.match(values.get("AL8"), /<f>SUM\(AL4:AL4\)<\/f><v>8<\/v>/);
  assert.match(values.get("AM8"), /<f>SUM\(AM4:AM4\)<\/f><v>-2<\/v>/);
});

test("empty timesheet exports have valid forward ranges and zero total formulas", async () => {
  const people = await parts(createPersonnelTimesheetXlsx("Проект", "Октябрь", [], [], [], 0, 0));
  const machines = await parts(createEquipmentTimesheetXlsx("Проект", "Октябрь", [], [], [], 0, 0, 0));
  assert.match(people.get("xl/worksheets/sheet1.xml"), /autoFilter ref="B3:AN3"/);
  assert.match(machines.get("xl/worksheets/sheet1.xml"), /autoFilter ref="B5:AL5"/);
  assert.match(cells(people.get("xl/worksheets/sheet1.xml")).get("AL8"), /<f>0<\/f><v>0<\/v>/);
  assert.match(cells(machines.get("xl/worksheets/sheet1.xml")).get("AJ7"), /<f>0<\/f><v>0<\/v>/);
});
