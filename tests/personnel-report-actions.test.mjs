import assert from "node:assert/strict";
import test from "node:test";
import { defaultPersonnelReportSubmissions, selectPersonnelReportSubmissions, personnelReportReviewIssue, personnelReportMatchesView } from "../app/personnelReportActions.ts";
import { buildPersonnelReportCrew, personnelReportCrewSource, personnelReportYesterday } from "../app/personnelReportCarryOver.ts";

const item = (key, date, owner = 10, status = "draft", rowCount = 4) => ({ key, workDate: date, ownerUserId: owner, status, rowCount });

test("report tabs separate confirmed and submitted records from each user's own draft dates", () => {
  const items = [
    item("own-draft", "2026-11-06"), item("own-returned", "2026-11-05", 10, "rejected"),
    item("other-draft", "2026-11-06", 11), item("other-returned", "2026-11-04", 11, "rejected"),
    item("own-submitted", "2026-11-04", 10, "submitted"), item("other-submitted", "2026-11-05", 11, "submitted"),
    item("own-approved", "2026-11-03", 10, "approved"), item("other-approved", "2026-11-03", 11, "approved"),
  ];
  const keys = (view, userId) => items.filter(report => personnelReportMatchesView(report, view, userId)).map(report => report.key);
  assert.deepEqual(keys("approved", 10), ["own-approved", "other-approved"]);
  assert.deepEqual(keys("submitted", 10), ["own-submitted", "other-submitted"]);
  assert.deepEqual(keys("draft", 10), ["own-draft", "own-returned"]);
  assert.deepEqual(keys("draft", 11), ["other-draft", "other-returned"]);
  assert.deepEqual(keys("draft", 12), []);
  assert.equal(personnelReportMatchesView({ status: "draft", ownerUserId: null }, "draft", 10), false);
});

test("sending defaults to all of a foreman's nonempty draft dates, without another foreman's records", () => {
  const items = [item("1", "2026-10-28"), item("2", "2026-10-27"), item("3", "2026-10-26", 10, "rejected"), item("4", "2026-10-28", 11), item("5", "2026-10-28", 10, "submitted"), item("6", "2026-10-27", 10, "approved"), item("7", "2026-10-28", 10, "draft", 0)];
  const keys = defaultPersonnelReportSubmissions(items, 10);
  assert.deepEqual(keys, ["1", "2", "3"]);
  assert.deepEqual(selectPersonnelReportSubmissions(items, keys).map(item => item.workDate), ["2026-10-28", "2026-10-27", "2026-10-26"]);
  assert.deepEqual(defaultPersonnelReportSubmissions(items, 11), ["4"]);
});
test("an explicit send selection sends only chosen reports and rejects stale or empty targets", () => {
  const items = [item("1", "2026-10-28"), item("2", "2026-10-27"), item("3", "2026-10-26")];
  assert.deepEqual(selectPersonnelReportSubmissions(items, ["3", "2"]).map(item => item.key), ["2", "3"]);
  assert.throws(() => selectPersonnelReportSubmissions(items, []), /Выберите/);
  assert.throws(() => selectPersonnelReportSubmissions(items, ["2", "gone"]), /изменился/);
  assert.throws(() => selectPersonnelReportSubmissions([item("1", "2026-10-28", 10, "submitted")], ["1"]), /изменился/);
});
test("an engineer can review a submitted report with unrelated unsaved drafts, including empty ones", () => {
  assert.equal(personnelReportReviewIssue(5, ["new:2026-10-28", "2"]), null);
  assert.match(personnelReportReviewIssue(5, ["5", "new:2026-10-28"]), /В этом отчёте/);
});

const row = (patch = {}) => ({ id: 1, reportId: 1, siteId: 7, workDate: "2026-10-27", employeeId: 1, hours: 8, employeeName: "Старое имя", note: "Вчерашняя работа", shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1, approvedEntryId: null, ...patch });
const report = (patch = {}) => ({ id: 1, siteId: 7, ownerUserId: 10, status: "draft", workDate: "2026-10-27", rows: [row()], ...patch });
test("each foreman receives only yesterday's own crew on the same project, including separate jobs", () => {
  const reports = [report({ rows: [row({ hours: 3 }), row({ id: 2, hours: 5 })] }), report({ id: 2, ownerUserId: 11, rows: [row({ employeeId: 2 })] }), report({ id: 3, siteId: 8 }), report({ id: 4, workDate: "2026-10-26" })];
  assert.deepEqual(personnelReportCrewSource(reports, 7, 10, "2026-10-28").rows.map(row => row.hours), [3, 5]);
  assert.deepEqual(personnelReportCrewSource(reports, 7, 11, "2026-10-28").rows.map(row => row.employeeId), [2]);
  assert.equal(personnelReportCrewSource(reports, 7, 12, "2026-10-28"), null);
  assert.equal(personnelReportCrewSource([reports[3]], 7, 10, "2026-10-28"), null);
});
test("today's saved, submitted or approved report is never replaced or seeded twice", () => {
  for (const status of ["draft", "rejected", "submitted", "approved"]) {
    assert.equal(personnelReportCrewSource([report(), report({ id: 2, workDate: "2026-10-28", status })], 7, 10, "2026-10-28"), null);
  }
  const empty = report({ id: 2, workDate: "2026-10-28", rows: [] });
  assert.equal(personnelReportCrewSource([report(), empty], 7, 10, "2026-10-28"), null);
  assert.equal(personnelReportCrewSource([report(), { ...empty, status: "submitted" }], 7, 10, "2026-10-28"), null);
});
test("legacy approved rows retain owner isolation and are not duplicated with their originating reports", () => {
  const entries = [{ ...row({ id: 50 }), responsibleUserId: 10 }, { ...row({ id: 51 }), responsibleUserId: 11 }];
  assert.equal(personnelReportCrewSource([], 7, 10, "2026-10-28", entries).rows.length, 1);
  assert.equal(personnelReportCrewSource([report({ rows: [row({ approvedEntryId: 50 })] })], 7, 10, "2026-10-28", entries).rows.length, 1);
  assert.equal(personnelReportCrewSource([], 7, 12, "2026-10-28", entries), null);
});
test("carried rows receive fresh identities, keep hours and jobs, skip removed people and clear retired options", () => {
  const options = [{ id: 1, name: "Доступно", mainWorkTypeId: 1 }];
  const catalogs = { employees: [{ id: 1, fullName: "Текущее имя" }], shifts: options, zones: options, mainWorkTypes: options, subworkTypes: options.map(option => ({ ...option, mainWorkTypeId: 1 })), masters: options };
  let index = 0;
  const source = [row({ hours: 3 }), row({ id: 2, hours: 5, zoneId: 99 }), row({ id: 3, employeeId: 99 })];
  const { drafts, skipped } = buildPersonnelReportCrew(source, catalogs, () => `new-${++index}`, "2026-10-28T10:00:00Z");
  assert.equal(skipped, 1);
  assert.deepEqual(drafts.map(row => [row.key, row.hours, row.zoneId]), [["new-1", "3", "1"], ["new-2", "5", ""]]);
  assert.ok(drafts.every(row => row.employeeQuery === "Текущее имя" && row.carriedFromPreviousDay && !row.reportRowId));
  assert.equal(drafts[0].note, source[0].note);
  assert.equal(source[1].zoneId, 99);
});
test("yesterday uses calendar days across months, years and leap days", () => {
  assert.equal(personnelReportYesterday("2026-11-01"), "2026-10-31");
  assert.equal(personnelReportYesterday("2027-01-01"), "2026-12-31");
  assert.equal(personnelReportYesterday("2028-03-01"), "2028-02-29");
});
