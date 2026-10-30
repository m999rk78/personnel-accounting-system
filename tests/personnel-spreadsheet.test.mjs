import assert from "node:assert/strict";
import test from "node:test";
import { pastePersonnelCells, personnelCellErrors, draftHistoryReducer } from "../app/personnelSpreadsheet.ts";
import { parseSpreadsheetText, serializeSpreadsheetText } from "../app/spreadsheetClipboard.ts";

const catalogs = { employees: [{ id: 1, fullName: "Пётр Иванов" }], shifts: [{ id: 1, name: "День" }], zones: [{ id: 2, name: "Зона А" }], mainWorkTypes: [], subworkTypes: [], masters: [] };
const blank = { key: "one", employeeId: "", employeeQuery: "", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", masterId: "", hours: "", note: "" };

test("mixed paste keeps bad text and all valid neighbouring cells without changing the source", () => {
  const result = pastePersonnelCells(blank, { employeeName: "Петр Иванов", shift: "день", zone: "Несуществующая зона", hours: "15", note: "Сохранить текст" }, catalogs);
  assert.equal(result.employeeId, "1");
  assert.equal(result.shiftId, "1");
  assert.equal(result.zoneId, "");
  assert.equal(result.inputValues.zone, "Несуществующая зона");
  assert.equal(result.hours, "15");
  assert.equal(result.note, "Сохранить текст");
  assert.deepEqual(Object.keys(personnelCellErrors(result, catalogs)).sort(), ["hours", "zone"]);
  assert.equal(blank.note, "");
  const fixed = pastePersonnelCells(result, { zone: "Зона А", hours: "7,0" }, catalogs);
  assert.equal(fixed.zoneId, "2");
  assert.equal(fixed.hours, "7");
  assert.deepEqual(personnelCellErrors(fixed, catalogs), {});
  assert.equal(result.inputValues.zone, "Несуществующая зона");
});

test("clearing errors, locked identities and ambiguous employees are handled per cell", () => {
  const bad = pastePersonnelCells(blank, { employeeName: "Неизвестный", shift: "Неверно" }, catalogs);
  assert.deepEqual(Object.keys(personnelCellErrors(bad, catalogs)), ["employeeName", "shift"]);
  assert.deepEqual(personnelCellErrors(pastePersonnelCells(bad, { employeeName: "", shift: "" }, catalogs), catalogs), {});
  const locked = pastePersonnelCells({ ...blank, employeeId: "1", employeeQuery: "Пётр Иванов", lockedEmployee: true }, { employeeName: "Другой", hours: "5" }, catalogs);
  assert.equal(locked.employeeId, "1");
  assert.equal(locked.hours, "5");
  const duplicate = pastePersonnelCells(blank, { employeeName: "Петр Иванов" }, { ...catalogs, employees: [...catalogs.employees, { id: 3, fullName: "Пётр Иванов" }] });
  assert.ok(personnelCellErrors(duplicate, catalogs).employeeName);
  assert.equal(Object.keys(personnelCellErrors(blank, catalogs, true)).length, 7);
});

test("bulk history restores invalid text and appended rows in one undo/redo step", () => {
  const initial = { new: [blank] };
  const inserted = { new: [pastePersonnelCells(blank, { zone: "Нет такой зоны" }, catalogs), { ...blank, key: "two", hours: "5" }] };
  let state = draftHistoryReducer({ present: initial, past: [], future: [] }, { type: "change", update: inserted });
  state = draftHistoryReducer(state, { type: "undo" });
  assert.deepEqual(state.present, initial);
  state = draftHistoryReducer(state, { type: "redo" });
  assert.deepEqual(state.present, inserted);
  state = draftHistoryReducer(state, { type: "reset", value: {} });
  assert.deepEqual(state.past, []);
  assert.deepEqual(state.future, []);
});

test("Excel clipboard round-trips tabs, multiline notes, quotes, blank cells and CRLF", () => {
  const matrix = [["ФИО", "строка\nпродолжение", 'текст "в кавычках"', ""], ["Пётр", "значение\tс табом", "", "7"]];
  assert.deepEqual(parseSpreadsheetText(serializeSpreadsheetText(matrix)), matrix);
  assert.deepEqual(parseSpreadsheetText("День\t5\r\nНочь\t7\r\n"), [["День", "5"], ["Ночь", "7"]]);
  assert.deepEqual(parseSpreadsheetText(""), [[""]]);
});
