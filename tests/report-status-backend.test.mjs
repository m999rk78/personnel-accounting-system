import assert from "node:assert/strict";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import * as personnelWorkflow from "../app/personnelReportWorkflow.ts";
import * as equipmentWorkflow from "../app/equipmentReportWorkflow.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const personnelStore = await import(await compileModuleGraph(new URL("../app/personnelReportStore.ts", import.meta.url)));
const equipmentStore = await import(await compileModuleGraph(new URL("../app/equipmentReportStore.ts", import.meta.url)));
const personnelBuffer = await import(await compileModuleGraph(new URL("../app/personnelReportDraftBufferStore.ts", import.meta.url)));
const equipmentBuffer = await import(await compileModuleGraph(new URL("../app/equipmentReportDraftBufferStore.ts", import.meta.url)));
const denied = error => error.code === "REPORT_FORBIDDEN" && error.status === 403;
const actor = (role = "engineer") => ({ id: 8, role, assignedSiteId: 7, projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate(role) });
const identity = (status, ownerUserId = 8) => ({ siteId: 7, ownerUserId, status, revision: 1 });
const hidden = { view: false, create: false, update: false, delete: false };
const readOnly = { ...hidden, view: true };

for (const [label, resource, workflow, store, buffer] of [
  ["Personnel", "workers_report", personnelWorkflow, personnelStore, personnelBuffer],
  ["Equipment", "equipment_report", equipmentWorkflow, equipmentStore, equipmentBuffer],
]) {
  const save = workflow[`assertCanSave${label}Report`];
  const next = workflow[`next${label}ReportStatus`];
  const list = store[`list${label}Reports`];

  test(`${label}: a draft editor can edit only own drafts while confirmed and submitted records stay read-only`, () => {
    const user = actor();
    user.permissions[`${resource}_approved`] = { ...readOnly };
    user.permissions[`${resource}_submitted`] = { ...readOnly };
    assert.doesNotThrow(() => save(user));
    assert.doesNotThrow(() => save(user, identity("draft")));
    assert.doesNotThrow(() => save(user, identity("rejected")));
    assert.throws(() => save(user, identity("draft", 9)), denied);
    for (const status of ["submitted", "approved"]) assert.throws(() => save(user, identity(status)), denied);
    assert.equal(next(user, identity("draft"), "submit"), "submitted");
    assert.equal(next(user, identity("submitted"), "reopen"), "draft");
    assert.throws(() => next(user, identity("submitted", 9), "reopen"), denied);
    assert.throws(() => next(user, identity("submitted"), "approve"), error => error.status === 403 && ["REPORT_FORBIDDEN", "REVIEW_FORBIDDEN"].includes(error.code));
  });

  test(`${label}: draft denial does not disable permitted confirmed edits, and hidden records cannot be mutated`, () => {
    const user = actor();
    user.permissions[`${resource}_draft`] = { ...hidden };
    assert.throws(() => save(user), denied);
    assert.throws(() => save(user, identity("draft")), denied);
    assert.doesNotThrow(() => save(user, identity("approved", 9)));
    user.permissions[`${resource}_approved`].view = false;
    assert.throws(() => save(user, identity("approved", 9)), denied);
  });

  test(`${label}: approval, submission and reopening enforce both sides of the transition`, () => {
    const user = actor();
    user.permissions[`${resource}_approved`].create = false;
    assert.throws(() => next(user, identity("submitted", 9), "approve"), denied);
    assert.equal(next(user, identity("submitted", 9), "reject", "Уточнить часы"), "rejected");
    user.permissions[`${resource}_approved`].create = true;
    user.permissions[`${resource}_approved`].update = false;
    assert.equal(next(user, identity("submitted", 9), "approve"), "approved");
    user.permissions[`${resource}_submitted`].view = false;
    assert.throws(() => next(user, identity("draft"), "submit"), denied);
    user.permissions[`${resource}_submitted`].view = true;
    user.permissions[`${resource}_draft`].update = false;
    assert.throws(() => next(user, identity("submitted"), "reopen"), denied);
  });

  test(`${label}: explicit status rights allow every role to edit published reports, but never foreign drafts`, () => {
    for (const role of ["foreman", "viewer", "engineer", "superadmin"]) {
      const user = actor(role);
      user.permissions = rolePermissionTemplate("superadmin");
      assert.doesNotThrow(() => save(user, identity("approved", 9)));
      assert.doesNotThrow(() => save(user, identity("submitted", 9)));
      assert.equal(next(user, identity("submitted", 9), "approve"), "approved");
      assert.throws(() => save(user, identity("draft", 9)), denied);
      assert.throws(() => next(user, identity("draft", 9), "submit"), denied);
      assert.doesNotThrow(() => buffer[`assert${label}ReportDraftBufferAccess`](user, 7));
      user.permissions[`${resource}_approved`].update = false;
      assert.throws(() => save(user, identity("approved", 9)), denied);
    }
  });

  test(`${label}: legacy published mutations fail before SQL when only approved editing is denied`, async () => {
    const user = actor(); user.permissions[`${resource}_approved`].update = false;
    const db = { transaction: callback => callback(db), prepare() { throw new Error("Forbidden mutation reached SQL"); } };
    await assert.rejects(store[`mutate${label}ReportEntry`](db, user, {}), denied);
    const changeDate = label === "Personnel" ? store.mutatePersonnelReportEntryDate : store.changeEquipmentReportEntryDate;
    await assert.rejects(changeDate(db, user, {}), denied);
    if (label === "Personnel") {
      user.permissions.workers_report_approved.delete = false;
      await assert.rejects(store.deletePersonnelReportApprovedRows(db, user, {}), denied);
    }
  });

  test(`${label}: autosave requires draft access even if other report statuses remain writable`, () => {
    const user = actor();
    user.permissions[`${resource}_draft`] = { ...hidden };
    assert.throws(() => buffer[`assert${label}ReportDraftBufferAccess`](user, 7), error => error.code === "DRAFT_BUFFER_FORBIDDEN");
    user.permissions[`${resource}_draft`] = { ...readOnly };
    assert.throws(() => buffer[`assert${label}ReportDraftBufferAccess`](user, 7), error => error.code === "DRAFT_BUFFER_FORBIDDEN");
    user.permissions[`${resource}_draft`].update = true;
    assert.doesNotThrow(() => buffer[`assert${label}ReportDraftBufferAccess`](user, 7));
  });

  test(`${label}: listing applies status filters in SQL and never returns hidden publications or foreign drafts`, async () => {
    const user = actor();
    user.permissions[`${resource}_submitted`] = { ...hidden };
    user.permissions[`${resource}_approved`] = { ...hidden };
    const headers = [8, 9].flatMap(ownerUserId => ["draft", "rejected", "submitted", "approved"].map((status, index) => ({ ...identity(status, ownerUserId), id: ownerUserId * 10 + index, workDate: "2026-11-09" })));
    const queries = [];
    const db = { prepare(sql) {
      let values = [];
      const execute = () => {
        queries.push({ sql, values });
        if (sql.includes("FROM sites WHERE")) return [{ id: 7 }];
        if (sql.includes("JOIN app_users owner")) return headers;
        if (sql.includes("draft_row JOIN")) return values[0].map(reportId => ({ id: reportId, reportId }));
        if (sql.includes("equipment_timesheet_marks")) return [];
        throw new Error(`Unexpected or unauthorized SQL: ${sql}`);
      };
      const statement = { bind(...params) { values = params; return statement; }, async first() { return execute()[0]; }, async all() { return { results: execute() }; } };
      return statement;
    } };
    const result = await list(db, user, 7, null, null);
    assert.deepEqual(result.reports.map(report => report.id), [80, 81]);
    assert.deepEqual(result.entries, []);
    const headerQuery = queries.find(query => query.sql.includes("JOIN app_users owner"));
    assert.match(headerQuery.sql, /report\.status = ANY\(\?\)/);
    assert.deepEqual(headerQuery.values.at(-1), ["draft", "rejected"]);
    const sourceQuery = queries.find(query => query.sql.includes("draft_row JOIN"));
    assert.deepEqual(sourceQuery.values, [[80, 81]]);
  });
}
