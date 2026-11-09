import assert from "node:assert/strict";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import {
  assertCanSaveEquipmentReport, assertEquipmentReportHours, assertEquipmentReportRevision,
  assertEquipmentReportSiteAccess, canReviewEquipmentReport, completeEquipmentReportRows,
  nextEquipmentReportStatus, normalizeEquipmentReportRows, validEquipmentReportDate,
  collectEquipmentReportHourIssues, inspectEquipmentReportRows, isLegacyEquipmentReportMutation,
} from "../app/equipmentReportWorkflow.ts";

const foreman = { id: 7, role: "foreman", assignedSiteId: 1, permissions: rolePermissionTemplate("foreman") };
const engineer = { id: 8, role: "engineer", assignedSiteId: 1, projectAccess: { mode: "selected", siteIds: [1] }, permissions: rolePermissionTemplate("engineer") };
const report = { siteId: 1, ownerUserId: foreman.id, status: "draft", revision: 2 };
const completeRow = { equipmentId: 11, shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, hours: 6, note: "" };
const code = (value) => (error) => error.code === value;

test("drafts accept partial cells but submitting requires complete nonempty rows", () => {
  const partial = normalizeEquipmentReportRows([{ equipmentId: 11, note: "  Проверить  " }]);
  assert.equal(partial[0].note, "Проверить");
  assert.equal(partial[0].hours, null);
  assert.throws(() => completeEquipmentReportRows(partial), /заполните/);
  assert.throws(() => completeEquipmentReportRows([]), /Добавьте/);
  assert.deepEqual(completeEquipmentReportRows(normalizeEquipmentReportRows([completeRow])), [completeRow]);
  for (const hours of [0, 11, 1.5, NaN, "8"]) assert.throws(() => normalizeEquipmentReportRows([{ hours }]), /часов/);
});

test("foreman can submit his own assigned-site report but cannot review anyone", () => {
  assert.equal(nextEquipmentReportStatus(foreman, report, "submit"), "submitted");
  assert.equal(nextEquipmentReportStatus(foreman, { ...report, status: "submitted" }, "reopen"), "draft");
  assert.throws(() => nextEquipmentReportStatus(foreman, { ...report, status: "submitted" }, "approve"), code("REVIEW_FORBIDDEN"));
  assert.throws(() => nextEquipmentReportStatus(foreman, { ...report, ownerUserId: 99 }, "submit"), code("REPORT_FORBIDDEN"));
  assert.throws(() => assertEquipmentReportSiteAccess(foreman, 2), code("REPORT_FORBIDDEN"));
  assert.equal(canReviewEquipmentReport(foreman), false);
});

test("engineer review has explicit transitions and a reason when returning for corrections", () => {
  const submitted = { ...report, status: "submitted" };
  assert.equal(nextEquipmentReportStatus(engineer, submitted, "approve"), "approved");
  assert.equal(nextEquipmentReportStatus(engineer, submitted, "reject", "Неверная зона"), "rejected");
  assert.throws(() => nextEquipmentReportStatus(engineer, submitted, "reject", "  "), /причину/);
  assert.equal(nextEquipmentReportStatus(foreman, { ...report, status: "rejected" }, "submit"), "submitted");
  for (const action of ["submit", "approve", "reject", "reopen"]) {
    assert.throws(() => nextEquipmentReportStatus(engineer, { ...report, status: "approved" }, action, "Возврат"), code("INVALID_TRANSITION"));
  }
  assert.doesNotThrow(() => assertCanSaveEquipmentReport(engineer, submitted));
  assert.doesNotThrow(() => assertCanSaveEquipmentReport(engineer, { ...report, status: "approved" }));
  assert.doesNotThrow(() => assertCanSaveEquipmentReport({ ...engineer, role: "superadmin" }, { ...report, status: "approved" }));
  assert.throws(() => assertCanSaveEquipmentReport(foreman, submitted), code("REPORT_FORBIDDEN"));
  assert.throws(() => assertCanSaveEquipmentReport(foreman, { ...report, status: "approved" }), code("REPORT_FORBIDDEN"));
});

test("custom permissions remain effective even for the engineer role", () => {
  const restricted = { ...engineer, permissions: rolePermissionTemplate("engineer") };
  restricted.permissions.equipment_report.update = false;
  assert.equal(canReviewEquipmentReport(restricted), false);
  for (const status of ["draft", "submitted", "approved"]) assert.throws(() => assertCanSaveEquipmentReport(restricted, { ...report, status }), code("REPORT_FORBIDDEN"));
  assert.throws(() => nextEquipmentReportStatus(restricted, { ...report, status: "submitted" }, "approve"), code("REPORT_FORBIDDEN"));
  const cannotCreate = { ...foreman, permissions: rolePermissionTemplate("foreman") };
  cannotCreate.permissions.equipment_report.create = false;
  assert.throws(() => assertCanSaveEquipmentReport(cannotCreate), code("REPORT_FORBIDDEN"));
});

test("unfinished equipment drafts are private to their author regardless of review rights", () => {
  for (const role of ["engineer", "superadmin"]) {
    const reviewer = { ...engineer, role };
    for (const status of ["draft", "rejected"]) {
      const foreign = { ...report, status };
      assert.throws(() => assertCanSaveEquipmentReport(reviewer, foreign), code("REPORT_FORBIDDEN"));
      assert.throws(() => nextEquipmentReportStatus(reviewer, foreign, "submit"), code("REPORT_FORBIDDEN"));
      assert.doesNotThrow(() => assertCanSaveEquipmentReport(reviewer, { ...foreign, ownerUserId: reviewer.id }));
    }
    assert.throws(() => nextEquipmentReportStatus(reviewer, { ...report, status: "submitted" }, "reopen"), code("REPORT_FORBIDDEN"));
  }
});

test("revisions are mandatory and prevent stale or repeated approval", () => {
  assert.doesNotThrow(() => assertEquipmentReportRevision(3, 3));
  for (const expected of [undefined, null, 0, 2, "3", NaN]) assert.throws(() => assertEquipmentReportRevision(3, expected), code("STALE_REPORT"));
});

test("daily equipment hours cap at 20 across projects while each report row stays within 1–10", () => {
  assert.doesNotThrow(() => assertEquipmentReportHours([{ ...completeRow, hours: 10 }], new Map([[11, 10]])));
  assert.throws(() => assertEquipmentReportHours([{ ...completeRow, hours: 10 }], new Map([[11, 11]])), code("HOURS_CONFLICT"));
  assert.throws(() => assertEquipmentReportHours([{ ...completeRow, hours: 10 }, { ...completeRow, hours: 10 }, { ...completeRow, hours: 1 }], new Map()), code("HOURS_CONFLICT"));
  assert.doesNotThrow(() => assertEquipmentReportHours([{ ...completeRow, hours: 10 }, { ...completeRow, equipmentId: 12, hours: 10 }], new Map()));
});

test("calendar validation rejects normalized but nonexistent dates", () => {
  assert.equal(validEquipmentReportDate("2026-02-30"), false);
  assert.equal(validEquipmentReportDate("2026-13-01"), false);
  assert.equal(validEquipmentReportDate("2028-02-29"), true);
  assert.equal(validEquipmentReportDate("2026-10-28"), true);
});

test("submission inspection reports every invalid or incomplete row together", () => {
  const result = inspectEquipmentReportRows([
    { ...completeRow, hours: 11, shiftId: -1, note: "x".repeat(4001) },
    { equipmentId: 12, hours: null },
    null,
    { ...completeRow, equipmentId: 13, hours: 4 },
  ]);
  assert.deepEqual(result.issues.map(issue => issue.rowNumbers), [[1], [1], [1], [2], [3]]);
  assert.equal(result.issues.filter(issue => issue.code === "INVALID_ROW_VALUE").length, 3);
  assert.equal(result.issues[3].code, "INCOMPLETE_ROW");
  assert.equal(result.issues[4].code, "INVALID_ROW");
  assert.equal(result.rows[0].hours, null);
  assert.equal(result.rows[3].equipmentId, 13);
  assert.equal(result.rows[3].hours, 4);
  assert.equal(inspectEquipmentReportRows([]).issues[0].code, "EMPTY_REPORT");
  assert.equal(inspectEquipmentReportRows([{}], false).issues.length, 0);
});

test("all equipment hour conflicts are collected once with all contributing row numbers", () => {
  const rows = [
    { equipmentId: 11, hours: 2 },
    { equipmentId: 12, hours: 3 },
    { equipmentId: 11, hours: 2 },
    { equipmentId: 13, hours: 10 },
  ];
  const approved = new Map([[11, 18], [12, 19]]);
  const names = new Map([[11, "Первый экскаватор"], [12, "Второй экскаватор"]]);
  const issues = collectEquipmentReportHourIssues(rows, approved, names);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map(issue => [issue.equipmentId, issue.rowNumbers]), [[11, [1, 3]], [12, [2]]]);
  assert.deepEqual(issues.map(issue => [issue.usedHours, issue.requestedHours, issue.availableHours]), [[18, 4, 2], [19, 3, 1]]);
  assert.throws(() => assertEquipmentReportHours(rows, approved, names), error => {
    assert.equal(error.code, "HOURS_CONFLICT");
    assert.deepEqual(error.details.issues, issues);
    assert.match(error.message, /Первый экскаватор/);
    assert.match(error.message, /Второй экскаватор/);
    return true;
  });
  assert.deepEqual(collectEquipmentReportHourIssues([{ equipmentId: 11, hours: 2 }, { equipmentId: 12, hours: 1 }], approved), []);
});

test("only the author can reopen submitted equipment reports, including reviewing roles", () => {
  assert.throws(() => nextEquipmentReportStatus(engineer, { ...report, status: "submitted" }, "reopen"), code("REPORT_FORBIDDEN"));
  assert.equal(nextEquipmentReportStatus(engineer, { ...report, ownerUserId: engineer.id, status: "submitted" }, "reopen"), "draft");
});

test("legacy entry publishing endpoints are blocked without blocking catalog or timesheet writes", () => {
  for (const action of ["save-entry", "delete-entry", "import-entries", "submit-daily-report"]) assert.equal(isLegacyEquipmentReportMutation(action), true);
  for (const action of ["save-timesheet-mark", "save-unit", "delete-unit", "import-units", "assign-unit-project", "remove-unit-project", undefined, null, 10]) assert.equal(isLegacyEquipmentReportMutation(action), false);
});


test("equipment engineers review every owner in their assigned project, while all-project engineers can review all projects", () => {
  const ownProject = { ...report, status: "submitted", ownerUserId: 99 };
  assert.doesNotThrow(() => assertEquipmentReportSiteAccess(engineer, 1));
  assert.equal(nextEquipmentReportStatus(engineer, ownProject, "approve"), "approved");
  assert.doesNotThrow(() => assertCanSaveEquipmentReport(engineer, { ...ownProject, status: "approved" }));
  const foreign = { ...ownProject, siteId: 2 };
  // Even fully enabled resource overrides never remove a role's project boundary.
  const enabled = { ...engineer, permissions: rolePermissionTemplate("superadmin") };
  for (const action of ["submit", "approve", "reject", "reopen"]) {
    assert.throws(() => nextEquipmentReportStatus(enabled, foreign, action, "Причина"), code("REPORT_FORBIDDEN"));
  }
  for (const status of ["draft", "submitted", "approved", "rejected"]) {
    assert.throws(() => assertCanSaveEquipmentReport(enabled, { ...foreign, status }), code("REPORT_FORBIDDEN"));
  }
  assert.throws(() => assertEquipmentReportSiteAccess({ ...engineer, projectAccess: { mode: "selected", siteIds: [] } }, 1), code("REPORT_FORBIDDEN"));
  const allProjectEngineer = { ...engineer, assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] } };
  assert.doesNotThrow(() => assertEquipmentReportSiteAccess(allProjectEngineer, 2));
  assert.equal(nextEquipmentReportStatus(allProjectEngineer, foreign, "approve"), "approved");
  assert.equal(nextEquipmentReportStatus(allProjectEngineer, foreign, "reject", "Уточните работы"), "rejected");
  assert.doesNotThrow(() => assertCanSaveEquipmentReport(allProjectEngineer, { ...foreign, status: "approved" }));
});
