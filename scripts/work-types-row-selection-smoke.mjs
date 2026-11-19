// Actual components, synthetic HTTP only: no .env, accounts or database access.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const columnShortcut = process.env.TABLE_COLUMN_SHORTCUT ?? "Control+Space";
const config = { configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "work-types-row-selection-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/workspace-header.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3162, strictPort: true } };
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
  async function open(path, title) {
    await page.goto(`http://127.0.0.1:3162/workspace-header.html?route=${encodeURIComponent(path)}`);
    await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll(".page-content [role='status']")].some(element => element.textContent?.includes("Загружаем")));
    await settle();
  }
  await open("/settings/project/work-types", "Виды и подвиды работ");
  const master = page.getByRole("grid", { name: "Таблица видов работ", exact: true });
  const masterCells = column => master.locator(`.ag-row [col-id="${column}"]`).filter({ has: page.locator(".work-types-master-name, .work-types-count") });
  const ownSelected = root => root.evaluate(element => [...element.querySelectorAll(".ag-cell-range-selected")].filter(cell => cell.closest(".work-types-master-grid,.work-types-detail-grid") === element).length);
  const expectSelected = async (root, expected) => {
    await page.waitForFunction(({ root, expected }) => [...root.querySelectorAll(".ag-cell-range-selected")].filter(cell => cell.closest(".work-types-master-grid,.work-types-detail-grid") === root).length === expected, { root: await root.elementHandle(), expected });
    assert.equal(await ownSelected(root), expected);
  };
  const copy = () => page.evaluate(() => {
    const data = new DataTransfer();
    document.activeElement.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }));
    return data.getData("text/plain");
  });
  await masterCells("childCount").first().click();
  await page.keyboard.press("Shift+Space");
  await expectSelected(master, 2);
  assert.equal((await copy()).split("\n").length, 1);
  assert.equal((await copy()).split("\t").length, 2);
  await page.keyboard.press("Shift+ArrowDown"); await expectSelected(master, 4);
  await page.keyboard.press("Shift+ArrowUp"); await expectSelected(master, 2);
  await masterCells("name").nth(2).click({ modifiers: ["Shift"] });
  await expectSelected(master, 6);
  assert.equal((await copy()).split("\n").length, 3);
  await page.keyboard.press("ArrowUp"); await expectSelected(master, 1);
  assert.equal(await master.locator('.ag-cell-focus').getAttribute("col-id"), "childCount", "plain navigation returns to original column");
  assert.equal(await master.locator('.ag-cell-focus').evaluate(cell => cell.closest('.ag-row').getAttribute('row-index')), "1");
  assert.equal(await master.locator('.ag-selection-checkbox input:checked').count(), 0);
  await page.keyboard.press("Escape"); await expectSelected(master, 0);
  console.log("PASS: WorkTypes whole row, Shift arrows/click, original column, copying and independent action checkboxes");

  await masterCells("childCount").nth(1).click(); await page.keyboard.press(columnShortcut);
  await expectSelected(master, 3);
  await master.locator('.ag-excel-header-selected[col-id="childCount"]').waitFor();
  assert.equal(await master.locator('.ag-excel-header-selected[col-id="childCount"]').count(), 1);
  const columnCopy = await copy();
  assert.equal(columnCopy.split("\n").length, 4); assert.equal(columnCopy.split("\n")[0], "Подвидов");
  await page.keyboard.press("Shift+ArrowLeft"); await expectSelected(master, 6);
  await master.locator('.ag-excel-header-selected[col-id="name"]').waitFor();
  assert.equal(await master.locator('.ag-excel-header-selected').count(), 2);
  await page.keyboard.press("Shift+ArrowRight"); await expectSelected(master, 3);
  const header = master.locator('.ag-header-cell[col-id="name"]');
  const previousSort = await header.getAttribute("aria-sort");
  await header.getByText("Вид работы", { exact: true }).click({ modifiers: ["Shift"] });
  await expectSelected(master, 6); assert.equal(await header.getAttribute("aria-sort"), previousSort, "Shift+click extends columns without sorting");
  await page.keyboard.press("ArrowUp"); await expectSelected(master, 1);
  assert.equal(await master.locator('.ag-cell-focus').evaluate(cell => cell.closest('.ag-row').getAttribute('row-index')), "0", "column mode keeps original row for exit navigation");
  await masterCells("childCount").nth(1).click(); await page.keyboard.press("Shift+Space");
  await page.keyboard.press(columnShortcut); await expectSelected(master, 3);
  await master.locator('.ag-excel-header-selected[col-id="childCount"]').waitFor();
  assert.equal(await master.locator('.ag-excel-header-selected[col-id="childCount"]').count(), 1, "row to column uses original active column");
  await page.keyboard.press("Shift+Space"); await expectSelected(master, 2);
  assert.equal((await copy()).split("\n").length, 1, "column to row uses original active record without header");
  await page.keyboard.press("Escape"); await expectSelected(master, 0);
  console.log("PASS: whole columns, one header, Shift arrows/header click, mode switching and original active row");

  await master.locator(".ag-group-contracted").first().click();
  const detail = page.getByRole("grid", { name: "Таблица подвидов работ", exact: true }); await detail.waitFor();
  await masterCells("name").first().click();
  await page.keyboard.press("Shift+Space"); await expectSelected(master, 2);
  await page.keyboard.press("Shift+ArrowDown"); await expectSelected(master, 4);
  assert.equal((await copy()).split("\n").length, 2, "detail panels are not copied into parent rows");
  assert.equal(await ownSelected(detail), 0, "parent shortcut does not select child records");
  await page.keyboard.press(columnShortcut); await expectSelected(master, 3);
  assert.equal((await copy()).split("\n").length, 4, "column copy contains one header and three master rows without detail panel");
  assert.equal(await ownSelected(detail), 0);
  const childCells = detail.locator('.ag-row [col-id="name"]').filter({ hasText: /^Подработа / });
  await childCells.first().click(); await page.keyboard.press("Shift+Space"); await expectSelected(detail, 1);
  await page.keyboard.press("Shift+ArrowDown"); await expectSelected(detail, 2);
  await childCells.nth(2).click({ modifiers: ["Shift"] }); await expectSelected(detail, 3);
  const childCopy = await copy();
  assert.equal(childCopy.split("\n").length, 3); assert.ok(!childCopy.includes("Работа 1"));
  await page.keyboard.press("Escape"); await expectSelected(detail, 0);
  await childCells.nth(1).click(); await page.keyboard.press(columnShortcut); await expectSelected(detail, 3);
  const detailColumnCopy = await copy();
  assert.equal(detailColumnCopy.split("\n")[0], "Подвид работы"); assert.equal(detailColumnCopy.split("\n").length, 4);
  await page.keyboard.press("F2");
  const columnEditor = detail.locator('.ag-row[row-index="1"] [col-id="name"] input'); await columnEditor.waitFor();
  await columnEditor.press("Escape"); await columnEditor.waitFor({ state: "detached" });
  await childCells.first().dblclick();
  const editor = detail.locator('.ag-row[row-index="0"] [col-id="name"] input'); await editor.waitFor();
  await editor.fill("Отменить"); await editor.press("Shift+Space");
  assert.equal(await editor.inputValue(), "Отменить ", "Shift+Space inserts space inside an active editor");
  await editor.press("Escape"); await editor.waitFor({ state: "detached" });
  assert.match(await childCells.first().innerText(), /^Подработа /);
  console.log("PASS: nested detail ownership, structural rows excluded and editor typing preserved");
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    console.error("STATE", await page.evaluate(() => ({active: document.activeElement?.outerHTML.slice(0,400), selected: [...document.querySelectorAll('.ag-cell-range-selected')].map(el=>({text:el.textContent,row:el.closest('.ag-row')?.getAttribute('row-index'),column:el.getAttribute('col-id')}))})));
    await page.screenshot({ path: "/tmp/work-types-row-selection-failure.png" });
  }
  throw error;
} finally { await browser?.close(); await server.httpServer.close(); }
