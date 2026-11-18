// Real UI on an isolated Vite fixture, with every API request intercepted.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const fixtures = new URL("../tests/fixtures/", import.meta.url);
const config = {
  configFile: false, envDir: false, publicDir: false, root: fileURLToPath(fixtures), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "statistics-period-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("workspace-header.html", fixtures)) } },
  preview: { host: "127.0.0.1", port: 3181, strictPort: true },
};
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [], queries = [];
  let showSampleRows = false, showLongRange = false;
  const sampleDays = (kind) => kind === "equipment" ? [
    { workDate: "2026-11-02", welders: 0, installers: 0, other: 0, productive: 3, downtime: 1, total: 4 },
    { workDate: "2026-11-04", welders: 0, installers: 0, other: 0, productive: 8, downtime: 2, total: 10 },
  ] : [
    { workDate: "2026-11-02", welders: 2, installers: 2, other: 1, productive: 0, downtime: 0, total: 5 },
    { workDate: "2026-11-04", welders: 6, installers: 4, other: 2, productive: 0, downtime: 0, total: 12 },
  ];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    assert.equal(request.method(), "GET");
    const url = new URL(request.url());
    if (url.pathname === "/api/statistics") {
      const query = Object.fromEntries(url.searchParams);
      queries.push(query);
      const sample = sampleDays(query.kind);
      const historicalDays = showLongRange ? Array.from(Array(35).keys(), index => ({
        ...sample[0], workDate: new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10),
      })) : [];
      const days = showSampleRows ? [...historicalDays, ...sample].filter(({ workDate }) => query.period === "all" || workDate >= query.from && workDate <= query.to) : [];
      const rows = query.groupBy === "day" ? days : days.length ? [
        days.reduce((zone, day) => {
          for (const key of ["welders", "installers", "other", "productive", "downtime", "total"]) zone[key] += day[key];
          return zone;
        }, { zoneId: 9, zone: "Учебная зона", welders: 0, installers: 0, other: 0, productive: 0, downtime: 0, total: 0 }),
      ] : [];
      return route.fulfill({ json: { rows } });
    }
    assert.equal(url.pathname, "/api/data");
    return route.fulfill({ json: { sites: [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }] } });
  });
  const picker = page.getByRole("button", { name: "Период статистики", exact: true });
  const from = page.getByRole("textbox", { name: "Дата начала периода", exact: true });
  const to = page.getByRole("textbox", { name: "Дата окончания периода", exact: true });
  const toCalendar = page.getByRole("button", { name: "Дата окончания периода: выбрать в календаре" });
  const calendar = page.getByRole("dialog", { name: "Дата окончания периода: выбрать в календаре" });
  const choose = async name => {
    await picker.click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  const idle = () => page.getByText("За выбранный период нет подтверждённых отчётов.", { exact: true }).waitFor();
  const check = async (kind, period) => { await idle(); assert.deepEqual(queries.at(-1), { siteId: "1", kind, ...period }); };
  const grouping = page.getByRole("tablist", { name: "Группировка статистики" });
  const byZone = grouping.getByRole("tab", { name: "По зонам", exact: true });
  const byDay = grouping.getByRole("tab", { name: "По дням", exact: true });
  await page.goto("http://127.0.0.1:3181/workspace-header.html?route=%2Fstatistics%2Fworkers");
  await check("personnel", { from: "2026-11-01", to: "2026-11-04" });
  assert.equal(await picker.innerText(), "Текущий месяц");
  await choose("Текущая неделя");
  await check("personnel", { from: "2026-11-02", to: "2026-11-04" });
  assert.equal(await from.count(), 0);
  await choose("Прошлый месяц");
  await check("personnel", { from: "2026-10-01", to: "2026-10-31" });
  await choose("За весь период");
  await check("personnel", { period: "all" });

  await choose("Свой период…");
  await check("personnel", { from: "2026-11-01", to: "2026-11-04" });
  assert.equal(await from.inputValue(), "01.11.2026");
  await from.fill("03112026"); await from.press("Enter");
  await check("personnel", { from: "2026-11-03", to: "2026-11-04" });
  assert.equal(await from.inputValue(), "03.11.2026");

  await toCalendar.click();
  await calendar.getByRole("button", { name: "04.11.2026", exact: true }).press("ArrowLeft");
  await page.keyboard.press("Enter");
  await calendar.waitFor({ state: "hidden" });
  await check("personnel", { from: "2026-11-03", to: "2026-11-03" });
  assert.equal(await to.inputValue(), "03.11.2026");

  const count = queries.length;
  await to.fill("02.11.2026"); await to.press("Enter");
  await page.getByRole("alert").filter({ hasText: "Дата окончания" }).waitFor();
  assert.equal(queries.length, count, "An invalid range never triggers a request");
  await to.fill("06.11.2026"); await to.press("Tab");
  await check("personnel", { from: "2026-11-03", to: "2026-11-06" });

  await toCalendar.click(); await calendar.waitFor();
  await page.keyboard.press("Escape"); await calendar.waitFor({ state: "hidden" });
  assert.equal(await toCalendar.evaluate(button => document.activeElement === button), true);
  assert.equal(await to.inputValue(), "06.11.2026");
  await picker.click();
  const menu = page.getByRole("listbox", { name: "Период статистики" });
  await menu.waitFor(); await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
  assert.equal(await picker.innerText(), "Свой период…");
  if (process.env.STATISTICS_PERIOD_QA_SCREENSHOT) await page.screenshot({ path: process.env.STATISTICS_PERIOD_QA_SCREENSHOT, fullPage: true });

  await page.getByRole("tab", { name: "Техника" }).click();
  await check("equipment", { from: "2026-11-03", to: "2026-11-06" });
  await choose("За весь период");
  await check("equipment", { period: "all" });
  await choose("Свой период…");
  await check("equipment", { from: "2026-11-03", to: "2026-11-06" });

  showSampleRows = true;
  const week = { from: "2026-11-02", to: "2026-11-04" };
  const zoneData = page.getByRole("region", { name: "Данные по зонам", exact: true });
  const dayData = page.getByRole("region", { name: "Данные по дням", exact: true });
  async function checkDay(kind, period) {
    await dayData.getByRole("columnheader", { name: "Дата", exact: true }).waitFor();
    await dayData.getByRole("columnheader", { name: kind === "personnel" ? "Сварщики" : "Простой", exact: true }).waitFor();
    await dayData.getByRole("gridcell", { name: "04.11.2026", exact: true }).waitFor();
    const dates = await dayData.getByRole("gridcell", { name: /^\d{2}\.\d{2}\.\d{4}$/ }).allTextContents();
    assert.deepEqual(dates, ["02.11.2026", "04.11.2026"], "Dates are displayed in chronological order even when later totals are larger");
    await page.getByRole("heading", { name: "Часы по дням", exact: true }).waitFor();
    await page.getByRole("region", { name: "Столбчатый график часов по дням" }).locator("canvas").first().waitFor();
    assert.equal(await page.locator(".statistics-total-all dd").innerText(), kind === "personnel" ? "17 ч" : "14 ч");
    assert.equal(await byDay.getAttribute("aria-selected"), "true");
    assert.deepEqual(queries.at(-1), { siteId: "1", kind, ...period, groupBy: "day" });
  }
  assert.equal(await byZone.getAttribute("aria-selected"), "true");
  await choose("Текущая неделя");
  await zoneData.getByRole("gridcell", { name: "Учебная зона", exact: true }).waitFor();
  await byZone.press("ArrowRight");
  await checkDay("equipment", week);
  assert.equal(await picker.innerText(), "Текущая неделя");
  await page.getByRole("tab", { name: "Персонал", exact: true }).click();
  await checkDay("personnel", week);
  await choose("За весь период");
  await checkDay("personnel", { period: "all" });
  await byZone.click();
  await zoneData.getByRole("gridcell", { name: "Учебная зона", exact: true }).waitFor();
  assert.deepEqual(queries.at(-1), { siteId: "1", kind: "personnel", period: "all" });

  await choose("Прошлый месяц");
  await check("personnel", { from: "2026-10-01", to: "2026-10-31" });
  await byDay.click();
  await idle();
  assert.equal(await byDay.getAttribute("aria-selected"), "true");
  assert.deepEqual(queries.at(-1), { siteId: "1", kind: "personnel", from: "2026-10-01", to: "2026-10-31", groupBy: "day" });
  await byZone.click();
  await check("personnel", { from: "2026-10-01", to: "2026-10-31" });

  showLongRange = true;
  await byDay.click();
  await idle();
  await choose("За весь период");
  await dayData.getByRole("gridcell", { name: "01.07.2026", exact: true }).waitFor();
  const scrollableGrid = dayData.locator(".ag-grid-viewport");
  await page.waitForFunction(() => {
    const body = document.querySelector(".statistics-grid-scroll .ag-grid-viewport");
    return body && body.scrollHeight > body.clientHeight;
  });
  assert.equal(await dayData.getByRole("gridcell", { name: "04.11.2026", exact: true }).count(), 0, "Long periods do not render all rows at once");
  await scrollableGrid.evaluate(body => { body.scrollTop = body.scrollHeight; });
  await dayData.getByRole("gridcell", { name: "04.11.2026", exact: true }).waitFor();
  await byZone.click();
  await choose("Свой период…");

  await page.setViewportSize({ width: 375, height: 760 });
  const [left, right] = await Promise.all([from.boundingBox(), to.boundingBox()]);
  assert.ok(left && right && left.width >= 65 && right.width >= 65 && left.x >= 0 && right.x + right.width <= 375, "Both dates fit on a narrow viewport");
  const groupTabs = await grouping.boundingBox();
  assert.ok(groupTabs && groupTabs.x >= 0 && groupTabs.x + groupTabs.width <= 375, "Both grouping options fit on a narrow viewport");
  await toCalendar.click(); await calendar.waitFor();
  const popup = await calendar.boundingBox();
  assert.ok(popup && popup.x >= 0 && popup.x + popup.width <= 375 && popup.y >= 0 && popup.y + popup.height <= 760, "Calendar fits the viewport");
  assert.deepEqual(errors, []);
  console.log("PASS: both statistics kinds, day and zone grouping, charts and grids, all presets, current range reuse, manual dates, calendar, validation, Escape and narrow layout.");
} finally {
  await browser?.close();
  await server.httpServer.close();
}
