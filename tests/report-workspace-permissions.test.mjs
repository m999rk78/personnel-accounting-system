import assert from "node:assert/strict";
import test from "node:test";
import { reportWorkspacePermissions } from "../app/reportWorkspacePermissions.ts";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

const granted = { create: true, update: true, delete: true };
const readOnly = { view: true, create: false, update: false, delete: false };
for (const resource of ["workers_report", "equipment_report"]) {
  test(`${resource}: foreman's default is own draft work and read-only review/confirmed tabs`, () => {
    const access = reportWorkspacePermissions(resource, { role: "foreman" }, granted);
    assert.deepEqual(access.draft, { view: true, ...granted });
    assert.deepEqual(access.submitted, readOnly);
    assert.deepEqual(access.approved, readOnly);
  });

  test(`${resource}: custom draft editor cannot modify or delete confirmed records`, () => {
    const permissions = rolePermissionTemplate("engineer");
    permissions[`${resource}_approved`] = { ...readOnly };
    permissions[`${resource}_submitted`] = { ...readOnly };
    const access = reportWorkspacePermissions(resource, { role: "engineer", permissions }, granted);
    assert.equal(access.draft.create, true);
    assert.equal(access.draft.update, true);
    assert.equal(access.draft.delete, true);
    assert.deepEqual(access.approved, readOnly);
    assert.deepEqual(access.submitted, readOnly);
  });

  test(`${resource}: confirmed correction can be granted without access to draft or review data`, () => {
    const permissions = rolePermissionTemplate("engineer");
    for (const status of ["draft", "submitted"]) permissions[`${resource}_${status}`] = { view: false, create: false, update: false, delete: false };
    const access = reportWorkspacePermissions(resource, { role: "engineer", permissions }, granted);
    assert.equal(access.draft.view, false);
    assert.equal(access.submitted.view, false);
    assert.equal(access.approved.update, true);
    assert.equal(access.approved.delete, true);
  });

  test(`${resource}: viewer defaults show submitted reports without granting changes or private drafts`, () => {
    const viewer = reportWorkspacePermissions(resource, { role: "viewer", canViewPendingReports: false }, granted);
    assert.equal(viewer.draft.view, false);
    assert.deepEqual(viewer.submitted, readOnly);
    assert.deepEqual(viewer.approved, readOnly);
  });

  test(`${resource}: explicit rights work equally for viewer and foreman, including the legacy pending flag being false`, () => {
    const full = rolePermissionTemplate("superadmin");
    for (const role of ["viewer", "foreman"]) {
      const explicit = reportWorkspacePermissions(resource, { role, canViewPendingReports: false, permissions: full }, granted);
      for (const status of Object.values(explicit)) assert.deepEqual(status, { view: true, ...granted });
    }
    const bound = reportWorkspacePermissions(resource, { role: "viewer", permissions: full }, { create: false, update: false, delete: false });
    for (const status of Object.values(bound)) assert.deepEqual(status, readOnly);
  });

  test(`${resource}: an explicit submitted view denial is respected for every role`, () => {
    for (const role of ["foreman", "engineer", "viewer", "superadmin"]) {
      const permissions = rolePermissionTemplate(role);
      permissions[`${resource}_submitted`] = { view: false, create: false, update: false, delete: false };
      assert.equal(reportWorkspacePermissions(resource, { role, permissions, canViewPendingReports: true }, granted).submitted.view, false);
    }
  });
}

test("personnel and equipment status access can be configured independently", () => {
  const permissions = rolePermissionTemplate("engineer");
  permissions.workers_report_approved = { ...readOnly };
  const user = { role: "engineer", permissions };
  assert.equal(reportWorkspacePermissions("workers_report", user, granted).approved.update, false);
  assert.equal(reportWorkspacePermissions("equipment_report", user, granted).approved.update, true);
});
