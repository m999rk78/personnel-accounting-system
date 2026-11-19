// Real timesheets with synthetic GET responses only; no credentials or database.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const columnShortcut = process.env.TABLE_COLUMN_SHORTCUT ?? "Control+Space";
const port = Number(process.argv[3] ?? 3193), base = `http://127.0.0.1:${port}`;
const config = { configFile: false, envDir: false, publicDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()], logLevel: "error",
  build: { outDir: await mkdtemp(join(tmpdir(), "timesheet-row-selection-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/index.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port, strictPort: true } };
await build(config);
const server = await preview(config);
let browser, page;
const errors = [], writes = [];
const employees = Array.from({ length: 1200 }, (_, index) => ({ id: index + 1, fullName: `Сотрудник ${index + 1}`, employmentType: "ИТР", department: "Участок", position: "Инженер" }));
const units = employees.map(({ id }) => ({ id, organization: "Учебная организация", equipmentType: "Кран", brand: "Тест", model: `Модель ${id}`, registrationNumber: `ТЕСТ-${id}`, note: "" }));
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 954 } });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") { writes.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 405, json: { error: "Выделение не изменяет данные" } }); }
    if (url.pathname === "/api/timesheet") return route.fulfill({ json: { siteId: 1, siteName: "Изолированный проект", month: "2026-10", employees, entries: [], marks: [], canEdit: true, canCreate: true, canUpdate: true, canDelete: true } });
    if (url.pathname === "/api/equipment") return route.fulfill({ json: { siteId: 1, siteName: "Изолированный проект", month: "2026-10", workDate: "2026-10-21", units, sites: [], entries: [], marks: [], dailyTimesheetMarks: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], foremanProgress: [], filledDates: [], currentUserRole: "superadmin", currentUserName: "Проверка", canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true } });
    return route.fulfill({ status: 404, json: { error: "Неизвестный запрос стенда" } });
  });
  const copy = async root => {
    const value = await root.evaluate(element => {
      const clipboardData = new DataTransfer();
      const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
      element.dispatchEvent(event);
      return { text: clipboardData.getData("text/plain"), handled: event.defaultPrevented };
    });
    assert.equal(value.handled, true);
    return value.text;
  };
  await page.goto(`${base}/index.html`);
  for (const kind of ["workers", "equipment"]) {
    if (kind === "equipment") await page.getByRole("button", { name: "Техника (1000)", exact: true }).click();
    const shell = page.locator(".timesheet-grid-shell");
    const cell = row => shell.locator(`[data-timesheet-row="${row}"][data-timesheet-column="0"]`);
    await cell(0).waitFor(); await cell(0).click();
    await page.keyboard.press("Shift+Space");
    let text = await copy(shell);
    assert.equal(text.split("\n").length, 1);
    assert.ok(text.split("\t").length > 31, "Identity and total columns are included");
    assert.match(text, kind === "workers" ? /Сотрудник 1/ : /Модель 1/);
    for (let index = 0; index < 120; index++) await page.keyboard.press("Shift+ArrowDown");
    text = await copy(shell);
    assert.equal(text.split("\n").length, 121);
    assert.ok(await shell.locator("tbody tr[data-virtual-row]").count() < 100, "Range includes unmounted virtual rows");
    await page.keyboard.press("Shift+ArrowUp"); assert.equal((await copy(shell)).split("\n").length, 120);
    // Wait for queued scroll frames and use the row's stable coordinate: a live
    // .last() locator can resolve to another row after virtualization settles.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const clickTarget = shell.locator('tbody tr[data-virtual-row] [data-timesheet-column="0"]').last();
    const endRow = Number(await clickTarget.getAttribute("data-timesheet-row"));
    await cell(endRow).click({ modifiers: ["Shift"] });
    assert.equal((await copy(shell)).split("\n").length, endRow + 1);
    assert.equal(await shell.locator('input[type="checkbox"]:checked').count(), 0, "Copy selection never selects row actions");
    await page.keyboard.press("ArrowUp");
    assert.equal(await copy(shell), "", "Ordinary arrow restores the original day column");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".timesheet-cell-selected"));
    await cell(endRow - 1).dblclick();
    const input = shell.locator(".timesheet-cell-inline-editor input");
    await input.fill("9"); await input.press("Shift+Space");
    assert.equal(await input.inputValue(), "9 ", "Shift+Space remains ordinary text inside the editor");
    await input.press("Escape"); await input.waitFor({ state: "detached" });

    const originalRow = endRow - 1;
    await cell(originalRow).click(); await page.keyboard.press(columnShortcut);
    let columns = (await copy(shell)).split("\n");
    assert.equal(columns.length, 1201, "Entire model plus header, not just rendered rows");
    assert.equal(columns[0], "01.10.2026");
    assert.equal(await shell.locator("thead .timesheet-column-header-selected").count(), 1);
    assert.ok(await shell.locator("tbody tr[data-virtual-row]").count() < 100);
    await page.keyboard.press("Shift+ArrowRight");
    assert.equal((await copy(shell)).split("\n")[0], "01.10.2026\t02.10.2026");
    assert.equal(await shell.locator("thead .timesheet-column-header-selected").count(), 2);
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+Space");
    assert.equal((await copy(shell)).split("\n").length, 1, "Switch to row uses original active row");
    assert.match(await copy(shell), new RegExp(kind === "workers" ? `Сотрудник ${originalRow + 1}(?:\\t|$)` : `Модель ${originalRow + 1} //`));
    await page.keyboard.press(columnShortcut);
    assert.equal((await copy(shell)).split("\n")[0], "01.10.2026", "Switch back retains original active day");
    await page.keyboard.press("8");
    await input.waitFor();
    assert.match(await input.getAttribute("aria-label"), new RegExp(kind === "workers" ? `Сотрудник ${originalRow + 1},` : `Модель ${originalRow + 1} //`));
    assert.equal(await input.inputValue(), "8");
    await input.press(columnShortcut);
    assert.equal(await shell.locator("thead .timesheet-column-header-selected").count(), 0, "Editor shortcut never selects a column");
    await input.press("Escape"); await input.waitFor({ state: "detached" });
    await cell(originalRow).click(); await page.keyboard.press(columnShortcut);
    await shell.locator(`[data-timesheet-row="${originalRow}"][data-timesheet-column="-2"]`).click({ modifiers: ["Shift"] });
    columns = (await copy(shell)).split("\n");
    assert.equal(columns.length, 1201);
    assert.equal(columns[0], kind === "workers" ? "Сотрудник\tДолжность\t01.10.2026" : "Техника\tОрганизация\t01.10.2026");
    await page.keyboard.press("ArrowUp");
    assert.match(await copy(shell), new RegExp(kind === "workers" ? `^Сотрудник ${originalRow}$` : `^Модель ${originalRow} //`));
    // Readonly totals are selectable/copyable and retain numeric zero.
    await shell.locator(`[data-timesheet-row="${originalRow - 1}"][data-timesheet-column="31"]`).click();
    await page.keyboard.press(columnShortcut);
    columns = (await copy(shell)).split("\n");
    assert.equal(columns.length, 1201); assert.equal(columns[0], kind === "workers" ? "Табель" : "Работа");
    assert.ok(columns.slice(1).every(value => value === "0"));
    assert.equal(await shell.locator('input[type="checkbox"]:checked').count(), 0);
    await page.keyboard.press("Escape");

    const trigger = shell.locator(kind === "workers" ? ".timesheet-employee-column .timesheet-header-filter" : ".equipment-machine-column .timesheet-header-filter");
    await trigger.click();
    const filter = page.locator(".ag-filter-menu");
    await filter.waitFor();
    // This community fixture filters identity keys; labels remain the visible copy values.
    await filter.locator('input:not([type="checkbox"])').first().fill("2");
    await filter.getByRole("button", { name: "Применить", exact: true }).click();
    await filter.waitFor({ state: "detached" });
    await cell(0).click(); await page.keyboard.press("Shift+Space");
    await page.keyboard.press("Shift+ArrowDown"); await page.keyboard.press("Shift+ArrowDown");
    const filtered = (await copy(shell)).split("\n");
    assert.equal(filtered.length, 3);
    for (const row of filtered) assert.match(row, kind === "workers" ? /Сотрудник \d*2\d*/ : /Модель \d*2\d*/);
    await shell.locator('[data-timesheet-row="0"][data-timesheet-column="-2"]').click();
    await page.keyboard.press(columnShortcut);
    const filteredColumn = (await copy(shell)).split("\n");
    assert.equal(filteredColumn.length, employees.filter(employee => String(employee.id).includes("2")).length + 1);
    assert.equal(filteredColumn[0], kind === "workers" ? "Сотрудник" : "Техника");
    for (const value of filteredColumn.slice(1)) assert.match(value, kind === "workers" ? /Сотрудник \d*2\d*/ : /Модель \d*2\d*/);
    if (kind === "workers") {
      await page.setViewportSize({ width: 1000, height: 954 });
      await page.waitForFunction(() => getComputedStyle(document.querySelector("thead .timesheet-position-column")).display === "none");
      await shell.locator('[data-timesheet-row="0"][data-timesheet-column="-2"]').click();
      await page.keyboard.press(columnShortcut); await page.keyboard.press("Shift+ArrowRight");
      assert.equal((await copy(shell)).split("\n")[0], "Сотрудник\t01.10.2026", "Narrow layouts skip hidden position column");
      await page.setViewportSize({ width: 1440, height: 954 });
    }
    console.log(`PASS ${kind}: whole rows/columns, 1200 virtual rows, Shift-click/arrows, headers, zeros, filtering and editor isolation`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log("PASS: no runtime errors or business writes");
} catch (error) {
  if (page) await page.screenshot({ path: "/private/tmp/timesheet-row-selection-failure.png" }).catch(() => {});
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
