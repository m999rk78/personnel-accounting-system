// Isolated UI test: all API requests are intercepted with synthetic in-memory data.
// No environment files, real accounts, database connections or production writes.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { emptyPermissionSet, normalizePermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const outDir = await mkdtemp(join(tmpdir(), "permission-visibility-"));
const config = {
  configFile: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false,
  plugins: [react(), { name: "isolated-permission-fixture", configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.startsWith("/api/")) { response.statusCode = 404; response.end("Unmocked fixture API"); return; }
      if (!request.url?.startsWith("/assets/") && !request.url?.endsWith(".svg")) request.url = "/permission-visibility.html";
      next();
    });
  } }],
  build: { outDir, emptyOutDir: false, rollupOptions: { input: fileURLToPath(new URL("../tests/fixtures/permission-visibility.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3107, strictPort: true },
};
await build(config);
const server = await preview(config);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const user = permissions => ({ id: 10, fullName: "Прораб для проверки", email: "fixture@example.invalid", role: "foreman", assignedSiteId: 1, permissions, permissionsCustomized: true });
const employee = { id: 1, fullName: "Иван Примеров", employmentType: "ОПР", department: "Монтаж", position: "Монтажник", source: "manual", bitrix24Stage: "", availabilityStatus: "available", syncError: null, siteId: 1, siteName: "Учебный объект" };
const dataset = { sites: [{ id: 1, code: "TEST", name: "Учебный объект", timezone: "Europe/Moscow" }], employees: [employee], projectEmployees: [employee], placementEmployees: [employee], reportEmployees: [employee], positionCatalog: [], employmentTypes: [], departments: [], positions: [], users: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false };
const failures = [];
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
page.setDefaultTimeout(10_000);
page.on("pageerror", error => failures.push(error.message));
let activeUser = user(rolePermissionTemplate("foreman"));
let requests = [];
await page.route("**/api/**", async route => {
  const path = new URL(route.request().url()).pathname;
  requests.push(path);
  assert.equal(route.request().method(), "GET", "Read-only visibility tests must not mutate data");
  let body;
  if (path === "/api/auth/status") body = { authenticated: true, user: activeUser };
  else if (path === "/api/data") body = dataset;
  // Deliberately grants shared order writes: the UI must still restrict by the current resource.
  else if (path === "/api/table-order") body = { ids: [1], canWrite: true, hasSavedOrder: true };
  else if (path === "/api/personnel-report") body = { reports: [], entries: [], canReview: false, from: null, to: null };
  else throw new Error(`Unexpected fixture API: ${path}`);
  await route.fulfill({ json: body });
});
const count = async (selector, expected) => { await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector, expected }); };
try {
  await page.goto("http://127.0.0.1:3107/settings/project/employees");
  await page.getByRole("heading", { name: "Сотрудники проекта", exact: true }).waitFor();
  await page.locator('.ag-cell[col-id="fullName"]').filter({ hasText: employee.fullName }).waitFor();
  await count('.ag-header-cell[col-id="ag-Grid-SelectionColumn"]', 0);
  await count('.ag-header-cell[col-id="rowOrder"]', 0);
  assert.equal(await page.getByRole("button", { name: "Добавить сотрудника в проект", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Общие настройки", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Табель персонала", exact: true }).count(), 0);
  const nameCell = page.locator('.ag-cell[col-id="fullName"]').filter({ hasText: employee.fullName });
  await nameCell.click();
  await nameCell.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Копировать ячейку/ }).waitFor();
  assert.equal(await page.getByRole("menuitem", { name: /Вставить|Редактировать|Переместить|Выбрать строку/ }).count(), 0);
  await page.keyboard.press("Escape");

  // Grant deletion: selection and removal appear, editing remains absent.
  activeUser = user(normalizePermissionSet({ ...activeUser.permissions, project_employees: { view: true, delete: true } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await count('.ag-header-cell[col-id="ag-Grid-SelectionColumn"]', 1);
  await page.locator('.ag-row .ag-selection-checkbox input').first().check();
  await page.getByRole("button", { name: "Убрать из проекта", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Редактировать", exact: true }).count(), 0);
  await count('.ag-header-cell[col-id="rowOrder"]', 0);
  assert.ok(requests.includes("/api/auth/status"));

  // Revoke the whole project section: no old page or cached rows may remain visible.
  activeUser = user(normalizePermissionSet({ workers_report: { view: true } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("heading", { name: "Отчёт персонала", exact: true }).waitFor();
  await count(".settings-group", 0);
  assert.equal(await page.getByRole("heading", { name: "Сотрудники проекта", exact: true }).count(), 0);
  assert.match(page.url(), /\/reports\/workers/);

  // Direct links to forbidden resources return to the available report.
  requests = [];
  await page.goto("http://127.0.0.1:3107/settings/general/access?scenario=report-only");
  await page.getByRole("heading", { name: "Отчёт персонала", exact: true }).waitFor();
  assert.match(page.url(), /\/reports\/workers/);
  assert.equal(requests.includes("/api/access-rights"), false);
  await count(".settings-group", 0);

  // Update-only rights expose editing but neither deletion nor adding.
  activeUser = user(normalizePermissionSet({ employees: { view: true, update: true } }));
  await page.goto("http://127.0.0.1:3107/settings/general/employees?scenario=partial");
  await page.getByRole("heading", { name: "Сотрудники", exact: true }).waitFor();
  await page.locator('.ag-row .ag-selection-checkbox input').first().check();
  await page.getByRole("button", { name: "Редактировать", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Удалить сотрудников", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Добавить сотрудника", exact: true }).count(), 0);

  // Adding permissions must not silently discard unfinished edits in the current table.
  await page.getByRole("button", { name: "Редактировать", exact: true }).click();
  await page.locator('.ag-cell[col-id="fullName"]').filter({ hasText: employee.fullName }).dblclick();
  const editor = page.getByRole("textbox", { name: "ФИО сотрудника", exact: true });
  await editor.fill("Несохранённый черновик");
  await editor.press("Enter");
  activeUser = user(normalizePermissionSet({ employees: { view: true, update: true, create: true }, project_employees: { view: true } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "Настройки проекта", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.ag-cell[col-id="fullName"]')?.textContent?.includes("Несохранённый черновик"));
  await page.getByRole("button", { name: "Сохранить изменения", exact: true }).waitFor();
  assert.match(await page.locator('.ag-cell[col-id="fullName"]').innerText(), /Несохранённый черновик/);

  activeUser = user(normalizePermissionSet({ employees: { view: true } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "Настройки проекта", exact: true }).waitFor({ state: "detached" });
  await count('.ag-header-cell[col-id="ag-Grid-SelectionColumn"]', 0);
  await count('.ag-editable-cell-menu', 0);
  assert.equal(await page.getByRole("button", { name: "Сохранить изменения", exact: true }).count(), 0);
  assert.match(await page.locator('.ag-cell[col-id="fullName"]').innerText(), /Несохранённый черновик/);

  // No permissions means a neutral screen, not the name of a forbidden report.
  activeUser = user(emptyPermissionSet());
  await page.goto("http://127.0.0.1:3107/settings/general/employees?scenario=none");
  await page.getByRole("heading", { name: "Нет доступных разделов", exact: true }).waitFor();
  assert.equal(await page.locator(".nav-group").count(), 0);
  assert.equal(await page.locator(".ag-root-wrapper").count(), 0);
  assert.deepEqual(failures, []);
  console.log("PASS: foreman read-only columns and context menu, independent actions, live grant/revoke without losing drafts, hidden navigation, protected direct URLs, empty access state");
} catch (failure) {
  console.error((await page.locator("body").innerText()).slice(-6000));
  await page.screenshot({ path: "/tmp/permission-visibility-failure.png", fullPage: true });
  throw failure;
} finally { await browser.close(); await server.httpServer.close(); }
