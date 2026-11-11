// Production table components with synthetic data and no database access.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = Number(process.argv[3] ?? 3168);
const fixtures = new URL("../tests/fixtures/", import.meta.url);
const pages = ["workspace-header.html", "report-filter-search.html", "unified-filters.html"];
const config = {
  configFile: false,
  envDir: false,
  publicDir: false,
  root: fileURLToPath(fixtures),
  logLevel: "warn",
  plugins: [react()],
  build: {
    outDir: await mkdtemp(join(tmpdir(), "filter-input-smoke-")),
    emptyOutDir: false,
    rolldownOptions: { input: pages.map(name => fileURLToPath(new URL(name, fixtures))) },
  },
  preview: { host: "127.0.0.1", port, strictPort: true },
};
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.setDefaultTimeout(8_000);
  const errors = [];
  const unexpectedRequests = [];
  page.on("pageerror", error => errors.push(error.message));

  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const positions = ["Boreal", "Bosco", "Delta"].map((name, index) => ({ id: index + 1, name }));
  const positionCatalog = positions.map(({ id, name }) => ({ id, employmentType: "ИТР", department: "Монтаж", position: name }));
  const employees = positionCatalog.map(item => ({
    ...item, fullName: `${item.position} Worker`, source: "manual", siteId: 1, siteName: sites[0].name,
    availabilityStatus: "active", bitrix24Stage: "", syncError: null,
  }));
  const data = {
    sites, employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees,
    positionCatalog, positions, employmentTypes: [{ id: 1, name: "ИТР" }], departments: [{ id: 1, name: "Монтаж" }],
    users: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], entries: [], filledDates: [],
    employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false, projectStats: [],
    bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } },
  };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (pathname === "/api/data") return route.fulfill({ json: data });
      if (pathname === "/api/table-order") return route.fulfill({ json: { ids: [], canWrite: false, hasSavedOrder: false } });
    }
    unexpectedRequests.push(`${request.method()} ${pathname}`);
    return route.fulfill({ status: 404, json: { error: "Этот API не подключён к стенду." } });
  });

  const base = `http://127.0.0.1:${port}`;
  const popup = page.locator(".ag-filter-menu:visible");
  async function expectCells(selector, count) {
    await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count, { selector, count });
  }
  async function typeThroughFilter(input, text, check) {
    await input.click();
    const original = await input.elementHandle();
    let typed = "";
    for (const char of text) {
      // Type into the focused control. Re-focusing it between characters would hide the regression.
      await page.keyboard.type(char);
      typed += char;
      await check?.(typed);
      assert.equal(await popup.count(), 1, `Filter closed after typing ${JSON.stringify(typed)}`);
      assert.equal(await original.evaluate(element => element === document.activeElement), true, `Filter lost focus after typing ${JSON.stringify(typed)}`);
      assert.equal(await original.inputValue(), typed);
    }
  }

  const checklistCases = [
    { route: "/settings/general/positions", heading: "Список должностей", column: "Должность", field: "position", match: "Boreal" },
    { route: "/settings/general/employees", heading: "Сотрудники", column: "ФИО", field: "fullName", match: "Boreal Worker" },
  ];
  for (const { route, heading, column, field, match } of checklistCases) {
    await page.goto(`${base}/workspace-header.html?route=${encodeURIComponent(route)}`);
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    const cells = `.page-content .ag-row .ag-cell[col-id="${field}"]`;
    await expectCells(cells, 3);
    const filter = page.getByRole("button", { name: `Фильтр: ${column}`, exact: true });
    await filter.click();
    const input = popup.getByRole("textbox", { name: "Поиск значений фильтра", exact: true });
    await typeThroughFilter(input, "bore", typed => expectCells(cells, typed.length < 3 ? 2 : 1));
    assert.equal(await filter.getAttribute("aria-expanded"), "true");
    assert.deepEqual(await page.locator(cells).allTextContents(), [match]);
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });
    await expectCells(cells, 1);
    console.log(`PASS: ${heading} keeps the live filter open and focused for every character`);
  }

  await page.goto(`${base}/report-filter-search.html`);
  for (const { report, column, query, count } of [
    { report: "Отчёт персонала", column: "ФИО", query: "иванов", count: 6 },
    { report: "Отчёт техники", column: "Статус", query: "подтвержд", count: 2 },
  ]) {
    await page.getByRole("button", { name: report, exact: true }).click();
    await page.getByRole("button", { name: `Фильтр: ${column}`, exact: true }).click();
    const input = popup.getByRole("textbox", { name: "Поиск значений фильтра", exact: true });
    await typeThroughFilter(input, query);
    const observation = page.locator(".report-filter-observation");
    const summary = JSON.parse(await observation.innerText());
    assert.equal(summary.rows, count, `${report} after typing ${query}: ${JSON.stringify(summary)}`);
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });
    console.log(`PASS: ${report} keeps Cyrillic input focused while filtering rows`);
  }

  await page.goto(`${base}/unified-filters.html`);
  for (const { screen, column, query, count } of [
    { screen: "Табель рабочих", column: "Сотрудник", query: "белов", count: 1 },
    { screen: "Табель техники", column: "Организация", query: "стройтехника", count: 2 },
  ]) {
    await page.getByRole("button", { name: screen, exact: true }).click();
    const rows = '.timesheet-grid-shell tbody th[scope="row"]';
    await expectCells(rows, 4);
    await page.getByRole("button", { name: `Фильтр: ${column}`, exact: true }).click();
    await typeThroughFilter(popup.getByRole("textbox", { name: "Поиск значений фильтра", exact: true }), query);
    await expectCells(rows, count);
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });
    console.log(`PASS: ${screen} keeps Cyrillic input focused while filtering rows`);
  }

  // The full filter still keeps a separate draft until its Apply action.
  await page.getByRole("button", { name: "AG Grid", exact: true }).click();
  const cells = '.unified-example-grid .ag-row .ag-cell[col-id="name"]';
  await expectCells(cells, 4);
  await page.getByRole("button", { name: "Фильтр: Сотрудник", exact: true }).press("Enter");
  await typeThroughFilter(popup.locator(".ag-mini-filter input"), "алекс", () => expectCells(cells, 4));
  await popup.getByRole("button", { name: "Применить", exact: true }).click();
  await popup.waitFor({ state: "hidden" });
  await expectCells(cells, 1);
  assert.match(await page.locator(cells).innerText(), /^Александров/);
  console.log("PASS: the full filter remains focused and only applies when requested");

  await page.goto(`${base}/unified-filters.html?many=1`);
  await page.getByRole("button", { name: "Фильтр: Сотрудник", exact: true }).click();
  const values = popup.getByRole("region", { name: "Значения фильтра", exact: true });
  await values.hover();
  const list = await values.elementHandle();
  const scrollTop = () => list.evaluate(element => element.scrollTop);
  const atEnd = element => element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
  const afterScroll = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.mouse.wheel(0, 50_000);
  await page.waitForFunction(atEnd, list);
  await afterScroll();
  const bottom = await scrollTop();
  assert.ok(bottom > 10_000, "The filter must contain a long scrollable list");
  await page.mouse.wheel(0, -68);
  await afterScroll();
  assert.ok(await scrollTop() < bottom - 1, "The first upward wheel movement must move the filter off the bottom");
  await afterScroll();
  assert.equal(await list.evaluate(atEnd), false, "The list must stay off the bottom after measurements finish");
  await page.mouse.wheel(0, 50_000);
  await page.waitForFunction(atEnd, list);
  await afterScroll();
  const stayedUp = await list.evaluate(element => new Promise(resolve => {
    const row = element.querySelector("[data-value]");
    // Deliver a reversal between a row resize and the next frame. A synthetic
    // wheel event has no default scrolling, so move the viewport as the wheel would.
    const resize = new ResizeObserver(() => {
      resize.disconnect();
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -96 }));
      element.scrollTop -= 96;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(element.scrollHeight - element.clientHeight - element.scrollTop > 1);
      }));
    });
    resize.observe(row);
    row.style.height = `${row.offsetHeight - 4}px`;
  }));
  assert.equal(stayedUp, true, "A row measurement queued at the bottom must not undo the user's upward scroll");
  await values.press("End");
  await page.waitForFunction(atEnd, list);
  await values.press("Home");
  await afterScroll();
  assert.equal(await scrollTop(), 0, "Home must return to the first value");
  console.log("PASS: reversing the wheel from the bottom moves the long filter on the first attempt; End and Home still work");

  assert.deepEqual(unexpectedRequests, []);
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
