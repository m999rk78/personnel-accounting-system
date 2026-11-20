import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { canModifyReportOwner } from "../app/reportRowPermissions.ts";

function bind(code, result, environment) {
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), `${compiled}\nreturn ${result};`)(...Object.values(environment));
}

for (const kind of ["Personnel", "Equipment"]) {
  const path = `../app/${kind}ReportWorkspace.tsx`;
  const file = ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ["canEdit", "rows", "beginReview"].includes(node.name.getText(file))) declarations.set(node.name.getText(file), node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of ["canEdit", "rows", "beginReview"]) assert.ok(declarations.has(name), `${path}: actual ${name} implementation exists`);

  function harness(role, { canEditApproved = true, canDeleteApproved = true, locked = false } = {}) {
    const currentUser = { id: 7, role, fullName: "Учебный пользователь" };
    const makeReport = (id, status, ownerUserId) => ({ id, ownerUserId, status, siteId: 1, workDate: "2026-11-20", ownerName: "Автор",
      rows: [{ id: id + 100, reportId: id, ...(status === "approved" ? { approvedEntryId: id + 200 } : {}) }] });
    const reports = [makeReport(10, "approved", 7), makeReport(11, "approved", 8), makeReport(12, "submitted", 7), makeReport(13, "submitted", 8)];
    const toDraft = row => ({ key: `report-${row.reportId}-${row.id}`, reportRowId: row.id });
    const environment = {
      currentUser, canModifyReportOwner, permissions: { create: true, update: true, view: true }, canEditApproved, canDeleteApproved, canEditSubmitted: true,
      locked, reports, edits: {}, entrySessions: {}, newDraftGroups: [],
      statusAccess: { approved: { view: true } },
      data: { entries: [{ id: 201, responsibleUserId: 7 }, { id: 202, responsibleUserId: 8 }, { id: 203, responsibleUserId: null }] },
      useCallback: callback => callback, useMemo: callback => callback(),
      [`is${kind}ReportDraft`]: status => ["draft", "rejected"].includes(status),
      keyOf: report => String(report.id), entryKey: entry => `entry-${entry.id}`,
      toDraft, toApprovedDraft: toDraft, toEntryDraft: entry => ({ key: `approved-${entry.id}` }),
    };
    const canEdit = bind(`const ${declarations.get("canEdit")};`, "canEdit", environment);
    const rows = bind(`const ${declarations.get("rows")};`, "rows", { ...environment, canEdit });
    let review = null, error = "";
    const beginReview = bind(`const ${declarations.get("beginReview")};`, "beginReview", { ...environment,
      canApprove: true, setError: value => { error = value; }, setReportsOpen() {}, setComment() {}, setReview: value => { review = value; },
      [`${kind.toLowerCase()}ReportReviewIssue`]: () => null,
    });
    return { rows, reports, beginReview, get review() { return review; }, get error() { return error; } };
  }

  test(`${kind}: an explicitly granted foreman can edit and delete own approved rows, while another author's rows stay read-only`, () => {
    const { rows } = harness("foreman");
    const byKey = new Map(rows.map(row => [row.rowKey, row]));
    for (const key of ["report-10-110", "approved-201"]) {
      const row = byKey.get(key);
      assert.equal(row.editable, true); assert.equal(row.dateEditable, true); assert.equal(row.removable, true);
    }
    for (const key of ["report-11-111", "approved-202", "approved-203"]) {
      const row = byKey.get(key);
      assert.equal(row.editable, false); assert.equal(row.dateEditable, false); assert.equal(row.removable, false);
    }
    assert.equal(byKey.get("approved-202").draft, undefined, "Read-only legacy rows do not enter the editable owner map");
    assert.equal(byKey.get("report-12-112").editable, true);
    assert.equal(byKey.get("report-13-113").editable, false);
  });

  test(`${kind}: engineer and other explicitly granted roles retain cross-author approved access`, () => {
    for (const role of ["engineer", "superadmin", "viewer"]) {
      const { rows } = harness(role);
      assert.ok(rows.filter(row => row.status === "approved").every(row => row.editable && row.dateEditable && row.removable));
      assert.ok(rows.filter(row => row.status === "submitted").every(row => row.editable));
    }
  });

  test(`${kind}: ownership does not grant missing edit/delete rights and busy rows stay locked`, () => {
    const withoutEdit = harness("foreman", { canEditApproved: false }).rows.find(row => row.rowKey === "approved-201");
    assert.equal(withoutEdit.editable, false); assert.equal(withoutEdit.dateEditable, false); assert.equal(withoutEdit.removable, true);
    assert.equal(withoutEdit.draft, undefined);
    assert.ok(harness("foreman", { canDeleteApproved: false }).rows.filter(row => row.status === "approved").every(row => !row.removable));
    assert.ok(harness("foreman", { locked: true }).rows.every(row => !row.editable && !row.removable));
  });

  test(`${kind}: focused review actions mirror the server's foreman ownership rule`, () => {
    for (const action of ["approve", "reject"]) {
      const own = harness("foreman"); own.beginReview(own.reports[2], action);
      assert.equal(own.review.report.id, 12); assert.equal(own.error, "");
      const other = harness("foreman"); other.beginReview(other.reports[3], action);
      assert.equal(other.review, null); assert.match(other.error, /Нет права/);
      const engineer = harness("engineer"); engineer.beginReview(engineer.reports[3], action);
      assert.equal(engineer.review.report.id, 13); assert.equal(engineer.error, "");
    }
  });
}

test("a foreman cannot mutate unassigned historical rows, while the owner predicate imposes no new cap on explicit grants for other roles", () => {
  assert.equal(canModifyReportOwner({ id: 7, role: "foreman" }, null), false);
  assert.equal(canModifyReportOwner({ id: 7, role: "foreman" }, undefined), false);
  assert.equal(canModifyReportOwner({ id: 7, role: "viewer" }, 8), true);
});
