// Exercise the real workspace with in-memory APIs only; no environment files or work database.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = 3167, base = `http://127.0.0.1:${port}`;
const fixture = spawn(process.execPath, [fileURLToPath(new URL("./personnel-report-smoke.mjs", import.meta.url)), "--scenario", "defaults", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
let browser, page, output = "", expandRows = false;
const errors = [];
const poll = async (read, check, label) => {
  const deadline = Date.now() + 15_000; let actual;
  while (Date.now() < deadline) { actual = await read(); if (check(actual)) return actual; await new Promise(resolve => setTimeout(resolve, 70)); }
  throw new Error(`Timed out: ${label}. Actual: ${JSON.stringify(actual)}`);
};
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output}`)), 60_000);
    const capture = chunk => { output += chunk; if (output.includes(`${base}/`)) { clearTimeout(timer); resolve(); } };
    fixture.stdout.on("data", capture); fixture.stderr.on("data", capture);
    fixture.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); });
    fixture.once("error", error => { clearTimeout(timer); reject(error); });
  });
  browser = await chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  page = await browser.newPage({ viewport: { width: 1170, height: 953 } });
  page.setDefaultTimeout(12_000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  // Inflate GET responses in this browser only; fixture defaults and saved reports stay unchanged.
  await page.route("**/api/personnel-report?*", async route => {
    if (!expandRows || route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(), payload = await response.json();
    const seed = payload.reports.find(report => report.status === "draft" && report.rows.length);
    if (seed) payload.reports = Array.from({ length: 32 }, (_, reportIndex) => {
      const workDate = new Date(Date.UTC(2026, 9, 28 - reportIndex)).toISOString().slice(0, 10), id = 10_000 + reportIndex;
      return { ...seed, id, workDate, rows: seed.rows.map((row, rowIndex) => ({ ...row, id: 1_000_000 + reportIndex * seed.rows.length + rowIndex, reportId: id, workDate })) };
    });
    await route.fulfill({ response, json: payload });
  });
  await page.goto(`${base}/personnel-report-smoke.html`);
  await page.waitForFunction(() => document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled === false);
  const stage = page.locator(".personnel-report-page-scroll-stage");
  const frame = page.locator(".personnel-report-page-scroll-frame");
  const viewport = page.locator(".personnel-history-grid .ag-grid-viewport");
  const horizontal = page.locator('[data-table-page-horizontal]');
  const tabs = page.getByRole("group", { name: "Показать отчёты" });
  const geometry = () => page.evaluate(() => {
    const stage = document.querySelector(".personnel-report-page-scroll-stage"), frame = document.querySelector(".personnel-report-page-scroll-frame");
    const view = document.querySelector(".personnel-history-grid .ag-grid-viewport"), grid = document.querySelector(".personnel-history-grid");
    const header = grid.querySelector(".ag-header"), footer = document.querySelector(".personnel-history-footer");
    const bar = document.querySelector('[data-table-page-horizontal]'), doc = document.scrollingElement;
    const bounds = element => { const rect = element.getBoundingClientRect(); return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }; };
    return { y: window.scrollY, pageMax: Math.max(0, doc.scrollHeight - window.innerHeight), pageXMax: doc.scrollWidth - window.innerWidth,
      innerHeight: window.innerHeight, stage: bounds(stage), frame: bounds(frame), grid: bounds(grid), header: bounds(header), footer: bounds(footer),
      framePosition: getComputedStyle(frame).position, viewportOverflowY: getComputedStyle(view).overflowY,
      top: view.scrollTop, maxTop: view.scrollHeight - view.clientHeight, left: view.scrollLeft, maxLeft: view.scrollWidth - view.clientWidth,
      externalLeft: bar?.scrollLeft ?? 0, externalMax: bar ? bar.scrollWidth - bar.clientWidth : 0,
      barVisible: Boolean(bar && !bar.hidden && getComputedStyle(bar).display !== "none"), barPosition: bar ? getComputedStyle(bar).position : null,
      bar: bar ? bounds(bar) : null, verticalTracks: document.querySelectorAll('[data-personnel-external-scroll="vertical"]').length,
      rows: [...new Set([...grid.querySelectorAll(".ag-row[row-id]")].map(row => row.getAttribute("row-id")))] };
  });
  const synchronizedX = value => Math.abs(value.left - value.externalLeft) <= 1 && Math.abs(value.maxLeft - value.externalMax) <= 1;
  const settle = async () => {
    let previous = "", since = Date.now();
    return poll(geometry, value => {
      const positions = JSON.stringify([value.y, value.top, value.left, value.externalLeft, value.pageMax]);
      if (previous !== positions || !synchronizedX(value)) { previous = positions; since = Date.now(); return false; }
      return Date.now() - since >= 180;
    }, "page and grid scrolling settle together");
  };
  const scrollPage = async where => {
    await page.evaluate(where => window.scrollTo(0, where === "end" ? document.scrollingElement.scrollHeight : where), where);
    return settle();
  };
  const scrollX = async offset => {
    await horizontal.evaluate((element, offset) => { element.scrollLeft = Math.min(offset, element.scrollWidth - element.clientWidth); }, offset);
    return poll(geometry, value => synchronizedX(value) && Math.abs(value.left - Math.min(offset, value.maxLeft)) <= 1, "horizontal control moves the grid");
  };
  const assertSticky = value => {
    assert.equal(value.framePosition, "sticky");
    assert.ok(value.header.top >= -1 && value.header.top <= 3, `header remains at page top: ${value.header.top}`);
    assert.ok(value.footer.top >= value.header.bottom && value.footer.bottom <= value.innerHeight - 8 + 1, "save/add footer stays visible above the bottom scrollbar");
  };
  const pinnedBounds = () => page.locator('.personnel-history-grid .ag-header-cell[col-id="employeeName"], .personnel-history-grid .ag-header-cell[col-id="workDate"]').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.getAttribute("col-id"), { x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width }])));
  const selection = () => page.locator(".personnel-history-grid .ag-excel-selected").evaluateAll(elements => elements.map(element => `${element.closest(".ag-row")?.getAttribute("row-id")}:${element.getAttribute("col-id")}`).sort());

  await page.getByText("Нет подтверждённых отчётов", { exact: true }).waitFor();
  await stage.waitFor(); await frame.waitFor();
  await tabs.getByRole("button", { name: /^Черновик/ }).click();
  await page.locator('.ag-row [col-id="employeeName"]').first().waitFor();
  const initial = await poll(geometry, value => value.pageMax > 300 && value.maxTop > 300 && value.barVisible && synchronizedX(value), "document owns the personnel rows' scroll range");
  await poll(() => page.locator(".ag-overlay-message:visible").count(), count => count === 0, "populated rows clear the empty-state overlay");
  assert.equal(initial.viewportOverflowY, "hidden", "the grid does not own an independent wheel-scrollable Y viewport");
  assert.equal(initial.verticalTracks, 0, "there is no duplicate vertical rail beside the grid");
  assert.ok(Math.abs(initial.stage.width - initial.frame.width) <= 1 && Math.abs(initial.frame.width - initial.grid.width) <= 1, "the stage and grid use all available width without a right-hand scrollbar gutter");
  assert.ok(initial.pageXMax <= 1, "wide columns do not add document horizontal overflow");
  assert.equal(initial.barPosition, "fixed");
  assert.ok(initial.bar.bottom <= initial.innerHeight + 1 && initial.bar.bottom >= initial.innerHeight - 1, "horizontal scrollbar lives at the page bottom");
  assert.ok(Math.abs(initial.bar.left - initial.grid.left) <= 1 && Math.abs(initial.bar.width - initial.grid.width) <= 1, "bottom scrollbar follows the physical table bounds");

  await page.locator('.personnel-history-grid .ag-header-cell[col-id="employeeName"]').hover();
  await page.mouse.wheel(0, 120);
  const headerWheel = await settle();
  assert.ok(headerWheel.y >= 100 && headerWheel.y <= 140, "wheel over the column header uses the document without jumping past the page heading");
  await scrollPage(0);

  // Real wheel input over the page margin and over rows must move the same document host.
  await page.mouse.move(1167, 400); await page.mouse.wheel(0, 240);
  await poll(geometry, value => value.y > initial.y + 100, "wheel outside the table scrolls the page");
  await settle();
  const outsideWheel = await geometry(), viewBox = await viewport.boundingBox();
  await viewport.hover({ position: { x: Math.min(viewBox.width - 30, 300), y: Math.min(viewBox.height - 20, 130) } });
  await page.mouse.wheel(0, 240);
  await poll(geometry, value => value.y > outsideWheel.y + 100 && value.top > outsideWheel.top + 100, "wheel over a row scrolls the document and virtualized rows together");
  assertSticky(await settle());
  await scrollPage("end");
  const end = await poll(geometry, value => value.pageMax - value.y <= 2 && value.maxTop - value.top <= 2, "page end exposes the final row");
  assertSticky(end);
  const lastEmployee = page.getByText("Абдурахманов Магомед Магомедрасулович", { exact: true });
  await lastEmployee.waitFor();
  const lastBounds = await lastEmployee.boundingBox();
  assert.ok(lastBounds.y >= end.header.bottom - 1 && lastBounds.y + lastBounds.height <= end.footer.top + 1, "the final employee is visible above the footer");

  // Spreadsheet edge navigation calls ensureIndexVisible; the document must follow it.
  await scrollPage(0);
  await page.locator('.ag-row [col-id="employeeName"]').first().click();
  await poll(selection, values => values.length > 0, "a spreadsheet cell is selected");
  const beforeKeyboard = await geometry();
  await page.keyboard.press("Control+ArrowDown");
  await poll(geometry, value => value.y > beforeKeyboard.y + 200 && value.maxTop - value.top <= 2, "keyboard edge navigation updates the document scroll position");
  await settle();
  await page.keyboard.press("Control+ArrowUp");
  await poll(geometry, value => value.top <= 1, "keyboard navigation returns to the first virtual row");
  await settle();
  const selected = await poll(selection, values => values.length > 0, "keyboard navigation keeps a spreadsheet cell selected");
  const pinned = await pinnedBounds(), barBox = await horizontal.boundingBox();
  await horizontal.click({ position: { x: barBox.width - 5, y: barBox.height / 2 } });
  await poll(geometry, value => synchronizedX(value) && value.left > 1, "native bottom-track pointer input scrolls the columns");
  await settle();
  assert.deepEqual(await selection(), selected, "horizontal scrollbar input preserves spreadsheet selection");
  assert.deepEqual(await pinnedBounds(), pinned, "date and employee columns remain pinned while center columns scroll");
  await scrollX(0);
  await viewport.evaluate(element => { element.scrollLeft = 100; });
  await poll(geometry, value => synchronizedX(value) && Math.abs(value.left - 100) <= 1, "native grid horizontal scroll updates the page-bottom track");
  const beforeHorizontalWheel = await geometry();
  await viewport.hover({ position: { x: Math.min(viewBox.width - 30, 300), y: 100 } });
  await page.mouse.wheel(190, 0);
  await poll(geometry, value => synchronizedX(value) && value.left > beforeHorizontalWheel.left + 40, "horizontal wheel input remains available");
  await settle();
  await scrollX(Number.MAX_SAFE_INTEGER);
  await page.locator('.personnel-history-grid .ag-header-cell[col-id="note"]').waitFor();
  await page.locator('.ag-row [col-id="note"]').first().waitFor();

  await page.setViewportSize({ width: 843, height: 953 });
  await poll(geometry, value => synchronizedX(value) && value.pageXMax <= 1 && value.barVisible && Math.abs(value.bar.width - value.grid.width) <= 1, "narrow page recalculates the bottom horizontal track");
  await scrollPage("end");
  assertSticky(await settle());
  await page.screenshot({ path: "/private/tmp/personnel-report-page-scroll-843.png", fullPage: false });
  await page.setViewportSize({ width: 1170, height: 953 });
  await scrollX(0);
  await scrollPage(0);
  await tabs.getByRole("button", { name: "Подтверждённые", exact: true }).click();
  await page.getByText("Нет подтверждённых отчётов", { exact: true }).waitFor();
  await poll(geometry, value => value.top <= 1 && value.pageMax <= 2 && value.y <= 1 && synchronizedX(value), "empty reports release the long document spacer and clamp page scroll");
  const empty = await geometry();
  assert.ok(empty.grid.height > 400, "an empty table still fills the working viewport");
  assert.ok(empty.barVisible, "empty rows do not disable horizontal access to overflowing columns");

  // 32 daily reports × 32 rows verify the document scroll does not render the full history.
  expandRows = true;
  await page.reload();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled === false);
  await tabs.getByRole("button", { name: /^Черновик/ }).click();
  await page.locator(".personnel-history-summary > strong").filter({ hasText: "Строк: 1024" }).waitFor();
  const largeTop = await poll(geometry, value => value.pageMax > 30_000 && value.rows.length > 0 && value.rows.length < 100, "large history remains virtualized at the top");
  await poll(() => page.locator(".ag-overlay-message:visible").count(), count => count === 0, "large populated history clears the previous empty-tab overlay");
  await scrollPage(largeTop.pageMax / 2);
  const largeMiddle = await geometry();
  assert.ok(largeMiddle.rows.length > 0 && largeMiddle.rows.length < 100, "middle of large history renders only nearby rows");
  assert.notDeepEqual(largeMiddle.rows, largeTop.rows, "page scrolling replaces virtual rows");
  assertSticky(largeMiddle);
  await scrollPage("end");
  const largeEnd = await poll(geometry, value => value.maxTop - value.top <= 2 && value.rows.length > 0 && value.rows.length < 100, "large history stays virtualized through its final row");
  assert.notDeepEqual(largeEnd.rows, largeMiddle.rows);
  assertSticky(largeEnd);
  await page.screenshot({ path: "/private/tmp/personnel-report-page-scroll-large.png", fullPage: false });
  assert.deepEqual(errors, []);
  console.log("PASS: real document wheel scrolling inside/outside the grid; sticky header and save footer; keyboard visibility; fixed horizontal pointer/wheel synchronization; pinned columns and selection; narrow/empty layouts; 1,024 virtualized rows");
} catch (failure) {
  console.error((await page?.locator("body").innerText())?.slice(-12_000));
  await page?.screenshot({ path: "/private/tmp/personnel-report-page-scroll-failure.png", fullPage: false });
  throw failure;
} finally { await browser?.close(); fixture.kill(); }
