// Real application, synthetic actors and read-only mocks. No environment/DB access.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? process.argv[2] + "/index.mjs" : "playwright");
const port = Number(process.argv[3] ?? 3174);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Укажите корректный порт стенда.");
const config = {
  configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "table-context-menu-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/table-context-menu.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port, strictPort: true },
};
await build(config);
const server = await preview(config);
let browser, page;
let currentCase = "initialisation";
let lastAction = null;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 954 } });
  page.setDefaultTimeout(12_000);
  const errors = [], writes = [], checks = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    window.__tableContextEvents = [];
    document.addEventListener("contextmenu", event => {
      const target = event.target;
      window.__tableContextEvents.push({
        event,
        text: target instanceof Element ? target.textContent?.slice(0, 80) : "",
        tag: target instanceof Element ? target.tagName : "",
        className: target instanceof Element ? String(target.className).slice(0, 160) : "",
        headerId: target instanceof Element ? target.closest(".ag-header-cell")?.getAttribute("col-id") : null,
        cellId: target instanceof Element ? target.closest(".ag-cell")?.getAttribute("col-id") : null,
        x: event.clientX, y: event.clientY,
      });
    }, true);
  });
  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const users = [{ id: 1, fullName: "Проверка меню", email: "menus@example.invalid", role: "superadmin", assignedSiteId: null,
    projectAccess: { mode: "all", siteIds: [] }, status: "active" }];
  const employees = ["Иванов Сергей Петрович", "Петров Андрей Николаевич"].map((fullName, index) => ({
    id: index + 1, fullName, employmentType: index ? "ИТР" : "ОПР", department: index ? "МУСК" : "МУТТ",
    position: index ? "Мастер" : "Монтажник", source: "manual", siteId: 1, siteName: sites[0].name,
    availabilityStatus: "active", bitrix24Stage: "", syncError: null,
  }));
  const units = employees.map(({ id }) => ({
    id, name: "Кран " + id, equipmentType: "Кран", brand: "Тест", model: "Модель " + id,
    registrationNumber: "ТЕСТ" + id, inventoryNumber: "TEST-" + id, organization: "Организация " + id,
    siteId: 1, siteName: sites[0].name, availabilityStatus: "active", unavailableFrom: null, note: "",
  }));
  const options = {
    shifts: [{ id: 1, name: "день" }], zones: [{ id: 1, name: "Зона 1" }, { id: 2, name: "Зона 2" }],
    mainWorkTypes: [{ id: 1, name: "Монтаж" }, { id: 2, name: "Подготовка" }],
    subworkTypes: [{ id: 1, name: "Сборка", mainWorkTypeId: 1 }, { id: 2, name: "Разметка", mainWorkTypeId: 2 }],
    masters: [{ id: 2, name: employees[1].fullName, employeeId: 2 }],
  };
  const entries = equipment => employees.map((employee, index) => ({
    id: employee.id, siteId: 1, workDate: "2026-11-04", shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 2,
    hours: index ? 6 : 8, note: "", shiftName: "день", zoneName: "Зона 1", mainWorkTypeName: "Монтаж",
    subworkTypeName: "Сборка", masterName: employees[1].fullName, createdAt: "2026-11-04T10:00:00.000Z",
    updatedAt: "2026-11-04T10:00:00.000Z", rowOrder: employee.id, revision: 1, responsibleUserId: 1,
    responsibleUserName: users[0].fullName,
    ...(equipment ? { equipmentId: employee.id, equipmentName: units[index].name, equipmentType: "Кран",
      organization: units[index].organization, brand: "Тест", model: units[index].model, registrationNumber: units[index].registrationNumber }
      : { employeeId: employee.id, employeeName: employee.fullName, employmentType: employee.employmentType,
        department: employee.department, positionSnapshot: employee.position }),
  }));
  const data = {
    sites, employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees,
    positionCatalog: employees.map(({ id, employmentType, department, position }) => ({ id, employmentType, department, position })),
    employmentTypes: [{ id: 1, name: "ОПР" }, { id: 2, name: "ИТР" }], departments: [{ id: 1, name: "МУТТ" }, { id: 2, name: "МУСК" }],
    positions: employees.map(({ id, position }) => ({ id, name: position })), users, ...options,
    entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false,
    projectStats: [{ siteId: 1, employeeCount: 2, foremanCount: 1 }],
    bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } },
  };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") {
      writes.push(request.method() + " " + url.pathname);
      await route.fulfill({ status: 403, json: { error: "Запись отключена на стенде." } });
      return;
    }
    let body;
    if (url.pathname === "/api/data") body = data;
    else if (url.pathname === "/api/table-order") body = { ids: [], canWrite: false, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report")) body = { reports: [], entries: entries(url.pathname === "/api/equipment-report"), canReview: true, availabilityMarks: [], from: null, to: null };
    else if (url.pathname === "/api/personnel-report-draft") body = { revision: 0, snapshot: null };
    else if (url.pathname === "/api/timesheet") body = { siteId: 1, siteName: sites[0].name, month: url.searchParams.get("month"),
      canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees, entries: [], marks: [] };
    else if (url.pathname === "/api/equipment") body = {
      siteId: 1, siteName: sites[0].name, workDate: url.searchParams.get("date"), month: url.searchParams.get("month"),
      canEditDaily: true, canCreateDaily: true, canUpdateDaily: true, canDeleteDaily: true, canEditTimesheet: true,
      canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, canManageRegistry: true,
      canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true, canManageAssignments: true,
      canCreateAssignments: true, canUpdateAssignments: true, canDeleteAssignments: true, currentUserRole: "superadmin",
      currentUserName: users[0].fullName, reportSubmitted: false, foremanProgress: [], units, availableUnits: units, sites,
      entries: [], marks: [], dailyTimesheetMarks: [], filledDates: [], ...options,
    };
    else if (url.pathname === "/api/roles") body = { roles: [], canManage: true };
    else if (url.pathname === "/api/access-rights") body = { users, sites, canManage: true, currentUserId: 1 };
    else if (url.pathname === "/api/audit-log") body = { events: [] };
    else { await route.fulfill({ status: 404, json: { error: "Неизвестный API стенда: " + url.pathname } }); return; }
    await route.fulfill({ json: body });
  });

  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const headerById = id => page.locator('.page-content .ag-grid-shell .ag-header-cell[col-id="' + id + '"]');
  const bodyMenu = () => page.locator(".table-context-menu:visible");
  const headerMenu = () => page.locator(".ag-menu:visible").filter({ has: page.locator(".ag-menu-list") }).first();
  const cellById = id => page.locator('.page-content .ag-grid-shell .ag-row[row-index] .ag-cell[col-id="' + id + '"]').first();
  // Pin entries are menuitemradio in AG36, while regular actions are menuitem.
  const menuItem = pattern => page.locator('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]').filter({ hasText: pattern });
  const lastPrevented = () => page.evaluate(() => window.__tableContextEvents.at(-1)?.event.defaultPrevented);
  async function closeMenus() { await page.keyboard.press("Escape"); await frames(); }
  async function open(path, title, role = "superadmin") {
    currentCase = page.viewportSize().width + "px " + role + " " + path;
    lastAction = { type: "navigate", path, role };
    await page.goto("http://127.0.0.1:" + port + "/table-context-menu.html?route=" + encodeURIComponent(path) + "&role=" + role);
    await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
    await page.locator(".page-content .ag-grid-shell .ag-header-cell-text").filter({ hasText: /\S/ }).first().waitFor();
    await frames();
  }
  async function visiblePoint(locator, vertical = .5) {
    for (const fraction of [0, .3, .65, 1]) {
      if (await locator.count()) {
        const point = await locator.first().evaluate((element, vertical) => {
          const r = element.getBoundingClientRect();
          for (const x of [r.left + r.width / 2, r.left + 16, r.right - 16]) {
            const y = r.top + r.height * vertical;
            if (x < 2 || x > innerWidth - 2 || y < 2 || y > innerHeight - 2) continue;
            const hit = document.elementFromPoint(x, y);
            if (hit && (hit === element || element.contains(hit))) return { x, y };
          }
          return null;
        }, vertical);
        if (point) return point;
      }
      await page.locator(".page-content .ag-grid-shell .ag-grid-viewport").first().evaluate((viewport, fraction) => {
        viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) * fraction;
      }, fraction);
      await frames();
    }
    throw new Error(currentCase + ": no visible hit point for " + locator);
  }
  async function headerContext(id, { button = false } = {}) {
    const owner = headerById(id);
    const point = await visiblePoint(owner);
    lastAction = { type: "headerContext", id, button, point };
    if (button) {
      const filterButton = owner.locator(".ag-column-filter");
      assert.ok(await filterButton.count(), "Expected a header filter button");
      const r = await filterButton.boundingBox();
      lastAction.point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2, { button: "right" });
    } else await page.mouse.click(point.x, point.y, { button: "right" });
    await headerMenu().waitFor();
    assert.equal(await bodyMenu().count(), 0, "Headers must not use a stale cell-copy menu");
    assert.equal(await lastPrevented(), true, "A header menu owns its contextmenu event");
    const r = await headerMenu().boundingBox(), viewport = page.viewportSize();
    assert.ok(r && r.x >= -1 && r.y >= -1 && r.x + r.width <= viewport.width + 1 && r.y + r.height <= viewport.height + 1, "Header menu must fit its viewport");
    return owner;
  }
  async function cellContext(id, native = false) {
    const cell = cellById(id);
    const point = await visiblePoint(cell);
    lastAction = { type: "cellContext", id, native, point };
    await page.mouse.click(point.x, point.y, { button: "right" });
    if (native) await menuItem(/Копировать|Copy/).first().waitFor();
    else await bodyMenu().waitFor();
    assert.equal(await lastPrevented(), true, "A real table cell owns its contextmenu event");
  }
  async function outside(locator, label) {
    if (!await locator.count()) return;
    await closeMenus();
    const target = locator.first();
    lastAction = { type: "outside", label };
    await target.scrollIntoViewIfNeeded();
    await target.click({ button: "right" });
    await frames();
    assert.equal(await lastPrevented(), false, label + ": leave the native browser context menu untouched");
    assert.equal(await bodyMenu().count(), 0, label + ": no cell menu outside the table");
    assert.equal(await page.locator(".ag-menu:visible").count(), 0, label + ": no header menu outside the table");
    await closeMenus();
  }
  async function clickMenu(pattern) {
    lastAction = { type: "clickMenu", pattern: String(pattern) };
    const item = menuItem(pattern).first();
    await item.waitFor();
    assert.notEqual(await item.getAttribute("aria-disabled"), "true", "Menu action should be enabled: " + pattern);
    await item.click();
    await frames();
  }
  async function resize(id, delta) {
    const owner = await headerContext(id); await closeMenus();
    const grip = owner.locator(".ag-header-cell-resize");
    const r = await grip.boundingBox();
    const before = (await owner.boundingBox()).width;
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down(); await page.mouse.move(r.x + r.width / 2 + delta, r.y + r.height / 2, { steps: 8 }); await page.mouse.up(); await frames();
    return { before, after: (await headerById(id).boundingBox()).width };
  }

  const routes = [
    ["/settings/general/employees", "Сотрудники", "fullName"],
    ["/settings/general/equipment", "Реестр техники", "equipmentType"],
    ["/reports/workers?date=2026-11-04", "Отчёт персонала", "employeeName"],
    ["/reports/equipment?date=2026-11-04", "Отчёт техники", "equipment"],
    ["/settings/project/employees", "Сотрудники проекта", "fullName"],
    ["/settings/project/work-types", "Виды и подвиды работ", "name", true],
  ];
  for (const viewport of [{ width: 1440, height: 954 }, { width: 831, height: 954 }]) {
    await page.setViewportSize(viewport);
    for (const [path, title, columnId, native] of routes) {
      await open(path, title);
      await cellContext(columnId, native);
      if (!native) await page.getByRole("menuitem", { name: /Копировать ячейку/ }).waitFor();
      await headerContext(columnId);
      assert.equal(await menuItem(/^Сгруппировать по/).count(), 0, "Do not enable unsafe new grouping on editable grids");
      await clickMenu(/По возрастанию/);
      await page.waitForFunction(id => document.querySelector('.page-content .ag-grid-shell .ag-header-cell[col-id="' + id + '"]')?.getAttribute("aria-sort") === "ascending", columnId);
      await headerContext(columnId);
      await clickMenu(/По убыванию/);
      await page.waitForFunction(id => document.querySelector('.page-content .ag-grid-shell .ag-header-cell[col-id="' + id + '"]')?.getAttribute("aria-sort") === "descending", columnId);
      await headerContext(columnId);
      await clickMenu(/(?:Отменить|Сбросить) сортировку/);
      await headerContext(columnId, { button: !native });
      await closeMenus();
      await outside(page.locator(".workspace-page-heading h1"), "Page heading");
      await outside(page.locator(".sidebar-product-title > span"), "Sidebar");
      await outside(page.locator(".page-content .table-edit-footer"), "Footer");
      await outside(page.locator(".page-content .grid-filter-summary"), "Sort/filter toolbar");
      checks.push(viewport.width + " " + path);
      console.log("PASS " + currentCase);
    }
  }

  // Exercise concrete column operations on a multi-column catalogue.
  await page.setViewportSize({ width: 1440, height: 954 });
  await open("/settings/general/employees", "Сотрудники");
  const resized = await resize("department", 150);
  assert.ok(resized.after > resized.before + 50, "The test must first make a visibly wide column");
  await headerContext("department"); await clickMenu(/(?:Ширина по содержимому|Подобрать ширину столбца)/);
  assert.ok((await headerById("department").boundingBox()).width < resized.after - 15, "Auto-size uses real content rather than doing nothing");
  await headerContext("department"); await clickMenu(/Закрепить столбец/);
  await clickMenu(/Закрепить слева/);
  await page.waitForFunction(() => Boolean(document.querySelector('.ag-header-row .ag-grid-pinned-left-cells .ag-header-cell[col-id="department"]')));
  await headerContext("department"); await clickMenu(/Закрепить столбец/); await clickMenu(/Открепить/);
  await page.waitForFunction(() => !document.querySelector('.ag-header-row .ag-grid-pinned-left-cells .ag-header-cell[col-id="department"]'));
  await headerContext("department"); await clickMenu(/Скрыть столбец/);
  assert.equal(await headerById("department").count(), 0, "Hide applies to the requested column only");
  await headerContext("fullName"); await clickMenu(/Выбрать столбцы/);
  const chooser = page.locator(".ag-dialog:visible").filter({ has: page.locator(".ag-column-select") }).first();
  await chooser.waitFor();
  assert.doesNotMatch(await chooser.innerText(), /Порядок импорта|createdAt|updatedAt|reportDateGroup/, "Technical columns stay out of the chooser");
  const department = chooser.locator(".ag-column-select-column").filter({ has: page.getByText("Отдел", { exact: true }) });
  await department.locator('input[type="checkbox"]').check();
  await closeMenus(); await headerById("department").waitFor();
  await headerContext("department"); await clickMenu(/Подобрать ширину всех|Подобрать ширину всех столбцов/);
  await headerContext("department"); await clickMenu(/Сбросить.*столбц/);
  await headerById("department").waitFor();
  console.log("PASS column operations: resize, auto-size, pin/unpin, hide, chooser, reset");
  await open("/settings/project/zones", "Зоны");
  await headerContext("name");
  const hideLast = menuItem(/Скрыть столбец/);
  if (await hideLast.count()) assert.equal(await hideLast.first().getAttribute("aria-disabled"), "true", "The last meaningful column must not be hidden");
  await closeMenus();
  console.log("PASS last business column is protected");

  // Display operations remain available to read-only users; mutation commands do not.
  await open("/settings/project/employees", "Сотрудники проекта", "foreman");
  await cellContext("fullName");
  assert.equal(await bodyMenu().getByRole("menuitem", { name: /Редактировать|Удалить|Вставить|Вырезать|Очистить/ }).count(), 0, "Read-only body menus do not expose mutations");
  await headerContext("department"); await clickMenu(/По возрастанию/);
  await outside(page.locator(".workspace-page-heading h1"), "Read-only outside table");
  console.log("PASS read-only context menus and scope");

  if (process.argv.includes("--timesheets")) {
    for (const kind of ["workers", "equipment"]) {
      const title = kind === "workers" ? "Табель рабочих" : "Табель техники";
      currentCase = "native timesheet " + kind;
      await page.goto("http://127.0.0.1:" + port + "/table-context-menu.html?route=" + encodeURIComponent("/timesheets/" + kind + "?month=2026-11"));
      await page.getByRole("heading", { name: title, level: 1, exact: true }).waitFor();
      const first = page.locator(".timesheet-table thead th").filter({ has: page.locator(".timesheet-filterable-heading") }).first();
      await first.click({ button: "right" }); await page.getByRole("menu").first().waitFor();
      await menuItem(/По возрастанию/).first().waitFor();
      await closeMenus();
      await outside(page.locator(".workspace-page-heading h1"), "Native timesheet outside table");
      console.log("PASS native timesheet " + kind);
    }
  }
  assert.deepEqual(writes, [], "Column/context menus must never write business data");
  assert.deepEqual(errors, [], "No runtime errors");
  console.log(JSON.stringify({ checks, interactions: "cell/header scope, native outside menu, sorting, pin/unpin, auto-size, hide/chooser/reset, read-only", writes: writes.length }));
} catch (error) {
  console.error("FAILED CASE " + currentCase);
  console.error("LAST ACTION " + JSON.stringify(lastAction));
  if (page && !page.isClosed()) {
    try {
      const diagnostic = await page.evaluate(() => {
        const describe = element => {
          const r = element.getBoundingClientRect(), style = getComputedStyle(element);
          return { tag: element.tagName, className: String(element.className).slice(0, 200), role: element.getAttribute("role"),
            text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 450),
            box: { x: r.x, y: r.y, width: r.width, height: r.height }, display: style.display, visibility: style.visibility };
        };
        return {
          url: location.href,
          contextEvents: window.__tableContextEvents.slice(-6).map(({ event, ...record }) => ({ ...record, defaultPrevented: event.defaultPrevented })),
          menus: [...document.querySelectorAll(".ag-menu,.ag-column-menu,.table-context-menu,[role='menu']")].slice(0, 12).map(describe),
          headers: [...document.querySelectorAll(".page-content .ag-grid-shell .ag-header-cell")].slice(0, 16).map(element => ({
            id: element.getAttribute("col-id"), sort: element.getAttribute("aria-sort"), ...describe(element),
          })),
        };
      });
      console.error("MENU DIAGNOSTIC " + JSON.stringify(diagnostic));
      const screenshotPath = join(tmpdir(), "table-context-menu-failure.png");
      await page.screenshot({ path: screenshotPath });
      console.error("FAILURE SCREENSHOT " + screenshotPath);
    } catch (diagnosticError) { console.error("Diagnostic capture failed: " + diagnosticError.message); }
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
