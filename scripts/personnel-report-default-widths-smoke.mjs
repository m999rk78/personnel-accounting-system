// Real workspace and content sizing; only synthetic in-memory report APIs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PERSONNEL_REPORT_COLUMN_SIZING, personnelReportColumnWidths } from "../app/personnelReportColumnSizing.ts";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = 3165, base = `http://127.0.0.1:${port}`;
const fixture = spawn(process.execPath, [fileURLToPath(new URL("./personnel-report-smoke.mjs", import.meta.url)), "--scenario", "defaults", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
let browser, page, output = "";
const errors = [];
const poll = async (read, check, name) => {
  const deadline = Date.now() + 15_000; let actual;
  while (Date.now() < deadline) { actual = await read(); if (check(actual)) return actual; await new Promise(resolve => setTimeout(resolve, 70)); }
  throw new Error(`Timed out: ${name}. Actual: ${JSON.stringify(actual)}`);
};
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output}`)), 60_000);
    const capture = chunk => { output += chunk; if (output.includes(`${base}/`)) { clearTimeout(timer); resolve(); } };
    fixture.stdout.on("data", capture); fixture.stderr.on("data", capture);
    fixture.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); });
    fixture.once("error", error => { clearTimeout(timer); reject(error); });
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 3200, height: 953 } });
  page.setDefaultTimeout(12_000); page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  await page.goto(`${base}/personnel-report-smoke.html`);
  await page.waitForFunction(() => document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled === false);
  const tabs = page.getByRole("group", { name: "Показать отчёты" });
  assert.equal(await tabs.getByRole("button", { name: "Подтверждённые", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator('.personnel-history-table .ag-row [col-id="employeeName"]').count(), 0, "approved is empty while defaults must still use draft values");
  const reports = (await (await page.request.get(`${base}/api/personnel-report?siteId=1&all=true`)).json()).reports;
  const values = reports.flatMap(report => report.rows.map(row => ({ workDate: row.workDate.split("-").reverse().join("."), employeeName: row.employeeName,
    status: "Черновик", responsibleUserName: report.ownerName, employmentType: row.employmentType, department: row.department,
    position: row.positionSnapshot, shift: row.shiftName, zone: row.zoneName, mainWork: row.mainWorkTypeName,
    subwork: row.subworkTypeName, master: row.masterName, hours: row.hours, note: row.note })));
  assert.equal(values.length, 32);
  const requests = new Map();
  personnelReportColumnWidths(values, (text, bold) => { requests.set(`${bold ? "header" : "cell"}:${text}`, { text, bold }); return 0; });
  const measurements = await page.evaluate(items => {
    const context = document.createElement("canvas").getContext("2d"), family = getComputedStyle(document.querySelector(".personnel-history-grid")).fontFamily;
    return Object.fromEntries(items.map(({ text, bold }) => { context.font = `${bold ? 650 : 400} 13px ${family}`; return [`${bold ? "header" : "cell"}:${text}`, context.measureText(text).width]; }));
  }, [...requests.values()]);
  const expected = personnelReportColumnWidths(values, (text, bold) => measurements[`${bold ? "header" : "cell"}:${text}`]);
  const header = id => page.locator(`.personnel-history-grid .ag-header-cell[col-id="${id}"]`);
  const rawWidth = async id => Math.round((await header(id).boundingBox()).width);
  const scroll = () => page.locator('.personnel-history-grid [data-default-width-scroll="true"]');
  async function markScroll() {
    await page.locator(".personnel-history-grid").evaluate(root => {
      for (const element of root.querySelectorAll("[data-default-width-scroll]")) element.removeAttribute("data-default-width-scroll");
      const candidates = [...root.querySelectorAll("*")].filter(element => element instanceof HTMLElement && element.clientWidth > 100 && element.scrollWidth > element.clientWidth + 2 && ["auto", "scroll"].includes(getComputedStyle(element).overflowX));
      candidates.sort((left, right) => Number(right.classList.contains("ag-grid-viewport")) - Number(left.classList.contains("ag-grid-viewport")) || right.clientHeight - left.clientHeight);
      if (!candidates.length) throw new Error("Horizontal viewport not found");
      candidates[0].setAttribute("data-default-width-scroll", "true");
    });
  }
  async function reveal(id) {
    if (["employeeName", "workDate"].includes(id)) { await header(id).waitFor(); return; }
    await markScroll();
    const max = await scroll().evaluate(element => element.scrollWidth - element.clientWidth);
    for (let offset = 0; offset <= max + 300; offset += 250) {
      await scroll().evaluate((element, position) => { element.scrollLeft = position; }, Math.min(offset, max));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (await header(id).count()) {
        const box = await header(id).boundingBox(), left = (await header("employeeName").boundingBox());
        if (box && box.x >= left.x + left.width - 1 && box.x + box.width <= 3180) return;
      }
      if (offset >= max) break;
    }
    throw new Error(`Cannot reveal ${id}`);
  }
  const width = async id => { await reveal(id); return rawWidth(id); };
  for (const id of Object.keys(expected)) {
    await poll(() => width(id), actual => Math.abs(actual - expected[id]) <= 1, `${id} sized from complete content`);
    const readable = await header(id).locator(".ag-header-cell-text").evaluate(element => element.scrollWidth <= element.clientWidth + 1);
    assert.equal(readable, true, `${id}: header must be readable`);
  }
  assert.ok(expected.hours >= 84 && expected.hours <= 96);
  assert.ok(expected.employeeName > 280 && expected.mainWork > 240, "offscreen long values must expand initial defaults");
  const originalPreference = await page.evaluate(() => JSON.parse(localStorage.getItem("personnel-report-grid:v1:10:1") ?? "null"));
  assert.deepEqual(originalPreference?.widths ?? {}, {}, "automatic defaults are not manual preferences");
  await tabs.getByRole("button", { name: /^Черновик/ }).click();
  await page.locator('.ag-row [col-id="employeeName"]').first().waitFor();
  assert.equal(await page.getByText("Абдурахманов Магомед Магомедрасулович", { exact: true }).count(), 0, "longest employee is beyond visible rows");
  for (const id of ["employeeName", "position", "zone", "mainWork", "subwork", "master", "hours"]) assert.ok(Math.abs(await width(id) - expected[id]) <= 1);
  await reveal("note");
  await page.locator('.ag-row [col-id="note"]').first().dblclick();
  const note = page.getByRole("textbox", { name: "Примечание к отчёту", exact: true });
  await note.fill("Длинное новое примечание ".repeat(20)); await note.press("Enter");
  await page.waitForTimeout(150);
  assert.equal(await width("note"), expected.note, "editing must not move column boundaries");
  await tabs.getByRole("button", { name: "Подтверждённые", exact: true }).click();
  assert.equal(await width("mainWork"), expected.mainWork, "switching tabs keeps initialized widths");

  // An explicit smaller width always wins over the content-based default.
  const before = await width("employeeName"), handle = await header("employeeName").locator(".ag-header-cell-resize").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 230 - before, handle.y + handle.height / 2, { steps: 12 }); await page.mouse.up();
  await poll(() => rawWidth("employeeName"), actual => actual === 230, "manual smaller width");
  await page.reload();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled === false);
  await poll(() => rawWidth("employeeName"), actual => actual === 230, "manual width remains higher priority after reload");
  assert.ok((await width("hours")) <= PERSONNEL_REPORT_COLUMN_SIZING.hours.max);
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 1170, height: 953 });
  await page.screenshot({ path: "/private/tmp/personnel-report-default-widths-smoke.png", fullPage: true });
  console.log("PASS: all-row content sizing from an empty approved tab; readable headers and compact hours; offscreen values; stable editing/tabs; manual narrower width survives reload");
} catch (failure) {
  console.error((await page?.locator("body").innerText())?.slice(-12_000));
  await page?.screenshot({ path: "/private/tmp/personnel-report-default-widths-failure.png", fullPage: true });
  throw failure;
} finally { await browser?.close(); fixture.kill(); }
