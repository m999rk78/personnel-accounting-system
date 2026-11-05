// Actual worker timesheet and Excel preview; all records/API responses are synthetic.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { PERSONNEL_TIMESHEET_OPTIONS, isPersonnelTimesheetValue } from "../app/personnelTimesheetValues.ts";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const output = await mkdtemp(join(tmpdir(), "personnel-timesheet-values-"));
const config = { configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: output, emptyOutDir: false, rolldownOptions: { input: {
    table: fileURLToPath(new URL("../tests/fixtures/timesheet-batch-save.html", import.meta.url)),
    preview: fileURLToPath(new URL("../tests/fixtures/personnel-report-smoke.html", import.meta.url)),
  } } }, preview: { host: "127.0.0.1", port: 3157, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  const errors = [], writes = [], records = new Map();
  context.on("page", current => current.on("pageerror", error => errors.push(error.message)));
  page.on("pageerror", error => errors.push(error.message));
  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const employees = ["Иванов Иван", "Петров Пётр"].map((fullName, index) => ({ id: index + 1, fullName, employmentType: "ОПР", department: "МУТТ", position: "Монтажник", source: "manual", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
  const options = { shifts: [{ id: 1, name: "день" }], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [] };
  const previewHtml = await readFile(join(output, "personnel-report-smoke.html"), "utf8");
  await context.route("**/excel-preview?*", route => route.fulfill({ contentType: "text/html", body: previewHtml }));
  await context.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") {
      assert.equal(request.method(), "POST"); assert.equal(url.pathname, "/api/timesheet");
      const body = request.postDataJSON(); assert.equal(body.siteId, 1);
      const key = `${body.employeeId}:${body.workDate}`, value = String(body.value ?? "");
      writes.push(body);
      if (!value) { records.delete(key); return route.fulfill({ json: { deleted: true } }); }
      assert.ok(isPersonnelTimesheetValue(value), `Invalid value reached API: ${value}`);
      const numeric = /^\d+$/.test(value);
      const mark = { employeeId: body.employeeId, workDate: body.workDate, hours: numeric ? Number(value) : null, code: numeric ? null : value, note: body.note ?? "", updatedBy: "Проверка" };
      records.set(key, mark);
      return route.fulfill({ json: { mark } });
    }
    let body;
    if (url.pathname === "/api/table-order") body = { ids: [1, 2], canWrite: false, hasSavedOrder: false };
    else if (url.pathname === "/api/timesheet") body = { siteId: 1, siteName: sites[0].name, month: url.searchParams.get("month"), canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees, entries: [], marks: [...records.values()] };
    else {
      assert.equal(url.pathname, "/api/data");
      body = { sites, employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees, positionCatalog: [], employmentTypes: [{ id: 1, name: "ОПР" }], departments: [{ id: 1, name: "МУТТ" }], positions: [{ id: 1, name: "Монтажник" }], users: [], ...options, projectStats: [], bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } } };
    }
    return route.fulfill({ json: body });
  });
  const fixture = `http://127.0.0.1:3157/timesheet-batch-save.html?route=${encodeURIComponent("/timesheets/workers?month=2026-11")}`;
  const cell = column => page.locator(`[data-timesheet-row="0"][data-timesheet-column="${column}"]`);
  const value = column => cell(column).locator(".timesheet-cell-value");
  const record = column => records.get(`1:2026-11-${String(column + 1).padStart(2, "0")}`);
  const waitForValue = (column, text) => page.waitForFunction(({ column, text }) => document.querySelector(`[data-timesheet-row="0"][data-timesheet-column="${column}"] .timesheet-cell-value`)?.textContent === text, { column, text });
  const settled = () => page.waitForFunction(() => !document.querySelector(".timesheet-save-status[aria-busy='true']"));
  const paste = async (text, column = 0) => {
    await cell(column).click();
    await page.locator(".timesheet-grid-shell").evaluate((element, value) => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    }, text);
    await settled();
  };
  await page.goto(fixture); await cell(0).waitFor();
  await cell(0).click(); await cell(0).getByRole("button", { name: /Выбрать значение:/ }).click();
  const list = page.getByRole("listbox", { name: "Значение табеля", exact: true }); await list.waitFor();
  assert.deepEqual(await list.getByRole("option").allTextContents(), PERSONNEL_TIMESHEET_OPTIONS.map(option => option.label));
  const fitting = await list.getByRole("option").evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1));
  assert.ok(fitting, "Long reference descriptions wrap inside the menu");
  assert.equal(await list.getByRole("option", { name: "0 часов отработано", exact: true }).count(), 0);
  await list.getByRole("option", { name: "1 час отработан", exact: true }).click();
  await waitForValue(0, "1"); assert.equal(record(0).hours, 1); assert.equal(record(0).code, null);
  await page.goto(fixture); await waitForValue(0, "1");
  assert.equal(await value(1).innerText(), "");
  console.log("PASS: all 23 choices have reference order/descriptions; zero is absent and allowed hours survive reloading");

  // Native AG Grid set filtering must distinguish a saved value from an empty day.
  await page.getByRole("button", { name: "Фильтр и сортировка: 1 вс", exact: true }).click();
  const miniFilter = page.locator(".ag-set-filter .ag-mini-filter input").first(); await miniFilter.waitFor();
  await miniFilter.fill("1");
  await page.getByRole("button", { name: "Применить", exact: true }).last().click();
  await page.waitForFunction(() => document.querySelectorAll(".personnel-timesheet-table tbody tr[data-virtual-row]").length === 1);
  assert.match(await page.locator(".personnel-timesheet-table tbody").innerText(), /Иванов Иван/);
  await page.locator(".timesheet-header-filter-reset").click();
  await page.waitForFunction(() => document.querySelectorAll(".personnel-timesheet-table tbody tr[data-virtual-row]").length === 2);
  console.log("PASS: a saved hour value can be searched and applied in a date filter without including blank cells");

  const beforeZero = writes.length;
  await cell(1).click(); await page.keyboard.type("0");
  const zeroInput = cell(1).locator("input"); await zeroInput.press("Enter");
  await cell(1).locator(".timesheet-cell-inline-error").waitFor();
  assert.equal(await zeroInput.inputValue(), "0");
  assert.equal(await zeroInput.getAttribute("aria-invalid"), "true");
  assert.equal(writes.length, beforeZero, "Keyboard zero must be rejected before any API request");
  await zeroInput.press("Escape"); await zeroInput.waitFor({ state: "detached" });
  await paste("0", 1);
  await page.waitForFunction(() => document.querySelector('[data-timesheet-row="0"][data-timesheet-column="1"]')?.getAttribute("data-save-state") === "error");
  assert.equal(writes.length, beforeZero, "Pasted zero must be rejected before any API request");
  assert.equal(record(1), undefined);
  await cell(1).dblclick(); await cell(1).locator("input").fill("1");
  await cell(1).locator("input").press("Enter"); await waitForValue(1, "1");
  console.log("PASS: keyboard and pasted zero are rejected locally; correcting to an allowed hour removes the error");

  await cell(1).click(); await page.keyboard.press("Delete"); await waitForValue(1, "");
  assert.equal(record(1), undefined);
  await page.keyboard.press("ControlOrMeta+z"); await waitForValue(1, "1");
  assert.equal(record(1).hours, 1);
  console.log("PASS: clearing an allowed hour and undoing restores the saved value");

  const reference = PERSONNEL_TIMESHEET_OPTIONS.map(option => option.value);
  const before = writes.length;
  await paste(reference.join("\t"));
  await page.waitForFunction(() => document.querySelector(".timesheet-save-status")?.textContent?.includes("Сохранено ячеек: 23 из 23"));
  assert.equal(writes.length, before + 23);
  for (let index = 0; index < reference.length; index++) {
    assert.equal(await value(index).innerText(), reference[index]);
    const mark = record(index); assert.equal(String(mark.code ?? mark.hours), reference[index]);
  }
  assert.equal(record(23), undefined);
  console.log("PASS: pasting all 13 codes and 10 allowed hour values keeps each visible cell and saved value");

  await page.getByRole("button", { name: "Excel", exact: true }).click();
  const popupOpened = context.waitForEvent("page");
  await page.getByRole("menuitem", { name: "Экспорт в Excel", exact: true }).click();
  const popup = await popupOpened; popup.setDefaultTimeout(10_000);
  const previewDays = popup.locator(".excel-timesheet-preview-table tbody tr").first().locator(".excel-timesheet-day");
  await previewDays.first().waitFor();
  assert.deepEqual((await previewDays.allTextContents()).slice(0, 23), reference);
  assert.equal(await previewDays.nth(23).innerText(), "");
  const downloadStarted = popup.waitForEvent("download");
  await popup.getByRole("button", { name: "Скачать Excel", exact: true }).click();
  const download = await downloadStarted;
  const workbook = new TextDecoder().decode(await readFile(await download.path()));
  assert.match(workbook, /<c r="AA4"[^>]*><v>1<\/v><\/c>/);
  for (const code of reference.filter(value => !/^\d+$/.test(value))) assert.ok(workbook.includes(`>${code}</t>`), code);
  console.log("PASS: actual preview and downloaded Excel retain all codes, allowed hour values and blank days");
  await page.screenshot({ path: "/tmp/personnel-timesheet-values.png" });
  await popup.close();
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await server.httpServer.close(); }
