import test from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_EXCEL_HEADERS, blankExcelRows, employeesFromExcelNames } from "../app/settingsExcel.ts";

test("settings template headers match their import contracts and blank rows have the full width", () => {
  assert.deepEqual(SETTINGS_EXCEL_HEADERS.employees, ["ФИО", "Тип", "Отдел", "Должность", "Проект"]);
  assert.deepEqual(SETTINGS_EXCEL_HEADERS.positions, ["Тип", "Отдел", "Должность"]);
  for (const headers of Object.values(SETTINGS_EXCEL_HEADERS)) {
    const rows = blankExcelRows(headers.length);
    assert.equal(rows.length, 25);
    assert.ok(rows.every(row => row.length === headers.length));
  }
});

test("employee import resolves unique normalized names and refuses silently choosing a homonym", () => {
  const employees = [{ id: 1, fullName: "Пётр  Иванов" }, { id: 2, fullName: "Анна Тестовая" }];
  assert.deepEqual(employeesFromExcelNames([" анна тестовая ", "петр иванов", "Пётр Иванов"], employees), [employees[1], employees[0]]);
  assert.throws(() => employeesFromExcelNames(["Неизвестный"], employees), /не найден/);
  assert.throws(() => employeesFromExcelNames(["Петр Иванов"], [...employees, { id: 3, fullName: "Петр Иванов" }]), /нескольким сотрудникам/);
});
