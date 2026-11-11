import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PERMISSION_CATALOG, emptyPermissionSet, normalizePermissionSet, patchPermissionSet, roleAllowsPermission, rolePermissionTemplate } from "../app/permissionModel.ts";
import { normalizeCustomRolePermissions } from "../app/customRoles.ts";
import { projectAccessHarness, accessRequest } from "./fixtures/project-access-boundary.mjs";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const resources = ["workers_statistics", "equipment_statistics"];
const readonly = view => ({ view, create: false, update: false, delete: false });
const withoutStatistics = permissions => Object.fromEntries(Object.entries(permissions).filter(([key]) => !resources.includes(key)));

test("every catalog resource renders in the actual permission matrix, including statistics search", async () => {
  const hook = `data:text/javascript,${encodeURIComponent('export function useNativeTableSelectAll(){return {ref:null,className:"",handlers:{}};}')}`;
  const { PermissionMatrix } = await import(await compileModuleGraph(new URL("../app/PermissionMatrix.tsx", import.meta.url), { "./useNativeTableSelectAll": hook }));
  const render = search => renderToStaticMarkup(createElement(PermissionMatrix, { label: "Права", value: emptyPermissionSet(), search, onChange() {} }));
  const all = render("");
  for (const { key } of PERMISSION_CATALOG) assert.ok(all.includes(`data-permission-resource="${key}"`), `Missing permissions for ${key}`);
  const statistics = render("Статистика");
  assert.equal((statistics.match(/data-permission-resource=/g) ?? []).length, 2);
  assert.match(statistics, /Статистика персонала/);
  assert.match(statistics, /Статистика техники/);
  assert.equal((statistics.match(/type="checkbox"/g) ?? []).length, 8);
  assert.equal((statistics.match(/disabled=""/g) ?? []).length, 6);
});

test("every role can independently grant or revoke either statistics tab without report rights", () => {
  for (const role of ["foreman", "engineer", "viewer", "superadmin"]) {
    for (const resource of resources) {
      assert.equal(roleAllowsPermission(role, resource, "view"), true);
      assert.equal(roleAllowsPermission(role, resource, "update"), false);
      const grant = patchPermissionSet(emptyPermissionSet(), resource, "view", true);
      assert.deepEqual(grant[resource], readonly(true));
      assert.equal(grant.workers_report.view, false);
      assert.equal(grant.equipment_report.view, false);
      assert.equal(grant[resources.find(key => key !== resource)].view, false);
      assert.deepEqual(patchPermissionSet(grant, resource, "view", false), emptyPermissionSet());
    }
  }
});

test("legacy role JSON inherits prior approved visibility while explicit statistics choices are independent", () => {
  const old = withoutStatistics(rolePermissionTemplate("engineer"));
  old.workers_report_approved = readonly(false);
  const legacy = normalizeCustomRolePermissions(old, "engineer");
  assert.deepEqual(legacy.workers_statistics, readonly(false));
  assert.deepEqual(legacy.equipment_statistics, readonly(true));
  const chosen = normalizePermissionSet({ ...old, workers_statistics: { view: true }, equipment_statistics: { view: false, update: true } });
  assert.deepEqual(chosen.workers_statistics, readonly(true));
  assert.deepEqual(chosen.equipment_statistics, readonly(false));
});

test("legacy effective user overrides do not gain statistics through the role fallback", async () => {
  const h = await projectAccessHarness();
  const old = withoutStatistics(rolePermissionTemplate("engineer"));
  h.db.state.customRoles.set(41, { id: 41, name: "Прежний инженер", baseRole: "engineer", permissions: old, revision: 1, active: 1 });
  const role = await h.customRoles.loadCustomRole(41, h.db);
  assert.deepEqual(role.inheritedStatisticsPermissions, resources);
  h.db.state.permissions.set(2, new Map([["workers_report_approved", { resource: "workers_report_approved", canView: 0, canCreate: 0, canUpdate: 0, canDelete: 0 }]]));
  for (const customRole of [undefined, role]) {
    const result = await h.permissions.loadEffectivePermissions(2, "engineer", undefined, h.db, customRole);
    assert.equal(result.permissions.workers_statistics.view, false);
    assert.equal(result.permissions.equipment_statistics.view, true);
  }
  const explicitRole = { ...role, permissions: { ...role.permissions, workers_statistics: readonly(true) }, inheritedStatisticsPermissions: [] };
  const explicit = await h.permissions.loadEffectivePermissions(2, "engineer", undefined, h.db, explicitRole);
  assert.equal(explicit.permissions.workers_statistics.view, true);
  h.db.state.permissions.get(2).set("workers_statistics", { resource: "workers_statistics", canView: 0, canCreate: 0, canUpdate: 0, canDelete: 0 });
  const denied = await h.permissions.loadEffectivePermissions(2, "engineer", undefined, h.db, explicitRole);
  assert.equal(denied.permissions.workers_statistics.view, false);
});

test("individual statistics grants save through access API, reload, revoke and reset to role settings", async () => {
  const h = await projectAccessHarness();
  await h.asUser(4);
  const permissions = patchPermissionSet(emptyPermissionSet(), "workers_statistics", "view", true);
  const save = await h.route.POST(accessRequest({ userId: 1, permissions }));
  assert.equal(save.status, 200);
  const reload = await h.permissions.loadEffectivePermissions(1, "foreman", undefined, h.db);
  assert.deepEqual(reload.permissions, permissions);
  assert.equal(h.db.state.permissions.get(1).get("workers_statistics").canView, 1);
  const revoked = patchPermissionSet(permissions, "workers_statistics", "view", false);
  assert.equal((await h.route.POST(accessRequest({ userId: 1, permissions: revoked }))).status, 200);
  assert.deepEqual((await h.permissions.loadEffectivePermissions(1, "foreman", undefined, h.db)).permissions, emptyPermissionSet());
  assert.equal((await h.route.POST(accessRequest({ userId: 1, reset: true }))).status, 200);
  assert.deepEqual((await h.permissions.loadEffectivePermissions(1, "foreman", undefined, h.db)).permissions, rolePermissionTemplate("foreman"));
});
