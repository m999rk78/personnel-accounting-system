// Real table components and synthetic data only. No env, credentials or database.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { parseSpreadsheetText } from "../app/spreadsheetClipboard.ts";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = Number(process.argv[3] ?? 3190), base = `http://127.0.0.1:${port}`;
const fixture = name => fileURLToPath(new URL(`../tests/fixtures/${name}.html`, import.meta.url));
const config = { configFile: false, envDir: false, publicDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()], logLevel: "error",
  build: { outDir: await mkdtemp(join(tmpdir(), "table-select-all-")), emptyOutDir: false, rolldownOptions: { input: ["grid-editing", "work-types", "index", "excel-preview-selection"].map(fixture) } },
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
    if (request.method() !== "GET") { writes.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 405, json: { error: "Проверка копирования не изменяет данные" } }); }
    if (url.pathname === "/api/timesheet") return route.fulfill({ json: { siteId: 1, siteName: "Изолированный проект", month: "2026-10", employees, entries: [], marks: [], canEdit: true, canCreate: true, canUpdate: true, canDelete: true } });
    if (url.pathname === "/api/equipment") return route.fulfill({ json: { siteId: 1, siteName: "Изолированный проект", month: "2026-10", workDate: "2026-10-21", units, sites: [], entries: [], marks: [], dailyTimesheetMarks: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], foremanProgress: [], filledDates: [], currentUserRole: "superadmin", currentUserName: "Проверка", canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true } });
    return route.fulfill({ status: 404, json: { error: "Неизвестный запрос изолированного стенда" } });
  });
  const copy = async root => {
    const value = await root.evaluate(element => {
      const clipboardData = new DataTransfer();
      const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
      element.dispatchEvent(event);
      return { text: clipboardData.getData("text/plain"), handled: event.defaultPrevented };
    });
    assert.equal(value.handled, true, "Application owns the selected table's copy event");
    return parseSpreadsheetText(value.text);
  };

  await page.goto(`${base}/grid-editing.html?selection&enterprise`);
  const grid = page.locator(".localized-grid-body").first();
  await grid.locator('.ag-row [col-id="name"]').first().click();
  await page.keyboard.press("ControlOrMeta+a");
  let data = await copy(grid);
  assert.equal(data.length, 3); assert.ok(data[0].join(" ").includes("Зоны"));
  assert.deepEqual(data.slice(1).map(row => row.at(-1)), ["Исходная зона", "Вторая зона"]);
  assert.equal(await grid.locator('.ag-row input[type="checkbox"]:checked').count(), 0, "Cell select-all never changes destructive row selection");
  const text = page.getByRole("textbox", { name: "Проверка копирования" });
  await text.fill("ABCDEF"); await text.press("ControlOrMeta+a");
  assert.deepEqual(await text.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, 6]);
  console.log("PASS generic AG: header+data copy, row-checkbox isolation, text input retains native select-all");

  await page.goto(`${base}/work-types.html?selection`);
  await page.getByRole("combobox", { name: "Тестовые данные" }).selectOption("large");
  const master = page.locator(".work-types-master-grid");
  await master.locator('.ag-row [col-id="name"]').first().click();
  await page.keyboard.press("ControlOrMeta+a");
  data = await copy(master);
  assert.equal(data.length, 502, "500 virtual parents, unassigned parent and column headers are copied");
  assert.equal(data[0][0], "Вид работы");
  assert.ok(await master.locator('.ag-row:not(.ag-full-width-row)').count() < 100, "Copy includes unmounted virtual rows");
  await master.locator(".ag-group-contracted").first().click();
  const detail = page.locator(".work-types-detail-grid").first();
  await detail.locator('.ag-row [col-id="name"]').first().click();
  await page.keyboard.press("ControlOrMeta+a");
  const detailData = await copy(detail);
  assert.equal(detailData[0][0], "Подвид работы");
  assert.ok(detailData.length > 80, "A nested detail copies all its virtual child rows");
  assert.ok(detailData.length < 200, "A nested detail never copies every parent's children");
  assert.equal(detailData.some(row => row.includes("Вид работы")), false, "Detail selection does not inherit the parent's header");
  console.log(`PASS work types: 500 virtual parents and ${detailData.length - 1} nested children copied in independent scopes`);

  await page.goto(`${base}/index.html`);
  for (const kind of ["workers", "equipment"]) {
    if (kind === "equipment") await page.getByRole("button", { name: "Техника (1000)", exact: true }).click();
    const shell = page.locator(kind === "workers" ? ".personnel-timesheet-table" : ".equipment-month-table").locator("xpath=..");
    const first = shell.locator('tbody tr[data-virtual-row] [data-timesheet-column="0"]').first();
    await first.waitFor(); await first.click(); await page.keyboard.press("ControlOrMeta+a");
    data = await copy(shell);
    assert.equal(data.length, 1201, "All filtered virtual rows and headers are copied");
    assert.ok(data[0].includes(kind === "workers" ? "Сотрудник" : "Техника"));
    assert.ok(data[0].includes("01.10.2026"));
    assert.equal(data[1][0], "1"); assert.equal(data.at(-1)[0], "1200");
    assert.ok(await shell.locator("tbody tr[data-virtual-row]").count() < 100);
    console.log(`PASS ${kind}: full table with identity and totals columns, headers and 1200 virtual records`);
  }
  await page.goto(`${base}/excel-preview-selection.html`);
  const preview = page.locator(".excel-preview-table-wrap");
  await preview.locator("tbody td").first().click(); await page.keyboard.press("ControlOrMeta+a");
  const previewData = await copy(preview);
  assert.equal(previewData.length, 3); assert.deepEqual(previewData[0], ["№", "ФИО", "Часы"]);
  assert.equal(previewData.at(-1).at(-1), "0", "Historical zero and display data remain intact during copying");
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log("PASS Excel preview select-all; no browser runtime errors or business writes");
} catch (error) {
  if (page) await page.screenshot({ path: "/private/tmp/table-select-all-failure.png" }).catch(() => {});
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
