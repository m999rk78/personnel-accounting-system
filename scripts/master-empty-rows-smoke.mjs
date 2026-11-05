// Real PersonnelApp; synthetic read-only API only. Never opens .env or a real DB.
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
  build: { outDir: await mkdtemp(join(tmpdir(), "master-empty-rows-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/workspace-header.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3153, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 843, height: 953 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  let count = 5;
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.testClipboard = "";
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText: async value => { window.testClipboard = value; }, readText: async () => window.testClipboard,
    } });
    window.open = url => { window.testExportUrl = String(url); return {}; };
  });
  await page.route("**/api/**", async route => {
    assert.equal(route.request().method(), "GET", "Visual empty rows must not write data");
    const url = new URL(route.request().url());
    if (url.pathname === "/api/table-order") { await route.fulfill({ json: { ids: [], canWrite: false, hasSavedOrder: false } }); return; }
    assert.equal(url.pathname, "/api/data");
    const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
    const employees = Array.from({ length: count }, (_, index) => ({ id: index + 1, fullName: `Мастер ${String(index + 1).padStart(3, "0")}`, employmentType: "ИТР", department: "МУТТ", position: "Прораб", source: "manual", siteId: 1, siteName: sites[0].name }));
    await route.fulfill({ json: { sites, employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees,
      masters: employees.map(employee => ({ id: employee.id, name: employee.fullName, employeeId: employee.id })),
      positionCatalog: [], positions: [], departments: [], employmentTypes: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], users: [],
      entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false } });
  });
  const grid = () => page.locator(".reference-section .ag-reference-grid");
  const body = () => grid().locator(".ag-grid-scrolling-rows");
  async function open() {
    await page.goto("http://127.0.0.1:3153/workspace-header.html?route=%2Fsettings%2Fproject%2Fmasters");
    await page.getByRole("heading", { name: "Мастера", exact: true }).waitFor();
    await page.waitForFunction(expected => document.querySelector(".employee-total-count strong")?.textContent === String(expected), count);
    await body().waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function rowCount() { return Number(await grid().locator("[aria-rowcount]").getAttribute("aria-rowcount")) - 1; }
  for (count of [0, 5, 100]) {
    await open();
    assert.equal(await rowCount(), count, "Only real rows are exposed to AG Grid and accessibility");
    assert.match(await body().evaluate(element => getComputedStyle(element).backgroundImage), /repeating-linear-gradient/, "Blank area has decorative horizontal grid lines");
    if (!count) {
      assert.equal(await grid().locator(".ag-row").count(), 0);
      console.log("PASS: empty table has lines and no records");
      continue;
    }
    // Clipboard boundary regression is relevant when blank rows are visible.
    // The long-table case below checks virtualization, scrolling and export.
    if (count === 5) {
      await grid().locator('.ag-row[row-index="0"] [col-id="name"]').click();
      const copied = await grid().locator('.ag-row[row-index="0"] [col-id="name"]').evaluate(element => {
        const clipboardData = new DataTransfer();
        element.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
        return clipboardData.getData("text/plain");
      });
      assert.equal(copied, "Мастер 001", "Copy includes only selected real cell");
    }
    await grid().locator(".ag-header-select-all input").check();
    await page.waitForFunction(expected => document.querySelector(".employee-selection-summary strong")?.textContent === String(expected), count);
    assert.equal(await page.locator(".employee-selection-summary strong").innerText(), String(count), "Select all never selects decorative rows");
    await page.getByRole("button", { name: "Снять выделение", exact: true }).click();
    await page.locator(".workspace-page-heading").getByRole("button", { name: "Excel", exact: true }).click();
    await page.getByRole("menuitem", { name: "Экспорт в Excel", exact: true }).click();
    const exported = await page.evaluate(async () => {
      const blob = new URLSearchParams(window.testExportUrl.split("?")[1]).get("payload");
      return await (await fetch(blob)).json();
    });
    assert.equal(exported.rows.length, count, "Export contains no synthetic rows");
    assert.equal(exported.rows[0][0], "Мастер 001");
    if (count === 5) {
      for (const viewport of [{ width: 843, height: 953 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        if (viewport.width < 680 && await page.getByRole("button", { name: "Свернуть меню", exact: true }).count()) await page.getByRole("button", { name: "Свернуть меню", exact: true }).click();
        assert.match(await body().evaluate(element => getComputedStyle(element).backgroundImage), /repeating-linear-gradient/);
        assert.equal(await rowCount(), 5);
        await page.screenshot({ path: `/tmp/master-empty-rows-${viewport.width}.png` });
      }
      const blankArea = await body().boundingBox();
      const lastRow = await grid().locator('.ag-row[row-index="4"]').boundingBox();
      if (blankArea.y + blankArea.height > lastRow.y + lastRow.height + 20) {
        await page.mouse.click(blankArea.x + 10, lastRow.y + lastRow.height + 15);
        assert.equal(await rowCount(), 5);
        assert.equal(await grid().locator(".editable-row").count(), 0, "Clicking decorative space does not edit or add records");
      }
      await page.setViewportSize({ width: 843, height: 953 });
    } else {
      await grid().locator(".ag-grid-viewport").evaluate(element => { element.scrollTop = element.scrollHeight; });
      await grid().locator('.ag-row[row-index="99"]').waitFor();
      assert.equal(await rowCount(), 100, "Long table scrolls normally without filler records");
    }
    console.log(`PASS: ${count} real rows, ${count === 5 ? "copy, " : ""}select-all, export, resize/scroll, no fake records`);
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await server.httpServer.close(); }
