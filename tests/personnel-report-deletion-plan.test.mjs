import assert from "node:assert/strict";
import test from "node:test";
import { personnelReportDeletionPlan } from "../app/personnelReportDeletion.ts";

const row = (id, reportId, patch = {}) => ({ id, reportId, siteId: 1, workDate: "2026-11-08", employeeId: 7, employeeName: "Иванов Иван", approvedEntryId: id + 100, approvedEntryRevision: 3, hours: 4, mainWorkTypeName: "Монтаж", subworkTypeName: "Сварка", ...patch });
const report = (id, rows, patch = {}) => ({ id, siteId: 1, workDate: "2026-11-08", ownerName: "Прораб 1", revision: 8, status: "approved", rows, ...patch });
const gridRow = (source, patch = {}) => ({ rowKey: `report-${source.reportId}-${source.id}`, status: "approved", proposalId: source.reportId, editable: true, entry: { id: source.approvedEntryId, revision: 8 }, ...patch });

test("approved deletion selects exact published rows, never every row of the employee or report", () => {
  const first = row(1, 10), sameEmployee = row(2, 10), yesterday = row(3, 11, { workDate: "2026-11-07" });
  const reports = [report(10, [first, sameEmployee]), report(11, [yesterday])];
  const plan = personnelReportDeletionPlan(1, [gridRow(first), gridRow(yesterday)], reports, [], []);
  assert.deepEqual(plan.payload, { action: "delete-approved-rows", siteId: 1, rows: [{ entryId: 101, revision: 3, reportId: 10, reportRevision: 8 }, { entryId: 103, revision: 3, reportId: 11, reportRevision: 8 }] });
  assert.deepEqual(plan.items.map(item => item.workDate), ["2026-11-08", "2026-11-07"]);
  assert.equal(reports[0].rows.length, 2);
});

test("last report row and standalone legacy entry carry their independent versions", () => {
  const first = row(1, 10), legacy = { ...row(9, 0), id: 209, revision: 12, orderReportId: null, responsibleUserName: "Прораб 2" };
  const plan = personnelReportDeletionPlan(1, [gridRow(first), { rowKey: "approved-209", status: "approved", editable: true }], [report(10, [first])], [legacy], []);
  assert.deepEqual(plan.payload.rows[1], { entryId: 209, revision: 12 });
  assert.equal(plan.items[1].ownerName, "Прораб 2");
});

test("unsaved changes block only a selected report or legacy entry, preserving unrelated work", () => {
  const source = row(1, 10), reports = [report(10, [source])];
  assert.doesNotThrow(() => personnelReportDeletionPlan(1, [gridRow(source)], reports, [], ["new:2026-11-09", "11"]));
  assert.throws(() => personnelReportDeletionPlan(1, [gridRow(source)], reports, [], ["10"]), /несохранённые/);
  const legacy = { ...source, id: 209, revision: 2 };
  assert.throws(() => personnelReportDeletionPlan(1, [{ rowKey: "approved-209", status: "approved", editable: true }], [], [legacy], ["entry-209"]), /несохранённые/);
});

test("stale selections, unpublished or cross-project rows and duplicate entries cannot be deleted", () => {
  const source = row(1, 10), selected = gridRow(source);
  for (const reports of [[], [report(10, [])], [report(10, [source], { status: "submitted" })], [report(10, [source], { siteId: 2 })], [report(10, [{ ...source, approvedEntryId: null }])], [report(10, [{ ...source, approvedEntryRevision: undefined }])]]) {
    assert.throws(() => personnelReportDeletionPlan(1, [selected], reports, [], []), /изменился/);
  }
  assert.throws(() => personnelReportDeletionPlan(1, [selected, selected], [report(10, [source])], [], []), /изменился/);
  assert.throws(() => personnelReportDeletionPlan(1, [], [], [], []), /Выберите/);
  assert.throws(() => personnelReportDeletionPlan(1, [{ ...selected, editable: false }], [report(10, [source])], [], []), /доступные/);
});

test("confirmation uses saved names, hours and work descriptions from the exact source", () => {
  const source = row(1, 10);
  const plan = personnelReportDeletionPlan(1, [gridRow(source, { draft: { employeeQuery: "Другой", hours: "10" } })], [report(10, [source])], [], []);
  assert.deepEqual(plan.items[0], { rowKey: "report-10-1", employeeName: "Иванов Иван", workDate: "2026-11-08", ownerName: "Прораб 1", workName: "Сварка", hours: 4 });
});
