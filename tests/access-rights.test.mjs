import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PERMISSION_CATALOG,
  hasPermission,
  normalizePermissionSet,
  rolePermissionTemplate,
} from "../app/permissionModel.ts";

test("role templates provide safe defaults and allow granular overrides", () => {
  const foreman = rolePermissionTemplate("foreman");
  const engineer = rolePermissionTemplate("engineer");
  const admin = rolePermissionTemplate("superadmin");

  assert.equal(hasPermission(foreman, "workers_report", "update"), true);
  assert.equal(hasPermission(foreman, "workers_timesheet", "view"), false);
  assert.equal(hasPermission(engineer, "system_users", "view"), true);
  assert.equal(hasPermission(engineer, "system_users", "update"), false);
  assert.equal(hasPermission(engineer, "access_rights", "view"), true);
  assert.equal(hasPermission(engineer, "access_rights", "update"), false);
  assert.equal(hasPermission(admin, "access_rights", "update"), true);
  assert.equal(PERMISSION_CATALOG.length, 14);

  const custom = normalizePermissionSet({ workers_report: { view: true, create: false, update: false, delete: false } });
  assert.equal(custom.workers_report.view, true);
  assert.equal(custom.workers_report.update, false);
  assert.equal(custom.equipment_report.view, false);
});

test("keeps workers report actions independent when deletion is disabled", () => {
  const permissions = normalizePermissionSet({
    workers_report: { view: true, create: true, update: true, delete: false },
  });

  assert.equal(hasPermission(permissions, "workers_report", "view"), true);
  assert.equal(hasPermission(permissions, "workers_report", "create"), true);
  assert.equal(hasPermission(permissions, "workers_report", "update"), true);
  assert.equal(hasPermission(permissions, "workers_report", "delete"), false);
});

test("stores permissions, exposes a separate settings page, and enforces them in APIs", async () => {
  const migration = await readFile(new URL("../drizzle-postgres/0015_user_permissions.sql", import.meta.url), "utf8");
  const accessApi = await readFile(new URL("../app/api/access-rights/route.ts", import.meta.url), "utf8");
  const dataApi = await readFile(new URL("../app/api/data/route.ts", import.meta.url), "utf8");
  const equipmentApi = await readFile(new URL("../app/api/equipment/route.ts", import.meta.url), "utf8");
  const timesheetApi = await readFile(new URL("../app/api/timesheet/route.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const view = await readFile(new URL("../app/AccessRightsView.tsx", import.meta.url), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "user_permissions"/);
  assert.match(migration, /PRIMARY KEY \("user_id", "resource"\)/);
  assert.match(accessApi, /access_rights", "update"/);
  assert.match(accessApi, /Нельзя отключить себе/);
  assert.match(dataApi, /workers_report", "delete"/);
  assert.match(equipmentApi, /equipment_report", entryId \? "update" : "create"/);
  assert.match(timesheetApi, /existingMark \? "update" : "create"/);
  assert.match(app, /title: "Пользователи системы"/);
  assert.match(app, /title: "Права доступа"/);
  assert.match(view, /Быстрые настройки/);
  assert.match(view, /Права проверяются сервером для каждого действия/);
});

test("keeps create, update, and delete independent across every editable table", async () => {
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const equipment = await readFile(new URL("../app/EquipmentAccountingView.tsx", import.meta.url), "utf8");
  const grids = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const dataApi = await readFile(new URL("../app/api/data/route.ts", import.meta.url), "utf8");
  const timesheetApi = await readFile(new URL("../app/api/timesheet/route.ts", import.meta.url), "utf8");
  const equipmentApi = await readFile(new URL("../app/api/equipment/route.ts", import.meta.url), "utf8");

  assert.match(app, /disabled=\{saving \|\| !canUpdate\} title=\{canUpdate \? undefined : "Нет права редактирования"\}/);
  assert.match(app, /disabled=\{saving \|\| !canDelete\} title=\{canDelete \? undefined : "Нет права удаления"\}/);
  assert.match(app, /<PlacementAgGrid[\s\S]*canCreate=\{canCreateReportDate\}[\s\S]*canUpdate=\{canUpdateReportDate\}[\s\S]*canDelete=\{canDeleteReportDate\}/);
  assert.match(equipment, /<EquipmentDailyAgGrid[\s\S]*canCreate=\{Boolean\(payload\?\.canCreateDaily\)\}[\s\S]*canUpdate=\{Boolean\(payload\?\.canUpdateDaily\)\}[\s\S]*canDelete=\{Boolean\(payload\?\.canDeleteDaily\)\}/);
  assert.match(grids, /row\.kind === "draft" \? !current\.canCreate : !current\.canUpdate/);
  assert.match(dataApi, /const creates = rows\.some\(\(row\) => !asPositiveInteger\(row\.directoryId\)\)/);
  assert.match(dataApi, /const updates = rows\.some\(\(row\) => Boolean\(asPositiveInteger\(row\.directoryId\)\)\)/);
  assert.match(timesheetApi, /if \(!existingMark\) return Response\.json\(\{ deleted: false, employeeId, workDate: payload\.workDate \}\)/);
  assert.match(equipmentApi, /if \(!existingMark\) return Response\.json\(\{ deleted: false, equipmentId, workDate: payload\.workDate \}\)/);
});
