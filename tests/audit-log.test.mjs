import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("records successful mutations in a server-side audit trail", async () => {
  const helper = await readFile(new URL("../app/auditLog.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle-postgres/0014_audit_events.sql", import.meta.url), "utf8");
  const dataApi = await readFile(new URL("../app/api/data/route.ts", import.meta.url), "utf8");
  const equipmentApi = await readFile(new URL("../app/api/equipment/route.ts", import.meta.url), "utf8");
  const timesheetApi = await readFile(new URL("../app/api/timesheet/route.ts", import.meta.url), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "audit_events"/);
  assert.match(migration, /"actor_user_id" integer/);
  assert.match(migration, /"before_data" jsonb/);
  assert.match(migration, /"after_data" jsonb/);
  assert.match(migration, /idx_audit_events_created/);
  assert.match(helper, /sensitiveKey/);
  assert.match(helper, /password\|token\|secret\|webhook/);
  assert.match(helper, /previousState/);
  assert.match(helper, /Audit write failed/);
  assert.match(dataApi, /withAuditTrail\(request, handlePOST\)/);
  assert.match(dataApi, /withAuditTrail\(request, handlePATCH\)/);
  assert.match(dataApi, /withAuditTrail\(request, handleDELETE\)/);
  assert.match(equipmentApi, /withAuditTrail\(request, handlePOST\)/);
  assert.match(timesheetApi, /withAuditTrail\(request, handlePOST\)/);
});

test("shows the audit log in protected general settings", async () => {
  const route = await readFile(new URL("../app/api/audit-log/route.ts", import.meta.url), "utf8");
  const view = await readFile(new URL("../app/AuditLogView.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");

  assert.match(route, /hasPermission\(authUser\.permissions, "audit_log", "view"\)/);
  assert.match(route, /ORDER BY id DESC/);
  assert.match(view, /Неизменяемая история действий/);
  assert.match(view, /<CustomSelect[^>]*ariaLabel="Раздел журнала"/);
  assert.match(view, /Показать подробности/);
  assert.match(app, /title: "Журнал действий"/);
  assert.match(app, /<AuditLogView/);
});
