import assert from "node:assert/strict";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import {
  assertCanSavePersonnelReport, assertPersonnelReportHours, assertPersonnelReportRevision,
  assertPersonnelReportSiteAccess, canReviewPersonnelReport, completePersonnelReportRows,
  nextPersonnelReportStatus, normalizePersonnelReportRows, validPersonnelReportDate,
  collectPersonnelReportHourIssues, inspectPersonnelReportRows,
} from "../app/personnelReportWorkflow.ts";

const foreman = { id: 7, role: "foreman", assignedSiteId: 1, permissions: rolePermissionTemplate("foreman") };
const engineer = { id: 8, role: "engineer", assignedSiteId: null, permissions: rolePermissionTemplate("engineer") };
const report = { siteId: 1, ownerUserId: foreman.id, status: "draft", revision: 2 };
const completeRow = { employeeId: 11, shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1, hours: 6, note: "" };
const code = (value) => (error) => error.code === value;

test("drafts accept partial cells but submitting requires complete nonempty rows", () => {
  const partial = normalizePersonnelReportRows([{ employeeId: 11, note: "  Проверить  " }]);
  assert.equal(partial[0].note, "Проверить");
  assert.equal(partial[0].hours, null);
  assert.throws(() => completePersonnelReportRows(partial), /заполните/);
  assert.throws(() => completePersonnelReportRows([]), /Добавьте/);
  assert.deepEqual(completePersonnelReportRows(normalizePersonnelReportRows([completeRow])), [completeRow]);
  for (const hours of [0, 11, 1.5, NaN, "8"]) assert.throws(() => normalizePersonnelReportRows([{ hours }]), /часов/);
});

test("foreman can submit his own assigned-site report but cannot review anyone", () => {
  assert.equal(nextPersonnelReportStatus(foreman, report, "submit"), "submitted");
  assert.equal(nextPersonnelReportStatus(foreman, { ...report, status: "submitted" }, "reopen"), "draft");
  assert.throws(() => nextPersonnelReportStatus(foreman, { ...report, status: "submitted" }, "approve"), code("REVIEW_FORBIDDEN"));
  assert.throws(() => nextPersonnelReportStatus(foreman, { ...report, ownerUserId: 99 }, "submit"), code("REPORT_FORBIDDEN"));
  assert.throws(() => assertPersonnelReportSiteAccess(foreman, 2), code("REPORT_FORBIDDEN"));
  assert.equal(canReviewPersonnelReport(foreman), false);
});

test("engineer review has explicit transitions and a reason when returning for corrections", () => {
  const submitted = { ...report, status: "submitted" };
  assert.equal(nextPersonnelReportStatus(engineer, submitted, "approve"), "approved");
  assert.equal(nextPersonnelReportStatus(engineer, submitted, "reject", "Неверная зона"), "rejected");
  assert.throws(() => nextPersonnelReportStatus(engineer, submitted, "reject", "  "), /причину/);
  assert.equal(nextPersonnelReportStatus(foreman, { ...report, status: "rejected" }, "submit"), "submitted");
  for (const action of ["submit", "approve", "reject", "reopen"]) {
    assert.throws(() => nextPersonnelReportStatus(engineer, { ...report, status: "approved" }, action, "Возврат"), code("INVALID_TRANSITION"));
  }
  assert.doesNotThrow(() => assertCanSavePersonnelReport(engineer, submitted));
  assert.doesNotThrow(() => assertCanSavePersonnelReport(engineer, { ...report, status: "approved" }));
  assert.doesNotThrow(() => assertCanSavePersonnelReport({ ...engineer, role: "superadmin" }, { ...report, status: "approved" }));
  assert.throws(() => assertCanSavePersonnelReport(foreman, submitted), code("REPORT_LOCKED"));
  assert.throws(() => assertCanSavePersonnelReport(foreman, { ...report, status: "approved" }), code("REPORT_LOCKED"));
});

test("custom permissions remain effective even for the engineer role", () => {
  const restricted = { ...engineer, permissions: rolePermissionTemplate("engineer") };
  restricted.permissions.workers_report.update = false;
  assert.equal(canReviewPersonnelReport(restricted), false);
  for (const status of ["draft", "submitted", "approved"]) assert.throws(() => assertCanSavePersonnelReport(restricted, { ...report, status }), code("REPORT_FORBIDDEN"));
  assert.throws(() => nextPersonnelReportStatus(restricted, { ...report, status: "submitted" }, "approve"), code("REPORT_FORBIDDEN"));
  const cannotCreate = { ...foreman, permissions: rolePermissionTemplate("foreman") };
  cannotCreate.permissions.workers_report.create = false;
  assert.throws(() => assertCanSavePersonnelReport(cannotCreate), code("REPORT_FORBIDDEN"));
});

test("revisions are mandatory and prevent stale or repeated approval", () => {
  assert.doesNotThrow(() => assertPersonnelReportRevision(3, 3));
  for (const expected of [undefined, null, 0, 2, "3", NaN]) assert.throws(() => assertPersonnelReportRevision(3, expected), code("STALE_REPORT"));
});

test("daily hours combine approved hours across projects and every row in this proposal", () => {
  assert.doesNotThrow(() => assertPersonnelReportHours([{ ...completeRow, hours: 6 }], new Map([[11, 4]])));
  assert.throws(() => assertPersonnelReportHours([{ ...completeRow, hours: 7 }], new Map([[11, 4]])), code("HOURS_CONFLICT"));
  assert.throws(() => assertPersonnelReportHours([{ ...completeRow, hours: 6 }, { ...completeRow, hours: 5 }], new Map()), code("HOURS_CONFLICT"));
  assert.doesNotThrow(() => assertPersonnelReportHours([{ ...completeRow, hours: 10 }, { ...completeRow, employeeId: 12, hours: 10 }], new Map()));
});

test("calendar validation rejects normalized but nonexistent dates", () => {
  assert.equal(validPersonnelReportDate("2026-02-30"), false);
  assert.equal(validPersonnelReportDate("2026-13-01"), false);
  assert.equal(validPersonnelReportDate("2028-02-29"), true);
  assert.equal(validPersonnelReportDate("2026-10-28"), true);
});

test("submission inspection reports every invalid or incomplete row together", () => {
  const result = inspectPersonnelReportRows([
    { ...completeRow, hours: 11, shiftId: -1, note: "x".repeat(4001) },
    { employeeId: 12, hours: null },
    null,
    { ...completeRow, employeeId: 13, hours: 4 },
  ]);
  assert.deepEqual(result.issues.map(issue => issue.rowNumbers), [[1], [1], [1], [2], [3]]);
  assert.equal(result.issues.filter(issue => issue.code === "INVALID_ROW_VALUE").length, 3);
  assert.equal(result.issues[3].code, "INCOMPLETE_ROW");
  assert.equal(result.issues[4].code, "INVALID_ROW");
  assert.equal(result.rows[0].hours, null);
  assert.equal(result.rows[3].employeeId, 13);
  assert.equal(result.rows[3].hours, 4);
  assert.equal(inspectPersonnelReportRows([]).issues[0].code, "EMPTY_REPORT");
  assert.equal(inspectPersonnelReportRows([{}], false).issues.length, 0);
});

test("all employee hour conflicts are collected once with all contributing row numbers", () => {
  const rows = [
    { employeeId: 11, hours: 2 },
    { employeeId: 12, hours: 3 },
    { employeeId: 11, hours: 2 },
    { employeeId: 13, hours: 10 },
  ];
  const approved = new Map([[11, 8], [12, 9]]);
  const names = new Map([[11, "Первый сотрудник"], [12, "Второй сотрудник"]]);
  const issues = collectPersonnelReportHourIssues(rows, approved, names);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map(issue => [issue.employeeId, issue.rowNumbers]), [[11, [1, 3]], [12, [2]]]);
  assert.deepEqual(issues.map(issue => [issue.usedHours, issue.requestedHours, issue.availableHours]), [[8, 4, 2], [9, 3, 1]]);
  assert.throws(() => assertPersonnelReportHours(rows, approved, names), error => {
    assert.equal(error.code, "HOURS_CONFLICT");
    assert.deepEqual(error.details.issues, issues);
    assert.match(error.message, /Первый сотрудник/);
    assert.match(error.message, /Второй сотрудник/);
    return true;
  });
  assert.deepEqual(collectPersonnelReportHourIssues([{ employeeId: 11, hours: 2 }, { employeeId: 12, hours: 1 }], approved), []);
});
