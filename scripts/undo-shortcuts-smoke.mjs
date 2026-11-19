// Actual editors and histories, synthetic data only. All real API calls fail.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = Number(process.argv[3] ?? 3197);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid fixture port");
const fixture = name => fileURLToPath(new URL(`../tests/fixtures/${name}.html`, import.meta.url));
const config = { configFile: false, envDir: false, publicDir: false, logLevel: "warn", plugins: [react()],
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  build: { outDir: await mkdtemp(join(tmpdir(), "undo-shortcuts-")), emptyOutDir: false, rolldownOptions: { input: { undo: fixture("undo-shortcuts"), workTypes: fixture("work-types") } } },
  preview: { host: "127.0.0.1", port, strictPort: true } };
let browser, server, page, currentCase = "initialisation";
const errors = [], requests = [], checks = [];
try {
  await build(config);
  server = await preview(config);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => { requests.push(route.request().url()); return route.fulfill({ status: 500, json: { error: "No external API in this fixture" } }); });
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`http://127.0.0.1:${port}/undo-shortcuts.html`);
  const outside = () => page.locator("[data-outside]");
  const reportCell = field => page.locator(`.ag-row[row-id="draft-1"] .ag-cell[col-id="${field}"]`);
  const state = () => page.getByRole("status", { name: "Черновик отчёта" }).evaluate(element => JSON.parse(element.textContent));
  const waitNote = note => page.waitForFunction(value => JSON.parse(document.querySelector("output[aria-label='Черновик отчёта']").textContent).note === value, note);
  async function editNote(value) {
    await page.waitForFunction(() => {
      const viewport = document.querySelector(".ag-grid-viewport");
      if (!viewport) return false;
      viewport.scrollLeft = viewport.scrollWidth;
      return Boolean(document.querySelector('.ag-row[row-id="draft-1"] .ag-cell[col-id="note"]'));
    });
    await reportCell("note").waitFor();
    await reportCell("note").dblclick();
    await reportCell("note").locator("input").fill(value);
    await reportCell("note").locator("input").press("Enter");
    await waitNote(value);
  }
  for (const kind of ["personnel", "equipment"]) {
    currentCase = `${kind}: undo and redo after blur with both platforms and Russian layout`;
    if (kind === "equipment") await page.getByRole("button", { name: "Техника", exact: true }).click();
    await reportCell(kind === "personnel" ? "employeeName" : "equipment").waitFor();
    await editNote("Изменение один");
    await outside().click();
    await page.keyboard.press("Control+z"); await waitNote("Исходное примечание");
    await page.keyboard.press("Control+Shift+z"); await waitNote("Изменение один");
    await page.keyboard.press("Meta+z"); await waitNote("Исходное примечание");
    await page.keyboard.press("Control+y"); await waitNote("Изменение один");
    await outside().evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "я", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true })));
    await waitNote("Исходное примечание");
    await page.keyboard.press("Meta+Shift+z"); await waitNote("Изменение один");
    checks.push(currentCase);

    currentCase = `${kind}: native input undo leaves committed table history unchanged`;
    const input = page.getByRole("textbox", { name: "Заметка вне таблицы" });
    await input.fill(""); await input.pressSequentially("Нативная заметка");
    await input.press("ControlOrMeta+z");
    assert.equal((await state()).note, "Изменение один");
    assert.notEqual(await input.inputValue(), "Нативная заметка", "The browser handles text undo");
    checks.push(currentCase);

    currentCase = `${kind}: open select popup blocks underlying history even with focus elsewhere`;
    const primary = kind === "personnel" ? "employeeName" : "equipment";
    await reportCell(primary).dblclick();
    await page.locator(".custom-select-menu:visible").waitFor();
    await outside().focus(); await page.keyboard.press("Control+z");
    assert.equal((await state()).note, "Изменение один");
    await page.keyboard.press("Escape");
    await page.locator(".custom-select-menu:visible").waitFor({ state: "hidden" });
    checks.push(currentCase);
  }

  currentCase = "two catalog histories: only the last active grid is undone";
  await page.getByRole("button", { name: "Справочники", exact: true }).click();
  const catalogCell = name => page.locator(`[data-catalog="${name}"] .ag-row[row-id] .ag-cell[col-id="name"]`).first();
  for (const name of ["Альфа", "Бета"]) {
    await catalogCell(name).dblclick();
    await catalogCell(name).locator("input").fill(`Изменение ${name}`);
    await catalogCell(name).locator("input").press("Enter");
    await page.waitForFunction(({ name }) => document.querySelector(`[data-catalog="${name}"] .ag-cell[col-id="name"]`)?.textContent.includes(`Изменение ${name}`), { name });
  }
  await outside().click(); await page.keyboard.press("Control+z");
  await page.waitForFunction(() => document.querySelector('[data-catalog="Бета"] .ag-cell[col-id="name"]')?.textContent.includes("Исходное Бета"));
  assert.match(await catalogCell("Альфа").innerText(), /Изменение Альфа/);
  await catalogCell("Альфа").click(); await outside().click(); await page.keyboard.press("Meta+z");
  await page.waitForFunction(() => document.querySelector('[data-catalog="Альфа"] .ag-cell[col-id="name"]')?.textContent.includes("Исходное Альфа"));
  checks.push(currentCase);

  currentCase = "native WorkTypes master grid: one undo per keyboard event inside and outside the grid";
  await page.goto(`http://127.0.0.1:${port}/work-types.html`);
  const masterCell = page.locator('.work-types-master-grid .ag-row[row-id] .ag-cell[col-id="name"]').first();
  await masterCell.waitFor(); const original = await masterCell.innerText();
  await masterCell.dblclick(); await masterCell.locator("input").fill("Первое изменение вида"); await masterCell.locator("input").press("Enter");
  await page.waitForFunction(() => document.querySelector('.work-types-master-grid .ag-cell[col-id="name"]')?.textContent.includes("Первое изменение вида"));
  await masterCell.dblclick(); await masterCell.locator("input").fill("Второе изменение вида"); await masterCell.locator("input").press("Enter");
  await masterCell.locator("input").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector('.work-types-master-grid .ag-cell[col-id="name"]')?.textContent.includes("Второе изменение вида"));
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => document.querySelector('.work-types-master-grid .ag-cell[col-id="name"]')?.textContent.includes("Первое изменение вида"));
  assert.notEqual(await masterCell.innerText(), original);
  await page.keyboard.press("Control+y");
  await page.waitForFunction(() => document.querySelector('.work-types-master-grid .ag-cell[col-id="name"]')?.textContent.includes("Второе изменение вида"));
  await page.getByRole("heading", { level: 1 }).click();
  assert.match(await masterCell.innerText(), /Второе изменение вида/, "Moving focus outside must not change the edited value");
  await page.keyboard.press("Meta+z");
  await page.waitForFunction(() => document.querySelector('.work-types-master-grid .ag-cell[col-id="name"]')?.textContent.includes("Первое изменение вида"));
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForFunction(() => document.querySelector('.work-types-master-grid .ag-cell[col-id="name"]')?.textContent.includes("Второе изменение вида"));
  checks.push(currentCase);

  currentCase = "native WorkTypes detail history is not also undone by the master capture handler";
  await masterCell.locator(".ag-group-contracted").click();
  const detailCell = page.locator('.work-types-detail-grid .ag-row[row-id] .ag-cell[col-id="name"]').first();
  await detailCell.waitFor(); const originalDetail = await detailCell.innerText();
  await detailCell.dblclick(); await detailCell.locator("input").fill("Изменение подвидам"); await detailCell.locator("input").press("Enter");
  await page.waitForFunction(() => document.querySelector('.work-types-detail-grid .ag-cell[col-id="name"]')?.textContent.includes("Изменение подвидам"));
  await page.keyboard.press("Control+z");
  await page.waitForFunction(value => document.querySelector('.work-types-detail-grid .ag-cell[col-id="name"]')?.textContent.includes(value), originalDetail);
  assert.match(await masterCell.innerText(), /Второе изменение вида/, "The same event must not undo a second action in the parent history");
  checks.push(currentCase);
  assert.deepEqual(errors, [], "No browser errors"); assert.deepEqual(requests, [], "No real API requests");
  console.log(JSON.stringify({ checks, errors, apiRequests: requests.length }));
} catch (error) {
  console.error(`FAILED CASE ${currentCase}: ${String(error.message).slice(0, 1800)}`);
  if (page) await page.screenshot({ path: join(tmpdir(), "undo-shortcuts-failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
