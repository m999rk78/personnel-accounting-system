// Real application and DOM filters, synthetic rows only. No .env or real API.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = Number(process.argv[3] ?? 3176);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Укажите корректный порт стенда.");
const config = { configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "timesheet-day-row-filters-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/timesheet-batch-save.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port, strictPort: true } };
await build(config);
const server = await preview(config);
let browser, page, currentCase = "initialisation";
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 954 } });
  page.setDefaultTimeout(15_000);
  const errors = [], writes = [], checks = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    for (const kind of ["workers", "equipment"]) localStorage.setItem(`resource-report.timesheet-column-widths.${kind}.v1`, JSON.stringify({ "day-2": 88, "day-3": 72 }));
  });
  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const employees = Array.from({ length: 4 }, (_, index) => ({ id: index + 1,
    fullName: `Сотрудник ${String(index + 1).padStart(2, "0")}`, employmentType: "ИТР", department: "МУТТ",
    position: "Инженер", source: "manual", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
  const units = employees.map(({ id }) => ({ id, name: `Кран ${id}`, equipmentType: "Кран", brand: "Учебный", model: `Модель ${id}`,
    registrationNumber: `ТЕХ-${String(id).padStart(2, "0")}`, inventoryNumber: `TEST-${id}`, organization: "Учебная организация",
    siteId: 1, siteName: sites[0].name, availabilityStatus: "active", unavailableFrom: null, note: "" }));
  const date = day => `2026-11-${String(day).padStart(2, "0")}`;
  const firstDayHours = [9, 6, 5, 4], secondDayHours = [0, 0, 8, 4], thirdDayHours = [8, 4, 8, 4];
  const workerMarks = employees.flatMap(({ id }, index) => [
    { employeeId: id, workDate: date(1), hours: firstDayHours[index], code: null, note: "Первое число" },
    { employeeId: id, workDate: date(2), hours: id <= 2 ? null : secondDayHours[index], code: id <= 2 ? "О" : null, note: "Второе число" },
    { employeeId: id, workDate: date(3), hours: thirdDayHours[index], code: null, note: "Третье число" },
  ]);
  const equipmentMarks = units.flatMap(({ id }, index) => [
    { equipmentId: id, workDate: date(1), productiveHours: firstDayHours[index], downtimeHours: 0, note: "Первое число" },
    { equipmentId: id, workDate: date(2), productiveHours: secondDayHours[index], downtimeHours: id <= 2 ? 2 : 0, note: "Второе число" },
    { equipmentId: id, workDate: date(3), productiveHours: thirdDayHours[index], downtimeHours: 0, note: "Третье число" },
  ]);
  const options = { shifts: [{ id: 1, name: "день" }], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [] };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 405, json: { error: "Фильтры не должны менять данные." } });
    }
    let body;
    if (url.pathname === "/api/table-order") body = { ids: [], canWrite: false, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report")) body = { reports: [], entries: [], canReview: true, availabilityMarks: [], from: null, to: null };
    else if (url.pathname === "/api/timesheet") body = { siteId: 1, siteName: sites[0].name, month: url.searchParams.get("month"),
      canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees, entries: [], marks: workerMarks };
    else if (url.pathname === "/api/equipment") body = { siteId: 1, siteName: sites[0].name, workDate: "2026-11-05", month: url.searchParams.get("month"),
      canEditDaily: true, canCreateDaily: true, canUpdateDaily: true, canDeleteDaily: true, canEditTimesheet: true,
      canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, canManageRegistry: true,
      canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true, canManageAssignments: true,
      canCreateAssignments: true, canUpdateAssignments: true, canDeleteAssignments: true,
      currentUserRole: "superadmin", currentUserName: "Проверка фильтров", reportSubmitted: false, foremanProgress: [],
      units, availableUnits: units, sites, entries: [], marks: equipmentMarks, dailyTimesheetMarks: [], filledDates: [], ...options };
    else if (url.pathname === "/api/roles") body = { roles: [], canManage: true };
    else {
      assert.equal(url.pathname, "/api/data", `Неожиданный API: ${url.pathname}`);
      body = { sites, employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees,
        positionCatalog: [], employmentTypes: [{ id: 1, name: "ИТР" }], departments: [{ id: 1, name: "МУТТ" }],
        positions: [{ id: 1, name: "Инженер" }], users: [], ...options,
        entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false,
        projectStats: [], bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } } };
    }
    await route.fulfill({ json: body });
  });

  const table = () => page.locator("table.timesheet-resizable");
  const shell = () => page.locator(".timesheet-grid-shell").filter({ has: table() });
  const popup = () => page.locator(".ag-filter-menu:visible");
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function settle() {
    await shell().evaluate(element => new Promise(resolve => {
      let last = "", stable = 0;
      const check = () => {
        const r = element.getBoundingClientRect(), t = element.querySelector("table").getBoundingClientRect();
        const key = `${r.x}:${r.y}:${r.width}:${r.height}:${t.width}:${element.scrollLeft}`;
        stable = key === last ? stable + 1 : 0; last = key;
        if (stable >= 8) resolve(); else requestAnimationFrame(check);
      };
      check();
    }));
    await frames();
  }
  async function rows(kind, expected) {
    await page.waitForFunction(({ kind, expected }) => {
      const selector = kind === "workers" ? ".timesheet-employee-column" : ".equipment-machine-column";
      const ids = [...document.querySelectorAll(`table.timesheet-resizable tbody tr[data-virtual-row] ${selector}`)]
        .map(element => Number(element.textContent.match(kind === "workers" ? /Сотрудник (\d+)/ : /ТЕХ-(\d+)/)?.[1])).sort((a, b) => a - b);
      return JSON.stringify(ids) === JSON.stringify(expected);
    }, { kind, expected });
    await settle();
  }
  async function geometry() {
    await settle();
    return table().evaluate(table => {
      const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const shell = table.closest(".timesheet-grid-shell"), heads = [...table.tHead.rows[1].cells];
      return { table: rect(table), shell: rect(shell), scrollLeft: shell.scrollLeft, scrollWidth: shell.scrollWidth,
        cols: table.querySelectorAll("colgroup col").length,
        days: heads.map(cell => ({ day: Number(cell.querySelector(".timesheet-filterable-heading-label > span")?.textContent), ...rect(cell) })) };
    });
  }
  function sameGeometry(before, after, label) {
    const near = (a, b, detail) => assert.ok(Math.abs(a - b) <= 1.2, `${label}: ${detail} changed ${a} → ${b}`);
    assert.deepEqual(after.days.map(day => day.day), Array.from({ length: 30 }, (_, index) => index + 1), `${label}: every calendar day stays rendered`);
    assert.equal(after.cols, before.cols, `${label}: filtering must not remove colgroup tracks`);
    for (const metric of ["x", "y", "width", "height"]) near(before.shell[metric], after.shell[metric], `shell ${metric}`);
    near(before.table.width, after.table.width, "table width");
    near(before.scrollLeft, after.scrollLeft, "horizontal scroll");
    near(before.scrollWidth, after.scrollWidth, "scrollable width");
    before.days.forEach((day, index) => {
      near(day.x, after.days[index].x, `day ${day.day} position`);
      near(day.width, after.days[index].width, `day ${day.day} width`);
    });
  }
  async function openDay(day) {
    const header = table().locator("thead tr:nth-child(2) th").nth(day - 1);
    const button = header.locator(".timesheet-header-filter");
    await button.scrollIntoViewIfNeeded(); await button.click();
    await popup().waitFor();
    await popup().locator(".grid-checklist-values").waitFor();
    return button;
  }
  async function closeFilter() {
    await popup().getByRole("button", { name: "Закрыть фильтр", exact: true }).click();
    await popup().waitFor({ state: "hidden" });
  }
  async function chooseValue(value) {
    await popup().locator(".grid-checklist-values").getByRole("checkbox", { name: value, exact: true }).check();
    await closeFilter();
  }
  async function summary(kind, total, dayOneTotal) {
    const selector = kind === "workers" ? ".personnel-timesheet-summary .productive strong" : ".equipment-timesheet-summary .equipment-total strong";
    assert.equal(Number((await page.locator(selector).textContent()).replace(/[^\d.-]/g, "")), total, "Month totals use all days for the matching rows");
    if (dayOneTotal !== null) {
      assert.equal(Number(await table().locator("tfoot tr > :nth-child(2)").textContent()), dayOneTotal, "An unfiltered day retains the matching rows' values and totals");
    }
  }
  for (const viewport of [{ width: 1440, height: 954 }, { width: 831, height: 954 }]) {
    await page.setViewportSize(viewport);
    for (const kind of ["workers", "equipment"]) {
      currentCase = `${kind} ${viewport.width}px`;
      await page.goto(`http://127.0.0.1:${port}/timesheet-batch-save.html?route=${encodeURIComponent(`/timesheets/${kind}?month=2026-11`)}`);
      await table().waitFor(); await rows(kind, [1, 2, 3, 4]);
      assert.equal(await page.locator(".personnel-timesheet-day-focus").count(), 0, "A date filter never inserts a layout-shifting focus panel");
      await summary(kind, kind === "workers" ? 60 : 64, 24);

      await openDay(2);
      let before = await geometry();
      assert.ok(before.days[1].width >= 80, "Expanded day width must be loaded before filtering");
      await chooseValue(kind === "workers" ? "О" : "П 2");
      await rows(kind, [1, 2]); sameGeometry(before, await geometry(), `${currentCase}: first day filter`);
      await summary(kind, kind === "workers" ? 27 : 31, 15);
      assert.match(await table().locator("thead tr:first-child").innerText(), /Дни месяца/);
      if (kind === "workers" && viewport.width === 1440) await page.screenshot({ path: join(tmpdir(), "timesheet-all-days-vacation-filter.png") });

      await openDay(3); before = await geometry();
      await chooseValue("8");
      await rows(kind, [1]); sameGeometry(before, await geometry(), `${currentCase}: AND day filters`);
      await summary(kind, kind === "workers" ? 17 : 19, 9);

      await openDay(2); before = await geometry();
      await popup().locator(".grid-checklist-values").getByRole("button", { name: "Сбросить фильтр", exact: true }).click();
      await closeFilter();
      await rows(kind, [1, 3]); sameGeometry(before, await geometry(), `${currentCase}: clear one day filter`);
      await summary(kind, kind === "workers" ? 38 : 40, 14);
      assert.equal(await table().locator("thead tr:nth-child(2) th").nth(1).locator(".timesheet-header-filter.active").count(), 0);
      assert.equal(await table().locator("thead tr:nth-child(2) th").nth(2).locator(".timesheet-header-filter.active").count(), 1);

      before = await geometry();
      await page.locator(".timesheet-header-filter-reset").click();
      await rows(kind, [1, 2, 3, 4]); sameGeometry(before, await geometry(), `${currentCase}: reset filters`);
      await summary(kind, kind === "workers" ? 60 : 64, 24);

      await openDay(2); before = await geometry();
      await popup().getByRole("button", { name: /Состояние ячейки/ }).click();
      await popup().locator(".grid-checklist-states").getByRole("checkbox", { name: "Нет значения", exact: true }).check();
      await closeFilter();
      await rows(kind, []); sameGeometry(before, await geometry(), `${currentCase}: empty result`);
      await summary(kind, 0, null);
      await page.locator(".timesheet-header-filter-reset").click();
      await rows(kind, [1, 2, 3, 4]);
      checks.push(currentCase); console.log(`PASS ${currentCase}: row-only date filters, AND/reset/empty, full-month geometry and totals`);
    }
  }
  assert.deepEqual(writes, [], "Filtering never writes business data");
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log(JSON.stringify({ checks, writes: writes.length, screenshot: join(tmpdir(), "timesheet-all-days-vacation-filter.png") }));
} catch (error) {
  console.error("FAILED CASE " + currentCase + ": " + String(error.message).slice(0, 1800));
  if (page) {
    const screenshot = join(tmpdir(), "timesheet-day-row-filter-failure.png");
    await page.screenshot({ path: screenshot }).catch(() => {});
    console.error("FAILURE SCREENSHOT " + screenshot);
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
