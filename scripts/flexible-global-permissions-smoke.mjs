// Actual app and native timesheets, synthetic HTTP only. No database or env file.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const base = "http://127.0.0.1:3186";
const config = { configFile: false, envDir: false, publicDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()], logLevel: "error",
  build: { outDir: await mkdtemp(join(tmpdir(), "flexible-global-permissions-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/flexible-global-permissions.html", import.meta.url)) } }, preview: { host: "127.0.0.1", port: 3186, strictPort: true } };
await build(config);
const server = await preview(config);
let browser, actorRole = "viewer";
const errors = [], writes = [];
const sites = [{ id: 1, name: "Изолированный проект", code: "QA", timezone: "Europe/Moscow" }];
const employees = [{ id: 1, fullName: "Проверочный сотрудник", employmentType: "ОПР", department: "Участок", position: "Монтажник", siteId: 1, siteName: sites[0].name, source: "manual" }];
const units = [{ id: 1, equipmentType: "Кран", brand: "Тест", model: "К1", registrationNumber: "QA-1", organization: "Учебная", note: "Тестовые данные", assignedSiteId: 1, assignedSiteName: sites[0].name }];
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() !== "GET") { writes.push(req.url()); return route.fulfill({ status: 400, json: { error: "Проверка не сохраняет данные" } }); }
    if (url.pathname === "/api/table-order") return route.fulfill({ json: { ids: [], canWrite: true, hasSavedOrder: false, importIds: [], hasImportOrder: false } });
    if (url.pathname === "/api/data") return route.fulfill({ json: { sites, employees, reportEmployees: employees, projectEmployees: employees, placementEmployees: employees, positionCatalog: [{ id: 1, employmentType: "ОПР", department: "Участок", position: "Монтажник" }], shifts: [{ id: 1, name: "День" }], zones: [], masters: [], mainWorkTypes: [], subworkTypes: [], entries: [], timesheetMarks: [], filledDates: [], users: [], foremanProgress: [], employeeUsage: [], reportSubmitted: false, syncStatus: null } });
    if (url.pathname === "/api/timesheet") return route.fulfill({ json: { siteId: 1, siteName: sites[0].name, month: "2026-11", canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees, entries: [], marks: [] } });
    if (url.pathname === "/api/equipment") return route.fulfill({ json: { siteId: 1, siteName: sites[0].name, workDate: "2026-11-09", month: "2026-11", currentUserRole: actorRole, currentUserName: "Проверка выданных прав", sites, units, availableUnits: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], entries: [], marks: [], dailyTimesheetMarks: [], filledDates: [], foremanProgress: [], reportSubmitted: false, canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true, canManageRegistry: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, canEditTimesheet: true } });
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  });
  const open = (role, path, grants = "full") => { actorRole = role; return page.goto(`${base}/flexible-global-permissions.html?role=${role}&page=${encodeURIComponent(path)}&grants=${grants}`); };
  for (const role of ["foreman", "viewer"]) {
    await open(role, "/settings/general/positions");
    await page.getByRole("heading", { name: "Список должностей" }).waitFor();
    await page.getByRole("button", { name: /Добавить должность/ }).waitFor();
    const position = page.locator('.ag-row [col-id="position"]').first();
    await position.dblclick(); await position.locator("input,textarea").first().waitFor();
    await open(role, "/settings/general/equipment");
    await page.getByRole("heading", { name: "Реестр техники" }).waitFor();
    await page.getByRole("button", { name: "Добавить технику", exact: true }).waitFor();
    const note = page.locator('.ag-row [col-id="note"]').first();
    await note.dblclick(); await note.locator("input,textarea").first().waitFor();
    for (const [path, selector] of [["/timesheets/workers?month=2026-11", ".personnel-timesheet-table"], ["/timesheets/equipment?month=2026-11", ".equipment-month-table"]]) {
      await open(role, path);
      const cell = page.locator(`${selector} tbody td.editable`).first();
      await cell.waitFor(); await cell.dblclick();
      await page.locator(".timesheet-cell-inline-editor input").first().waitFor();
    }
    console.log(`PASS ${role}: global directory, equipment registry and both native timesheets use explicit grants`);
  }
  await open("viewer", "/timesheets/workers?month=2026-11", "default");
  await page.locator(".personnel-timesheet-table tbody tr").first().waitFor();
  assert.equal(await page.locator(".personnel-timesheet-table tbody td.editable").count(), 0);
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  console.log("PASS default viewer stays read-only; no writes or runtime errors");
} finally { await browser?.close(); await server.httpServer.close(); }
