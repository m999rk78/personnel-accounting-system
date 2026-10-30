import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT_MASTER_POSITIONS, normalizeProjectMasterText, isProjectMasterPosition, planProjectMasters } from "../app/projectMasters.ts";

const employee = (id, fullName = `Сотрудник ${id}`, position = PROJECT_MASTER_POSITIONS[0]) => ({ id, fullName, position });
const master = (id, employeeId, name, active = 1) => ({ id, employeeId, name, active });

test("automatic masters accept the two specified positions without broad substring matching", () => {
  assert.deepEqual(PROJECT_MASTER_POSITIONS, ["Мастер участка строительных конструкций", "Мастер участка технологических трубопроводов"]);
  for (const position of PROJECT_MASTER_POSITIONS) {
    assert.equal(isProjectMasterPosition(position), true);
    assert.equal(isProjectMasterPosition(`  ${position.toLocaleUpperCase("ru-RU").replaceAll(" ", "  ")}  `), true);
    assert.equal(isProjectMasterPosition(`Старший ${position}`), false);
  }
  assert.equal(normalizeProjectMasterText("  Пётр\t ИВАНОВ\n"), "петр иванов");
  assert.equal(isProjectMasterPosition("Мастер строительно-монтажных работ"), false);
  assert.equal(isProjectMasterPosition("Мастер"), false);
  assert.equal(isProjectMasterPosition(""), false);
});

test("project masters are created only for eligible positions and repeated reconciliation is idempotent", () => {
  const people = [employee(1), employee(2, "Второй мастер", PROJECT_MASTER_POSITIONS[1]), employee(3, "Монтажник", "Монтажник")];
  const first = planProjectMasters(people, []);
  assert.deepEqual(first, { updates: [], inserts: [{ employeeId: 1, name: "Сотрудник 1" }, { employeeId: 2, name: "Второй мастер" }] });
  assert.deepEqual(planProjectMasters(people, first.inserts.map((row, index) => master(index + 10, row.employeeId, row.name))), { updates: [], inserts: [] });
});

test("renaming a linked employee preserves the master ID rather than making another reference", () => {
  assert.deepEqual(planProjectMasters([employee(7, "Новое имя")], [master(80, 7, "Старое имя")]), {
    updates: [{ id: 80, employeeId: 7, name: "Новое имя", active: 1 }], inserts: [],
  });
});

test("a removed or no longer eligible employee archives only their automatic master", () => {
  const manual = master(10, null, "Ручной мастер");
  assert.deepEqual(planProjectMasters([employee(2, "Смена должности", "Инженер")], [manual, master(11, 1, "Удалённый"), master(12, 2, "Смена должности"), master(13, 3, "Уже архивирован", 0)]), {
    updates: [
      { id: 11, employeeId: 1, name: "Удалённый", active: 0 },
      { id: 12, employeeId: 2, name: "Смена должности", active: 0 },
    ], inserts: [],
  });
});

test("returning to the project reactivates the same linked row and historical ID", () => {
  assert.deepEqual(planProjectMasters([employee(5, "Вернувшийся мастер")], [master(44, 5, "Предыдущее имя", 0)]), {
    updates: [{ id: 44, employeeId: 5, name: "Вернувшийся мастер", active: 1 }], inserts: [],
  });
});

test("one unambiguous legacy master is adopted without losing its ID", () => {
  assert.deepEqual(planProjectMasters([employee(5, "Пётр Иванов")], [master(44, null, "  Петр  ИВАНОВ  ")]), {
    updates: [{ id: 44, employeeId: 5, name: "Пётр Иванов", active: 1 }], inserts: [],
  });
});

test("namesakes and duplicate legacy names do not redirect an automatic master to the wrong employee", () => {
  const namesakes = [employee(1, "Однофамилец"), employee(2, "Однофамилец")];
  const plan = planProjectMasters(namesakes, [master(10, null, "Однофамилец")]);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.inserts, [{ employeeId: 1, name: "Однофамилец" }, { employeeId: 2, name: "Однофамилец" }]);
  const differentPosition = planProjectMasters([employee(1, "Однофамилец"), employee(2, "Однофамилец", "Инженер")], [master(10, null, "Однофамилец")]);
  assert.deepEqual(differentPosition, { updates: [], inserts: [{ employeeId: 1, name: "Однофамилец" }] }, "a legacy name is ambiguous even when only one namesake has an eligible position");
  const duplicateLegacy = planProjectMasters([employee(3, "Третий")], [master(11, null, "Третий"), master(12, null, "Третий", 0)]);
  assert.deepEqual(duplicateLegacy.updates, []);
  assert.deepEqual(duplicateLegacy.inserts, [{ employeeId: 3, name: "Третий" }]);
});

test("a linked employee never adopts a second legacy row with the same name", () => {
  assert.deepEqual(planProjectMasters([employee(7, "Имя")], [master(1, 7, "Имя"), master(2, null, "Имя")]), { updates: [], inserts: [] });
});
