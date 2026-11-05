// Actual application + synthetic API responses. No .env, production API or DB access.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const config = { configFile: false, envDir: false, publicDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "workspace-header-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/workspace-header.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3152, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = [], requests = [];
  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const employees = ["Иванов Сергей Петрович", "Петров Андрей Николаевич"].map((fullName, index) => ({ id: index + 1, fullName, employmentType: "ОПР", department: "МУТТ", position: "Монтажник", source: "manual", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
  const units = [{ id: 1, name: "Кран 50 т", model: "КС-65715", registrationNumber: "ТЕСТ01", inventoryNumber: "TEST-01", organization: "Учебная организация", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", unavailableFrom: null }];
  const options = { shifts: [{ id: 1, name: "день" }], zones: [{ id: 1, name: "Монтажная зона" }], mainWorkTypes: [{ id: 1, name: "Монтаж" }], subworkTypes: [{ id: 1, name: "Сборка", mainWorkTypeId: 1 }], masters: [{ id: 1, name: "Иванов Сергей Петрович", employeeId: 1 }] };
  const data = { sites, employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees, positionCatalog: [{ id: 1, employmentType: "ОПР", department: "МУТТ", position: "Монтажник" }], employmentTypes: [{ id: 1, name: "ОПР" }], departments: [{ id: 1, name: "МУТТ" }], positions: [{ id: 1, name: "Монтажник" }], users: [{ id: 1, fullName: "Проверка шапок", email: "header@example.invalid", role: "superadmin", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, status: "active" }], ...options,
    entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false, projectStats: [{ siteId: 1, employeeCount: 2, foremanCount: 1 }], bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } } };
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(`${request.method()} ${url.pathname}`);
    assert.equal(request.method(), "GET", `Header smoke must never write: ${request.url()}`);
    let body;
    if (url.pathname === "/api/data") body = data;
    else if (url.pathname === "/api/table-order") body = { ids: [], canWrite: false, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report")) body = { reports: [], entries: [], canReview: true, availabilityMarks: [] };
    else if (url.pathname === "/api/timesheet") body = { siteId: 1, siteName: sites[0].name, month: url.searchParams.get("month"), canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees, entries: [], marks: [] };
    else if (url.pathname === "/api/equipment") body = { siteId: 1, siteName: sites[0].name, workDate: url.searchParams.get("date"), month: url.searchParams.get("month"), canEditDaily: true, canCreateDaily: true, canUpdateDaily: true, canDeleteDaily: true, canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, canManageRegistry: true, canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true, canManageAssignments: true, canCreateAssignments: true, canUpdateAssignments: true, canDeleteAssignments: true, currentUserRole: "superadmin", currentUserName: "Проверка шапок", reportSubmitted: false, foremanProgress: [], units, availableUnits: units, sites, entries: [], marks: [], dailyTimesheetMarks: [], filledDates: [], ...options };
    else if (url.pathname === "/api/roles") body = { roles: [], canManage: true };
    else if (url.pathname === "/api/audit-log") body = { events: [] };
    else if (url.pathname === "/api/access-rights") body = { users: [], canManage: true };
    else throw new Error(`Unexpected API: ${url.pathname}`);
    await route.fulfill({ json: body });
  });
  const routes = [
    ["/settings/general", "Общие настройки"], ["/settings/general/employees", "Сотрудники", "Общие настройки"],
    ["/settings/general/equipment", "Реестр техники", "Общие настройки"], ["/settings/general/positions", "Список должностей", "Общие настройки"],
    ["/settings/general/projects", "Проекты", "Общие настройки"], ["/settings/general/users", "Пользователи и права", "Общие настройки"],
    ["/settings/general/access", "Пользователи и права", "Общие настройки"], ["/settings/general/activity", "Журнал действий", "Общие настройки"],
    ["/settings/project", "Настройки проекта"], ["/settings/project/employees", "Сотрудники проекта", "Настройки проекта"],
    ["/settings/project/equipment", "Техника проекта", "Настройки проекта"], ["/settings/project/zones", "Зоны", "Настройки проекта"],
    ["/settings/project/work-types", "Виды и подвиды работ", "Настройки проекта"], ["/settings/project/subwork-types", "Виды и подвиды работ", "Настройки проекта"],
    ["/settings/project/masters", "Мастера", "Настройки проекта"],
    ["/reports/workers?date=2026-11-04", "Отчёт персонала"], ["/reports/equipment?date=2026-11-04", "Отчёт техники"],
    ["/timesheets/workers?month=2026-11", "Табель рабочих"], ["/timesheets/equipment?month=2026-11", "Табель техники"],
  ];
  let checked = 0;
  for (const viewport of [{ width: 1440, height: 900 }, { width: 913, height: 861 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    if (process.argv[4] && viewport.width !== Number(process.argv[4])) continue;
    await page.setViewportSize(viewport);
    for (const [route, title, backLabel] of routes) {
      if (process.argv[3] && !process.argv[3].split(",").includes(route)) continue;
      await page.goto(`http://127.0.0.1:3152/workspace-header.html?route=${encodeURIComponent(route)}`);
      const heading = page.locator(".workspace-page-heading");
      await heading.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
      if (viewport.width <= 680 && await page.getByRole("button", { name: "Свернуть меню", exact: true }).count()) await page.getByRole("button", { name: "Свернуть меню", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".page-content [role='status']")?.textContent?.includes("Загружаем"));
      // Start each visual assertion at the top, including browsers restoring a
      // previous document's scroll offset while a lazy-loaded section mounts.
      await page.evaluate(() => window.scrollTo(0, 0));
      if (backLabel) {
        const back = heading.locator(".page-heading-back"); await back.waitFor();
        assert.equal(await back.innerText(), backLabel, `${route} back label`);
        const box = await back.boundingBox(), titleBox = await heading.locator("h1").boundingBox();
        assert.ok(box.y >= 0, `${route} back link visible at ${viewport.width}`);
        assert.ok(box.y + box.height <= titleBox.y + 1, `${route} back above title at ${viewport.width}`);
      }
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
      if (!fits) {
        await page.screenshot({ path: "/tmp/workspace-header-overflow.png" });
        console.log(await page.evaluate(() => [...document.querySelectorAll(".page-content *")].filter(element => element.getBoundingClientRect().right > innerWidth + 1 && !element.closest(".ag-root, .roles-matrix-wrap, .users-table-wrap")).slice(0, 15).map(element => ({ class: element.className, width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right }))));
      }
      assert.ok(fits, `${route} no page overflow at ${viewport.width}`);
      const titleBox = await heading.locator("h1").boundingBox();
      assert.ok(titleBox.x >= 0 && titleBox.x + titleBox.width <= viewport.width + 1, `${route} title fits at ${viewport.width}`);
      if (["/settings/general/users", "/settings/general/access"].includes(route)) {
        assert.equal(await heading.locator(".users-rights-tabs").evaluate(element => getComputedStyle(element).borderRadius), "10px", "Users/rights header keeps its capsule tabs");
        assert.equal(await heading.getByRole("tab", { selected: true }).evaluate(element => getComputedStyle(element).backgroundColor), "rgb(255, 255, 255)", "Active capsule keeps its original background");
      }
      const excel = heading.getByRole("button", { name: "Excel", exact: true });
      if (!["/settings/general", "/settings/project", "/settings/general/access", "/settings/general/activity"].includes(route)) await excel.waitFor();
      if (await excel.count()) {
        assert.equal(await excel.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(24, 24, 27)", `${route} Excel uses unified black style`);
        if (await excel.isEnabled()) {
          await excel.focus(); await page.keyboard.press("ArrowDown");
          const menu = page.getByRole("menu", { name: "Действия с Excel", exact: true }); await menu.waitFor();
          assert.ok(await menu.getByRole("menuitem").count() > 0, `${route} Excel actions retained`);
          const box = await menu.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, `${route} menu fits at ${viewport.width}`);
          await page.keyboard.press("Escape"); await menu.waitFor({ state: "detached" });
          assert.equal(await excel.evaluate(element => element === document.activeElement), true, `${route} Excel keyboard focus retained`);
        }
      }
      const visibleFooter = page.locator(".employee-footer-base, .report-grid-footer, .timesheet-month-overview").filter({ visible: true }).last();
      if (await visibleFooter.count()) {
        const footer = await visibleFooter.boundingBox();
        // Full-height table workspaces keep their footer on screen; ordinary
        // settings pages (for example Projects) retain normal page scrolling.
        if (await page.locator(".table-workspace-page, .timesheet-workspace-page").count()) assert.ok(footer.y + footer.height <= viewport.height + 1, `${route} original footer visible at ${viewport.width}: ${JSON.stringify(footer)}`);
      }
      if (route.startsWith("/timesheets")) {
        await page.locator(".timesheet-table tbody tr").first().waitFor();
        const picker = page.locator(".timesheet-month-picker-trigger");
        // Both timesheets retain a working month/year calendar in their summary bar.
        if (await picker.count()) { await picker.click(); await page.getByRole("dialog").waitFor(); await page.keyboard.press("Escape"); }
      }
      if (["/settings/general/positions", "/settings/general/users", "/settings/general/access", "/reports/workers?date=2026-11-04", "/timesheets/equipment?month=2026-11"].includes(route) && viewport.width !== 913) await page.screenshot({ path: `/tmp/workspace-header-${route.split("/").at(-1).split("?")[0]}-${viewport.width}.png` });
      checked++;
      console.log(`PASS ${viewport.width}: ${route}`);
    }
  }
  assert.deepEqual(errors, [], "No application errors on any section");
  assert.ok(requests.length > 0);
  console.log(`PASS: ${checked} section/viewport combinations; original menus, tables, calendars, and read-only mocked API`);
} finally { await browser?.close(); await server.httpServer.close(); }
