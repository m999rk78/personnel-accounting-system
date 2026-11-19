// Real table components, synthetic fixture data and no production API access.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = Number(process.argv[3] ?? 3199);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Укажите корректный порт стенда.");
const fixture = name => fileURLToPath(new URL(`../tests/fixtures/${name}.html`, import.meta.url));
const config = {
  configFile: false, envDir: false, publicDir: false, logLevel: "warn",
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "compact-cell-editors-")), emptyOutDir: false,
    rolldownOptions: { input: { reports: fixture("report-column-widths"), workTypes: fixture("work-types") } } },
  preview: { host: "127.0.0.1", port, strictPort: true },
};
let server, browser, page, currentCase = "initialisation";
const errors = [], apiRequests = [], checks = [];
try {
  await build(config);
  server = await preview(config);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    apiRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: "No real API is available in this isolated fixture." } });
  });
  const reportCell = (kind, field) => page.locator(`.ag-row[row-id="${kind}-1"] .ag-cell[col-id="${field}"]`);
  async function openReportCell(kind, field) {
    if (field === "note") {
      await reportCell(kind, kind === "personnel" ? "employeeName" : "equipment").waitFor();
      await page.waitForFunction(({ kind, field }) => {
        const viewport = document.querySelector(".ag-grid-viewport");
        if (!viewport) return false;
        viewport.scrollLeft = viewport.scrollWidth;
        return Boolean(document.querySelector(`.ag-row[row-id="${kind}-1"] .ag-cell[col-id="${field}"]`));
      }, { kind, field });
    }
    const cell = reportCell(kind, field);
    await cell.scrollIntoViewIfNeeded();
    await cell.dblclick();
    await cell.locator(".ag-cell-editor-host").waitFor();
    return cell;
  }
  async function singleFrame(cell, control) {
    const dimensions = await control.evaluate(input => {
      const cell = input.closest(".ag-cell");
      const layers = [];
      for (let element = input; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        const visible = color => color !== "transparent" && color !== "rgba(0, 0, 0, 0)";
        const border = ["Top", "Right", "Bottom", "Left"].some(side =>
          Number.parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== "none" && visible(style[`border${side}Color`]));
        const shadow = style.boxShadow !== "none";
        const outline = Number.parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== "none" && visible(style.outlineColor);
        if (border || shadow || outline) layers.push({ className: element.className, border, shadow, outline, borderColor: style.borderColor });
        if (element === cell) break;
      }
      return { layers, height: input.getBoundingClientRect().height, rowHeight: cell.getBoundingClientRect().height };
    });
    assert.equal(dimensions.layers.length, 1, `${currentCase}: exactly one visible frame, not nested borders: ${JSON.stringify(dimensions.layers)}`);
    assert.ok(dimensions.height <= 30.5 && dimensions.height >= 24, `${currentCase}: compact control height ${dimensions.height}`);
    assert.ok(dimensions.height < dimensions.rowHeight, `${currentCase}: editor stays inside its row`);
    assert.equal(await cell.locator("input, textarea, .custom-select-toggle").count(), 1, `${currentCase}: only one cell editor control`);
  }
  async function selectionIsThin(cell) {
    await page.waitForFunction(() => document.querySelector(".ag-cell.ag-excel-selected"));
    const borders = await cell.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
    });
    assert.deepEqual(borders, ["1px", "1px", "1px", "1px"], `${currentCase}: selection border stays one pixel`);
  }
  const reportState = () => page.locator("output").evaluate(element => JSON.parse(element.textContent).rows[0].draft);
  await page.goto(`http://127.0.0.1:${port}/report-column-widths.html`);
  await page.addStyleTag({ content: await readFile(new URL("../app/personnelReport.css", import.meta.url), "utf8") });
  await page.locator("main").evaluate(element => element.classList.add("personnel-report-workspace"));
  for (const kind of ["personnel", "equipment"]) {
    currentCase = `${kind}: compact text editor, commit and cancel`;
    if (kind === "equipment") await page.getByRole("button", { name: "Техника", exact: true }).click();
    const noteCell = await openReportCell(kind, "note");
    const editor = noteCell.locator("input");
    if (kind === "personnel") await page.screenshot({ path: "/private/tmp/compact-cell-editor-qa.png", fullPage: true });
    await singleFrame(noteCell, editor);
    await editor.fill(`Проверка ${kind}`);
    await editor.press("Enter");
    await noteCell.locator(".ag-cell-editor-host").waitFor({ state: "hidden" });
    assert.equal((await reportState()).note, `Проверка ${kind}`);
    await selectionIsThin(noteCell);
    await openReportCell(kind, "note");
    await editor.fill("Отменённое изменение");
    await editor.press("Escape");
    await noteCell.locator(".ag-cell-editor-host").waitFor({ state: "hidden" });
    assert.equal((await reportState()).note, `Проверка ${kind}`);
    checks.push(currentCase);

    currentCase = `${kind}: compact select trigger, search and keyboard choice`;
    const target = kind === "personnel" ? "employeeName" : "equipment";
    const selectCell = reportCell(kind, target);
    await selectCell.getByRole("button", { name: kind === "personnel" ? "Открыть список: ФИО" : "Открыть список: Техника", exact: true }).click();
    const menu = page.locator(".custom-select-menu:visible");
    await menu.waitFor();
    await singleFrame(selectCell, selectCell.locator(".custom-select-toggle"));
    const label = kind === "personnel" ? "Проверяемый сотрудник" : "Тестовая модель // ТЕСТ-001";
    await menu.getByRole("searchbox").fill(kind === "personnel" ? "Проверяемый" : "ТЕСТ-001");
    await menu.getByRole("option", { name: label, exact: true }).waitFor();
    await menu.getByRole("searchbox").press("Enter");
    await menu.waitFor({ state: "hidden" });
    await selectionIsThin(selectCell);
    checks.push(currentCase);
  }

  currentCase = "Timesheet: thin selection and one inline editor frame";
  await page.addStyleTag({ content: await readFile(new URL("../app/timesheetSelection.css", import.meta.url), "utf8") });
  await page.evaluate(() => {
    const table = document.createElement("table");
    table.className = "timesheet-table";
    table.dataset.testid = "compact-timesheet";
    table.innerHTML = '<tbody><tr><td style="position:relative;width:90px;height:44px" class="timesheet-cell-selected timesheet-cell-selection-top timesheet-cell-selection-right timesheet-cell-selection-bottom timesheet-cell-selection-left">8</td></tr></tbody>';
    document.body.append(table);
  });
  const timesheetCell = page.locator("[data-testid='compact-timesheet'] td");
  const shadows = await timesheetCell.evaluate(element => getComputedStyle(element).boxShadow);
  assert.match(shadows, /1px/, "Timesheet selected edges are one pixel");
  assert.doesNotMatch(shadows, /(?:^|\s)-?2px(?:\s|,|$)/, "No two-pixel selection edges remain");
  await timesheetCell.evaluate(element => { element.innerHTML = '<div class="timesheet-cell-inline-editor"><input aria-label="Тестовый табель" value="8"></div>'; });
  await timesheetCell.locator("input").focus();
  const timesheetFrames = await timesheetCell.evaluate(cell => {
    const wrapper = cell.querySelector(".timesheet-cell-inline-editor");
    const input = wrapper.querySelector("input");
    return { cellShadow: getComputedStyle(cell).boxShadow, cellOutline: getComputedStyle(cell).outlineStyle,
      wrapperShadow: getComputedStyle(wrapper).boxShadow, wrapperBorder: getComputedStyle(wrapper).borderTopWidth,
      wrapperHeight: wrapper.getBoundingClientRect().height, inputBorder: getComputedStyle(input).borderTopWidth,
      inputShadow: getComputedStyle(input).boxShadow, inputOutline: getComputedStyle(input).outlineStyle };
  });
  assert.equal(timesheetFrames.cellShadow, "none");
  assert.equal(timesheetFrames.cellOutline, "none");
  assert.equal(timesheetFrames.wrapperBorder, "1px");
  assert.equal(timesheetFrames.wrapperShadow, "none");
  assert.ok(timesheetFrames.wrapperHeight <= 30.5);
  assert.equal(timesheetFrames.inputBorder, "0px");
  assert.equal(timesheetFrames.inputShadow, "none");
  assert.equal(timesheetFrames.inputOutline, "none");
  checks.push(currentCase);

  currentCase = "Native AG Grid text editor: compact border and Escape";
  await page.goto(`http://127.0.0.1:${port}/work-types.html`);
  const nativeCell = page.locator(".work-types-master-grid .ag-row[row-id] .ag-cell[col-id='name']").first();
  await nativeCell.waitFor();
  const originalName = await nativeCell.innerText();
  await nativeCell.dblclick();
  const nativeEditor = nativeCell.locator("input");
  await nativeEditor.waitFor();
  await singleFrame(nativeCell, nativeEditor);
  await nativeEditor.fill("Отменённый вид работы");
  await nativeEditor.press("Escape");
  await nativeEditor.waitFor({ state: "hidden" });
  assert.equal(await nativeCell.innerText(), originalName);
  checks.push(currentCase);
  assert.deepEqual(errors, [], "No browser runtime errors");
  assert.deepEqual(apiRequests, [], "No production API requests");
  console.log(JSON.stringify({ checks, runtimeErrors: errors.length, apiRequests: apiRequests.length }));
} catch (error) {
  console.error(`FAILED CASE ${currentCase}: ${String(error.message).slice(0, 1800)}`);
  if (page) {
    const screenshot = join(tmpdir(), "compact-cell-editors-failure.png");
    await page.screenshot({ path: screenshot }).catch(() => {});
    console.error(`FAILURE SCREENSHOT ${screenshot}`);
  }
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
