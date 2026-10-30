import assert from "node:assert/strict";
import test from "node:test";
import { buildEquipmentReportCrew, equipmentReportCrewSource } from "../app/equipmentReportCarryOver.ts";
import { freezeEquipmentReportSessions, mergeEquipmentReportSessions, equipmentReportImportTarget, equipmentReportSaveIdentity } from "../app/equipmentReportSessions.ts";
import { equipmentSubmissionCellIssues, equipmentSubmissionToken, equipmentSubmissionCanSend, mergeEquipmentSubmissionIssues } from "../app/equipmentReportSubmissionValidation.ts";

const unit = id => ({ id, equipmentType: "Кран", brand: "Марка", model: `Модель ${id}`, registrationNumber: `А00${id}`, organization: "Подрядчик", note: "" });
const options = [{ id: 1, name: "Монтаж", mainWorkTypeId: 1 }];
const catalogs = { units: [unit(1), unit(2)], shifts: options, zones: options, mainWorkTypes: options, subworkTypes: options };
const reportRow = (patch = {}) => ({ id: 7, reportId: 5, siteId: 9, workDate: "2026-10-29", equipmentId: 1, shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, hours: 6, note: "Вчерашняя работа", approvedEntryId: 50, ...patch });
const report = (patch = {}) => ({ id: 5, siteId: 9, workDate: "2026-10-29", ownerUserId: 10, status: "approved", revision: 3, rows: [reportRow()], ...patch });
const draft = (patch = {}) => ({ key: "draft", equipmentId: "1", shiftId: "1", zoneId: "1", mainWorkTypeId: "1", subworkTypeId: "1", hours: "6", note: "", ...patch });

test("equipment carryover keeps own separate jobs, excludes published duplicates and unavailable or transferred units", () => {
  const own = report({ rows: [reportRow(), reportRow({ id: 8, hours: 2 }), reportRow({ id: 9, equipmentId: 2 }), reportRow({ id: 10, equipmentId: 3 })] });
  const source = equipmentReportCrewSource([own, report({ id: 6, ownerUserId: 11 })], 9, 10, "2026-10-30", [{ ...reportRow(), id: 50, responsibleUserId: 10 }]);
  assert.equal(source.rows.length, 4);
  const marks = [{ equipmentId: 2, workDate: "2026-10-30", productiveHours: 0, downtimeHours: 10, note: "Ремонт" }];
  let id = 0;
  const result = buildEquipmentReportCrew(source.rows, { ...catalogs, workDate: "2026-10-30", dailyTimesheetMarks: marks }, () => `new-${++id}`, "2026-10-30T05:00:00Z");
  assert.deepEqual(result.drafts.map(row => row.hours), ["6", "2"]);
  assert.equal(result.skipped, 2);
  assert.ok(result.drafts.every(row => row.referenceIds === undefined && row.reportRowId === undefined));
  assert.equal(equipmentReportCrewSource([own, report({ id: 8, workDate: "2026-10-30", rows: [] })], 9, 10, "2026-10-30"), null);
});

test("equipment edits retain original revisions and imports cannot enter a submitted date", () => {
  const original = report({ status: "draft" });
  const sessions = freezeEquipmentReportSessions({}, [original], ["5"]);
  const merged = mergeEquipmentReportSessions([report({ status: "submitted", revision: 4 })], sessions, ["5"]);
  assert.equal(merged[0].revision, 3);
  assert.deepEqual(equipmentReportSaveIdentity("5", sessions, 9, "2026-10-30"), { siteId: 9, workDate: "2026-10-29", reportId: 5, revision: 3 });
  assert.throws(() => equipmentReportImportTarget([report({ status: "submitted" })], {}, 9, 10, "2026-10-29"), /проверку/);
});

test("validation checks every equipment date and retains authoritative downtime blockers", () => {
  const marks = [{ equipmentId: 1, workDate: "2026-10-29", productiveHours: 0, downtimeHours: 8, note: "Ремонт" }];
  const groups = [{ key: "new:2026-10-30", workDate: "2026-10-30", drafts: [draft()] }, { key: "5", workDate: "2026-10-29", drafts: [draft({ hours: "11", zoneId: "" })] }];
  const local = equipmentSubmissionCellIssues(groups, { ...catalogs, dailyTimesheetMarks: marks });
  assert.equal(local.length, 1);
  assert.equal(local[0].workDate, "2026-10-29");
  assert.match(local[0].message, /10/);
  const remote = { key: "5", workDate: "2026-10-29", rowNumbers: [1], code: "EQUIPMENT_UNAVAILABLE", message: "Недоступна по табелю" };
  assert.equal(mergeEquipmentSubmissionIssues(local, [remote]).length, 2);
  const first = equipmentSubmissionToken(9, groups);
  const second = equipmentSubmissionToken(9, groups.slice(0, 1));
  assert.equal(equipmentSubmissionCanSend(second, { token: first, status: "valid", issues: [] }, true), false);
});
