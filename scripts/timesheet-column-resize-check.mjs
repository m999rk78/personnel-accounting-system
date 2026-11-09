// Real application + synthetic actor/data. Every API is intercepted; no .env/DB.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const menusOnly = process.argv.includes("--menus-only");
const args = process.argv.slice(2).filter(argument => argument !== "--menus-only");
const { chromium } = await import(args[0] ? `${args[0]}/index.mjs` : "playwright");
const port = Number(args[1] ?? 3171);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Укажите корректный порт стенда.");
const config = { configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "timesheet-column-resize-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/timesheet-batch-save.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 953 } });
  page.setDefaultTimeout(12_000);
  const errors = [], writes = [];
  page.on("pageerror", error => errors.push(error.message));
  let rowCount = 4;
  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const employees = () => Array.from({ length: rowCount }, (_, index) => ({ id: index + 1,
    fullName: `Сотрудник ${String(index + 1).padStart(5, "0")} с длинным именем`, employmentType: "ИТР", department: "МУТТ",
    position: "Руководитель монтажного участка", source: "manual", siteId: 1, siteName: sites[0].name,
    availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
  const units = () => employees().map(({ id }) => ({ id, name: `Кран ${id}`, equipmentType: "Кран", brand: "Учебная марка",
    model: `Модель ${id}`, registrationNumber: `ТЕСТ${id}`, inventoryNumber: `TEST-${id}`, organization: "Учебная организация",
    siteId: 1, siteName: sites[0].name, availabilityStatus: "active", unavailableFrom: null, note: "" }));
  const options = { shifts: [{ id: 1, name: "день" }], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [] };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 405, json: { error: "Изменение ширины не должно менять данные." } });
    }
    let body;
    if (url.pathname === "/api/table-order") body = { ids: [], canWrite: false, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report")) body = { reports: [], entries: [], canReview: true, availabilityMarks: [], from: null, to: null };
    else if (url.pathname === "/api/timesheet") body = { siteId: 1, siteName: sites[0].name, month: url.searchParams.get("month"),
      canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees: employees(), entries: [], marks: [] };
    else if (url.pathname === "/api/equipment") body = { siteId: 1, siteName: sites[0].name, workDate: "2026-11-05", month: url.searchParams.get("month"),
      canEditDaily: true, canCreateDaily: true, canUpdateDaily: true, canDeleteDaily: true, canEditTimesheet: true,
      canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, canManageRegistry: true,
      canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true, canManageAssignments: true,
      canCreateAssignments: true, canUpdateAssignments: true, canDeleteAssignments: true,
      currentUserRole: "superadmin", currentUserName: "Проверка ширин", reportSubmitted: false, foremanProgress: [],
      units: units(), availableUnits: units(), sites, entries: [], marks: [], dailyTimesheetMarks: [], filledDates: [], ...options };
    else if (url.pathname === "/api/roles") body = { roles: [], canManage: true };
    else {
      assert.equal(url.pathname, "/api/data", `Неожиданный API: ${url.pathname}`);
      body = { sites, employees: employees(), projectEmployees: employees(), placementEmployees: employees(), reportEmployees: employees(),
        positionCatalog: [], employmentTypes: [{ id: 1, name: "ИТР" }], departments: [{ id: 1, name: "МУТТ" }],
        positions: [{ id: 1, name: "Руководитель монтажного участка" }], users: [], ...options,
        entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false,
        projectStats: [], bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } } };
    }
    await route.fulfill({ json: body });
  });

  const table = () => page.locator("table.timesheet-resizable");
  const shell = () => page.locator(".timesheet-grid-shell").filter({ has: table() });
  const grip = selector => table().locator(`thead ${selector} .timesheet-column-resize-handle[data-resize-edge="right"]`);
  const mainGrip = kind => grip(kind === "workers" ? ".timesheet-employee-column" : ".equipment-machine-column");
  const dayGrip = day => table().locator("thead tr:nth-child(2) th").nth(day - 1).locator('.timesheet-column-resize-handle[data-resize-edge="right"]');
  const totalGrip = kind => grip(kind === "workers" ? ".timesheet-difference-total" : ".equipment-all-total");
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const width = handle => handle.evaluate(element => element.closest("th").getBoundingClientRect().width);
  const near = (actual, expected, label, tolerance = 1.6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} !== ${expected}`);

  async function open(kind, month = "2026-11") {
    const path = `/timesheets/${kind}?month=${month}`;
    await page.goto(`http://127.0.0.1:${port}/timesheet-batch-save.html?route=${encodeURIComponent(path)}`);
    await table().waitFor();
    await page.waitForFunction(() => document.querySelector(".timesheet-grid-shell")?.getAttribute("aria-busy") !== "true");
    await mainGrip(kind).waitFor();
    await frames();
  }

  async function drag(handle, delta, { finish = true } = {}) {
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, "A visible resize hit target is required");
    const x = box.x + box.width / 2, y = box.y + Math.min(18, box.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 12 });
    if (finish) await page.mouse.up();
    await frames();
  }

  async function geometry(label, { checkTail = false } = {}) {
    await settleLayout();
    await frames();
    const result = await table().evaluate(table => {
      const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; };
      const visible = element => getComputedStyle(element).display !== "none";
      const shell = table.closest(".timesheet-grid-shell");
      const first = [...table.tHead.rows[0].cells], days = [...table.tHead.rows[1].cells].filter(visible);
      const leaf = first.flatMap(cell => cell.colSpan > 1 ? days : visible(cell) ? [cell] : []);
      const sticky = leaf.filter(cell => cell.classList.contains("timesheet-sticky"));
      const body = table.querySelector("tbody tr[data-virtual-row]");
      const bodyCells = body ? [...body.cells].filter(visible) : [];
      const footer = table.tFoot?.rows[0];
      const footerCells = footer ? [...footer.cells].filter(visible) : [];
      const filler = table.querySelector(".timesheet-fill-row > td, tbody > tr > td[data-empty-column-boundaries]");
      const left = shell.getBoundingClientRect().left + shell.clientLeft, right = left + shell.clientWidth;
      const pinnedRight = Math.max(left, ...sticky.map(cell => box(cell).right));
      const expectedEdges = leaf.filter(cell => cell.classList.contains("timesheet-sticky") || box(cell).right > pinnedRight + .5)
        .map(cell => box(cell).right).filter(edge => edge > left + 1 && edge < right - 1);
      const paintedEdges = filler?.dataset.emptyColumnBoundaries
        ? JSON.parse(filler.dataset.emptyColumnBoundaries).map(edge => box(filler).left + edge).filter(edge => edge > left + 1 && edge < right - 1) : [];
      return { table: box(table), colCount: table.querySelectorAll("colgroup col").length,
        headers: leaf.map(box), sticky: sticky.map(box), days: days.map(box), dayGroup: box(first.find(cell => cell.colSpan > 1)),
        body: bodyCells.map(box), footer: footerCells.map(box), summarySpan: footerCells[0]?.colSpan,
        expectedEdges, paintedEdges, left, right, scrollWidth: shell.scrollWidth, scrollLeft: shell.scrollLeft,
        clientWidth: shell.clientWidth, realRowCount: table.querySelectorAll("tbody tr[data-virtual-row]").length };
    });
    assert.equal(result.colCount, result.headers.length, `${label}: colgroup has exactly the visible leaf columns`);
    near(result.table.width, result.headers.reduce((sum, cell) => sum + cell.width, 0), `${label}: table is the sum of its columns`);
    near(result.dayGroup.width, result.days.reduce((sum, cell) => sum + cell.width, 0), `${label}: month group spans every day precisely`);
    let stickyLeft = result.left;
    result.sticky.forEach((cell, index) => { near(cell.left, stickyLeft, `${label}: cumulative sticky offset ${index}`); stickyLeft += cell.width; });
    if (result.body.length) {
      assert.equal(result.body.length, result.headers.length, `${label}: data cells match leaf headers`);
      result.body.forEach((cell, index) => {
        near(cell.width, result.headers[index].width, `${label}: body width ${index}`);
        near(cell.left, result.headers[index].left, `${label}: body left ${index}`);
        near(cell.height, 46, `${label}: virtual row height stays fixed`);
      });
    }
    if (result.footer.length) {
      assert.equal(result.summarySpan, result.sticky.length, `${label}: footer span accounts for hidden position column`);
      near(result.footer[0].width, result.sticky.reduce((sum, cell) => sum + cell.width, 0), `${label}: summary tracks metadata width`);
      result.footer.slice(1).forEach((cell, index) => {
        const header = result.headers[result.sticky.length + index];
        near(cell.width, header.width, `${label}: footer width ${index}`);
        near(cell.left, header.left, `${label}: footer left ${index}`);
      });
    }
    for (const edge of result.expectedEdges) assert.ok(result.paintedEdges.some(actual => Math.abs(actual - edge) <= 1.6), `${label}: decorative line follows ${edge}: ${result.paintedEdges}`);
    for (const edge of result.paintedEdges) assert.ok(result.expectedEdges.some(actual => Math.abs(actual - edge) <= 1.6), `${label}: no stale decorative line at ${edge}`);
    assert.ok(result.scrollWidth <= Math.ceil(result.table.width) + 2, `${label}: no extra scrollable blank area`);
    if (checkTail) near(result.table.right, result.right, `${label}: maximum scroll ends at the actual table edge`);
    return result;
  }

  async function settleLayout() {
    // The real app animates sidebar/workspace width at responsive breakpoints.
    // Wait for that layout transition before asserting an exact scroll endpoint.
    await shell().evaluate(element => new Promise(resolve => {
      let previous = "", stable = 0;
      const check = () => {
        const table = element.querySelector("table");
        const key = `${element.clientWidth}:${element.getBoundingClientRect().left}:${table.getBoundingClientRect().width}:${table.style.cssText}`;
        stable = key === previous ? stable + 1 : 0;
        previous = key;
        if (stable >= 8) resolve(); else requestAnimationFrame(check);
      };
      check();
    }));
  }
  async function maxScroll(label) {
    await settleLayout();
    await shell().evaluate(element => { element.scrollLeft = element.scrollWidth; });
    return geometry(label, { checkTail: true });
  }
  async function noDragCursor(label) {
    const cursors = await page.evaluate(() => [document.body, document.documentElement].map(element => getComputedStyle(element).cursor));
    assert.ok(cursors.every(cursor => cursor !== "col-resize"), `${label}: drag cursor must be released`);
  }

  const columnMenu = () => page.getByRole("menu", { name: "Действия со столбцом", exact: true });
  const cellMenu = () => page.getByRole("menu", { name: "Действия с ячейкой таблицы", exact: true });
  const mainHeader = kind => mainGrip(kind).locator("..");
  async function openColumnMenu(kind, target = mainHeader(kind)) {
    await target.click({ button: "right" });
    await columnMenu().waitFor();
    await columnMenu().getByRole("menuitem", { name: "Ширина по содержимому", exact: true }).waitFor();
    return columnMenu();
  }
  async function nativeContextEvent(target, keyboard = false) {
    return target.evaluate((element, keyboard) => {
      const box = element.getBoundingClientRect();
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2,
        clientX: keyboard ? 0 : box.left + Math.min(15, box.width / 2),
        clientY: keyboard ? 0 : box.top + Math.min(15, box.height / 2) });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, keyboard);
  }
  for (const kind of ["workers", "equipment"]) {
    await page.setViewportSize({ width: 1440, height: 953 });
    await open(kind);
    await page.evaluate(kind => localStorage.removeItem(`resource-report.timesheet-column-widths.${kind}.v1`), kind);
    await open(kind);
    const initialMain = await width(mainGrip(kind));
    const initialDay = await width(dayGrip(1));
    const rowLabel = () => table().locator(`tbody tr[data-virtual-row] > th.${kind === "workers" ? "timesheet-employee-column" : "equipment-machine-column"} > span`).first();
    const originalFirst = await rowLabel().innerText();
    const lastLabel = await table().locator(`tbody tr[data-virtual-row] > th.${kind === "workers" ? "timesheet-employee-column" : "equipment-machine-column"} > span`).last().innerText();

    // Right-click is scoped to a real leaf TH, not the page, totals, or empty grid.
    for (const target of [page.locator("h1").first(), table().locator("tfoot td, tfoot th").first(), table().locator("thead th[colspan]").first()]) {
      assert.equal(await nativeContextEvent(target), false, `${kind}: outside/aggregate headers preserve the browser context menu`);
      assert.equal(await columnMenu().count(), 0, `${kind}: no column menu outside a leaf header`);
    }
    const numberHeader = table().locator('thead [data-resize-owner="number"][data-resize-edge="right"]').locator("..");
    await openColumnMenu(kind, numberHeader);
    assert.equal(await columnMenu().getByRole("menuitem", { name: "По возрастанию", exact: true }).count(), 0, `${kind}: number column does not pretend to support sorting`);
    for (const label of ["Закрепить столбец", "Скрыть столбец", "Выбрать столбцы"]) {
      assert.equal(await columnMenu().getByRole("menuitem", { name: label, exact: true }).count(), 0, `${kind}: unsupported structural actions are not offered`);
    }
    await page.keyboard.press("Escape");

    await openColumnMenu(kind);
    assert.equal(await columnMenu().getByRole("menuitem", { name: "Сбросить сортировку", exact: true }).isDisabled(), true);
    await columnMenu().getByRole("menuitem", { name: "По убыванию", exact: true }).click();
    await page.waitForFunction(({ kind, lastLabel }) => document.querySelector(`table.timesheet-resizable tbody tr[data-virtual-row] > th.${kind === "workers" ? "timesheet-employee-column" : "equipment-machine-column"} > span`)?.textContent === lastLabel, { kind, lastLabel });
    await openColumnMenu(kind);
    assert.equal(await columnMenu().getByRole("menuitem", { name: "По убыванию", exact: true }).isDisabled(), true);
    await columnMenu().getByRole("menuitem", { name: "Сбросить сортировку", exact: true }).click();
    await page.waitForFunction(({ kind, originalFirst }) => document.querySelector(`table.timesheet-resizable tbody tr[data-virtual-row] > th.${kind === "workers" ? "timesheet-employee-column" : "equipment-machine-column"} > span`)?.textContent === originalFirst, { kind, originalFirst });

    await openColumnMenu(kind);
    await columnMenu().getByRole("menuitem", { name: "Фильтр…", exact: true }).click();
    await page.locator(".ag-filter-menu").waitFor();
    assert.equal(await columnMenu().count(), 0, `${kind}: filter opens the existing anchored filter, not a second column menu`);
    await page.keyboard.press("Escape");
    await page.locator(".ag-filter-menu").waitFor({ state: "hidden" });

    await drag(mainGrip(kind), -200);
    const narrowMain = await width(mainGrip(kind));
    await openColumnMenu(kind, mainGrip(kind)); // Capture must also handle the resize grip itself.
    await columnMenu().getByRole("menuitem", { name: "Ширина по содержимому", exact: true }).click();
    await frames();
    assert.ok(await width(mainGrip(kind)) > narrowMain + 1, `${kind}: autosize changes the real native column width`);
    await geometry(`${kind}: column menu autosize`);
    await openColumnMenu(kind);
    await columnMenu().getByRole("menuitem", { name: "Подобрать ширину всех", exact: true }).click();
    await geometry(`${kind}: autosize all native columns`);
    const preferences = await page.evaluate(kind => JSON.parse(localStorage.getItem(`resource-report.timesheet-column-widths.${kind}.v1`) || "{}"), kind);
    assert.ok(Object.keys(preferences).length > 30, `${kind}: autosize all stores individual real column widths`);
    await openColumnMenu(kind);
    await columnMenu().getByRole("menuitem", { name: "Сбросить ширину столбцов", exact: true }).click();
    await frames();
    near(await width(mainGrip(kind)), initialMain, `${kind}: menu resets metadata widths`);
    near(await width(dayGrip(1)), initialDay, `${kind}: menu resets day widths`);

    const dayCell = table().locator('tbody tr[data-virtual-row] [data-timesheet-column="0"]').first();
    assert.equal(await nativeContextEvent(dayCell), true, `${kind}: day cells retain their own clipboard context menu`);
    await cellMenu().waitFor();
    assert.equal(await columnMenu().count(), 0);
    // Keyboard-invoked header menu must replace, rather than overlap, a body menu.
    assert.equal(await nativeContextEvent(mainHeader(kind), true), true);
    await columnMenu().waitFor();
    await cellMenu().waitFor({ state: "hidden" });
    assert.equal(await page.locator(".table-context-menu").count(), 1);
    await page.keyboard.press("Escape");

    await openColumnMenu(kind);
    // Programmatic clicks deliberately avoid pointer-down's automatic dismissal:
    // changing the month must independently invalidate the retained header anchor.
    await page.getByRole("button", { name: "Предыдущий месяц", exact: true }).evaluate(button => button.click());
    await page.waitForURL(url => url.searchParams.get("month") === "2026-10");
    await table().locator("thead tr:nth-child(2) th").nth(30).waitFor();
    await columnMenu().waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Следующий месяц", exact: true }).evaluate(button => button.click());
    await page.waitForURL(url => url.searchParams.get("month") === "2026-11");
    await page.waitForFunction(() => document.querySelectorAll("table.timesheet-resizable thead tr:nth-child(2) th").length === 30);
    await frames();
    assert.equal(await columnMenu().count(), 0, `${kind}: returning to a month never revives a stale menu`);
    await geometry(`${kind}: native header menu preserves all geometry`);
    await page.evaluate(kind => localStorage.removeItem(`resource-report.timesheet-column-widths.${kind}.v1`), kind);
    console.log(`PASS: ${kind}: scoped native header menu, sorting/filter, autosize/reset, clipboard isolation, month invalidation`);
  }
  assert.deepEqual(writes, [], "Native column menus must never write business data");
  assert.deepEqual(errors, [], "No native column menu browser runtime errors");

  if (!menusOnly) {
  const savedMain = {}, savedDay = {};
  for (const kind of ["workers", "equipment"]) {
    await page.setViewportSize({ width: 831, height: 954 });
    await open(kind);
    for (const month of ["2026-10", "2026-11", "2027-02"]) {
      await page.evaluate(kind => localStorage.removeItem(`resource-report.timesheet-column-widths.${kind}.v1`), kind);
      await open(kind, month);
      await maxScroll(`${kind} ${month}: left total divider`);
      const totalId = kind === "workers" ? "timesheet" : "productive";
      const leftGrip = table().locator(`[data-resize-owner="${totalId}"][data-resize-edge="left"]`);
      const lastDay = await table().locator("thead tr:nth-child(2) th").count();
      assert.equal(await leftGrip.getAttribute("data-column-id"), `day-${lastDay}`);
      assert.equal(await leftGrip.getAttribute("tabindex"), "-1", "Proxy dividers must not duplicate keyboard tab stops");
      for (const lowerHalf of [false, true]) {
        await maxScroll(`${kind}: before left-edge drag`);
        const cell = await leftGrip.evaluate(element => { const box = element.closest("th").getBoundingClientRect(); return { left: box.left, top: box.top, height: box.height }; });
        const point = { x: cell.left + 3, y: cell.top + (lowerHalf ? cell.height - 13 : 13) };
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-resize-edge]")?.getAttribute("data-resize-owner"), point);
        assert.equal(hit, totalId, `${kind}: the physical left edge works in both halves of the rowspan header`);
        const beforeDay = await width(dayGrip(lastDay));
        const beforeTotal = await width(grip(kind === "workers" ? ".timesheet-tabell-total" : ".equipment-work-total"));
        await page.mouse.move(point.x, point.y); await page.mouse.down();
        await page.mouse.move(point.x + 16, point.y, { steps: 6 }); await page.mouse.up(); await frames();
        near(await width(dayGrip(lastDay)), beforeDay + 16, `${kind}: left edge resizes the preceding day`);
        near(await width(grip(kind === "workers" ? ".timesheet-tabell-total" : ".equipment-work-total")), beforeTotal, `${kind}: either side of a divider addresses the same preceding column`);
        await geometry(`${kind}: left edge keeps the entire grid aligned`);
      }
      const centered = await table().evaluate(table => {
        const rect = element => element.getBoundingClientRect();
        const textRect = element => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect(); };
        return [...table.querySelectorAll("thead th")].filter(cell => getComputedStyle(cell).display !== "none").flatMap(cell => {
          const label = cell.querySelector(".timesheet-filterable-heading-label");
          if (!label) return [];
          const texts = label.children.length ? [...label.children] : [label];
          const cellBox = rect(cell), icon = rect(cell.querySelector(".timesheet-header-filter svg"));
          return texts.map(text => {
            const box = textRect(text);
            return { text: text.textContent, offset: (box.left + box.right - cellBox.left - cellBox.right) / 2,
              overlap: Math.min(box.right, icon.right) - Math.max(box.left, icon.left) > .5 && Math.min(box.bottom, icon.bottom) - Math.max(box.top, icon.top) > .5 };
          });
        });
      });
      centered.forEach(result => {
        near(result.offset, 0, `${kind}: caption ${result.text} is centered`, 1);
        assert.equal(result.overlap, false, `${kind}: filter icon must not cover caption ${result.text}`);
      });
      await maxScroll(`${kind}: centered headers at right edge`);
      if (month === "2026-10") await page.screenshot({ path: `/tmp/timesheet-left-divider-${kind}.png` });
    }
    await page.evaluate(kind => localStorage.removeItem(`resource-report.timesheet-column-widths.${kind}.v1`), kind);
  }
  for (const kind of ["workers", "equipment"]) {
    await page.setViewportSize({ width: 1440, height: 953 });
    await open(kind);
    const before = await geometry(`${kind}: initial`);
    const initialMain = await width(mainGrip(kind));
    const initialDay = await width(dayGrip(1));
    if (kind === "equipment") near(initialDay, 48, "Equipment day widths do not inherit worker preferences");
    await drag(mainGrip(kind), 150);
    const grownMain = await width(mainGrip(kind));
    assert.ok(grownMain >= initialMain + 20, `${kind}: metadata column can be enlarged`);
    const grown = await geometry(`${kind}: enlarged metadata`);
    near(grown.table.width - before.table.width, grownMain - initialMain, `${kind}: the whole table grows with the column`);
    await maxScroll(`${kind}: enlarged end-of-table`);
    await shell().evaluate(element => { element.scrollLeft = 0; });
    await drag(mainGrip(kind), -90);
    const shrunk = await width(mainGrip(kind));
    assert.ok(shrunk < grownMain, `${kind}: metadata column can be shrunk`);
    await geometry(`${kind}: shrunk metadata`);

    // Cancel must restore widths and not leave pointer capture/cursor behind.
    await drag(mainGrip(kind), 70, { finish: false });
    await page.keyboard.press("Escape"); await page.mouse.up(); await frames();
    near(await width(mainGrip(kind)), shrunk, `${kind}: Escape restores the original width`);
    await noDragCursor(`${kind}: Escape`);
    await drag(mainGrip(kind), 60, { finish: false });
    await mainGrip(kind).dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse", bubbles: true });
    await page.mouse.up(); await frames();
    near(await width(mainGrip(kind)), shrunk, `${kind}: pointercancel restores the original width`);
    await noDragCursor(`${kind}: pointercancel`);

    await mainGrip(kind).dblclick(); await frames();
    near(await width(mainGrip(kind)), initialMain, `${kind}: double-click restores default metadata width`);
    await mainGrip(kind).focus(); await page.keyboard.press("ArrowRight"); await frames();
    assert.ok(await width(mainGrip(kind)) > initialMain, `${kind}: keyboard resizes without navigating spreadsheet cells`);
    savedMain[kind] = await width(mainGrip(kind));
    await drag(dayGrip(1), 40);
    savedDay[kind] = await width(dayGrip(1));
    assert.ok(savedDay[kind] > initialDay, `${kind}: individual days are resizable`);
    await geometry(`${kind}: day resized`);

    await totalGrip(kind).scrollIntoViewIfNeeded();
    const oldTotal = await width(totalGrip(kind));
    await totalGrip(kind).focus(); await page.keyboard.press("ArrowRight"); await frames();
    assert.ok(await width(totalGrip(kind)) > oldTotal, `${kind}: total columns are resizable`);
    await maxScroll(`${kind}: total resized`);

    // Extreme shrink cannot collapse a track, and enlargement cannot overflow its cap.
    await shell().evaluate(element => { element.scrollLeft = 0; });
    const min = Number(await dayGrip(1).getAttribute("aria-valuemin"));
    const max = Number(await dayGrip(1).getAttribute("aria-valuemax"));
    await drag(dayGrip(1), -2000);
    assert.ok(await width(dayGrip(1)) >= min - 1, `${kind}: minimum width is enforced`);
    await drag(dayGrip(1), 2000);
    assert.ok(await width(dayGrip(1)) <= max + 1, `${kind}: maximum width is enforced`);
    await dayGrip(1).dblclick(); await frames();
    await drag(dayGrip(1), 40); savedDay[kind] = await width(dayGrip(1));

    await open(kind);
    near(await width(mainGrip(kind)), savedMain[kind], `${kind}: metadata width survives reopening`);
    near(await width(dayGrip(1)), savedDay[kind], `${kind}: day width survives reopening`);
    await open(kind, "2026-12");
    near(await width(mainGrip(kind)), savedMain[kind], `${kind}: metadata width survives month change`);
    near(await width(dayGrip(1)), savedDay[kind], `${kind}: day preference survives month change`);
    await geometry(`${kind}: 31-day month`);

    await page.setViewportSize({ width: 843, height: 953 }); await frames();
    await geometry(`${kind}: narrow breakpoint`);
    await drag(mainGrip(kind), 150);
    await geometry(`${kind}: narrow resize`);
    await maxScroll(`${kind}: narrow right edge`);
    await page.screenshot({ path: `/tmp/timesheet-column-resize-${kind}-843.png` });
    await page.setViewportSize({ width: 1440, height: 953 }); await frames();
    await geometry(`${kind}: expanded viewport`);
    await maxScroll(`${kind}: expanded right edge`);
    await page.screenshot({ path: `/tmp/timesheet-column-resize-${kind}-1440.png` });

    rowCount = 0; await open(kind); await geometry(`${kind}: no data`);
    await drag(mainGrip(kind), 24); await geometry(`${kind}: no data, resized`);
    await maxScroll(`${kind}: no data right edge`);
    rowCount = 1000; await open(kind);
    const many = await geometry(`${kind}: 1000 data rows`);
    assert.ok(many.realRowCount < 100, `${kind}: resizing must retain row virtualisation`);
    await shell().evaluate(element => { element.scrollTop = 12_000; }); await frames();
    await geometry(`${kind}: virtual rows after vertical scroll`);
    await maxScroll(`${kind}: virtual rows right edge`);
    rowCount = 4;
    await page.evaluate(kind => localStorage.removeItem(`resource-report.timesheet-column-widths.${kind}.v1`), kind);
    await page.setViewportSize({ width: 3840, height: 953 });
    await open(kind);
    await geometry(`${kind}: ultrawide auto-filled grid`);
    const autoWidth = await width(dayGrip(1));
    await drag(dayGrip(1), 1);
    near(await width(dayGrip(1)), autoWidth + 1, `${kind}: 1px gesture does not double-count auto-fill`, 2);
    const beforeArrow = await width(dayGrip(1));
    await dayGrip(1).focus(); await page.keyboard.press("ArrowRight"); await frames();
    near(await width(dayGrip(1)), beforeArrow + 8, `${kind}: auto-filled keyboard resize has no jump`, 2);
    await geometry(`${kind}: ultrawide after drag and keyboard`);
    await page.setViewportSize({ width: 8192, height: 953 });
    await open(kind, "2027-02");
    await geometry(`${kind}: auto-fill larger than stored maximum`);
    const validRanges = await table().locator(".timesheet-column-resize-handle").evaluateAll(handles => handles.every(handle => {
      const value = Number(handle.getAttribute("aria-valuenow"));
      return value >= Number(handle.getAttribute("aria-valuemin")) && value <= Number(handle.getAttribute("aria-valuemax"));
    }));
    assert.ok(validRanges, `${kind}: accessible resize ranges include auto-filled widths`);
    console.log(`PASS: ${kind}: coherent column/sticky/footer geometry, drag/keyboard/reset/cancel, persistence, narrow/empty/virtualised tables`);
  }
  }
  assert.deepEqual(writes, [], "Column resizing is a browser preference, never a business-data write");
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log(JSON.stringify({ checks: menusOnly
    ? "workers + equipment: scoped header menus, sorting, filter, autosize/reset, clipboard menu isolation, month invalidation"
    : "workers + equipment: header menus, widths, sticky offsets, footer, empty grid, no blank tail, keyboard/pointer, persistence, responsive/virtualised rows", writes: writes.length }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
