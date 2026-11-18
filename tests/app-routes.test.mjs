import { readWorkspaceImplementation } from "./fixtures/read-implementation.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isEmployeeNavigationTarget, isEquipmentNavigationTarget, isGeneralSettingsView, isTimesheetView, parseWorkspaceLocation, validDate, validMonth, workspaceDocumentTitle, workspacePath, workspaceTitle, workspaceUrl } from "../app/appRoutes.ts";

test("maps every workspace section to a stable address", () => {
  assert.equal(workspaceUrl("placement", "all", "2026-10-01", "2026-10"), "/reports/workers?date=2026-10-01");
  assert.equal(workspaceUrl("equipment", "all", "2026-09-30", "2026-09"), "/reports/equipment?date=2026-09-30");
  assert.equal(workspaceUrl("timesheet", "all", "2026-10-01", "2026-10"), "/timesheets/workers?month=2026-10");
  assert.equal(workspaceUrl("equipmentTimesheet", "all", "2026-10-01", "2026-10"), "/timesheets/equipment?month=2026-10");
  assert.equal(workspacePath("personnelStatistics"), "/statistics/workers");
  assert.equal(workspacePath("equipmentStatistics"), "/statistics/equipment");
  assert.equal(workspacePath("employees"), "/settings/general/employees");
  assert.equal(workspacePath("auditLog"), "/settings/general/activity");
  assert.equal(workspacePath("accessRights"), "/settings/general/access");
  assert.equal(workspacePath("projectEquipment"), "/settings/project/equipment");
  assert.equal(workspacePath("directories", "zone"), "/settings/project/zones");
  assert.equal(workspacePath("directories", "mainWorkType"), "/settings/project/work-types");
  assert.equal(workspacePath("directories", "subworkType"), "/settings/project/subwork-types");
  assert.equal(workspacePath("directories", "master"), "/settings/project/masters");
});

test("restores a section and its period from the browser address", () => {
  assert.deepEqual(parseWorkspaceLocation("/reports/equipment/", "?date=2026-09-30", "2026-10-01"), {
    view: "equipment",
    directoryFocus: "all",
    date: "2026-09-30",
    month: "2026-09",
    recognized: true,
  });
  assert.deepEqual(parseWorkspaceLocation("/settings/project/zones", "", "2026-10-01"), {
    view: "directories",
    directoryFocus: "zone",
    date: "2026-10-01",
    month: "2026-10",
    recognized: true,
  });
  assert.equal(parseWorkspaceLocation("/unknown", "?date=not-a-date", "2026-10-01").recognized, false);
  assert.equal(parseWorkspaceLocation("/statistics/workers/", "", "2026-10-01").view, "personnelStatistics");
  assert.equal(parseWorkspaceLocation("/statistics/equipment", "", "2026-10-01").view, "equipmentStatistics");
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2026-02-28"), true);
  assert.equal(validMonth("2026-13"), false);
  assert.equal(validMonth("2026-12"), true);
});

test("employee links preserve identity and report month only in supported destinations", () => {
  for (const [view, expected] of [
    ["timesheet", "/timesheets/workers?month=2025-12&employeeId=42"],
    ["employees", "/settings/general/employees?employeeId=42"],
    ["projectEmployees", "/settings/project/employees?employeeId=42"],
  ]) {
    assert.equal(isEmployeeNavigationTarget(view, 42), true);
    const url = workspaceUrl(view, "all", "2025-12-31", "2025-12", 42);
    assert.equal(url, expected);
    const parsed = new URL(url, "http://localhost");
    const location = parseWorkspaceLocation(parsed.pathname, parsed.search, "2026-11-17");
    assert.equal(location.view, view);
    assert.equal(location.employeeId, 42);
    if (view === "timesheet") assert.equal(location.month, "2025-12");
  }
  for (const view of ["placement", "equipment", "equipmentTimesheet", "users", "settings", "directories"]) {
    assert.equal(isEmployeeNavigationTarget(view, 42), false);
    const url = workspaceUrl(view, "all", "2026-11-17", "2026-11", 42);
    assert.ok(!url.includes("employeeId"));
    const parsed = new URL(url, "http://localhost");
    parsed.searchParams.set("employeeId", "42");
    assert.equal(parseWorkspaceLocation(parsed.pathname, parsed.search, "2026-11-17").employeeId, undefined);
  }
});

test("invalid or unsafe employee identities never become navigable links", () => {
  for (const employeeId of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "42"]) {
    assert.equal(isEmployeeNavigationTarget("timesheet", employeeId), false);
    assert.equal(workspaceUrl("timesheet", "all", "2026-11-17", "2026-11", employeeId), "/timesheets/workers?month=2026-11");
  }
  for (const employeeId of ["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "person-42"]) {
    assert.equal(parseWorkspaceLocation("/timesheets/workers", `?month=2025-12&employeeId=${encodeURIComponent(employeeId)}`, "2026-11-17").employeeId, undefined);
  }
});

test("equipment links preserve identity in all linked tables and the report month in the timesheet", () => {
  for (const [view, expected] of [
    ["equipmentTimesheet", "/timesheets/equipment?month=2025-12&equipmentId=73"],
    ["equipmentRegistry", "/settings/general/equipment?equipmentId=73"],
    ["projectEquipment", "/settings/project/equipment?equipmentId=73"],
  ]) {
    assert.equal(isEquipmentNavigationTarget(view, 73), true);
    const url = workspaceUrl(view, "all", "2025-12-31", "2025-12", null, 73);
    assert.equal(url, expected);
    const parsed = new URL(url, "http://localhost");
    assert.deepEqual(parseWorkspaceLocation(parsed.pathname, parsed.search, "2026-11-17"), {
      view, directoryFocus: "all", date: "2026-11-17", month: view === "equipmentTimesheet" ? "2025-12" : "2026-11", equipmentId: 73, recognized: true,
    });
  }
  for (const view of ["placement", "equipment", "timesheet", "employees", "projectEmployees", "settings"]) {
    assert.equal(isEquipmentNavigationTarget(view, 73), false);
    const otherUrl = new URL(workspaceUrl(view, "all", "2026-11-17", "2026-11", null, 73), "http://localhost");
    assert.equal(otherUrl.searchParams.has("equipmentId"), false);
    otherUrl.searchParams.set("equipmentId", "73");
    assert.equal(parseWorkspaceLocation(otherUrl.pathname, otherUrl.search, "2026-11-17").equipmentId, undefined);
  }
  const bothIds = "?month=2025-12&employeeId=42&equipmentId=73";
  assert.equal(parseWorkspaceLocation("/timesheets/equipment", bothIds, "2026-11-17").employeeId, undefined);
  assert.equal(parseWorkspaceLocation("/timesheets/workers", bothIds, "2026-11-17").equipmentId, undefined);
});

test("invalid or unsafe equipment identities never become navigable links", () => {
  for (const view of ["equipmentTimesheet", "equipmentRegistry", "projectEquipment"]) {
    for (const equipmentId of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "73"]) {
      assert.equal(isEquipmentNavigationTarget(view, equipmentId), false);
      assert.equal(workspaceUrl(view, "all", "2026-11-17", "2026-11", null, equipmentId), workspaceUrl(view, "all", "2026-11-17", "2026-11"));
    }
    for (const equipmentId of ["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "unit-73"]) {
      assert.equal(parseWorkspaceLocation(workspacePath(view), `?month=2025-12&equipmentId=${encodeURIComponent(equipmentId)}`, "2026-11-17").equipmentId, undefined);
    }
  }
});

test("marks protected route families and serves direct workspace links", async () => {
  assert.equal(isGeneralSettingsView("employees"), true);
  assert.equal(isGeneralSettingsView("auditLog"), true);
  assert.equal(isGeneralSettingsView("accessRights"), true);
  assert.equal(isGeneralSettingsView("projectEmployees"), false);
  assert.equal(isTimesheetView("timesheet"), true);
  assert.equal(isTimesheetView("placement"), false);
  assert.equal(workspaceTitle("placement"), "Отчёт персонала");
  assert.equal(workspaceTitle("directories", "zone"), "Зоны");
  assert.equal(workspaceDocumentTitle("equipmentTimesheet"), "Ресурсный отчёт | Табель техники");
  assert.equal(workspaceDocumentTitle("employees"), "Ресурсный отчёт | Сотрудники");
  assert.equal(workspaceDocumentTitle("users"), "Ресурсный отчёт | Пользователи и права");
  assert.equal(workspaceDocumentTitle("accessRights"), "Ресурсный отчёт | Пользователи и права");

  const app = await readWorkspaceImplementation();
  const catchAll = await readFile(new URL("../app/[...route]/page.tsx", import.meta.url), "utf8");
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /window\.history\.replaceState/);
  assert.match(app, /window\.addEventListener\("popstate"/);
  assert.match(catchAll, /<AuthGate initialToday=/);
});
