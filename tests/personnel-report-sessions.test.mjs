import assert from "node:assert/strict";
import test from "node:test";
import { freezePersonnelReportSessions, mergePersonnelReportSessions, personnelReportImportTarget, personnelReportNewDate, personnelReportNewKey, personnelReportSaveIdentity, personnelReportSubmissionTargets } from "../app/personnelReportSessions.ts";

const report = (patch = {}) => ({ id: 42, siteId: 7, workDate: "2026-10-20", ownerUserId: 3, ownerName: "Прораб", status: "draft", revision: 1, rows: [], ...patch });

test("refresh does not replace the original revision of an unsaved report", () => {
  const original = report();
  const sessions = freezePersonnelReportSessions({}, [original], ["42"]);
  const latest = report({ revision: 9, workDate: "2026-10-20" });
  const repeated = freezePersonnelReportSessions(sessions, [latest], ["42"]);
  assert.equal(repeated, sessions);
  const displayed = mergePersonnelReportSessions([latest], repeated, ["42"]);
  assert.equal(displayed[0], original);
  assert.deepEqual(personnelReportSaveIdentity("42", repeated, 7, "2026-10-28"), { siteId: 7, workDate: "2026-10-20", reportId: 42, revision: 1 });
});

test("changing the visible period retains dirty rows and their report identity", () => {
  const old = report();
  const sessions = freezePersonnelReportSessions({}, [old], ["42"]);
  assert.deepEqual(mergePersonnelReportSessions([], sessions, ["42"]), [old]);
  assert.deepEqual(personnelReportSaveIdentity("42", sessions, 9, "2026-10-28"), { siteId: 7, workDate: "2026-10-20", reportId: 42, revision: 1 });
  assert.deepEqual(mergePersonnelReportSessions([], sessions, []), []);
  // Undo can hide an edit; redo uses the same retained session snapshot.
  assert.equal(mergePersonnelReportSessions([], sessions, ["42"])[0], old);
});

test("an existing report without a frozen identity never becomes a new report", () => {
  assert.throws(() => personnelReportSaveIdentity("42", {}, 7, "2026-10-28"), /исходная версия/);
  assert.deepEqual(personnelReportSaveIdentity("new", {}, 7, "2026-10-28"), { siteId: 7, workDate: "2026-10-28" });
});

test("top submission includes only today's own editable reports", () => {
  const reports = [report(), report({ id: 43, workDate: "2026-10-28" }), report({ id: 44, workDate: "2026-10-28", ownerUserId: 8 }), report({ id: 45, workDate: "2026-10-28", status: "submitted" }), report({ id: 46, workDate: "2026-10-28", status: "rejected" }), report({ id: 47, workDate: "2026-10-28", status: "approved" })];
  assert.deepEqual(personnelReportSubmissionTargets(reports, 3, "2026-10-28").map(item => item.id), [43, 46]);
  assert.deepEqual(personnelReportSubmissionTargets(reports, 3, "2026-10-28", 42).map(item => item.id), [42]);
  assert.deepEqual(personnelReportSubmissionTargets(reports, 3, "2026-10-28", 45), []);
});

test("each unsaved report day retains a distinct identity rather than today's date", () => {
  const yesterday = personnelReportNewKey("2026-10-27");
  const today = personnelReportNewKey("2026-10-28");
  assert.equal(yesterday, "new:2026-10-27");
  assert.notEqual(yesterday, today);
  assert.deepEqual(personnelReportSaveIdentity(yesterday, {}, 7, "2026-10-28"), { siteId: 7, workDate: "2026-10-27" });
  assert.deepEqual(personnelReportSaveIdentity(today, {}, 7, "2026-10-29"), { siteId: 7, workDate: "2026-10-28" });
  assert.equal(personnelReportNewDate("new", "2026-10-28"), "2026-10-28");
  assert.equal(personnelReportNewDate(yesterday, "2026-10-28"), "2026-10-27");
});

test("dated identities accept only real ISO calendar dates", () => {
  for (const date of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-1-01", "2026-10-28T00:00:00Z", " 2026-10-28", "2026-10-28 ", ""]) {
    assert.throws(() => personnelReportNewKey(date), /корректную дату/);
    assert.equal(personnelReportNewDate(`new:${date}`, "2026-10-28"), null);
    assert.throws(() => personnelReportSaveIdentity(`new:${date}`, {}, 7, "2026-10-28"), /исходная версия/);
  }
  assert.equal(personnelReportNewDate("42", "2026-10-28"), null);
  assert.equal(personnelReportNewDate("new", "2026-02-30"), null);
  assert.equal(personnelReportNewDate("new:2028-02-29", "2026-10-28"), "2028-02-29");
});

test("multi-day imports reuse only the current user's editable report on the same site and date", () => {
  const own = report({ status: "rejected", revision: 5 });
  const others = [report({ id: 43, siteId: 8 }), report({ id: 44, ownerUserId: 9 }), report({ id: 45, workDate: "2026-10-19" })];
  assert.equal(personnelReportImportTarget([own, ...others], {}, 7, 3, "2026-10-20"), "42");
  assert.equal(personnelReportImportTarget(others, {}, 7, 3, "2026-10-20"), "new:2026-10-20");
  assert.equal(personnelReportImportTarget([report({ status: "approved" })], {}, 7, 3, "2026-10-20"), "new:2026-10-20");
  assert.throws(() => personnelReportImportTarget([report({ status: "submitted" })], {}, 7, 3, "2026-10-20"), /снимите его с проверки/);
});

test("imports retain an existing dirty report's frozen revision across refreshed or hidden history", () => {
  const original = report();
  const sessions = freezePersonnelReportSessions({}, [original], ["42"]);
  const refreshed = report({ revision: 6, status: "submitted" });
  const target = personnelReportImportTarget([refreshed], sessions, 7, 3, "2026-10-20");
  assert.equal(target, "42");
  assert.equal(personnelReportSaveIdentity(target, sessions, 99, "2026-10-28").revision, 1);
  assert.equal(personnelReportImportTarget([], sessions, 7, 3, "2026-10-20"), "42");
  assert.throws(() => personnelReportImportTarget([refreshed, report({ id: 43 })], sessions, 7, 3, "2026-10-20"), /несколько незавершённых/);
});

test("submission can explicitly include imported dates while preserving the original default and explicit report behavior", () => {
  const reports = [report(), report({ id: 43, workDate: "2026-10-28" }), report({ id: 44, workDate: "2026-10-19", status: "rejected" }), report({ id: 45, ownerUserId: 9 }), report({ id: 46, status: "submitted" })];
  assert.deepEqual(personnelReportSubmissionTargets(reports, 3, "2026-10-28", undefined, ["2026-10-20", "2026-10-19"]).map(item => item.id), [42, 44]);
  assert.deepEqual(personnelReportSubmissionTargets(reports, 3, "2026-10-28").map(item => item.id), [43]);
  assert.deepEqual(personnelReportSubmissionTargets(reports, 3, "2026-10-28", 44, []).map(item => item.id), [44]);
});
