// Actual components, synthetic HTTP only: no .env, accounts or database access.
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
  build: { outDir: await mkdtemp(join(tmpdir(), "table-escape-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/workspace-header.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3157, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors = [], writes = [];
  page.on("pageerror", error => errors.push(error.message));
  const range = make => Array.from({ length: 3 }, (_, index) => make(index + 1));
  const sites = range(id => ({ id, name: `Учебный проект ${id}`, code: `TEST${id}`, timezone: "Europe/Moscow" }));
  const employees = range(id => ({ id, fullName: `Сотрудник ${id}`, employmentType: "ИТР", department: "МУТТ", position: `Должность ${id}`, source: "manual", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
  const units = range(id => ({ id, name: `Кран ${id}`, equipmentType: "Кран", brand: "Тест", model: `Модель ${id}`, registrationNumber: `ТЕСТ${id}`, inventoryNumber: `TEST-${id}`, organization: "Учебная организация", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", unavailableFrom: null, note: "" }));
  const users = range(id => ({ id, fullName: `Пользователь ${id}`, email: `user${id}@example.invalid`, role: "engineer", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, status: "active" }));
  const options = { shifts: [{ id: 1, name: "день" }], zones: range(id => ({ id, name: `Зона ${id}` })), mainWorkTypes: range(id => ({ id, name: `Работа ${id}` })), subworkTypes: range(id => ({ id, name: `Подработа ${id}`, mainWorkTypeId: id })), masters: employees.map(employee => ({ id: employee.id, name: employee.fullName, employeeId: employee.id })) };
  const stamp = "2026-11-04T10:00:00.000Z";
  const entries = equipment => range(id => ({ id, siteId: 1, workDate: "2026-11-04", shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1, hours: 8, note: "", shiftName: "день", zoneName: "Зона 1", mainWorkTypeName: "Работа 1", subworkTypeName: "Подработа 1", masterName: "Сотрудник 1", createdAt: stamp, updatedAt: stamp, rowOrder: id, revision: 1, responsibleUserId: 1, responsibleUserName: "Проверка Escape",
    ...(equipment ? { equipmentId: id, equipmentName: `Кран ${id}`, equipmentType: "Кран", organization: "Учебная организация", brand: "Тест", model: `Модель ${id}`, registrationNumber: `ТЕСТ${id}` } : { employeeId: id, employeeName: `Сотрудник ${id}`, employmentType: "ИТР", department: "МУТТ", positionSnapshot: `Должность ${id}` }) }));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") { writes.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 500, json: { error: "Escape must not save data" } }); }
    let body;
    if (url.pathname === "/api/table-order") body = { ids: [], canWrite: true, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report")) body = { reports: [], entries: entries(url.pathname === "/api/equipment-report"), canReview: true, availabilityMarks: [], from: null, to: null };
    else if (url.pathname === "/api/timesheet") body = { siteId: 1, siteName: sites[0].name, month: "2026-11", canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees, entries: [], marks: [] };
    else if (url.pathname === "/api/equipment") body = { siteId: 1, siteName: sites[0].name, workDate: "2026-11-04", month: "2026-11", canEditDaily: true, canCreateDaily: true, canUpdateDaily: true, canDeleteDaily: true, canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, canManageRegistry: true, canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true, canManageAssignments: true, canCreateAssignments: true, canUpdateAssignments: true, canDeleteAssignments: true, currentUserRole: "superadmin", currentUserName: "Проверка Escape", reportSubmitted: false, foremanProgress: [], units, availableUnits: units, sites, entries: [], marks: [], dailyTimesheetMarks: [], filledDates: [], ...options };
    else if (url.pathname === "/api/roles") body = { roles: [], canManage: true };
    else if (url.pathname === "/api/access-rights") body = { users, sites, canManage: true, currentUserId: 1 };
    else {
      assert.equal(url.pathname, "/api/data");
      body = { sites, employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees, positionCatalog: range(id => ({ id, employmentType: "ИТР", department: "МУТТ", position: `Должность ${id}` })), employmentTypes: [{ id: 1, name: "ИТР" }], departments: [{ id: 1, name: "МУТТ" }], positions: range(id => ({ id, name: `Должность ${id}` })), users, ...options, entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false, projectStats: [], bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } } };
    }
    await route.fulfill({ json: body });
  });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const outsideFocus = () => page.locator("h1").evaluate(element => { element.tabIndex = -1; element.focus(); });
  async function open(path, title) {
    await page.goto(`http://127.0.0.1:3157/workspace-header.html?route=${encodeURIComponent(path)}`);
    await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll(".page-content [role='status']")].some(element => element.textContent?.includes("Загружаем")));
    await settle();
  }
  const noAGSelection = async () => {
    await settle();
    await page.waitForFunction(() => document.querySelectorAll(".page-content .ag-row-selected,.page-content .ag-excel-selected,.page-content .ag-cell-range-selected,.page-content .ag-cell-focus,.page-content .ag-selection-checkbox input:checked").length === 0);
  };
  const routes = [
    ["/settings/general/employees", "Сотрудники"], ["/settings/project/zones", "Зоны"],
    ["/settings/project/work-types", "Виды и подвиды работ"],
    ["/reports/workers?date=2026-11-04", "Отчёт персонала"],
    ["/reports/equipment?date=2026-11-04", "Отчёт техники"],
  ];
  for (const [path, title] of routes) {
    await open(path, title);
    const expandAll = page.getByRole("button", { name: "Раскрыть все", exact: true });
    if (await expandAll.count()) await expandAll.click();
    const checkbox = page.locator(".page-content .ag-row .ag-selection-checkbox input:enabled").first();
    await checkbox.waitFor(); await checkbox.check();
    assert.ok(await page.locator(".page-content .ag-row-selected").count(), `${path}: row selected`);
    await checkbox.press("Escape"); await noAGSelection();
    assert.equal(await checkbox.isChecked(), false, `${path}: focused checkbox cleared`);
    await checkbox.check(); await outsideFocus(); await page.keyboard.press("Escape"); await noAGSelection();
    assert.equal(await checkbox.isChecked(), false, `${path}: outside Escape cleared checkbox`);
    const dataCell = page.locator('.page-content .ag-row .ag-cell:is([col-id="fullName"],[col-id="name"],[col-id="employeeName"],[col-id="equipmentType"])').first();
    await dataCell.click(); await page.keyboard.press("Shift+ArrowDown"); await settle();
    assert.ok(await page.locator(".page-content .ag-excel-selected,.page-content .ag-cell-range-selected").count(), `${path}: cell selection present`);
    await outsideFocus(); await page.keyboard.press("Escape"); await noAGSelection();
    console.log(`PASS: ${path}: focused checkbox, outside focus, row and cell selection cleared`);
  }

  await open("/settings/general/employees", "Сотрудники");
  const nameCell = page.locator('.ag-row [col-id="fullName"]').first();
  await nameCell.dblclick();
  const nameInput = nameCell.locator("input"); await nameInput.waitFor();
  await nameInput.fill("Не сохранять этот текст"); await nameInput.press("Escape");
  await nameInput.waitFor({ state: "detached" });
  assert.match(await nameCell.innerText(), /Сотрудник 1/);
  console.log("PASS: cell editor Escape still cancels its draft without saving");
  await open("/settings/general/employees", "Сотрудники");
  const rowCheckbox = page.locator(".ag-row .ag-selection-checkbox input:enabled").first();
  await rowCheckbox.check();
  const filter = page.getByRole("button", { name: /Фильтр.*ФИО|Фильтр.*Фамилия|Фильтр.*имя/ }).first();
  await filter.click();
  const filterPanel = page.locator(".ag-filter-menu").first();
  await filterPanel.waitFor();
  const filterInput = filterPanel.locator("input:not([type='checkbox'])").first();
  await filterInput.waitFor(); await filterInput.press("Escape");
  await filterPanel.waitFor({ state: "detached" }); await settle();
  assert.ok(await page.locator(".ag-row-selected").count(), "Closing filter keeps row selection");
  await outsideFocus(); await page.keyboard.press("Escape"); await noAGSelection();
  console.log("PASS: first Escape belongs to filter; next Escape clears selection");

  for (const kind of ["workers", "equipment"]) {
    await open(`/timesheets/${kind}?month=2026-11`, kind === "workers" ? "Табель рабочих" : "Табель техники");
    const cell = page.locator('[data-timesheet-row="0"][data-timesheet-column="0"]'); await cell.waitFor();
    const rowHandle = page.locator(".table-row-number-handle").first();
    await rowHandle.click(); assert.ok(await page.locator(".table-row-move-selected").count());
    await rowHandle.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".table-row-move-selected"));
    await rowHandle.click(); await cell.click(); await page.keyboard.press("Shift+ArrowRight");
    assert.ok(await page.locator(".timesheet-cell-selected").count());
    await outsideFocus(); await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".timesheet-cell-selected,.table-row-move-selected"));
    await cell.dblclick(); const editor = cell.locator("input"); await editor.waitFor();
    await editor.fill("9"); await editor.press("Escape"); await editor.waitFor({ state: "detached" });
    console.log(`PASS: ${kind} timesheet: row/cell/outside Escape clears; editor Escape cancels`);
  }

  await open("/settings/general/users", "Пользователи и права");
  const allUsers = page.getByRole("checkbox", { name: "Выбрать всех пользователей", exact: true });
  await allUsers.check(); assert.equal(await page.locator(".users-table tbody input:checked").count(), 3);
  await allUsers.press("Escape"); assert.equal(await page.locator(".users-table tbody input:checked").count(), 0);
  await allUsers.check();
  await page.getByRole("button", { name: "Открыть пользователя Пользователь 1", exact: true }).click();
  await page.getByRole("dialog").waitFor(); await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await page.locator(".users-table tbody input:checked").count(), 3, "Details Escape keeps selection");
  await outsideFocus(); await page.keyboard.press("Escape");
  assert.equal(await page.locator(".users-table tbody input:checked").count(), 0);
  console.log("PASS: user table checkbox/outside Escape clears; details dialog owns first Escape");

  await open("/settings/general/projects", "Проекты");
  const projectCheck = page.getByRole("checkbox", { name: "Выбрать проект Учебный проект 1", exact: true });
  await projectCheck.locator("..").click(); assert.equal(await projectCheck.isChecked(), true);
  await projectCheck.press("Escape");
  assert.equal(await page.locator(".project-card.selected").count(), 0);
  console.log("PASS: project cards share the same Escape selection behavior");
  assert.deepEqual(writes, [], "Escape must never save, delete or reorder data");
  assert.deepEqual(errors, [], "No runtime errors");
  console.log("PASS: every table family, preserved editor/filter/dialog behavior, no data mutations");
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) console.error("Selection state:", await failedPage.evaluate(() => ({
    selected: [...document.querySelectorAll(".ag-row-selected")].map(row => row.getAttribute("row-id")),
    checked: [...document.querySelectorAll(".ag-selection-checkbox input:checked")].map(input => ({ row: input.closest(".ag-row")?.getAttribute("row-id"), role: input.getAttribute("role") })),
    focus: [...document.querySelectorAll(".ag-cell-focus")].map(cell => cell.getAttribute("col-id")),
    active: document.activeElement?.outerHTML.slice(0, 250),
    overlays: [...document.querySelectorAll("[role='dialog'],[role='menu'],[role='listbox'],.ag-menu,.ag-popup-editor,.personnel-filter")].filter(element => element.getClientRects().length).map(element => element.className),
  })));
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: "/tmp/table-escape-failure.png" }).catch(() => {});
  throw error;
} finally { await browser?.close(); await server.httpServer.close(); }
