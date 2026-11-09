import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { PERMISSION_ACTIONS, REPORT_PERMISSION_RESOURCES, emptyPermissionSet, getReportStatusPermission, hasReportStatusPermission, limitPermissionsToRole, normalizePermissionSet, patchPermissionSet, rolePermissionTemplate, reportStatusPermissionResource } from "../app/permissionModel.ts";
import { normalizeCustomRolePermissions } from "../app/customRoles.ts";
import { canViewPendingReportsFor } from "../app/roles.ts";

for (const resource of REPORT_PERMISSION_RESOURCES) test(`${resource}: foreman writes only own drafts; reviewer and viewer defaults retain their capabilities`, () => {
  const foreman = rolePermissionTemplate("foreman");
  assert.deepEqual(getReportStatusPermission(foreman, resource, "draft"), { view: true, create: true, update: true, delete: true });
  for (const status of ["submitted", "approved"]) assert.deepEqual(getReportStatusPermission(foreman, resource, status), { view: true, create: false, update: false, delete: false });
  for (const status of ["draft", "submitted", "approved"]) {
    assert.ok(PERMISSION_ACTIONS.every(action => hasReportStatusPermission(rolePermissionTemplate("engineer"), resource, status, action)));
    assert.deepEqual(getReportStatusPermission(rolePermissionTemplate("viewer"), resource, status), { view: status !== "draft", create: false, update: false, delete: false });
  }
  assert.deepEqual(getReportStatusPermission(foreman, resource, "rejected"), getReportStatusPermission(foreman, resource, "draft"));
});

test("legacy overall report rights inherit safely while explicit child and parent denies remain effective", () => {
  const legacy = { workers_report: { view: true, update: true, create: false, delete: false } };
  assert.equal(getReportStatusPermission(legacy, "workers_report", "approved").update, true);
  assert.equal(normalizePermissionSet(legacy).workers_report_approved.update, true);
  const safeForeman = normalizePermissionSet(legacy, rolePermissionTemplate("foreman"));
  assert.equal(safeForeman.workers_report_draft.update, true);
  assert.equal(safeForeman.workers_report_approved.update, false);
  const explicit = normalizePermissionSet({ workers_report: { view: true, update: true }, workers_report_approved: { view: true, update: false } }, rolePermissionTemplate("engineer"));
  assert.equal(explicit.workers_report_approved.update, false);
  assert.equal(explicit.workers_report_submitted.update, true);
  const parentDeny = normalizePermissionSet({ workers_report: { view: true, create: false, update: false, delete: false } }, rolePermissionTemplate("engineer"));
  for (const status of ["draft", "submitted", "approved"]) assert.equal(getReportStatusPermission(parentDeny, "workers_report", status).update, false);
});

test("old stored custom-role JSON fills status rows using its base role without granting unrelated sections", () => {
  const old = { workers_report: { view: true, create: true, update: true, delete: true } };
  const foreman = normalizeCustomRolePermissions(old, "foreman");
  assert.equal(foreman.workers_report_draft.update, true);
  assert.equal(foreman.workers_report_submitted.update, false);
  assert.equal(foreman.workers_report_approved.update, false);
  assert.equal(foreman.equipment_report.view, false);
  assert.equal(foreman.employees.view, false);
  const custom = normalizeCustomRolePermissions(old, "engineer");
  assert.equal(custom.workers_report_approved.update, true);
  assert.equal(custom.employees.view, false);
  assert.deepEqual(normalizeCustomRolePermissions(JSON.parse(JSON.stringify(foreman)), "foreman"), foreman);
});

test("status checkbox enables its general bound without granting another report or status", () => {
  const selected = patchPermissionSet(emptyPermissionSet(), "workers_report_draft", "update", true);
  assert.equal(selected.workers_report.update, true);
  assert.equal(selected.workers_report.view, true);
  assert.equal(selected.workers_report_draft.update, true);
  assert.equal(selected.workers_report_draft.view, true);
  assert.equal(selected.workers_report_approved.view, false);
  assert.equal(selected.workers_report_submitted.update, false);
  assert.equal(selected.equipment_report.view, false);
  const disabled = patchPermissionSet(selected, "workers_report", "view", false);
  for (const status of ["draft", "submitted", "approved"]) assert.deepEqual(getReportStatusPermission(disabled, "workers_report", status), { view: false, create: false, update: false, delete: false });
});

test("general checkbox can set a report's status rows together, then one tab can be restricted", () => {
  let value = patchPermissionSet(emptyPermissionSet(), "equipment_report", "update", true);
  for (const status of ["draft", "submitted", "approved"]) assert.equal(getReportStatusPermission(value, "equipment_report", status).update, true);
  value = patchPermissionSet(value, "equipment_report_approved", "update", false);
  assert.equal(value.equipment_report_draft.update, true);
  assert.equal(value.equipment_report_approved.update, false);
  assert.equal(value.equipment_report_approved.view, true);
  value = patchPermissionSet(value, "equipment_report", "update", false);
  for (const status of ["draft", "submitted", "approved"]) assert.equal(getReportStatusPermission(value, "equipment_report", status).update, false);
});

test("every role can receive the same explicit supported grants without a permanent role ceiling", () => {
  for (const role of ["foreman", "engineer", "viewer", "superadmin"]) {
    const permissions = limitPermissionsToRole(role, rolePermissionTemplate("superadmin"), { mode: "selected", siteIds: [7] });
    assert.deepEqual(permissions, rolePermissionTemplate("superadmin"));
    for (const resource of REPORT_PERMISSION_RESOURCES) for (const status of ["draft", "submitted", "approved"]) {
      const row = permissions[reportStatusPermissionResource(resource, status)];
      assert.ok(PERMISSION_ACTIONS.every(action => row[action]));
    }
  }
});

test("viewers see submitted reports by default while explicit status denies remain authoritative", () => {
  const permissions = rolePermissionTemplate("viewer");
  assert.equal(canViewPendingReportsFor({ role: "viewer", canViewPendingReports: false, permissions }), true);
  assert.equal(permissions.workers_report_draft.view, false);
  for (const resource of ["workers_report_submitted", "equipment_report_submitted"]) permissions[resource].view = false;
  assert.equal(canViewPendingReportsFor({ role: "viewer", canViewPendingReports: true, permissions }), false);
  permissions.workers_report_draft.view = true;
  assert.equal(canViewPendingReportsFor({ role: "viewer", canViewPendingReports: false, permissions }), true);
});

test("individual status overrides persist as separate rows and survive effective-permission loading", async context => {
  const previousMode = process.env.NODE_ENV, previousBootstrap = process.env.DATABASE_RUNTIME_BOOTSTRAP;
  process.env.NODE_ENV = "production"; delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
  context.after(() => { if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode; if (previousBootstrap === undefined) delete process.env.DATABASE_RUNTIME_BOOTSTRAP; else process.env.DATABASE_RUNTIME_BOOTSTRAP = previousBootstrap; });
  const stored = new Map();
  const db = { prepare(sql) {
    let values = [];
    const execute = () => {
      if (sql.startsWith("DELETE FROM user_permissions")) stored.clear();
      else if (sql.includes("INSERT INTO user_permissions")) stored.set(values[1], { resource: values[1], canView: values[2], canCreate: values[3], canUpdate: values[4], canDelete: values[5] });
      else if (sql.includes("FROM user_permissions")) return { results: [...stored.values()] };
      else throw new Error(`Unexpected synthetic SQL: ${sql}`);
      return { results: [] };
    };
    const statement = { bind(...args) { values = args; return statement; }, async run() { return execute(); }, async all() { return execute(); } };
    return statement;
  }, async transaction(callback) { return callback(db); } };
  const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const boundaryUrl = dataUrl("export let database;export function configure(value){database=value;}export function getDatabase(){return database;}");
  (await import(boundaryUrl)).configure(db);
  let code = ts.transpileModule(await readFile(new URL("../app/permissions.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  code = code.replaceAll('"../db/client"', JSON.stringify(boundaryUrl)).replaceAll('"./permissionModel"', JSON.stringify(new URL("../app/permissionModel.ts", import.meta.url).href));
  const { saveUserPermissions, loadEffectivePermissions } = await import(dataUrl(code));
  let selected = rolePermissionTemplate("engineer");
  selected = patchPermissionSet(selected, "workers_report_approved", "update", false);
  selected = patchPermissionSet(selected, "equipment_report_draft", "delete", false);
  await saveUserPermissions(42, selected, 1, db);
  assert.equal(stored.get("workers_report_approved").canUpdate, 0);
  assert.equal(stored.get("equipment_report_draft").canDelete, 0);
  const loaded = await loadEffectivePermissions(42, "engineer", undefined, db);
  assert.equal(loaded.permissions.workers_report_draft.update, true);
  assert.equal(loaded.permissions.workers_report_approved.update, false);
  assert.equal(loaded.permissions.equipment_report_draft.delete, false);
  stored.clear();
  stored.set("workers_report", { resource: "workers_report", canView: 1, canCreate: 1, canUpdate: 1, canDelete: 1 });
  const legacy = await loadEffectivePermissions(42, "foreman", undefined, db);
  assert.equal(legacy.permissions.workers_report_draft.update, true);
  assert.equal(legacy.permissions.workers_report_approved.update, false);
  stored.clear();
  let viewer = await loadEffectivePermissions(42, "viewer", undefined, db, undefined, false);
  assert.equal(viewer.permissions.workers_report_submitted.view, true);
  assert.equal(viewer.permissions.workers_report_draft.view, false);
  viewer = await loadEffectivePermissions(42, "viewer", undefined, db, undefined, true);
  assert.equal(viewer.permissions.workers_report_draft.view, true, "old opt-in survives when no explicit status row exists");
  stored.set("workers_report_draft", { resource: "workers_report_draft", canView: 0, canCreate: 0, canUpdate: 0, canDelete: 0 });
  viewer = await loadEffectivePermissions(42, "viewer", undefined, db, undefined, true);
  assert.equal(viewer.permissions.workers_report_draft.view, false, "explicit denial is never replaced by the old flag");
  stored.clear();
  const role = { id: 7, baseRole: "viewer", permissions: rolePermissionTemplate("viewer") };
  viewer = await loadEffectivePermissions(42, "viewer", undefined, db, role, true);
  assert.equal(viewer.permissions.workers_report_draft.view, false, "an explicitly configured role row is authoritative");
  viewer = await loadEffectivePermissions(42, "viewer", undefined, db, { ...role, inheritedStatusPermissions: ["workers_report_draft"] }, true);
  assert.equal(viewer.permissions.workers_report_draft.view, true);
});
