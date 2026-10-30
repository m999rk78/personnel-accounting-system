import assert from "node:assert/strict";
import test from "node:test";
import { groupPersonnelReportDates, isPersonnelReportOrderId, movePersonnelReportRows, personnelReportOrderId, remapPersonnelReportOrder } from "../app/personnelReportRowOrder.ts";
import { orderRowsByIds } from "../app/tableRowOrder.ts";

const rows = [
  { rowKey: "report-1-11", workDate: "2026-10-28", employeeId: 1, hours: 3, note: "Первая работа" },
  { rowKey: "report-1-12", workDate: "2026-10-28", employeeId: 2, hours: 8, note: "Другой сотрудник" },
  { rowKey: "report-1-13", workDate: "2026-10-28", employeeId: 1, hours: 5, note: "Вторая работа" },
  { rowKey: "approved-21", workDate: "2026-10-27", employeeId: 1, hours: 8, note: "Вчера" },
  { rowKey: "approved-22", workDate: "2026-10-27", employeeId: 2, hours: 6, note: "Вчера, другой сотрудник" },
];
const ids = rows.map(personnelReportOrderId);
test("moving one report record never moves its employee's other records or edits data", () => {
  const before = structuredClone(rows);
  const moved = movePersonnelReportRows(ids, { movingIds: [ids[2]], placement: "before", targetId: ids[0] });
  assert.deepEqual(moved, [ids[2], ids[0], ids[1], ids[3], ids[4]]);
  assert.deepEqual(orderRowsByIds(rows, moved, personnelReportOrderId), [rows[2], rows[0], rows[1], rows[3], rows[4]]);
  assert.deepEqual(rows, before);
});
test("start and end refer only to the selected date and block moves keep relative order", () => {
  assert.deepEqual(movePersonnelReportRows(ids, { movingIds: [ids[0]], placement: "end" }), [ids[1], ids[2], ids[0], ids[3], ids[4]]);
  assert.deepEqual(movePersonnelReportRows(ids, { movingIds: [ids[4]], placement: "start" }), [ids[0], ids[1], ids[2], ids[4], ids[3]]);
  assert.deepEqual(movePersonnelReportRows(ids, { movingIds: [ids[2], ids[1]], placement: "start" }), [ids[1], ids[2], ids[0], ids[3], ids[4]]);
});
test("cross-date destinations and cross-date selections cannot mix dates", () => {
  assert.throws(() => movePersonnelReportRows(ids, { movingIds: [ids[0]], placement: "after", targetId: ids[3] }), /внутри одной даты/);
  assert.throws(() => movePersonnelReportRows(ids, { movingIds: [ids[0], ids[3]], placement: "start" }), /строки одной даты/);
});
test("switching away from an automatic sort preserves the visible order inside the day", () => {
  const visible = [ids[1], ids[2], ids[0], ids[4], ids[3]];
  assert.deepEqual(movePersonnelReportRows(ids, { movingIds: [ids[0]], placement: "before", targetId: ids[2], displayedIds: visible }), [ids[1], ids[0], ids[2], ids[3], ids[4]]);
});
test("dates remain grouped and chronological with any employee or activity sort", () => {
  const shuffled = [rows[4], rows[1], rows[3], rows[2], rows[0]];
  groupPersonnelReportDates(shuffled, row => row.workDate);
  assert.deepEqual(shuffled, [rows[1], rows[2], rows[0], rows[4], rows[3]]);
  groupPersonnelReportDates(shuffled, row => row.workDate, "asc");
  assert.deepEqual(shuffled, [rows[4], rows[3], rows[1], rows[2], rows[0]]);
});
test("blank drafts also have unique move identities and invalid tokens are rejected", () => {
  const draft = { workDate: "2026-10-28", rowKey: "d0471ab9-d379-46f2-af6e-51ed0be6cfbf" };
  assert.equal(isPersonnelReportOrderId(personnelReportOrderId(draft)), true);
  for (const value of [1, "2026-10-28/1", "2026-02-31/approved-1", "2026-10-28/report-0-1", "2026-10-28/approved-1/anything"]) assert.equal(isPersonnelReportOrderId(value), false);
});
test("a moved draft keeps its place after saving and after approval changes its display row key", () => {
  const blank = "2026-10-28/d0471ab9-d379-46f2-af6e-51ed0be6cfbf";
  const persisted = "2026-10-28/report-1-14";
  assert.deepEqual(remapPersonnelReportOrder([ids[0], blank, ids[1]], { [blank]: persisted }, new Set([...ids, persisted])), [ids[0], persisted, ids[1]]);
  assert.throws(() => remapPersonnelReportOrder([blank], { [blank]: ids[3] }, new Set(ids)), /сопоставить/);
  assert.throws(() => remapPersonnelReportOrder([blank], { [blank]: persisted }, new Set(ids)), /сопоставить/);
  assert.equal(personnelReportOrderId({ rowKey: "approved-50", orderKey: "report-1-14", workDate: "2026-10-28" }), persisted);
});
