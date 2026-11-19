// Actual components, synthetic HTTP only: no .env, accounts or database access.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { parseSpreadsheetText } from "../app/spreadsheetClipboard.ts";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const columnShortcut = process.env.TABLE_COLUMN_SHORTCUT ?? "Control+Space";
const config = { configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "grid-row-selection-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/workspace-header.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3164, strictPort: true } };
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
  options.subworkTypes.push({ id: 4, name: "Подработа А", mainWorkTypeId: 1 }, { id: 5, name: "Подработа Б", mainWorkTypeId: 1 });
  const stamp = "2026-11-04T10:00:00.000Z";
  const entries = equipment => range(id => ({ id, siteId: 1, workDate: "2026-11-04", shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1, hours: 8, note: "", shiftName: "день", zoneName: "Зона 1", mainWorkTypeName: "Работа 1", subworkTypeName: "Подработа 1", masterName: "Сотрудник 1", createdAt: stamp, updatedAt: stamp, rowOrder: id, revision: 1, responsibleUserId: 1, responsibleUserName: "Проверка Escape",
    ...(equipment ? { equipmentId: id, equipmentName: `Кран ${id}`, equipmentType: "Кран", organization: "Учебная организация", brand: "Тест", model: `Модель ${id}`, registrationNumber: `ТЕСТ${id}` } : { employeeId: id, employeeName: `Сотрудник ${id}`, employmentType: "ИТР", department: "МУТТ", positionSnapshot: `Должность ${id}` }) }));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") { writes.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 500, json: { error: "Escape must not save data" } }); }
    let body;
    if (url.pathname === "/api/table-order") body = { ids: [], canWrite: true, hasSavedOrder: false };
    else if (url.pathname === "/api/personnel-report-draft" || url.pathname === "/api/equipment-report-draft") body = { revision: 0, snapshot: null };
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
  const copy = async root => parseSpreadsheetText(await root.evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData("text/plain");
  }));
  for (const [path, title, column, pattern] of [
    ["/settings/general/employees", "Сотрудники", "fullName", /^Сотрудник /],
    ["/settings/project/zones", "Зоны", "name", /^Зона /],
    ["/reports/workers?date=2026-11-04", "Отчёт персонала", "employeeName", /^Сотрудник /],
    ["/reports/equipment?date=2026-11-04", "Отчёт техники", "equipment", /^Модель /],
  ]) {
    await page.goto(`http://127.0.0.1:3164/workspace-header.html?route=${encodeURIComponent(path)}`);
    await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
    const root = page.locator('.localized-grid-body').first();
    const cells = root.locator(`.ag-row [col-id="${column}"]`).filter({ hasText: pattern });
    await cells.nth(2).waitFor(); await settle();
    const labels = await cells.allTextContents();
    await cells.first().click(); await page.keyboard.press("Shift+Space"); await settle();
    let matrix = await copy(root);
    assert.equal(matrix.length, 1, `${title}: one row`);
    assert.ok(matrix[0].includes(labels[0].trim()), `${title}: full row contains current cell`);
    const width = matrix[0].length;
    const displayed = await root.locator('.ag-header-cell[col-id]').evaluateAll(headers => headers.map(header => header.getAttribute('col-id')).filter(id => !['actions','rowOrder','ag-Grid-SelectionColumn'].includes(id)));
    assert.ok(width >= displayed.length, `${title}: all visible data columns included`);
    if (path.endsWith("employees")) {
      await page.keyboard.press("8");
      const activeEditor = root.locator('.ag-row [col-id="fullName"] input').first();
      await activeEditor.waitFor();
      assert.equal(await activeEditor.inputValue(), "8", "Typing after whole-row selection targets the original column");
      await activeEditor.press("Escape"); await activeEditor.waitFor({ state: "detached" });
      await cells.first().click(); await page.keyboard.press("Shift+Space"); await settle();
    }
    await page.keyboard.press("Shift+ArrowDown"); await settle();
    matrix = await copy(root); assert.equal(matrix.length, 2); assert.equal(matrix[1].length, width);
    await page.keyboard.press("Shift+ArrowUp"); await settle();
    assert.equal((await copy(root)).length, 1);
    await cells.nth(2).click({ modifiers: ["Shift"] }); await settle();
    matrix = await copy(root); assert.equal(matrix.length, 3, `${title}: ShiftClick expands full rows`);
    assert.ok(matrix.every(row => row.length === width));
    await cells.nth(1).click({ modifiers: ["Shift"] }); await settle();
    assert.equal((await copy(root)).length, 2, `${title}: ShiftClick contracts`);
    assert.equal(await root.locator('.ag-selection-checkbox input:checked').count(), 0, `${title}: no action checkbox selected`);
    await page.keyboard.press("ArrowDown"); await settle();
    matrix = await copy(root); assert.equal(matrix.length, 1); assert.equal(matrix[0].length, 1);
    assert.equal(matrix[0][0], labels[2].trim(), `${title}: ordinary arrow restores original column`);
    await page.keyboard.press("Escape"); await settle();
    assert.equal(await root.locator('.ag-excel-selected').count(), 0);
    await cells.nth(1).click(); await page.keyboard.press(columnShortcut); await settle();
    matrix = await copy(root);
    assert.equal(matrix.length, 4, `${title}: full column with header and all three rows`);
    assert.ok(matrix.every(row => row.length === 1));
    assert.equal(matrix[2][0], labels[1].trim());
    assert.equal(await root.locator('.ag-excel-header-selected').count(), 1);
    const nextColumn = displayed[displayed.indexOf(column) + 1];
    await page.keyboard.press("Shift+ArrowRight"); await settle();
    matrix = await copy(root); assert.ok(matrix.every(row => row.length === (nextColumn ? 2 : 1)));

    await page.keyboard.press("Shift+ArrowLeft"); await settle();
    assert.ok((await copy(root)).every(row => row.length === 1));
    if (nextColumn) {
    await root.locator(`.ag-header-cell[col-id="${nextColumn}"]`).click({ modifiers: ["Shift"] }); await settle();
    matrix = await copy(root); assert.equal(matrix.length, 4); assert.ok(matrix.every(row => row.length === 2), `${title}: Shift header click extends columns`);
    assert.equal(await root.locator('.ag-excel-header-selected').count(), 2);
    }
    assert.equal(await root.locator('.ag-selection-checkbox input:checked').count(), 0);
    await page.keyboard.press("Shift+Space"); await settle();
    matrix = await copy(root); assert.equal(matrix.length, 1); assert.ok(matrix[0].includes(labels[1].trim()), `${title}: row/column switch retains active row`);
    await cells.nth(1).click(); await page.keyboard.press(columnShortcut); await page.keyboard.press("ArrowDown"); await settle();
    assert.deepEqual(await copy(root), [[labels[2].trim()]], `${title}: column mode navigation retains origin row`);
    await page.keyboard.press("Escape"); await settle();
    assert.equal(await root.locator('.ag-excel-header-selected').count(), 0);
    if (path.endsWith("employees")) {
      await cells.nth(1).click(); await page.keyboard.press(columnShortcut); await page.keyboard.press("9");
      const editor = root.locator('.ag-row[row-index="1"] [col-id="fullName"] input');
      await editor.waitFor(); assert.equal(await editor.inputValue(), "9");
      await editor.press("Escape"); await editor.waitFor({ state: "detached" });
    }
    if (path.endsWith("employees")) {
      await cells.first().dblclick();
      const input = root.locator('.ag-row [col-id="fullName"] input').first(); await input.waitFor();
      await input.fill("Текст"); await input.press("End"); await input.press("Shift+Space");
      assert.equal(await input.inputValue(), "Текст ", "A real editor receives its normal space");
      await input.press("Escape"); await input.waitFor({ state: "detached" });
      assert.equal((await cells.first().innerText()).trim(), labels[0].trim());
    }
    console.log(`PASS ${title}: whole rows and columns, Shift arrows/header click, copy, mode switch, Escape/editor`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log("PASS: no runtime errors or data writes");
} finally { await browser?.close(); await server.httpServer.close(); }
