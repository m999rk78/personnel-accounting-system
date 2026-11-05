// Real report grids, headless browser and synthetic local data only. No env/DB/API writes.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const config = { configFile: false, envDir: false, publicDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "report-column-widths-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/report-column-widths.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3146, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 3000, height: 950 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => { throw new Error(`No API requests expected: ${route.request().method()} ${route.request().url()}`); });
  await page.goto("http://127.0.0.1:3146/report-column-widths.html");
  const header = columnId => page.locator(`.ag-header-cell[col-id="${columnId}"]`);
  const width = async columnId => Math.round((await header(columnId).boundingBox()).width);
  async function resize(columnId, delta) {
    const handle = await header(columnId).locator(".ag-header-cell-resize").boundingBox();
    const before = await width(columnId);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 + delta, handle.y + handle.height / 2, { steps: 12 }); await page.mouse.up();
    const after = await width(columnId);
    assert.ok(after >= before + delta - 3, `${columnId} should expand (${before} -> ${after})`);
    return after;
  }
  async function assertWidths(expected, action) {
    // Let AG Grid finish applying newly supplied definitions and the flex layout.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const [columnId, wanted] of Object.entries(expected)) assert.equal(await width(columnId), wanted, `${action}: manual width of ${columnId}`);
  }
  for (const kind of ["personnel", "equipment"]) {
    await page.getByRole("button", { name: kind === "personnel" ? "Персонал" : "Техника", exact: true }).click();
    await header("zone").waitFor();
    const rowId = `${kind}-1`, expected = {};
    expected.zone = await resize("zone", 200);
    expected.mainWork = await resize("mainWork", 130);
    expected.workDate = await resize("workDate", 10);
    const primary = kind === "personnel" ? "employeeName" : "equipment";
    expected[primary] = await resize(primary, 25);
    const cell = field => page.locator(`.ag-row[row-id="${rowId}"] [col-id="${field}"]`);
    for (const zoneId of [2, 1, 2]) {
      await cell("zone").getByRole("button", { name: "Открыть список: Зона", exact: true }).click();
      await page.getByRole("listbox").waitFor();
      await assertWidths(expected, `${kind}: zone dropdown opened`);
      await page.getByRole("option", { name: zoneId === 1 ? "Зона оборудования — участок монтажа технологических трубопроводов" : "Зона металлоконструкций — участок сборки и установки оборудования", exact: true }).click();
      await page.waitForFunction(({ zoneId }) => JSON.parse(document.querySelector("output").textContent).rows[0].draft.zoneId === String(zoneId), { zoneId });
      await assertWidths(expected, `${kind}: zone changed`);
    }
    await cell("mainWork").dblclick(); await page.getByRole("listbox").waitFor();
    await assertWidths(expected, `${kind}: work editor opened`);
    await page.getByRole("option", { name: "Подготовка площадки и перемещение строительных материалов", exact: true }).click();
    await assertWidths(expected, `${kind}: main work changed`);
    await cell("hours").getByRole("button", { name: "Открыть список: Часы", exact: true }).click();
    await page.getByRole("option", { name: "9", exact: true }).click();
    await assertWidths(expected, `${kind}: hours changed`);
    await page.getByRole("button", { name: "Обновить данные", exact: true }).click();
    await assertWidths(expected, `${kind}: data/catalog refresh`);
    await page.screenshot({ path: `/tmp/report-column-widths-${kind}.png` });
    console.log(`PASS ${kind}: manually resized columns survive dropdown open/close, repeated zone changes, work/hour edits and data refresh`);
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await server.httpServer.close(); }
