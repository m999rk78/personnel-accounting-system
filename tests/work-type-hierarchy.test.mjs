import assert from "node:assert/strict";
import test from "node:test";
import { subworkOptions, compatibleSubworkId, workTypeChanges } from "../app/workTypeHierarchy.ts";
import { pastePersonnelCells, personnelCellErrors } from "../app/personnelSpreadsheet.ts";
import { buildEquipmentCarryoverDrafts } from "../app/equipmentCarryover.ts";
import { buildPersonnelReportCrew } from "../app/personnelReportCarryOver.ts";

const parents = [{ id: 1, name: "Вспомогательные" }, { id: 2, name: "Земляные" }];
const children = [{ id: 10, name: "Перевозка", mainWorkTypeId: 1 }, { id: 11, name: "Уборка", mainWorkTypeId: 1 }, { id: 12, name: "Перевозка", mainWorkTypeId: 2 }, { id: 13, name: "Не назначен", mainWorkTypeId: null }];
const draft = { key: "one", employeeId: "1", employeeQuery: "Иван", shiftId: "", zoneId: "", mainWorkTypeId: "1", subworkTypeId: "10", masterId: "", hours: "5", note: "" };
const catalogs = { employees: [{ id: 1, fullName: "Иван" }], shifts: [], zones: [], mainWorkTypes: parents, subworkTypes: children, masters: [] };

test("only children of the selected parent are offered; unassigned children are never global options", () => {
  assert.deepEqual(subworkOptions(children, "1").map(row => row.id), [10, 11]);
  assert.deepEqual(subworkOptions(children, null), []);
  assert.deepEqual(subworkOptions(children, ""), []);
  assert.equal(compatibleSubworkId(children, 2, 10), "");
  assert.equal(compatibleSubworkId(children, 1, 10), "10");
});

test("changing or clearing a parent removes incompatible children and preserves unrelated edits", () => {
  assert.deepEqual(workTypeChanges(draft, { mainWorkTypeId: "2" }, children), { mainWorkTypeId: "2", subworkTypeId: "" });
  assert.deepEqual(workTypeChanges(draft, { mainWorkTypeId: "" }, children), { mainWorkTypeId: "", subworkTypeId: "" });
  assert.deepEqual(workTypeChanges(draft, { mainWorkTypeId: "2", subworkTypeId: "12" }, children), { mainWorkTypeId: "2", subworkTypeId: "12" });
  assert.deepEqual(workTypeChanges(draft, { note: "Текст" }, children), { note: "Текст" });
  assert.equal(draft.subworkTypeId, "10");
});

test("Excel paste resolves duplicate child names inside the chosen parent and flags invalid pairs without losing text", () => {
  const pasted = pastePersonnelCells(draft, { mainWork: "Земляные", subwork: "Перевозка" }, catalogs);
  assert.equal(pasted.mainWorkTypeId, "2"); assert.equal(pasted.subworkTypeId, "12");
  assert.deepEqual(personnelCellErrors(pasted, catalogs), {});
  const invalid = pastePersonnelCells(draft, { mainWork: "Земляные", subwork: "Уборка", note: "Сохранить" }, catalogs);
  assert.equal(invalid.subworkTypeId, ""); assert.equal(invalid.inputValues.subwork, "Уборка"); assert.equal(invalid.note, "Сохранить");
  assert.ok(personnelCellErrors(invalid, catalogs).subwork);
  assert.equal(pastePersonnelCells(draft, { mainWork: "Земляные" }, catalogs).subworkTypeId, "");
  assert.ok(personnelCellErrors({ ...draft, mainWorkTypeId: "2" }, catalogs).subwork);
});

test("copying yesterday into personnel and equipment never carries an incompatible child", () => {
  const row = { id: 5, employeeId: 1, equipmentId: 7, workDate: "2026-10-27", mainWorkTypeId: 2, subworkTypeId: 10, shiftId: null, zoneId: null, masterId: null, hours: 5, note: "Вчера" };
  const personnel = buildPersonnelReportCrew([row], catalogs, () => "new", "2026-10-28T10:00:00Z");
  assert.equal(personnel.drafts[0].subworkTypeId, "");
  const equipment = buildEquipmentCarryoverDrafts({ ...catalogs, reportSubmitted: false, workDate: "2026-10-28", units: [{ id: 7 }], entries: [] }, [row]);
  assert.equal(equipment[0].subworkTypeId, "");
  assert.equal(personnel.drafts[0].mainWorkTypeId, "2"); assert.equal(equipment[0].hours, "5");
});
