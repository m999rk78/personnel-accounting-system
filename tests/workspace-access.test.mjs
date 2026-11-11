import assert from "node:assert/strict";
import test from "node:test";
import { emptyPermissionSet, normalizePermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";
import { GENERAL_SETTINGS_RESOURCES, PROJECT_SETTINGS_RESOURCES, workspaceViewAllowed, workspaceTableAccess } from "../app/workspaceAccess.ts";

test("every protected view uses its own resource, including grouped settings", () => {
  const views = { placement: "workers_report", equipment: "equipment_report", timesheet: "workers_timesheet", equipmentTimesheet: "equipment_timesheet", personnelStatistics: "workers_statistics", equipmentStatistics: "equipment_statistics", employees: "employees", equipmentRegistry: "equipment_registry", positions: "positions", users: "system_users", projects: "projects", auditLog: "audit_log", accessRights: "access_rights", projectEmployees: "project_employees", projectEquipment: "project_equipment", directories: "project_directories" };
  for (const [allowedView, resource] of Object.entries(views)) {
    const permissions = normalizePermissionSet({ ...emptyPermissionSet(), [resource]: { view: true },
      ...(resource.endsWith("_report") ? { [`${resource}_approved`]: { view: true } } : {}),
    });
    for (const view of Object.keys(views)) assert.equal(workspaceViewAllowed(permissions, view), view === allowedView, `${resource} -> ${view}`);
    assert.equal(workspaceViewAllowed(permissions, "settings"), GENERAL_SETTINGS_RESOURCES.includes(resource));
    assert.equal(workspaceViewAllowed(permissions, "projectSettings"), PROJECT_SETTINGS_RESOURCES.includes(resource));
    assert.equal(workspaceTableAccess(permissions, allowedView).select, false);
    assert.equal(workspaceTableAccess(permissions, allowedView).edit, false);
    assert.equal(workspaceTableAccess(permissions, allowedView).reorder, false);
  }
  assert.equal(workspaceViewAllowed(emptyPermissionSet(), "settings"), false);
  assert.equal(workspaceViewAllowed(emptyPermissionSet(), "projectSettings"), false);
});

test("report permissions do not expose project employee management controls", () => {
  const foreman = rolePermissionTemplate("foreman");
  assert.equal(workspaceViewAllowed(foreman, "projectEmployees"), true);
  assert.equal(workspaceTableAccess(foreman, "placement").edit, true);
  assert.deepEqual(workspaceTableAccess(foreman, "projectEmployees"), { create: false, update: false, delete: false, edit: false, select: false, reorder: false });
});

test("each statistics tab has an independent permission and stays read-only", () => {
  const permissions = rolePermissionTemplate("superadmin");
  permissions.workers_statistics.view = false;
  assert.equal(workspaceViewAllowed(permissions, "personnelStatistics"), false);
  assert.equal(workspaceViewAllowed(permissions, "placement"), true);
  assert.equal(workspaceViewAllowed(permissions, "equipmentStatistics"), true);
  permissions.workers_statistics.view = true;
  permissions.workers_report.view = false;
  permissions.workers_report_approved.view = false;
  assert.equal(workspaceViewAllowed(permissions, "placement"), false);
  assert.equal(workspaceViewAllowed(permissions, "personnelStatistics"), true);
  assert.equal(workspaceViewAllowed(permissions, "equipmentStatistics"), true);
  for (const view of ["personnelStatistics", "equipmentStatistics"]) {
    assert.deepEqual(workspaceTableAccess(permissions, view), { create: false, update: false, delete: false, edit: false, select: false, reorder: false });
  }
  permissions.equipment_statistics.view = false;
  assert.equal(workspaceViewAllowed(permissions, "equipmentStatistics"), false);
  assert.equal(workspaceViewAllowed(permissions, "equipment"), true);
});

test("table actions stay independent and react to granted/revoked permissions", () => {
  for (const action of ["create", "update", "delete"]) {
    const permissions = normalizePermissionSet({ employees: { view: true, [action]: true } });
    const access = workspaceTableAccess(permissions, "employees");
    assert.equal(access.select, true);
    assert.equal(access.edit, action !== "delete");
    assert.equal(access.reorder, action === "update");
    assert.equal(access.delete, action === "delete");
    assert.equal(access.create, action === "create");
    assert.equal(access.update, action === "update");
    const revoked = emptyPermissionSet();
    assert.equal(workspaceTableAccess(revoked, "employees").select, false);
    assert.equal(workspaceViewAllowed(revoked, "employees"), false);
  }
});
