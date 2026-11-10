// Real report grids and synthetic React state only. No .env, DB or real API.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = Number(process.argv[3] ?? 3198);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Укажите корректный порт стенда.");
const outDir = await mkdtemp(join(tmpdir(), "report-select-editors-"));
const config = { configFile: false, envDir: false, publicDir: false, logLevel: "warn",
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir, emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/report-column-widths.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port, strictPort: true } };
let server, browser, page, currentCase = "initialisation";
try {
  await build(config);
  server = await preview(config);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [], apiRequests = [], checks = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    apiRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: "В изолированном стенде API отключён." } });
  });
  await page.addInitScript(() => localStorage.clear());
  const cell = (kind, columnId) => page.locator(`.ag-row[row-id="${kind}-1"] .ag-cell[col-id="${columnId}"]`);
  const viewport = () => page.locator(".ag-grid-viewport");
  const popup = () => page.locator(".custom-select-menu:visible");
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function selected(columnId) {
    await page.waitForFunction(column => {
      const selected = [...document.querySelectorAll(".ag-cell.ag-excel-selected")].map(element => element.getAttribute("col-id"));
      return selected.length === 1 && selected[0] === column;
    }, columnId);
  }
  async function revealAndSelect(kind, columnId) {
    const primary = kind === "equipment" ? "equipment" : "employeeName";
    const max = await viewport().evaluate(element => element.scrollWidth - element.clientWidth);
    // Move only the real table viewport. A pinned editor remains reachable while
    // the previously selected unpinned column is visible beside it.
    for (let left = 0; left <= max + 200; left += 200) {
      await viewport().evaluate((element, value) => { element.scrollLeft = value; }, Math.min(left, max));
      await frames();
      if (!await cell(kind, columnId).count()) continue;
      const [bounds, pinned, grid] = await Promise.all([
        cell(kind, columnId).boundingBox(), cell(kind, primary).boundingBox(), viewport().boundingBox(),
      ]);
      if (!bounds || !pinned || !grid) continue;
      const visibleLeft = Math.max(bounds.x, columnId === primary ? grid.x : pinned.x + pinned.width);
      const visibleRight = Math.min(bounds.x + bounds.width, grid.x + grid.width);
      if (visibleRight - visibleLeft < 50) continue;
      await page.mouse.click((visibleLeft + visibleRight) / 2, bounds.y + bounds.height / 2);
      await selected(columnId);
      return;
    }
    throw new Error(`Не удалось показать и выбрать ${kind}.${columnId}`);
  }
  async function geometry() {
    await frames();
    return page.evaluate(() => ({
      scrollLeft: document.querySelector(".ag-grid-viewport").scrollLeft,
      windowY: window.scrollY,
      widths: Object.fromEntries([...document.querySelectorAll(".ag-header-cell[col-id]")].map(element => [element.getAttribute("col-id"), element.getBoundingClientRect().width])),
    }));
  }
  async function unchanged(before, label) {
    const after = await geometry();
    assert.ok(Math.abs(after.scrollLeft - before.scrollLeft) <= 1, `${label}: horizontal scroll changed ${before.scrollLeft} → ${after.scrollLeft}`);
    assert.ok(Math.abs(after.windowY - before.windowY) <= 1, `${label}: page scroll changed`);
    for (const [columnId, width] of Object.entries(before.widths)) {
      assert.ok(Math.abs(after.widths[columnId] - width) <= 1, `${label}: ${columnId} width changed ${width} → ${after.widths[columnId]}`);
    }
  }
  async function open(kind, columnId, name, keyboard = false) {
    const trigger = cell(kind, columnId).getByRole("button", { name: `Открыть список: ${name}`, exact: true });
    if (keyboard) {
      await trigger.focus();
      await trigger.press("Enter");
    } else await trigger.click();
    await popup().waitFor();
    await popup().getByRole("searchbox").waitFor();
    await frames();
  }
  async function finishEquipment(before, label) {
    await popup().waitFor({ state: "hidden" });
    await selected("equipment");
    await unchanged(before, label);
    await page.keyboard.press("ArrowRight");
    await selected("status");
  }
  const equipmentLabel = "Тестовая модель // ТЕСТ-001";
  for (const width of [939, 2200]) {
    currentCase = `equipment ${width}px`;
    await page.setViewportSize({ width, height: 950 });
    await page.goto(`http://127.0.0.1:${port}/report-column-widths.html`);
    await page.getByRole("button", { name: "Техника", exact: true }).click();
    await cell("equipment", "equipment").waitFor();
    await revealAndSelect("equipment", "model");
    let before = await geometry();
    await open("equipment", "equipment", "Техника");
    assert.deepEqual(await popup().getByRole("option").allTextContents(), ["Выберите технику", equipmentLabel], "Equipment choices show only model // GRZ");
    for (const query of ["Кран", "Тестовая марка", "Тестовая организация", "Тестовая модель", "ТЕСТ-001"]) {
      await popup().getByRole("searchbox").fill(query);
      await popup().getByRole("option", { name: equipmentLabel, exact: true }).waitFor();
      assert.equal(await popup().getByRole("option").count(), 1, `Equipment search: ${query}`);
    }
    await popup().getByRole("option", { name: equipmentLabel, exact: true }).click();
    await finishEquipment(before, `${currentCase}: mouse choice`);

    await revealAndSelect("equipment", "model");
    before = await geometry();
    await open("equipment", "equipment", "Техника", true);
    await popup().getByRole("searchbox").fill("Тестовая марка");
    await popup().getByRole("option", { name: equipmentLabel, exact: true }).waitFor();
    await popup().getByRole("searchbox").press("Enter");
    await finishEquipment(before, `${currentCase}: keyboard choice`);
    checks.push(currentCase);
    console.log(`PASS ${currentCase}: exact labels, hidden search, keyboard/mouse activation and choice, equipment origin, widths/scroll and ArrowRight`);

    currentCase = `personnel ${width}px`;
    await page.getByRole("button", { name: "Персонал", exact: true }).click();
    await cell("personnel", "employeeName").waitFor();
    await revealAndSelect("personnel", "shift");
    // Zone is next to Shift; expose its button without changing the selected cell.
    await cell("personnel", "zone").getByRole("button", { name: "Открыть список: Зона", exact: true }).scrollIntoViewIfNeeded();
    before = await geometry();
    await open("personnel", "zone", "Зона");
    await popup().getByRole("option", { name: "Зона металлоконструкций — участок сборки и установки оборудования", exact: true }).click();
    await popup().waitFor({ state: "hidden" });
    await selected("zone");
    await unchanged(before, currentCase);
    await page.waitForFunction(() => JSON.parse(document.querySelector("output").textContent).rows[0].draft.zoneId === "2");
    checks.push(currentCase);
    console.log(`PASS ${currentCase}: previous cell → Zone chevron → choice retains Zone selection and geometry`);
  }
  assert.deepEqual(errors, [], "No browser runtime errors");
  assert.deepEqual(apiRequests, [], "No API requests");
  console.log(JSON.stringify({ checks, runtimeErrors: errors.length, apiRequests: apiRequests.length }));
} catch (error) {
  console.error(`FAILED CASE ${currentCase}: ${String(error.message).slice(0, 1800)}`);
  if (page) {
    const screenshot = join(tmpdir(), "report-select-editors-failure.png");
    await page.screenshot({ path: screenshot }).catch(() => {});
    console.error(`FAILURE SCREENSHOT ${screenshot}`);
  }
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await rm(outDir, { recursive: true, force: true });
}
