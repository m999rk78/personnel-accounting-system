import assert from "node:assert/strict";
import test from "node:test";
import { personnelCellErrors } from "../app/personnelSpreadsheet.ts";
import { personnelSubmissionCellIssues, mergePersonnelSubmissionIssues, personnelSubmissionCanSend, personnelSubmissionToken } from "../app/personnelReportSubmissionValidation.ts";

const option = { id: 1, name: "Доступно" };
const catalogs = { employees: [{ id: 1, fullName: "Иванов Иван", employmentType: "ОПР", department: "МУТТ", position: "Монтажник", source: "manual", siteId: 7, siteName: "Проект" }], shifts: [option], zones: [option], mainWorkTypes: [option], subworkTypes: [{ ...option, mainWorkTypeId: 1 }], masters: [option] };
const draft = (patch = {}) => ({ key: "row-1", employeeId: "1", employeeQuery: "Иванов Иван", shiftId: "1", zoneId: "1", mainWorkTypeId: "1", subworkTypeId: "1", masterId: "1", hours: "8", note: "", ...patch });
const issue = (patch = {}) => ({ key: "report-1", workDate: "2026-10-28", rowNumbers: [1], employeeId: 1, employeeName: "Иванов Иван", code: "INVALID_ROW", message: "Проверьте строку", ...patch });

test("all invalid employees and dates are returned, with every field message per row", () => {
  const bad = draft({ key: "bad", employeeId: "", employeeQuery: " Петров Пётр ", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", masterId: "", hours: "", note: "x".repeat(4001) });
  const groups = [{ key: "report-1", workDate: "2026-10-28", drafts: [draft(), bad] }, { key: "new:2026-10-27", workDate: "2026-10-27", drafts: [draft({ key: "bad-hours", hours: "12", employeeQuery: "" }), draft({ key: "empty", employeeId: "", employeeQuery: "   " })] }];
  const issues = personnelSubmissionCellIssues(groups, catalogs);
  assert.equal(issues.length, 3);
  assert.deepEqual(issues.map(item => [item.key, item.workDate, item.rowNumbers, item.employeeName]), [["report-1", "2026-10-28", [2], "Петров Пётр"], ["new:2026-10-27", "2026-10-27", [1], "Иванов Иван"], ["new:2026-10-27", "2026-10-27", [2], "Сотрудник не выбран"]]);
  for (const message of Object.values(personnelCellErrors(bad, catalogs, true))) assert.ok(issues[0].message.includes(message));
  assert.equal(Object.values(personnelCellErrors(bad, catalogs, true)).length, 8);
  assert.ok(issues.every(item => item.code === "INVALID_ROW"));
  assert.equal(issues[0].employeeId, undefined);
  assert.deepEqual(personnelSubmissionCellIssues([{ key: "valid", workDate: "2026-10-28", drafts: [draft()] }], catalogs), []);
});

test("validation and merging do not modify drafts, groups, catalogs or returned row numbers", () => {
  const frozenDraft = Object.freeze(draft({ hours: "12" }));
  const groups = Object.freeze([Object.freeze({ key: "report-1", workDate: "2026-10-28", drafts: Object.freeze([frozenDraft]) })]);
  const before = JSON.stringify(groups);
  const catalogsBefore = JSON.stringify(catalogs);
  const local = personnelSubmissionCellIssues(groups, catalogs);
  const input = Object.freeze(local.map(item => Object.freeze({ ...item, rowNumbers: Object.freeze([...item.rowNumbers]) })));
  const merged = mergePersonnelSubmissionIssues(input, input);
  assert.equal(JSON.stringify(groups), before);
  assert.equal(JSON.stringify(catalogs), catalogsBefore);
  assert.equal(frozenDraft.hours, "12");
  assert.equal(merged.length, 1);
  assert.equal(merged[0], input[0]);
});

test("local row errors replace overlapping remote cell errors without hiding other rows or dates", () => {
  const local = [issue({ message: "Все ошибки ячеек первой строки" })];
  const remote = [issue({ code: "MISSING_FIELDS" }), issue({ code: "INVALID_REFERENCE", rowNumbers: [2] }), issue({ key: "report-2", workDate: "2026-10-27", code: "MISSING_FIELDS" })];
  assert.deepEqual(mergePersonnelSubmissionIssues(local, remote), [local[0], remote[1], remote[2]]);
});

test("hours, stale versions, permissions and generic server blockers are always retained", () => {
  const local = [issue()];
  const remote = [issue({ code: "HOURS_CONFLICT", rowNumbers: [1, 2] }), issue({ code: "STALE_REPORT" }), issue({ code: "REPORT_FORBIDDEN" }), issue({ code: "INVALID_REPORT_ROW" }), issue({ code: "REPORT_LOCKED" }), issue({ rowNumbers: undefined, code: "INVALID_REPORT", message: "Ошибка отчёта целиком" })];
  assert.deepEqual(mergePersonnelSubmissionIssues(local, remote), [...local, ...remote]);
});

test("exact duplicate issues are deduplicated irrespective of object property order", () => {
  const original = issue({ code: "HOURS_CONFLICT" });
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.deepEqual(mergePersonnelSubmissionIssues([original, original], [reordered]), [original]);
});

test("fingerprints include site, selected reports, frozen revision and every row value", () => {
  const reports = [{ key: "report-1", reportId: 1, revision: 4, workDate: "2026-10-28", rows: [draft()] }, { key: "report-2", reportId: 2, revision: 1, workDate: "2026-10-27", rows: [draft({ key: "row-2" })] }];
  const token = personnelSubmissionToken(7, reports);
  assert.equal(token, personnelSubmissionToken(7, reports.map(report => Object.fromEntries(Object.entries(report).reverse()))));
  assert.notEqual(token, personnelSubmissionToken(8, reports));
  assert.notEqual(token, personnelSubmissionToken(7, reports.slice(1)));
  assert.notEqual(token, personnelSubmissionToken(7, [...reports].reverse()));
  for (const patch of [{ revision: 5 }, { reportId: 9 }, { workDate: "2026-10-26" }]) assert.notEqual(token, personnelSubmissionToken(7, [{ ...reports[0], ...patch }, reports[1]]));
  for (const patch of [{ hours: "9" }, { employeeId: "2" }, { note: "Изменено" }, { shiftId: "2" }, { zoneId: "2" }, { mainWorkTypeId: "2" }, { subworkTypeId: "2" }, { masterId: "2" }, { inputValues: { hours: "ошибка" } }]) assert.notEqual(token, personnelSubmissionToken(7, [{ ...reports[0], rows: [{ ...reports[0].rows[0], ...patch }] }, reports[1]]));
});

test("send gating rejects checking, invalid, failed and stale successful validations", () => {
  const token = personnelSubmissionToken(7, [{ key: "selected", rows: [draft()] }]);
  const valid = { token, status: "valid", issues: [] };
  assert.equal(personnelSubmissionCanSend(token, valid, true), true);
  assert.equal(personnelSubmissionCanSend(token, valid, false), false);
  for (const status of ["checking", "invalid", "error"]) assert.equal(personnelSubmissionCanSend(token, { ...valid, status }, true), false);
  assert.equal(personnelSubmissionCanSend(token, { ...valid, issues: [issue()] }, true), false);
  assert.equal(personnelSubmissionCanSend(token, { ...valid, token: "previous-selection" }, true), false);
  assert.equal(personnelSubmissionCanSend(`${token}changed`, valid, true), false);
  assert.equal(personnelSubmissionCanSend(token, null, true), false);
  assert.equal(personnelSubmissionCanSend(token, undefined, true), false);
  assert.equal(personnelSubmissionCanSend("", { ...valid, token: "" }, true), false);
});
