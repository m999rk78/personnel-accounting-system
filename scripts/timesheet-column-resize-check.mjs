// Real application + synthetic actor/data. Every API is intercepted; no .env/DB.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const menusOnly = process.argv.includes("--menus-only");
const headersOnly = process.argv.includes("--headers-only");
const args = process.argv.slice(2).filter(argument => !["--menus-only", "--headers-only"].includes(argument));
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
    model: `Модель ${id} с длинным наименованием для проверки подбора ширины`, registrationNumber: `ТЕСТ${id}`, inventoryNumber: `TEST-${id}`, organization: "Учебная организация",
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

  async function columnBorderPoint(handle) {
    await handle.scrollIntoViewIfNeeded();
    return handle.evaluate(element => {
      const cell = element.closest("th"), box = cell.getBoundingClientRect();
      return { x: box.right, y: box.top + Math.min(18, box.height / 2) };
    });
  }

  async function hoverBorder(handle, point) {
    await page.mouse.move(point.x, point.y); await frames();
    const hovered = table().locator("thead [data-resize-hover]");
    assert.equal(await hovered.count(), 1, "Only one divider is highlighted at the physical column boundary");
    assert.equal(await hovered.getAttribute("data-column-id"), await handle.getAttribute("data-column-id"), "The physical border resolves to its preceding column");
  }

  async function drag(handle, delta, { finish = true } = {}) {
    const point = await columnBorderPoint(handle);
    // The semantic separator is keyboard-operable but ignores pointer events.
    // Exercise the root's physical-boundary hit test through real mouse input.
    await hoverBorder(handle, point);
    await page.mouse.down();
    await page.mouse.move(point.x + delta, point.y, { steps: 12 });
    if (finish) await page.mouse.up();
    await frames();
  }

  async function doubleClickBorder(handle) {
    const point = await columnBorderPoint(handle);
    await hoverBorder(handle, point);
    await page.mouse.dblclick(point.x, point.y); await frames();
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
    await headerFilters(label);
    return result;
  }

  async function headerFilters(label) {
    const results = await table().evaluate(table => {
      const rect = element => element.getBoundingClientRect();
      const inside = (child, parent) => child.left >= parent.left - 1 && child.right <= parent.right + 1 && child.top >= parent.top - 1 && child.bottom <= parent.bottom + 1;
      const overlaps = (left, right) => Math.min(left.right, right.right) - Math.max(left.left, right.left) > .5 && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > .5;
      const textRect = element => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect(); };
      const shell = table.closest(".timesheet-grid-shell"), shellBox = rect(shell);
      const pinnedRight = Math.max(shellBox.left, ...[...table.querySelectorAll("thead .timesheet-sticky")].map(cell => rect(cell).right));
      return [...table.querySelectorAll("thead th")].filter(cell => getComputedStyle(cell).display !== "none").flatMap(cell => {
        const label = cell.querySelector(".timesheet-filterable-heading-label"), button = cell.querySelector(".timesheet-header-filter"), svg = button?.querySelector("svg");
        if (!label || !button || !svg) return [];
        const cellBox = rect(cell), labelBox = rect(label), buttonBox = rect(button), iconBox = rect(svg);
        const texts = label.children.length ? [...label.children] : [label];
        const captions = texts.map(text => {
          const box = textRect(text);
          const visibleBox = { left: Math.max(box.left, labelBox.left), right: Math.min(box.right, labelBox.right), top: box.top, bottom: box.bottom };
          return { text: text.textContent, fits: box.width <= labelBox.width + 1, offset: (box.left + box.right - labelBox.left - labelBox.right) / 2, overlap: overlaps(visibleBox, iconBox) };
        });
        const clippedBy = [];
        for (let ancestor = svg.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor), box = rect(ancestor);
          if (/hidden|clip|auto|scroll/.test(style.overflowX) && (iconBox.left < box.left - 1 || iconBox.right > box.right + 1)
            || /hidden|clip|auto|scroll/.test(style.overflowY) && (iconBox.top < box.top - 1 || iconBox.bottom > box.bottom + 1)) clippedBy.push(ancestor.className);
          if (ancestor === cell) break;
        }
        const x = iconBox.left + iconBox.width / 2, y = iconBox.top + iconBox.height / 2;
        const onScreen = x >= shellBox.left && x < Math.min(shellBox.right, innerWidth) && y >= 0 && y < innerHeight && (cell.classList.contains("timesheet-sticky") || x > pinnedRight);
        const hitTarget = onScreen ? document.elementFromPoint(x, y) : null;
        const hit = !onScreen || hitTarget?.closest(".timesheet-header-filter") === button;
        const grips = [...cell.querySelectorAll(".timesheet-column-resize-handle")].map(rect);
        const badge = button.querySelector(".timesheet-sort-indicator"), badgeBox = badge && rect(badge);
        return [{ name: button.getAttribute("aria-label"), captions, inside: inside(buttonBox, cellBox), iconInside: inside(iconBox, buttonBox), clippedBy, hit, hitTarget: hitTarget && `${hitTarget.tagName}.${String(hitTarget.className)} ${hitTarget.textContent}`,
          resizeOverlap: grips.some(grip => overlaps(buttonBox, grip)), badgeInside: !badgeBox || inside(badgeBox, cellBox), badgeResizeOverlap: Boolean(badgeBox && grips.some(grip => overlaps(badgeBox, grip))) }];
      });
    });
    for (const result of results) {
      for (const caption of result.captions) {
        if (caption.fits) near(caption.offset, 0, `${label}: caption ${caption.text} centered in its label slot`, 1);
        assert.equal(caption.overlap, false, `${label}: ${result.name} icon does not cover its caption`);
      }
      assert.equal(result.inside, true, `${label}: ${result.name} button stays wholly inside the header`);
      assert.equal(result.iconInside, true, `${label}: ${result.name} icon stays inside its button`);
      assert.deepEqual(result.clippedBy, [], `${label}: ${result.name} icon is not clipped by an ancestor`);
      if (!result.hit) await page.screenshot({ path: "/tmp/timesheet-filter-headers-failure.png" });
      assert.equal(result.hit, true, `${label}: ${result.name} icon remains clickable (hit ${result.hitTarget})`);
      assert.equal(result.resizeOverlap, false, `${label}: ${result.name} button is separate from resize handles`);
      assert.equal(result.badgeInside, true, `${label}: ${result.name} sort badge stays inside the header`);
      assert.equal(result.badgeResizeOverlap, false, `${label}: ${result.name} sort badge is separate from resize handles`);
    }
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

  async function rightPinnedHeaderAndTail(kind) {
    const id = kind === "workers" ? "timesheet" : "productive";
    const header = () => table().locator(`thead th[data-timesheet-column-id="${id}"]`);
    const keys = [`resource-report.timesheet-column-pins.${kind}.v1`, `resource-report.timesheet-column-widths.${kind}.v1`];
    const saved = await page.evaluate(keys => keys.map(key => [key, localStorage.getItem(key)]), keys);
    try {
      await openColumnMenu(kind, header());
      await columnMenu().getByRole("menuitem", { name: "Сбросить закрепление", exact: true }).click();
      await page.waitForFunction(id => document.querySelector(`table.timesheet-resizable thead th[data-timesheet-column-id="${id}"]`)?.dataset.timesheetPin === "none", id);
      // Set up pinning through the visible native menu, not the filter engine or
      // a storage shortcut: this exercises the same operation as the user.
      await openColumnMenu(kind, header());
      await columnMenu().getByRole("menuitem", { name: "Закрепить столбец", exact: true }).click();
      await page.getByRole("menuitem", { name: "Закрепить справа", exact: true }).click();
      await page.waitForFunction(id => document.querySelector(`table.timesheet-resizable thead th[data-timesheet-column-id="${id}"]`)?.dataset.timesheetPin === "right", id);
      const rail = page.getByRole("scrollbar", { name: kind === "workers" ? "Горизонтальная прокрутка табеля рабочих" : "Горизонтальная прокрутка табеля техники", exact: true });
      for (const position of ["Home", "middle", "End"]) {
        if (position === "middle") await shell().evaluate(element => { element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2; });
        else await rail.press(position);
        await settleLayout();
        const result = await header().evaluate(header => {
          const table = header.closest("table"), viewport = table.closest(".timesheet-grid-shell");
          const box = header.getBoundingClientRect(), frame = viewport.getBoundingClientRect();
          const contentRight = frame.left + viewport.clientLeft + viewport.clientWidth;
          const x = box.left + Math.min(40, box.width / 2);
          const points = [box.top + 18, box.bottom - 18].map(y => ({ y,
            owned: document.elementsFromPoint(x, y).find(element => element.closest("th"))?.closest("th") === header,
          }));
          const centerLayers = [...table.querySelectorAll('thead th[data-timesheet-pin="none"]')]
            .map(cell => Number(getComputedStyle(cell).zIndex)).filter(Number.isFinite);
          const lastBodyCell = table.querySelector("tbody tr[data-virtual-row]")?.lastElementChild;
          const lastFooterCell = table.tFoot?.rows[0]?.lastElementChild;
          return { points, label: header.querySelector(".timesheet-filterable-heading-label")?.textContent?.trim(),
            layer: Number(getComputedStyle(header).zIndex), centerLayer: Math.max(...centerLayers),
            tableWidth: table.getBoundingClientRect().width, scrollWidth: viewport.scrollWidth,
            scrollLeft: viewport.scrollLeft, maximum: viewport.scrollWidth - viewport.clientWidth,
            headerRight: box.right, bodyRight: lastBodyCell?.getBoundingClientRect().right,
            footerRight: lastFooterCell?.getBoundingClientRect().right, contentRight,
          };
        });
        const label = `${kind}: right-pinned total at ${position}`;
        assert.ok(result.label, `${label}: heading retains its caption`);
        assert.ok(result.points.every(point => point.owned), `${label}: header owns both the month and date bands`);
        assert.ok(result.layer > result.centerLayer, `${label}: pinned heading paints above every central heading`);
        assert.ok(result.scrollWidth - result.tableWidth <= 1, `${label}: invisible resize controls add no trailing scroll space`);
        near(result.headerRight, result.contentRight, `${label}: pinned header touches the viewport edge`, 1);
        if (position === "End") {
          near(result.scrollLeft, result.maximum, `${label}: scrollbar reaches its real maximum`, 1);
          if (result.bodyRight !== undefined) near(result.bodyRight, result.contentRight, `${label}: final body cell has no blank tail`, 1);
          if (result.footerRight !== undefined) near(result.footerRight, result.contentRight, `${label}: final footer cell has no blank tail`, 1);
        }
      }
      await openColumnMenu(kind, header());
      await columnMenu().getByRole("menuitem", { name: "Сбросить закрепление", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('table.timesheet-resizable thead th[data-timesheet-pin="right"]'));
      console.log(`PASS: ${kind}: native right pin, header hit/layer at Home/middle/End, no extra tail and aligned final cells`);
    } finally {
      // The fixture may be invoked with saved preferences from another check.
      // Restore the exact original pin and width values even after a failure.
      await page.evaluate(saved => {
        for (const [key, value] of saved) {
          if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
        }
      }, saved);
      await open(kind);
    }
  }
  for (const kind of ["equipment", "workers"]) {
    for (const viewport of [939, 1440]) {
      await page.setViewportSize({ width: viewport, height: 954 });
      await open(kind);
      for (const state of ["default", "minimum", "resized"]) {
        const widths = state === "default" ? {} : kind === "workers"
          ? state === "minimum" ? { employmentType: 50, department: 60, fullName: 140, position: 100, "day-1": 40, timesheet: 96, reports: 96, difference: 96 }
            : { employmentType: 78, department: 104, fullName: 340, position: 220, "day-1": 88, timesheet: 110, reports: 110, difference: 110 }
          : state === "minimum" ? { equipment: 160, organization: 100, "day-1": 40, productive: 96, downtime: 96, total: 96 }
            : { equipment: 420, organization: 240, "day-1": 88, productive: 110, downtime: 110, total: 110 };
        await page.evaluate(({ kind, widths }) => localStorage.setItem(`resource-report.timesheet-column-widths.${kind}.v1`, JSON.stringify(widths)), { kind, widths });
        await open(kind);
        await geometry(`${kind} ${viewport}px ${state}: filter headers at start`);
        if (kind === "equipment" && viewport === 939 && state === "default") {
          await page.screenshot({ path: "/tmp/timesheet-filter-headers-equipment-939.png" });
          console.log("SCREENSHOT /tmp/timesheet-filter-headers-equipment-939.png");
        }
        await maxScroll(`${kind} ${viewport}px ${state}: filter headers at end`);
      }
      await shell().evaluate(element => { element.scrollLeft = 0; });
      await openColumnMenu(kind);
      await columnMenu().getByRole("menuitem", { name: "По возрастанию", exact: true }).click();
      await headerFilters(`${kind} ${viewport}px sorted badge`);
      await page.evaluate(kind => localStorage.removeItem(`resource-report.timesheet-column-widths.${kind}.v1`), kind);
      console.log(`PASS: ${kind} ${viewport}px: default/minimum/resized filter buttons, clipping, click targets and sorted badge`);
    }
  }
  for (const kind of ["workers", "equipment"]) {
    await page.setViewportSize({ width: 1440, height: 953 });
    await open(kind);
    await rightPinnedHeaderAndTail(kind);
  }
  if (!headersOnly) {
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
    assert.equal(await columnMenu().getByRole("menuitem", { name: "Закрепить столбец", exact: true }).count(), 1, `${kind}: native columns offer their pin submenu`);
    for (const label of ["Скрыть столбец", "Выбрать столбцы"]) {
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

    const dayCell = table().locator('tbody tr[data-virtual-row] [data-timesheet-column-id="day-1"]').first();
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
      await page.setViewportSize({ width: 831, height: 954 });
      await page.evaluate(kind => localStorage.removeItem(`resource-report.timesheet-column-widths.${kind}.v1`), kind);
      await open(kind, month);
      await maxScroll(`${kind} ${month}: single column dividers`);
      const totalId = kind === "workers" ? "timesheet" : "productive";
      const totalHandle = grip(kind === "workers" ? ".timesheet-tabell-total" : ".equipment-work-total");
      const lastDay = await table().locator("thead tr:nth-child(2) th").count();
      const handles = await table().locator("thead .timesheet-column-resize-handle").evaluateAll(elements => elements.map(element => ({
        id: element.dataset.columnId, owner: element.dataset.resizeOwner, edge: element.dataset.resizeEdge, tabindex: element.tabIndex,
      })));
      assert.equal(handles.length, await table().locator("colgroup col").count(), `${kind}: exactly one grip per leaf column`);
      assert.equal(new Set(handles.map(handle => handle.id)).size, handles.length, `${kind}: adjacent headers do not duplicate a divider`);
      for (const handle of handles) {
        assert.equal(handle.edge, "right");
        assert.equal(handle.owner, handle.id);
        assert.equal(handle.tabindex, 0);
      }
      const lastDayCovered = await dayGrip(lastDay).evaluate(element => {
        const box = element.getBoundingClientRect(), table = element.closest("table");
        return (box.left + box.right) / 2 < Math.max(...[...table.querySelectorAll("thead th.timesheet-sticky")].map(header => header.getBoundingClientRect().right));
      });
      if (lastDayCovered) {
        await page.setViewportSize({ width: 1440, height: 954 });
        await maxScroll(`${kind}: reveal the last-day separator beside pinned metadata`);
      }
      // The day divider belongs only to the day header; the rowspan total has
      // its own independent right divider, available throughout its height.
      const beforeTotal = await width(totalHandle), beforeDay = await width(dayGrip(lastDay));
      await drag(dayGrip(lastDay), 16);
      near(await width(dayGrip(lastDay)), beforeDay + 16, `${kind}: day right edge changes that day only`);
      near(await width(totalHandle), beforeTotal, `${kind}: neighboring total stays unchanged`);
      for (const lowerHalf of [false, true]) {
        await maxScroll(`${kind}: before total right-edge drag`);
        const point = await totalHandle.evaluate((element, lowerHalf) => {
          const box = element.closest("th").getBoundingClientRect();
          return { x: box.right, y: box.top + (lowerHalf ? box.height - 13 : 13) };
        }, lowerHalf);
        await page.mouse.move(point.x, point.y); await frames();
        const hit = await table().locator("thead [data-resize-hover]").getAttribute("data-column-id");
        assert.equal(hit, totalId, `${kind}: one physical right divider works in both halves of the rowspan header`);
        const previousTotal = await width(totalHandle), previousDay = await width(dayGrip(lastDay));
        await page.mouse.move(point.x, point.y); await page.mouse.down();
        await page.mouse.move(point.x + 16, point.y, { steps: 6 }); await page.mouse.up(); await frames();
        near(await width(totalHandle), previousTotal + 16, `${kind}: total divider changes its own column`);
        near(await width(dayGrip(lastDay)), previousDay, `${kind}: total divider does not affect the previous day`);
        await geometry(`${kind}: single right edge keeps the entire grid aligned`);
      }
      await headerFilters(`${kind}: readable captions and filter controls`);
      await maxScroll(`${kind}: centered headers at right edge`);
      if (month === "2026-10") await page.screenshot({ path: `/tmp/timesheet-single-divider-${kind}.png` });
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

    await doubleClickBorder(mainGrip(kind));
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
    await doubleClickBorder(dayGrip(1));
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
  }
  assert.deepEqual(writes, [], "Column resizing is a browser preference, never a business-data write");
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log(JSON.stringify({ checks: headersOnly ? "workers + equipment: filter header layout, right-pinned header layers/hit targets, no blank tail at Home/middle/End" : menusOnly
    ? "workers + equipment: scoped header menus, right-pinned headers/no blank tail, sorting, filter, autosize/reset, clipboard menu isolation, month invalidation"
    : "workers + equipment: header menus, right-pinned headers, widths, sticky offsets, footer, empty grid, no blank tail, keyboard/pointer, persistence, responsive/virtualised rows", writes: writes.length }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
