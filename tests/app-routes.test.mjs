import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isGeneralSettingsView, isTimesheetView, parseWorkspaceLocation, validDate, validMonth, workspacePath, workspaceUrl } from "../app/appRoutes.ts";

test("maps every workspace section to a stable address", () => {
  assert.equal(workspaceUrl("placement", "all", "2026-10-01", "2026-10"), "/reports/workers?date=2026-10-01");
  assert.equal(workspaceUrl("equipment", "all", "2026-09-30", "2026-09"), "/reports/equipment?date=2026-09-30");
  assert.equal(workspaceUrl("timesheet", "all", "2026-10-01", "2026-10"), "/timesheets/workers?month=2026-10");
  assert.equal(workspaceUrl("equipmentTimesheet", "all", "2026-10-01", "2026-10"), "/timesheets/equipment?month=2026-10");
  assert.equal(workspacePath("employees"), "/settings/general/employees");
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
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2026-02-28"), true);
  assert.equal(validMonth("2026-13"), false);
  assert.equal(validMonth("2026-12"), true);
});

test("marks protected route families and serves direct workspace links", async () => {
  assert.equal(isGeneralSettingsView("employees"), true);
  assert.equal(isGeneralSettingsView("projectEmployees"), false);
  assert.equal(isTimesheetView("timesheet"), true);
  assert.equal(isTimesheetView("placement"), false);

  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const catchAll = await readFile(new URL("../app/[...route]/page.tsx", import.meta.url), "utf8");
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /window\.history\.replaceState/);
  assert.match(app, /window\.addEventListener\("popstate"/);
  assert.match(catchAll, /<AuthGate initialToday=/);
});
