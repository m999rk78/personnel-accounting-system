// Full app, synthetic GET-only API. No .env, credentials, production API or DB.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const config = { configFile: false, envDir: false, publicDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "empty-columns-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/workspace-header.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3155, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = [], requests = [];
  let count = 0;
  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const stamp = "2026-11-04T10:00:00.000Z";
  const range = make => Array.from({ length: count }, (_, index) => make(index + 1));
  const employees = () => range(id => ({ id, fullName: `Сотрудник ${String(id).padStart(3, "0")}`, employmentType: "ИТР", department: "МУТТ", position: `Должность ${id}`, source: "manual", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
  const units = () => range(id => ({ id, name: `Кран ${id}`, model: `Модель ${id}`, registrationNumber: `ТЕСТ${id}`, inventoryNumber: `TEST-${id}`, organization: "Учебная организация", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", unavailableFrom: null }));
  const options = () => ({ shifts: [{ id: 1, name: "день" }], zones: range(id => ({ id, name: `Зона ${id}` })), mainWorkTypes: range(id => ({ id, name: `Работа ${id}` })), subworkTypes: range(id => ({ id, name: `Подработа ${id}`, mainWorkTypeId: id })), masters: employees().map(employee => ({ id: employee.id, name: employee.fullName, employeeId: employee.id })) });
  const approvedEntries = equipment => range(id => ({ id, siteId: 1, workDate: "2026-11-04", shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1, hours: 8, note: "", shiftName: "день", zoneName: "Зона 1", mainWorkTypeName: "Работа 1", subworkTypeName: "Подработа 1", masterName: "Сотрудник 001", createdAt: stamp, updatedAt: stamp, rowOrder: id, revision: 1, responsibleUserId: 1, responsibleUserName: "Проверка таблиц",
    ...(equipment ? { equipmentId: id, equipmentName: `Кран ${id}`, equipmentType: "Кран", organization: "Учебная организация", brand: "Тест", model: `Модель ${id}`, registrationNumber: `ТЕСТ${id}` } : { employeeId: id, employeeName: `Сотрудник ${String(id).padStart(3, "0")}`, employmentType: "ИТР", department: "МУТТ", positionSnapshot: `Должность ${id}` }) }));
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { window.open = url => { window.testExportUrl = String(url); return {}; }; });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(`${request.method()} ${url.pathname}`);
    assert.equal(request.method(), "GET", "Decorative grid must never write data");
    let body;
    if (url.pathname === "/api/table-order") body = { ids: [], canWrite: false, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report")) body = { reports: [], entries: approvedEntries(url.pathname === "/api/equipment-report"), canReview: true, availabilityMarks: [], from: null, to: null };
    else if (url.pathname === "/api/timesheet") body = { siteId: 1, siteName: sites[0].name, month: "2026-11", canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees: employees(), entries: [], marks: [] };
    else if (url.pathname === "/api/equipment") body = { siteId: 1, siteName: sites[0].name, workDate: "2026-11-04", month: "2026-11", canEditDaily: true, canCreateDaily: true, canUpdateDaily: true, canDeleteDaily: true, canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, canManageRegistry: true, canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true, canManageAssignments: true, canCreateAssignments: true, canUpdateAssignments: true, canDeleteAssignments: true, currentUserRole: "superadmin", currentUserName: "Проверка таблиц", reportSubmitted: false, foremanProgress: [], units: units(), availableUnits: units(), sites, entries: [], marks: [], dailyTimesheetMarks: [], filledDates: [], ...options() };
    else if (url.pathname === "/api/roles") body = { roles: [], canManage: true };
    else {
      assert.equal(url.pathname, "/api/data");
      body = { sites, employees: employees(), projectEmployees: employees(), placementEmployees: employees(), reportEmployees: employees(), positionCatalog: range(id => ({ id, employmentType: "ИТР", department: "МУТТ", position: `Должность ${id}` })), employmentTypes: [{ id: 1, name: "ИТР" }], departments: [{ id: 1, name: "МУТТ" }], positions: range(id => ({ id, name: `Должность ${id}` })), users: range(id => ({ id, fullName: `Пользователь ${id}`, email: `user${id}@example.invalid`, role: "engineer", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, status: "active" })), ...options(), entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false, projectStats: [], bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } } };
    }
    await route.fulfill({ json: body });
  });
  const routes = [
    ["/settings/general/employees", "Сотрудники", "ag"], ["/settings/general/positions", "Список должностей", "ag"], ["/settings/general/equipment", "Реестр техники", "ag"],
    ["/settings/project/employees", "Сотрудники проекта", "ag"], ["/settings/project/equipment", "Техника проекта", "ag"], ["/settings/project/zones", "Зоны", "ag"],
    ["/settings/project/masters", "Мастера", "ag"], ["/settings/project/work-types", "Виды и подвиды работ", "ag"], ["/settings/project/subwork-types", "Виды и подвиды работ", "ag"],
    ["/reports/workers?date=2026-11-04", "Отчёт персонала", "ag"], ["/reports/equipment?date=2026-11-04", "Отчёт техники", "ag"],
    ["/settings/general/users", "Пользователи и права", "users"], ["/timesheets/workers?month=2026-11", "Табель рабочих", "timesheet"], ["/timesheets/equipment?month=2026-11", "Табель техники", "timesheet"],
  ];
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const firstAG = () => page.locator(".page-content .ag-grid-empty-rows").filter({ has: page.locator(".ag-header") }).first();
  async function usersException(label) {
    const surface = await page.locator(".users-table-wrap").evaluate(element => {
      const after = getComputedStyle(element, "::after");
      const table = element.querySelector("table");
      const empty = element.querySelector(".user-access-empty");
      return { display: getComputedStyle(element).display, afterContent: after.content, afterBackground: after.backgroundImage,
        columns: element.getAttribute("data-empty-column-boundaries"), columnStyle: element.style.getPropertyValue("--native-empty-column-lines"),
        height: element.getBoundingClientRect().height, contentHeight: table.getBoundingClientRect().height + (empty?.getBoundingClientRect().height ?? 0) };
    });
    assert.equal(surface.display, "block", `${label}: users retain ordinary auto-height layout`);
    assert.ok(["none", "normal", ""].includes(surface.afterContent), `${label}: no decorative pseudo rows`);
    assert.equal(surface.afterBackground, "none", `${label}: no empty row/column background`);
    assert.equal(surface.columns, null, `${label}: no decorative column metadata`);
    assert.equal(surface.columnStyle, "", `${label}: no decorative column style`);
    assert.ok(surface.height <= surface.contentHeight + 2, `${label}: users wrap does not stretch below content`);
    return surface;
  }
  async function geometry(kind, label) {
    await frames();
    // Users and permissions intentionally keep their original ordinary list.
    if (kind === "users") return usersException(label);
    if (kind === "ag") {
      // Column-model boundaries are final immediately; native headers may still
      // be completing AG's short pin/move/autosize transition.
      await page.waitForFunction(() => !document.querySelector(".page-content .ag-grid-empty-rows .ag-column-moving, .page-content .ag-grid-empty-rows .ag-animate-autosize"));
      await frames();
    }
    const result = await page.evaluate(kind => {
      const roots = [...document.querySelectorAll(".page-content .ag-grid-empty-rows")];
      const agRoot = roots.find(root => root.querySelector(".ag-header"));
      const overlay = kind === "ag" ? agRoot?.querySelector(".ag-empty-grid-columns") : kind === "users" ? document.querySelector(".users-table-wrap") : document.querySelector(".timesheet-fill-row > td, .equipment-month-table tbody > tr > td[data-empty-column-boundaries]");
      if (!overlay) return { error: "No decorative column host" };
      const rect = overlay.getBoundingClientRect();
      let boundaries;
      let regionBackground;
      if (kind === "ag") {
        // Each lane paints local model coordinates. The browser scrolls the
        // centre surface and sticks the opaque pinned surfaces above it.
        const regions = [...overlay.querySelectorAll(".ag-empty-grid-region")];
        if (regions.length !== 3) return { error: "Expected three decorative column regions", regions: regions.length };
        const lanes = regions.filter(region => !region.hidden && getComputedStyle(region).display !== "none").map(region => ({
          element: region, rect: region.getBoundingClientRect(), raw: region.getAttribute("data-column-boundaries"),
          side: region.classList.contains("ag-empty-grid-region-left") ? "left" : region.classList.contains("ag-empty-grid-region-right") ? "right" : "center",
        })).filter(region => region.rect.width > 0);
        if (lanes.some(region => !region.raw)) return { error: "No measurable decorative region boundaries" };
        const pinnedLeft = lanes.find(region => region.side === "left")?.rect.right ?? -Infinity;
        const pinnedRight = lanes.find(region => region.side === "right")?.rect.left ?? Infinity;
        boundaries = lanes.flatMap(region => JSON.parse(region.raw).map(Number).filter(Number.isFinite)
          .map(x => region.rect.left + x)
          // Centre lines underneath a pinned mask are intentionally invisible.
          .filter(x => region.side !== "center" || x > pinnedLeft + .5 && x <= pinnedRight + .5));
        regionBackground = lanes.map(region => getComputedStyle(region.element).backgroundImage).join("; ");
      } else {
        const raw = overlay.getAttribute("data-column-boundaries") ?? overlay.getAttribute("data-empty-column-boundaries");
        if (!raw) return { error: "No measurable decorative boundaries", class: overlay.className };
        boundaries = JSON.parse(raw).map(Number).filter(Number.isFinite).map(x => rect.left + x);
      }
      const headerRoot = kind === "ag" ? agRoot : kind === "users" ? document.querySelector(".users-table") : document.querySelector(".timesheet-table");
      const viewport = kind === "ag" ? agRoot.querySelector(".ag-grid-viewport") : kind === "users" ? overlay : document.querySelector(".timesheet-grid-shell");
      const viewportBox = viewport.getBoundingClientRect();
      const left = Math.max(viewportBox.left, 0), right = Math.min(viewportBox.right, innerWidth);
      const headers = [...headerRoot.querySelectorAll(kind === "ag" ? ".ag-header-cell" : "thead th")].filter(cell => {
        if (kind !== "ag" && cell.colSpan > 1) return false;
        const box = cell.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0 || box.right <= left + 1 || box.right >= right - 1) return false;
        // Ignore scrolling headers that are physically hidden under sticky/pinned cells.
        const hit = document.elementFromPoint(box.right - 2, Math.max(0, box.top + box.height / 2));
        return !!hit && (kind === "ag" ? hit.closest(".ag-header-cell") === cell : hit.closest("th") === cell);
      }).map(cell => cell.getBoundingClientRect().right);
      const expected = [...new Set(headers.map(x => Math.round(x * 100) / 100))];
      const actual = [...new Set(boundaries.filter(x => x > left + 1 && x < right - 1).map(x => Math.round(x * 100) / 100))];
      const lastRowBottom = kind === "ag" ? Math.max(0, ...[...agRoot.querySelectorAll(".ag-row")].map(row => row.getBoundingClientRect().bottom)) : 0;
      return { expected, actual, top: rect.top, height: rect.height, lastRowBottom, pointerEvents: getComputedStyle(overlay).pointerEvents, hidden: overlay.getAttribute("aria-hidden"), bg: regionBackground ?? getComputedStyle(overlay, kind === "users" ? "::after" : null).backgroundImage };
    }, kind);
    assert.equal(result.error, undefined, `${label}: ${JSON.stringify(result)}`);
    assert.ok(result.expected.length > 0 && result.actual.length > 0, `${label}: non-empty visible boundaries ${JSON.stringify(result)}`);
    for (const expected of result.expected) assert.ok(result.actual.some(actual => Math.abs(actual - expected) <= 1.5), `${label}: missing line below header ${expected}: ${JSON.stringify(result)}`);
    for (const actual of result.actual) assert.ok(result.expected.some(expected => Math.abs(actual - expected) <= 1.5), `${label}: stray line ${actual}: ${JSON.stringify(result)}`);
    if (kind === "ag") {
      assert.equal(result.hidden, "true"); assert.equal(result.pointerEvents, "none"); assert.ok(result.height > 0, `${label}: blank area visible`);
      assert.ok(result.top >= result.lastRowBottom - 1.5, `${label}: columns start below real records ${JSON.stringify(result)}`);
    }
    return result;
  }
  async function open(path, title, kind) {
    await page.goto(`http://127.0.0.1:3155/workspace-header.html?route=${encodeURIComponent(path)}`);
    await page.getByRole("heading", { name: title, level: 1, exact: true }).waitFor();
    if (kind === "ag") await page.locator(".page-content .ag-empty-grid-columns").first().waitFor({ state: "attached" });
    else if (kind === "users") await page.locator(".users-table-wrap").waitFor();
    else await page.locator(".timesheet-table").waitFor();
    await page.waitForFunction(() => !document.querySelector(".timesheet-loading") && document.querySelector(".timesheet-grid-shell")?.getAttribute("aria-busy") !== "true");
    await frames();
  }
  let checked = 0;
  for (count of [0, 3]) for (const [path, title, kind] of routes) {
    if (process.argv[3] && !path.startsWith(process.argv[3])) continue;
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(path, title, kind);
    await geometry(kind, `${path}, ${count} records`);
    if (kind === "ag") assert.equal(Number(await firstAG().locator("[aria-rowcount]").first().getAttribute("aria-rowcount")), count + 1, "No decorative AG data rows");
    else if (kind === "users") {
      assert.equal(await page.locator(".users-table tbody tr").count(), count, "No decorative users");
      const search = page.getByRole("textbox", { name: "Найти пользователя", exact: true });
      await search.fill(count ? "Пользователь 2" : "Несуществующий пользователь");
      await page.waitForFunction(expected => document.querySelectorAll(".users-table tbody tr").length === expected, count ? 1 : 0);
      if (count) assert.match(await page.locator(".users-table tbody tr").innerText(), /Пользователь 2/);
      await search.fill("Несуществующий пользователь"); await page.locator(".user-access-empty").waitFor();
      assert.equal(await page.locator(".users-table tbody tr").count(), 0);
      await search.fill("");
      await page.waitForFunction(expected => document.querySelectorAll(".users-table tbody tr").length === expected, count);
      if (count) {
        await page.getByRole("checkbox", { name: "Выбрать всех пользователей", exact: true }).check();
        assert.equal(await page.locator(".users-table tbody input:checked").count(), count);
        await page.getByRole("button", { name: "Снять выделение", exact: true }).click();
      }
      await usersException(`${path}: search and selection restored`);
    }
    else assert.equal(Number(await page.locator(".timesheet-table").getAttribute("aria-rowcount")), count + 3, "No decorative timesheet records");
    if (count === 3 && ["/settings/general/employees", "/settings/project/masters", "/settings/general/users"].includes(path)) {
      await page.locator(".workspace-page-heading").getByRole("button", { name: "Excel", exact: true }).click();
      await page.getByRole("menuitem", { name: "Экспорт в Excel", exact: true }).click();
      assert.equal(await page.evaluate(async () => (await (await fetch(new URLSearchParams(window.testExportUrl.split("?")[1]).get("payload"))).json()).rows.length), count);
    }
    if (count === 3 && (path === "/settings/project/masters" || kind === "users" || kind === "timesheet")) {
      await page.setViewportSize({ width: 843, height: 953 });
      await geometry(kind, `${path}, narrow desktop`);
      if (path === "/settings/project/masters") {
        const handle = firstAG().locator('.ag-header-cell[col-id="name"] .ag-header-cell-resize');
        const box = await handle.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 115, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
        await geometry(kind, "Masters resized name column");
        await firstAG().getByRole("button", { name: "Закрепить Тип", exact: true }).click(); await geometry(kind, "Masters pinned type column");
        await firstAG().getByRole("button", { name: "Открепить Тип", exact: true }).click();
      }
      const scroll = kind === "ag" ? firstAG().locator(".ag-grid-viewport") : kind === "timesheet" ? page.locator(".timesheet-grid-shell") : page.locator(".users-table-wrap");
      await scroll.evaluate(element => { element.scrollLeft = 193; });
      await geometry(kind, `${path}, horizontal scroll`);
      await page.setViewportSize({ width: 390, height: 844 });
      if (await page.getByRole("button", { name: "Свернуть меню", exact: true }).count()) await page.getByRole("button", { name: "Свернуть меню", exact: true }).click();
      await geometry(kind, `${path}, mobile`);
    }
    const name = path.replace(/^\//, "").replaceAll(/[/?=&]/g, "-");
    await page.screenshot({ path: `/tmp/empty-columns-${name}-${count}.png` });
    console.log(`PASS: ${count} records, ${kind === "users" ? "original users list without decorative grid" : "aligned vertical boundaries"}, ${path}`); checked++;
  }
  if (!process.argv[3] || "/settings/project/masters".startsWith(process.argv[3])) {
    count = 100; await page.setViewportSize({ width: 1440, height: 900 });
    await open("/settings/project/masters", "Мастера", "ag");
    assert.equal(Number(await firstAG().locator("[aria-rowcount]").first().getAttribute("aria-rowcount")), 101);
    assert.equal(await firstAG().locator(".ag-empty-grid-columns").evaluate(element => element.hidden || getComputedStyle(element).display === "none" || element.getBoundingClientRect().height <= 0), true, "Long tables do not paint over real rows");
    console.log("PASS: long table overlay hidden; real row count preserved");
  }
  assert.deepEqual(errors, []); assert.ok(requests.length > 0);
  console.log(`PASS: ${checked} empty/few table cases, original users list exception, geometric columns after resize/pin/scroll/mobile and real exports only`);
} catch (error) {
  if (browser) { const pages = browser.contexts().flatMap(context => context.pages()); await pages[0]?.screenshot({ path: "/tmp/empty-columns-failure.png" }).catch(() => {}); }
  throw error;
} finally { await browser?.close(); await server.httpServer.close(); }
