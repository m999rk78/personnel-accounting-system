// Full application with synthetic read-only APIs. No .env, credentials or DB access.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const config = { configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "all-empty-rows-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/workspace-header.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3154, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = [], requests = [];
  let count = 0;
  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const stamp = "2026-11-04T10:00:00.000Z";
  const range = make => Array.from({ length: count }, (_, index) => make(index + 1));
  const employees = () => range(id => ({ id, fullName: `Сотрудник ${String(id).padStart(3, "0")}`, employmentType: "ИТР", department: "МУТТ", position: `Должность ${id}`, source: "manual", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
  const units = () => range(id => ({ id, name: `Кран ${id}`, model: `Модель ${id}`, registrationNumber: `ТЕСТ${id}`, inventoryNumber: `TEST-${id}`, organization: "Учебная организация", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", unavailableFrom: null }));
  const options = () => ({ shifts: [{ id: 1, name: "день" }], zones: range(id => ({ id, name: `Зона ${id}` })), mainWorkTypes: range(id => ({ id, name: `Работа ${id}` })), subworkTypes: range(id => ({ id, name: `Подработа ${id}`, mainWorkTypeId: id })), masters: employees().map(employee => ({ id: employee.id, name: employee.fullName, employeeId: employee.id })) });
  const approvedEntries = equipment => range(id => ({ id, siteId: 1, workDate: "2026-11-04", shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1, hours: 8, note: "", shiftName: "день", zoneName: "Зона 1", mainWorkTypeName: "Работа 1", subworkTypeName: "Подработа 1", masterName: "Сотрудник 001", createdAt: stamp, updatedAt: stamp, rowOrder: id, revision: 1, responsibleUserId: 1, responsibleUserName: "Проверка таблиц",
    ...(equipment ? { equipmentId: id, equipmentName: `Кран ${id}`, equipmentType: "Кран", organization: "Учебная организация", brand: "Тест", model: `Модель ${id}`, registrationNumber: `ТЕСТ${id}` } : { employeeId: id, employeeName: `Сотрудник ${String(id).padStart(3, "0")}`, employmentType: "ИТР", department: "МУТТ", positionSnapshot: `Должность ${id}` }) }));
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { window.open = url => { window.testExportUrl = String(url); return {}; }; });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}`);
    assert.equal(request.method(), "GET", `Empty-row painting must never mutate data: ${request.url()}`);
    let body;
    if (url.pathname === "/api/table-order") body = { ids: [], canWrite: false, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report")) body = { reports: [], entries: approvedEntries(url.pathname === "/api/equipment-report"), canReview: true, availabilityMarks: [], from: null, to: null };
    else if (url.pathname === "/api/timesheet") body = { siteId: 1, siteName: sites[0].name, month: "2026-11", canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees: employees(), entries: [], marks: [] };
    else if (url.pathname === "/api/equipment") body = { siteId: 1, siteName: sites[0].name, workDate: "2026-11-04", month: "2026-11", canEditDaily: true, canCreateDaily: true, canUpdateDaily: true, canDeleteDaily: true, canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, canManageRegistry: true, canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true, canManageAssignments: true, canCreateAssignments: true, canUpdateAssignments: true, canDeleteAssignments: true, currentUserRole: "superadmin", currentUserName: "Проверка таблиц", reportSubmitted: false, foremanProgress: [], units: units(), availableUnits: units(), sites, entries: [], marks: [], dailyTimesheetMarks: [], filledDates: [], ...options() };
    else if (url.pathname === "/api/roles") body = { roles: [], canManage: true };
    else {
      assert.equal(url.pathname, "/api/data");
      body = { sites, employees: employees(), projectEmployees: employees(), placementEmployees: employees(), reportEmployees: employees(), positionCatalog: range(id => ({ id, employmentType: "ИТР", department: "МУТТ", position: `Должность ${id}` })), employmentTypes: [{ id: 1, name: "ИТР" }], departments: [{ id: 1, name: "МУТТ" }], positions: range(id => ({ id, name: `Должность ${id}` })), users: range(id => ({ id, fullName: `Пользователь ${id}`, email: `user${id}@example.invalid`, role: "engineer", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, status: "active" })), ...options(), entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false, projectStats: [], bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } } };
    }
    await route.fulfill({ json: body });
  });
  const routes = [
    ["/settings/general/employees", "Сотрудники", "ag", 54],
    ["/settings/general/positions", "Список должностей", "ag", 54],
    ["/settings/general/equipment", "Реестр техники", "ag", 54],
    ["/settings/project/employees", "Сотрудники проекта", "ag", 54],
    ["/settings/project/equipment", "Техника проекта", "ag", 54],
    ["/settings/project/zones", "Зоны", "ag", 54],
    ["/settings/project/masters", "Мастера", "ag", 54],
    ["/settings/project/work-types", "Виды и подвиды работ", "ag", 54],
    ["/settings/project/subwork-types", "Виды и подвиды работ", "ag", 54],
    ["/reports/workers?date=2026-11-04", "Отчёт персонала", "ag", 44],
    ["/reports/equipment?date=2026-11-04", "Отчёт техники", "ag", 44],
    ["/settings/general/users", "Пользователи и права", "users", 72],
    ["/timesheets/workers?month=2026-11", "Табель рабочих", "timesheet", 46],
    ["/timesheets/equipment?month=2026-11", "Табель техники", "timesheet", 46],
  ];
  async function assertUsersException(label) {
    const surface = await page.locator(".users-table-wrap").evaluate(element => {
      const after = getComputedStyle(element, "::after");
      const table = element.querySelector("table");
      const empty = element.querySelector(".user-access-empty");
      return { display: getComputedStyle(element).display, afterContent: after.content, afterBackground: after.backgroundImage,
        columns: element.getAttribute("data-empty-column-boundaries"), columnStyle: element.style.getPropertyValue("--native-empty-column-lines"),
        height: element.getBoundingClientRect().height, contentHeight: table.getBoundingClientRect().height + (empty?.getBoundingClientRect().height ?? 0) };
    });
    assert.equal(surface.display, "block", `${label}: users retain ordinary auto-height layout`);
    assert.ok(["none", "normal", ""].includes(surface.afterContent), `${label}: no decorative pseudo rows`);
    assert.equal(surface.afterBackground, "none", `${label}: no empty grid background`);
    assert.equal(surface.columns, null, `${label}: no decorative column metadata`);
    assert.equal(surface.columnStyle, "", `${label}: no decorative column style`);
    assert.ok(surface.height <= surface.contentHeight + 2, `${label}: users wrap does not stretch below content`);
  }
  let checked = 0;
  for (count of [0, 3, 100]) {
    for (const [path, title, kind, rowHeight] of routes) {
      if (process.argv[3] && !path.startsWith(process.argv[3])) continue;
      // Long datasets exercise one AG reference, users and both virtualized native tables.
      if (count === 100 && !["/settings/project/masters", "/settings/general/users"].includes(path) && kind !== "timesheet") continue;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`http://127.0.0.1:3154/workspace-header.html?route=${encodeURIComponent(path)}`);
      await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
      const scope = kind === "ag" ? page.locator(".page-content .ag-grid-empty-rows .ag-grid-scrolling-rows").first() : kind === "users" ? page.locator(".users-table-wrap") : page.locator(".timesheet-grid-shell");
      await scope.waitFor();
      if (kind === "timesheet") await page.waitForFunction(() => document.querySelector(".timesheet-grid-shell")?.getAttribute("aria-busy") !== "true" && !document.querySelector(".timesheet-loading"));
      await page.waitForFunction(() => ![...document.querySelectorAll(".page-content [role='status']")].some(element => element.textContent?.includes("Загружаем")));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const background = await scope.evaluate(element => [element, ...element.querySelectorAll("*")].flatMap(node => [getComputedStyle(node).backgroundImage, getComputedStyle(node, "::before").backgroundImage, getComputedStyle(node, "::after").backgroundImage]).find(value => value.includes("repeating-linear-gradient")) ?? "none");
      if (kind === "users") {
        assert.equal(background, "none", `${path}: users are excluded from decorative empty rows`);
        await assertUsersException(path);
      } else assert.match(background, /repeating-linear-gradient/, `${path}: decorative rows present for ${count} records`);
      if (kind === "ag") {
        const grid = page.locator(".page-content .ag-grid-empty-rows [aria-rowcount]").first();
        await page.waitForFunction(({ expected }) => Number(document.querySelector(".page-content .ag-grid-empty-rows [aria-rowcount]")?.getAttribute("aria-rowcount")) === expected + 1, { expected: count });
        assert.equal(Number(await grid.getAttribute("aria-rowcount")), count + 1, `${path}: no fake AG data rows`);
        if (count < 10) assert.equal(await page.locator(".page-content .ag-grid-empty-rows .ag-row").count(), count);
        assert.match(background, new RegExp(`${rowHeight}(?:px)?`), `${path}: blank row pitch matches its real rows`);
        if (count === 3 && path === "/settings/project/work-types") {
          await scope.locator(".ag-group-contracted").first().click();
          const detail = page.locator(".work-types-detail-grid");
          await detail.waitFor();
          assert.equal(Number(await detail.locator("[aria-rowcount]").getAttribute("aria-rowcount")), 2, "Expanded subwork table contains only its real child");
          assert.match(await detail.locator(".ag-grid-scrolling-rows").evaluate(element => getComputedStyle(element).backgroundImage), /repeating-linear-gradient/);
        }
      } else if (kind === "users") {
        assert.equal(await page.locator(".users-table tbody tr").count(), count, "No fake users or selectable blank rows");
        if (count < 10) {
          const search = page.getByRole("textbox", { name: "Найти пользователя", exact: true });
          await search.fill(count ? "Пользователь 2" : "Несуществующий пользователь");
          await page.waitForFunction(expected => document.querySelectorAll(".users-table tbody tr").length === expected, count ? 1 : 0);
          if (count) assert.match(await page.locator(".users-table tbody tr").innerText(), /Пользователь 2/);
          await search.fill("Несуществующий пользователь");
          await page.locator(".user-access-empty").waitFor();
          assert.equal(await page.locator(".users-table tbody tr").count(), 0);
          await search.fill("");
          await page.waitForFunction(expected => document.querySelectorAll(".users-table tbody tr").length === expected, count);
          await assertUsersException(`${path}: search restored`);
        }
        if (count === 3) {
          await page.getByRole("checkbox", { name: "Выбрать всех пользователей", exact: true }).check();
          assert.equal(await page.locator(".users-table tbody input:checked").count(), count);
          await page.getByRole("button", { name: "Снять выделение", exact: true }).click();
        }
      } else {
        const table = page.locator(".timesheet-table");
        if (await table.count()) assert.equal(Number(await table.getAttribute("aria-rowcount")), count + 3, `${path}: row totals exclude decorative rows`);
        if (count < 10) assert.equal(await page.locator(".timesheet-table [data-virtual-row]").count(), count);
        if (count === 100) {
          await scope.evaluate(element => { element.scrollTop = element.scrollHeight; });
          await page.locator('.timesheet-table [data-virtual-row="99"]').waitFor();
          assert.equal(Number(await table.getAttribute("aria-rowcount")), 103);
        }
      }
      // Representative exports use the actual handler, intercepted blob preview only.
      if (count === 3 && ["/settings/general/employees", "/settings/project/masters", "/settings/general/users"].includes(path)) {
        await page.locator(".workspace-page-heading").getByRole("button", { name: "Excel", exact: true }).click();
        await page.getByRole("menuitem", { name: "Экспорт в Excel", exact: true }).click();
        const exportedCount = await page.evaluate(async () => {
          const blob = new URLSearchParams(window.testExportUrl.split("?")[1]).get("payload");
          return (await (await fetch(blob)).json()).rows.length;
        });
        assert.equal(exportedCount, count, `${path}: export contains real records only`);
      }
      if (count < 10) {
        const name = path.replace(/^\//, "").replaceAll(/[/?=&]/g, "-");
        await page.screenshot({ path: `/tmp/all-empty-rows-${name}-${count}-1440.png` });
        if (count === 3) {
          await page.setViewportSize({ width: 390, height: 844 });
          if (await page.getByRole("button", { name: "Свернуть меню", exact: true }).count()) await page.getByRole("button", { name: "Свернуть меню", exact: true }).click();
          if (kind === "users") await assertUsersException(`${path}: mobile`);
          await page.screenshot({ path: `/tmp/all-empty-rows-${name}-${count}-390.png` });
        }
      }
      checked++;
      console.log(`PASS: ${count} real rows, ${path}`);
    }
  }
  assert.deepEqual(errors, [], "No runtime errors");
  assert.ok(requests.length > 0);
  console.log(`PASS: ${checked} empty/few/long table cases; users retain their original auto-height list and other decorative rows never become data or export rows`);
} finally { await browser?.close(); await server.httpServer.close(); }
