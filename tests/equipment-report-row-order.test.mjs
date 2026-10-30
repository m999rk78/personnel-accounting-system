import assert from "node:assert/strict";
import test from "node:test";
import { equipmentReportOrderId, equipmentReportOrderScope, groupEquipmentReportDates, isEquipmentReportOrderId, isUnsavedEquipmentReportOrderId, moveEquipmentReportRows, remapEquipmentReportOrder } from "../app/equipmentReportRowOrder.ts";

const rows = [
  { rowKey: "report-1-1", workDate: "2026-10-30", equipmentId: 2, hours: 4 },
  { rowKey: "report-1-2", workDate: "2026-10-30", equipmentId: 3, hours: 8 },
  { rowKey: "report-1-3", workDate: "2026-10-30", equipmentId: 2, hours: 6 },
  { rowKey: "approved-10", workDate: "2026-10-29", equipmentId: 2, hours: 8 },
];
const ids = rows.map(equipmentReportOrderId);

test("equipment jobs use separate record identities and moves never alter their contents", () => {
  const before = structuredClone(rows);
  assert.equal(equipmentReportOrderScope, "equipment-report-rows");
  assert.deepEqual(moveEquipmentReportRows(ids, { movingIds: [ids[2]], placement: "before", targetId: ids[0] }), [ids[2], ids[0], ids[1], ids[3]]);
  assert.deepEqual(moveEquipmentReportRows(ids, { movingIds: [ids[0]], placement: "end" }), [ids[1], ids[2], ids[0], ids[3]]);
  assert.deepEqual(rows, before);
});

test("equipment moves reject mixed dates and keep the visible order within the selected day", () => {
  assert.throws(() => moveEquipmentReportRows(ids, { movingIds: [ids[0]], placement: "after", targetId: ids[3] }), /внутри одной даты/);
  assert.throws(() => moveEquipmentReportRows(ids, { movingIds: [ids[0], ids[3]], placement: "start" }), /строки одной даты/);
  assert.deepEqual(moveEquipmentReportRows(ids, { movingIds: [ids[0]], placement: "before", targetId: ids[2], displayedIds: [ids[1], ids[2], ids[0], ids[3]] }), [ids[1], ids[0], ids[2], ids[3]]);
  const shuffled = [rows[3], rows[2], rows[0], rows[1]];
  groupEquipmentReportDates(shuffled, row => row.workDate);
  assert.deepEqual(shuffled, [rows[2], rows[0], rows[1], rows[3]]);
  groupEquipmentReportDates(shuffled, row => row.workDate, "asc");
  assert.deepEqual(shuffled, [rows[3], rows[2], rows[0], rows[1]]);
});

test("equipment row tokens validate dates and preserve order after saving and approval", () => {
  const draft = "2026-10-30/d0471ab9-d379-46f2-af6e-51ed0be6cfbf";
  const saved = "2026-10-30/report-1-4";
  assert.equal(isUnsavedEquipmentReportOrderId(draft), true);
  assert.equal(isUnsavedEquipmentReportOrderId(saved), false);
  for (const id of [1, "2026-10-30/2", "2026-02-30/approved-1", "2026-10-30/report-0-2", "2026-10-30/approved-1/extra"]) assert.equal(isEquipmentReportOrderId(id), false);
  assert.deepEqual(remapEquipmentReportOrder([ids[0], draft, ids[1]], { [draft]: saved }, new Set([...ids, saved])), [ids[0], saved, ids[1]]);
  assert.throws(() => remapEquipmentReportOrder([draft], { [draft]: ids[3] }, new Set(ids)), /сопоставить/);
  assert.throws(() => remapEquipmentReportOrder([draft], { [draft]: saved }, new Set(ids)), /сопоставить/);
  assert.equal(equipmentReportOrderId({ rowKey: "approved-50", orderKey: "report-1-4", workDate: "2026-10-30" }), saved);
});
