// Real app + synthetic read-only API. Never loads .env or reaches a database.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = Number(process.argv[3] ?? 3173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Укажите корректный порт стенда.");
const config = { configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "table-header-alignment-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/workspace-header.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 954 } });
  page.setDefaultTimeout(12_000);
  const errors = [], writes = [], checked = [];
  page.on("pageerror", error => errors.push(error.message));
  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const stamp = "2026-11-04T10:00:00.000Z";
  const employees = ["Иванов Сергей Петрович", "Петров Андрей Николаевич"].map((fullName, index) => ({ id: index + 1,
    fullName, employmentType: index ? "ИТР" : "ОПР", department: index ? "МУСК" : "МУТТ", position: index ? "Мастер" : "Монтажник",
    source: "manual", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
  const units = employees.map(({ id }) => ({ id, name: `Кран ${id}`, equipmentType: "Кран", brand: "Тест", model: `Модель ${id}`,
    registrationNumber: `ТЕСТ${id}`, inventoryNumber: `TEST-${id}`, organization: `Организация ${id}`, siteId: 1,
    siteName: sites[0].name, availabilityStatus: "active", unavailableFrom: null, note: "" }));
  const options = { shifts: [{ id: 1, name: "день" }], zones: [{ id: 1, name: "Зона 1" }, { id: 2, name: "Зона 2" }],
    mainWorkTypes: [{ id: 1, name: "Монтаж" }, { id: 2, name: "Подготовка" }],
    subworkTypes: [{ id: 1, name: "Сборка", mainWorkTypeId: 1 }, { id: 2, name: "Разметка", mainWorkTypeId: 2 }],
    masters: [{ id: 2, name: employees[1].fullName, employeeId: 2 }] };
  const users = [{ id: 1, fullName: "Проверка шапок", email: "header@example.invalid", role: "superadmin", assignedSiteId: null,
    projectAccess: { mode: "all", siteIds: [] }, status: "active" }];
  const entries = equipment => employees.map((employee, index) => ({ id: employee.id, siteId: 1, workDate: "2026-11-04",
    shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 2, hours: index ? 6 : 8, note: "",
    shiftName: "день", zoneName: "Зона 1", mainWorkTypeName: "Монтаж", subworkTypeName: "Сборка", masterName: employees[1].fullName,
    createdAt: stamp, updatedAt: stamp, rowOrder: employee.id, revision: 1, responsibleUserId: 1, responsibleUserName: users[0].fullName,
    ...(equipment ? { equipmentId: employee.id, equipmentName: `Кран ${employee.id}`, equipmentType: "Кран", organization: units[index].organization,
      brand: "Тест", model: units[index].model, registrationNumber: units[index].registrationNumber }
      : { employeeId: employee.id, employeeName: employee.fullName, employmentType: employee.employmentType,
        department: employee.department, positionSnapshot: employee.position }) }));
  const data = { sites, employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees,
    positionCatalog: employees.map(({ id, employmentType, department, position }) => ({ id, employmentType, department, position })),
    employmentTypes: [{ id: 1, name: "ОПР" }, { id: 2, name: "ИТР" }], departments: [{ id: 1, name: "МУТТ" }, { id: 2, name: "МУСК" }],
    positions: employees.map(({ id, position }) => ({ id, name: position })), users, ...options,
    entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false,
    projectStats: [{ siteId: 1, employeeCount: 2, foremanCount: 1 }], bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } } };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") { writes.push(`${request.method()} ${url.pathname}`); await route.fulfill({ status: 403, json: { error: "Запись отключена на стенде." } }); return; }
    let body;
    if (url.pathname === "/api/data") body = data;
    else if (url.pathname === "/api/table-order") body = { ids: [], canWrite: false, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report")) body = { reports: [], entries: entries(url.pathname === "/api/equipment-report"), canReview: true, availabilityMarks: [], from: null, to: null };
    else if (url.pathname === "/api/personnel-report-draft") body = { revision: 0, snapshot: null };
    else if (url.pathname === "/api/timesheet") body = { siteId: 1, siteName: sites[0].name, month: url.searchParams.get("month"), canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees, entries: [], marks: [] };
    else if (url.pathname === "/api/equipment") body = { siteId: 1, siteName: sites[0].name, workDate: url.searchParams.get("date"), month: url.searchParams.get("month"),
      canEditDaily: true, canCreateDaily: true, canUpdateDaily: true, canDeleteDaily: true, canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true,
      canManageRegistry: true, canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true, canManageAssignments: true, canCreateAssignments: true, canUpdateAssignments: true, canDeleteAssignments: true,
      currentUserRole: "superadmin", currentUserName: users[0].fullName, reportSubmitted: false, foremanProgress: [], units, availableUnits: units, sites,
      entries: [], marks: [], dailyTimesheetMarks: [], filledDates: [], ...options };
    else if (url.pathname === "/api/roles") body = { roles: [], canManage: true };
    else if (url.pathname === "/api/access-rights") body = { users, sites, canManage: true, currentUserId: 1 };
    else if (url.pathname === "/api/audit-log") body = { events: [] };
    else { await route.fulfill({ status: 404, json: { error: `Неизвестный тестовый API: ${url.pathname}` } }); return; }
    await route.fulfill({ json: body });
  });
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const near = (actual, expected, label, tolerance = 1.5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} !== ${expected}`);
  const routes = [
    ["/settings/general/employees", "Сотрудники"], ["/settings/general/positions", "Список должностей"],
    ["/settings/general/equipment", "Реестр техники"], ["/settings/general/projects", "Проекты", "cards"],
    ["/settings/project/employees", "Сотрудники проекта"], ["/settings/project/equipment", "Техника проекта"],
    ["/settings/project/zones", "Зоны"], ["/settings/project/work-types", "Виды и подвиды работ"],
    ["/settings/project/subwork-types", "Виды и подвиды работ"], ["/settings/project/masters", "Мастера"],
    ["/reports/workers?date=2026-11-04", "Отчёт персонала"], ["/reports/equipment?date=2026-11-04", "Отчёт техники"],
    ["/settings/general/users", "Пользователи и права", "users"], ["/settings/general/access", "Пользователи и права", "roles"],
  ];
  async function geometry(label, allowNoTable = false) {
    await frames();
    const result = await page.evaluate(() => {
      const visible = element => { const r = element.getBoundingClientRect(), style = getComputedStyle(element); return r.width > .1 && r.height > .1 && style.display !== "none" && style.visibility !== "hidden"; };
      const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const glyph = element => { const range = document.createRange(); range.selectNodeContents(element); return box(range); };
      const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
      const cells = [...document.querySelectorAll(".page-content .ag-grid-shell .ag-header-cell")].filter(visible).flatMap(cell => {
        const caption = cell.querySelector(".ag-pinnable-header > span:first-child") ?? cell.querySelector(".ag-header-cell-text");
        if (!caption?.textContent?.trim()) return [];
        const rect = box(cell), text = glyph(caption), clip = box(caption);
        const truncated = caption.scrollWidth > caption.clientWidth + 1 || text.width > clip.width + 1;
        const textBox = truncated ? clip : text;
        const icons = [...cell.querySelectorAll(".ag-header-tools svg, .ag-sort-indicator-container .ag-icon, .ag-sort-indicator-container .ag-sort-order, .ag-header-cell-filter-button .ag-icon, .ag-header-cell-menu-button .ag-icon")].filter(visible).map(box);
        return [{ text: caption.textContent.trim(), column: cell.getAttribute("col-id"), center: (rect.left + rect.right) / 2,
          captionCenter: (textBox.left + textBox.right) / 2, truncated,
          overlaps: !truncated && icons.some(icon => overlaps(text, icon)) }];
      });
      const native = [...document.querySelectorAll(".page-content .users-table thead th, .page-content .permission-matrix-header [role=columnheader]")].filter(visible).flatMap(cell => {
        if (!cell.textContent.trim()) return [];
        const rect = box(cell), text = glyph(cell);
        return [{ text: cell.textContent.trim(), center: (rect.left + rect.right) / 2,
          captionCenter: text.width ? (text.left + text.right) / 2 : (rect.left + rect.right) / 2,
          style: getComputedStyle(cell).textAlign }];
      });
      return { cells, native };
    });
    if (!allowNoTable && result.cells.length + result.native.length === 0) {
      console.log(await page.locator(".page-content .ag-grid-shell .ag-header-cell").evaluateAll(cells => cells.slice(0, 5).map(cell => ({ html: cell.outerHTML.slice(0, 2800), box: cell.getBoundingClientRect().toJSON(), visibility: getComputedStyle(cell).visibility }))));
      await page.screenshot({ path: "/tmp/table-header-alignment-debug.png" });
    }
    assert.ok(allowNoTable || result.cells.length + result.native.length > 0, `${label}: expected a table header`);
    for (const cell of [...result.cells, ...result.native]) near(cell.captionCenter, cell.center, `${label}: caption '${cell.text}' is centered`);
    for (const cell of result.cells) assert.equal(cell.overlaps, false, `${label}: icons do not cover '${cell.text}'`);
    return result;
  }
  async function open(path, title, kind) {
    await page.goto(`http://127.0.0.1:${port}/workspace-header.html?route=${encodeURIComponent(path)}`);
    await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
    if (kind === "cards") return;
    if (kind === "users") await page.locator(".users-table thead").waitFor();
    else if (kind === "roles") await page.locator(".permission-matrix-header").waitFor();
    else await page.locator(".page-content .ag-grid-shell .ag-header-cell-text").filter({ hasText: /\S/ }).first().waitFor();
    await frames();
  }
  for (const viewport of [{ width: 1440, height: 954 }, { width: 831, height: 954 }]) {
    await page.setViewportSize(viewport);
    for (const [path, title, kind] of routes) {
      if (process.argv[4] && !process.argv[4].split(",").includes(path)) continue;
      await open(path, title, kind);
      const observed = await geometry(`${viewport.width} ${path}`, kind === "cards");
      checked.push({ route: path, viewport: viewport.width, headers: observed.cells.length + observed.native.length });
      if (kind === "users") {
        const align = await page.locator(".users-table tbody td").last().evaluate(cell => getComputedStyle(cell).textAlign);
        assert.ok(["left", "start"].includes(align), "Centering users headers must not center/change their data rows");
      }
      if (path === "/settings/general/employees" || path === "/settings/project/equipment") {
        if (path === "/settings/project/equipment") {
          // Headers outside the visible column viewport are virtualised away.
          await page.locator(".page-content .ag-grid-shell .ag-grid-viewport").first().evaluate(viewport => { viewport.scrollLeft = 400; });
          await frames();
        }
        const button = path === "/settings/project/equipment"
          ? page.locator('.page-content .ag-header-cell[col-id="organization"] .ag-column-filter')
          : page.locator(".page-content .ag-column-filter").first();
        await button.scrollIntoViewIfNeeded(); await button.click();
        const popup = page.locator(".ag-filter-menu:visible"); await popup.waitFor();
        const choice = popup.locator(".ag-set-filter-item .ag-checkbox-label");
        await choice.last().waitFor();
        if (await choice.count() > 2) {
          await choice.last().click();
          const apply = popup.getByRole("button", { name: "Применить", exact: true });
          if (await apply.count()) await apply.click(); else await page.keyboard.press("Escape");
          await geometry(`${path}: active filter`);
        } else await page.keyboard.press("Escape");
      }
      if (path === "/settings/general/employees" || path === "/reports/equipment?date=2026-11-04") {
        const captions = page.locator(".page-content .ag-pinnable-header > span:first-child");
        await captions.first().click(); await frames();
        await geometry(`${path}: native sort indicator`);
        if (await captions.count() > 1) { await captions.nth(1).click({ modifiers: ["Shift"] }); await frames(); await geometry(`${path}: multi-sort indicators`); }
        const resize = page.locator(".page-content .ag-header-cell:has(.ag-pinnable-header) .ag-header-cell-resize").first();
        await resize.scrollIntoViewIfNeeded(); const rect = await resize.boundingBox();
        assert.ok(rect); await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
        await page.mouse.move(rect.x + rect.width / 2 + 42, rect.y + rect.height / 2, { steps: 6 }); await page.mouse.up(); await frames();
        await geometry(`${path}: resized column`);
        if (viewport.width === 831) await page.screenshot({ path: `/tmp/table-header-alignment-${path.includes("equipment") ? "equipment-report" : "employees"}.png` });
      }
      if (path === "/settings/project/employees") {
        // A single full-width column is automatically unpinned by AG Grid to
        // preserve its center viewport; exercise a normal multi-column grid.
        const pin = page.locator('.page-content .ag-header-cell[col-id="department"] .ag-column-pin');
        if (await pin.count()) {
          const original = await pin.getAttribute("aria-label"); await pin.click(); await frames();
          const changed = page.locator('.page-content .ag-header-cell[col-id="department"] .ag-column-pin');
          assert.notEqual(await changed.getAttribute("aria-label"), original, "Pin/unpin controls remain functional");
          await geometry(`${path}: pinned column`);
          await changed.click(); await frames(); await geometry(`${path}: unpinned column`);
        }
      }
    }
  }
  assert.deepEqual(writes, [], "Header layout changes must never write business data");
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log(JSON.stringify({ checks: checked, interactions: "filter, active state, sort/multi-sort, pin/unpin, resize", writes: writes.length }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
