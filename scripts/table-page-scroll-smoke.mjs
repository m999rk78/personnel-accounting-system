// Real PersonnelApp and shared table adapters. Synthetic GET payloads never reach a work database.
// Optional third CLI argument reuses the existing in-memory catalog preview on that URL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const base = process.argv[3] ?? "http://127.0.0.1:3164";
const fixture = process.argv[3] ? null : spawn(process.execPath, [fileURLToPath(new URL("./catalog-spreadsheet-smoke.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
const count = 1000, cases = [
  { key: "catalog-equipment", path: "/settings/general/equipment", grid: ".ag-catalog-grid", identity: "equipmentType", tail: "-1000" },
  { key: "employees", path: "/settings/general/employees", grid: ".ag-employee-grid", identity: "fullName", tail: "-1000" },
  { key: "work-types", path: "/settings/project/work-types", grid: ".work-types-master-grid", identity: "name", tail: "parent-180", minPage: 1500, nested: true },
  { key: "workers-timesheet", path: "/timesheets/workers?month=2026-11", native: true, identity: "timesheet-employee-column", tail: "999" },
  { key: "equipment-timesheet", path: "/timesheets/equipment?month=2026-11", native: true, identity: "equipment-machine-column", tail: "999" },
];
let browser, page, output = "", empty = false;
const errors = [], results = [];
const employees = () => empty ? [] : Array.from({ length: count }, (_, index) => ({ id: index + 1, fullName: `Сотрудник проверки ${String(index + 1).padStart(4, "0")}`,
  employmentType: "ИТР", department: "Учебный участок", position: "Руководитель монтажного участка", source: "manual", siteId: 1, siteName: "Учебный проект А",
  availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
const units = () => employees().map(({ id }) => ({ id, equipmentType: "Кран", brand: "Учебная марка", model: `Модель ${String(id).padStart(4, "0")}`,
  registrationNumber: `ПРОВ-${String(id).padStart(4, "0")}`, inventoryNumber: `TEST-${id}`, organization: "Учебная организация", note: "Синтетическая проверка прокрутки",
  assignedSiteId: 1, assignedSiteName: "Учебный проект А", availabilityStatus: "active", unavailableFrom: null }));
const poll = async (read, check, label) => {
  const deadline = Date.now() + 15_000; let actual;
  while (Date.now() < deadline) { actual = await read(); if (check(actual)) return actual; await new Promise(resolve => setTimeout(resolve, 70)); }
  throw new Error(`Timed out: ${label}. Actual: ${JSON.stringify(actual)}`);
};

try {
  if (fixture) await new Promise((resolve, reject) => {
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
  await page.route("**/api/**", async route => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    if (url.pathname === "/api/roles") return route.fulfill({ json: { roles: [], canManage: false } });
    if (url.pathname === "/api/table-order" && url.searchParams.get("scope") === "users") return route.fulfill({ json: { ids: Array.from({ length: 100 }, (_, index) => index + 1), canWrite: false, hasSavedOrder: false } });
    if (url.pathname === "/api/timesheet") return route.fulfill({ json: { siteId: 1, siteName: "Учебный проект А", month: url.searchParams.get("month"),
      canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees: employees(), entries: [], marks: [] } });
    const response = await route.fetch();
    if (url.pathname !== "/api/data" && url.pathname !== "/api/equipment") return route.fulfill({ response });
    const data = await response.json();
    if (url.pathname === "/api/data") {
      for (const key of ["employees", "projectEmployees", "placementEmployees", "reportEmployees"]) data[key] = employees();
      data.users = empty ? [] : Array.from({ length: 100 }, (_, index) => ({ id: index + 1, fullName: `Прораб проверки ${String(index + 1).padStart(3, "0")}`,
        email: `foreman${index + 1}@page-scroll.example.invalid`, role: "foreman", assignedSiteId: 1, customRoleId: null, status: "active" }));
      data.mainWorkTypes = empty ? [] : Array.from({ length: 80 }, (_, index) => ({ id: 101 + index, siteId: 1, name: `Вид проверки ${String(index + 1).padStart(4, "0")}` }));
      data.subworkTypes = empty ? [] : Array.from({ length: 200 }, (_, index) => ({ id: 500_000 + index, siteId: 1, name: `Подвид проверки ${String(index + 1).padStart(4, "0")}`, mainWorkTypeId: 101 }));
    } else {
      data.units = units(); data.availableUnits = units();
      data.entries = []; data.marks = []; data.dailyTimesheetMarks = [];
      data.canEditTimesheet = data.canCreateTimesheet = data.canUpdateTimesheet = data.canDeleteTimesheet = true;
    }
    await route.fulfill({ response, json: data });
  });

  const stage = () => page.locator(".table-page-scroll-stage").first();
  const owner = () => stage().locator("[data-table-page-viewport]").first();
  const bar = () => stage().locator("[data-table-page-horizontal]").first();
  const geometry = () => stage().evaluate(stage => {
    const frame = stage.querySelector(":scope > .table-page-scroll-frame"), view = frame.querySelector("[data-table-page-viewport]");
    const header = frame.querySelector(".ag-header,table thead tr:first-child th");
    const footer = frame.querySelector(".table-page-scroll-footer") ?? frame.querySelector("tfoot .timesheet-summary-label");
    const horizontal = stage.querySelector(":scope > [data-table-page-horizontal]"), doc = document.scrollingElement;
    const box = element => { const rect = element.getBoundingClientRect(); return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }; };
    const native = Boolean(frame.querySelector("table.timesheet-table"));
    return { windowY: window.scrollY, pageMax: Math.max(0, doc.scrollHeight - window.innerHeight), pageXMax: doc.scrollWidth - window.innerWidth,
      stageCount: document.querySelectorAll(".table-page-scroll-stage").length, height: window.innerHeight,
      stage: box(stage), frame: box(frame), header: header ? box(header) : null, footer: footer ? box(footer) : null,
      overflowY: getComputedStyle(view).overflowY, framePosition: getComputedStyle(frame).position,
      top: view.scrollTop, maxTop: view.scrollHeight - view.clientHeight, left: view.scrollLeft, maxLeft: view.scrollWidth - view.clientWidth,
      barLeft: horizontal.scrollLeft, barMax: horizontal.scrollWidth - horizontal.clientWidth, barVisible: !horizontal.hidden && getComputedStyle(horizontal).display !== "none", bar: box(horizontal),
      rows: native ? [...frame.querySelectorAll("tbody tr[data-virtual-row]")].map(row => row.getAttribute("data-virtual-row"))
        : [...new Set([...frame.querySelectorAll(".ag-row[row-id]")].filter(row => {
          const bounds = row.getBoundingClientRect(), id = row.getAttribute("row-id");
          return bounds.width > 0 && bounds.height > 0 && !row.classList.contains("ag-row-detail") && !id.startsWith("detail_");
        }).map(row => row.getAttribute("row-id")))] };
  });
  const synced = value => value.maxLeft <= 1
    ? !value.barVisible && value.left <= 1
    : value.barVisible && Math.abs(value.left - value.barLeft) <= 1 && Math.abs(value.maxLeft - value.barMax) <= 1;
  const settle = async () => {
    let previous = "", since = Date.now();
    return poll(geometry, value => {
      const positions = JSON.stringify([value.windowY, value.top, value.left, value.barLeft, value.pageMax]);
      if (positions !== previous || !synced(value)) { previous = positions; since = Date.now(); return false; }
      return Date.now() - since >= 180;
    }, "document/table geometry and native scroll input settle");
  };
  const scrollPage = async target => {
    await page.evaluate(target => window.scrollTo(0, target === "end" ? document.scrollingElement.scrollHeight : target), target);
    return settle();
  };
  const scrollX = async offset => {
    await bar().evaluate((element, offset) => { element.scrollLeft = Math.min(offset, element.scrollWidth - element.clientWidth); }, offset);
    return poll(geometry, value => synced(value) && Math.abs(value.left - Math.min(offset, value.maxLeft)) <= 1, "bottom native control and horizontal table offset agree");
  };
  const assertSticky = (value, key) => {
    assert.equal(value.framePosition, "sticky", `${key}: the document uses a sticky working viewport`);
    assert.ok(value.header && value.header.top >= -1 && value.header.top <= 3, `${key}: column headers remain at the page top`);
    if (value.footer) assert.ok(value.footer.top >= value.header.bottom - 1 && value.footer.bottom <= value.height - 8 + 1, `${key}: totals/actions stay visible above the horizontal page rail`);
  };
  const selection = native => stage().evaluate((stage, native) => native
    ? [...stage.querySelectorAll(".timesheet-cell-selected")].map(cell => `${cell.getAttribute("data-timesheet-row")}:${cell.getAttribute("data-timesheet-column")}`).sort()
    : [...stage.querySelectorAll(".ag-excel-selected,.ag-cell-range-selected")].map(cell => `${cell.closest(".ag-row")?.getAttribute("row-id")}:${cell.getAttribute("col-id")}`).sort(), native);
  const pinned = example => stage().locator(example.native ? `thead .${example.identity}` : `.ag-header-cell[col-id="${example.identity}"]`).first().evaluate(element => ({ left: element.getBoundingClientRect().left, width: element.getBoundingClientRect().width }));

  for (const example of cases) {
    empty = false;
    await page.setViewportSize({ width: 1170, height: 953 });
    await page.goto(`${base}${example.path}${example.path.includes("?") ? "&" : "?"}mode=full`);
    await owner().waitFor();
    const initial = await poll(geometry, value => value.pageMax > (example.minPage ?? 2500) && value.rows.length > 0 && value.rows.length < 100 && synced(value), `${example.key}: long data uses a bounded virtual row window`);
    assert.equal(initial.stageCount, 1, `${example.key}: there is one document scroll owner`);
    assert.equal(initial.overflowY, "hidden", `${example.key}: the row viewport has no independent wheel-scrollable vertical area`);
    assert.ok(initial.pageXMax <= 1, `${example.key}: document width remains constrained`);

    await page.mouse.move(1167, 400); await page.mouse.wheel(0, 240);
    await poll(geometry, value => value.windowY > initial.windowY + 100, `${example.key}: wheel over the page margin moves the document`);
    await settle();
    const afterOutside = await geometry(), ownerBox = await owner().boundingBox();
    await owner().hover({ position: { x: Math.min(ownerBox.width - 30, 300), y: Math.min(ownerBox.height - 20, 150) } });
    await page.mouse.wheel(0, 240);
    await poll(geometry, value => value.windowY > afterOutside.windowY + 100 && value.top > afterOutside.top + 100, `${example.key}: wheel over rows moves the same page and virtual offset`);
    assertSticky(await settle(), example.key);

    const header = stage().locator(example.native ? "thead tr:first-child th" : ".ag-header").first();
    const beforeHeaderWheel = await geometry();
    await header.hover(); await page.mouse.wheel(0, 160);
    await poll(geometry, value => value.windowY > beforeHeaderWheel.windowY + 60, `${example.key}: header wheel does not trap the page`);
    await settle();
    await scrollPage("end");
    const end = await poll(geometry, value => value.pageMax - value.windowY <= 2 && value.maxTop - value.top <= 2 && value.rows.some(id => id.endsWith(example.tail)), `${example.key}: the last real row is reachable at document end`);
    assert.ok(end.rows.length < 100, `${example.key}: final rows stay virtualized`);
    assertSticky(end, example.key);
    assert.notDeepEqual(end.rows, initial.rows, `${example.key}: document scrolling replaces rendered virtual rows`);
    await scrollPage(0);

    // Real spreadsheet navigation must propagate ensure-visible requests back to window.scrollY.
    if (!example.nested) {
      const firstCell = example.native ? stage().locator('tbody tr[data-virtual-row] [data-timesheet-column="0"]').first()
        : stage().locator(`.ag-row [col-id="${example.identity}"]`).first();
      await firstCell.click();
      if (example.native) for (let index = 0; index < 25; index++) await page.keyboard.press("ArrowDown");
      else await page.keyboard.press("Control+ArrowDown");
      await poll(geometry, value => value.windowY > 200 && value.top > 100, `${example.key}: keyboard row navigation updates the document`);
      await settle();
      await scrollPage(0);
      await firstCell.click();
    }

    if ((await geometry()).maxLeft > 50) {
      const selected = await selection(example.native), fixed = await pinned(example), beforePointer = await geometry(), bounds = await bar().boundingBox();
      await bar().click({ position: { x: bounds.width - 5, y: bounds.height / 2 } });
      await poll(geometry, value => value.left > 1 && synced(value), `${example.key}: the native bottom rail accepts pointer input`);
      await settle();
      assert.deepEqual(await pinned(example), fixed, `${example.key}: frozen identity columns keep their physical bounds`);
      if (selected.length) assert.deepEqual(await selection(example.native), selected, `${example.key}: the horizontal rail preserves cell selection`);
      assert.ok(Math.abs((await geometry()).windowY - beforePointer.windowY) <= 2, `${example.key}: horizontal input does not jump the page vertically`);
      await scrollX(0);
      await owner().evaluate(element => { element.scrollLeft = 100; });
      await poll(geometry, value => synced(value) && Math.abs(value.left - 100) <= 1, `${example.key}: direct table scrolling updates the native bottom rail`);
      const beforeWheelX = await geometry();
      await owner().hover({ position: { x: Math.min(ownerBox.width - 30, 300), y: 150 } }); await page.mouse.wheel(190, 0);
      await poll(geometry, value => synced(value) && value.left > beforeWheelX.left + 40, `${example.key}: horizontal trackpad input still scrolls columns`);
      await settle();
      await scrollX(Number.MAX_SAFE_INTEGER);
      await scrollX(0);
      const grip = example.native ? stage().locator(`thead .${example.identity} .timesheet-column-resize-handle[data-resize-edge="right"]`).first()
        : stage().locator(`.ag-header-cell[col-id="${example.identity}"] .ag-header-cell-resize`).first();
      const handle = await grip.boundingBox(), beforeResize = await geometry();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + Math.min(18, handle.height / 2)); await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + 45, handle.y + Math.min(18, handle.height / 2), { steps: 12 }); await page.mouse.up();
      await poll(geometry, value => synced(value) && value.maxLeft > beforeResize.maxLeft + 25, `${example.key}: resizing columns updates the native rail's extent`);
    }

    if (example.nested) {
      await stage().locator(".work-types-master-grid .ag-group-contracted").first().click();
      const detail = page.locator(".work-types-detail-grid .ag-grid-viewport").first();
      await detail.waitFor();
      assert.equal(await page.locator(".table-page-scroll-stage").count(), 1, "work-type detail must not introduce a second document owner");
      const beforeNested = await geometry();
      await detail.hover({ position: { x: 250, y: 140 } }); await page.mouse.wheel(0, 180);
      await poll(() => detail.evaluate(element => element.scrollTop), top => top > 60, "nested work-type detail retains its own bounded internal scroll");
      assert.ok(Math.abs((await geometry()).windowY - beforeNested.windowY) <= 2, "scrolling nested details does not move the parent document");
      await stage().locator(".work-types-master-grid .ag-group-expanded").first().click();
      await page.locator(".work-types-search").fill("Нет такого вида проверки");
      await poll(geometry, value => value.rows.length === 0 && value.pageMax <= 2 && value.top <= 1, "quick filtering releases the long master document extent");
      await page.locator(".work-types-search").fill("");
      await poll(geometry, value => value.pageMax > example.minPage && value.rows.length > 0, "clearing the master filter restores the page extent");
    }

    await page.setViewportSize({ width: 843, height: 953 });
    await poll(geometry, value => value.pageXMax <= 1 && synced(value) && (!value.barVisible || Math.abs(value.bar.width - value.frame.width) <= 2), `${example.key}: narrow viewport recalculates the external horizontal bounds`);
    await scrollPage("end");
    assertSticky(await settle(), `${example.key}/843`);
    await page.screenshot({ path: `/private/tmp/table-page-scroll-${example.key}-843.png`, fullPage: false });
    await page.setViewportSize({ width: 1170, height: 953 });
    const large = await scrollPage("end");
    results.push({ key: example.key, pageMax: large.pageMax, rendered: large.rows.length, horizontalRange: large.maxLeft });
    empty = true;
    await page.reload();
    await owner().waitFor();
    const blank = await poll(geometry, value => value.rows.length === 0 && value.pageMax <= 2 && value.windowY <= 1 && value.top <= 1 && synced(value), `${example.key}: empty results clamp the page and remove its long spacer`);
    assert.ok(blank.frame.height > 400, `${example.key}: an empty table still fills the working viewport`);
  }
  // Open the real equipment export flow in a separate tab; inspect without downloading.
  empty = false;
  await page.goto(`${base}/settings/general/equipment?mode=full`);
  await owner().waitFor();
  await poll(geometry, value => value.rows.length > 0 && value.pageMax > 30_000 && synced(value), "equipment export source is ready");
  await page.getByRole("button", { name: "Excel", exact: true }).click();
  const popup = page.context().waitForEvent("page");
  await page.getByRole("menuitem", { name: "Экспорт в Excel", exact: true }).click();
  const sourcePage = page;
  page = await popup;
  const downloads = [];
  page.on("download", download => downloads.push(download.suggestedFilename()));
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await owner().waitFor();
  await page.getByRole("button", { name: "Скачать Excel", exact: true }).waitFor();
  assert.equal(await page.locator(".excel-preview-table tbody tr").count(), count, "Excel preview includes every exported equipment row");
  const previewStart = await poll(geometry, value => value.pageMax > 30_000 && synced(value), "Excel preview uses the real document scroll host");
  await owner().hover({ position: { x: 300, y: 150 } }); await page.mouse.wheel(0, 280);
  await poll(geometry, value => value.windowY > previewStart.windowY + 100 && value.top > 100, "wheel over the export table moves the document");
  await settle();
  await scrollPage("end");
  const previewEnd = await poll(geometry, value => value.pageMax - value.windowY <= 2 && value.maxTop - value.top <= 2, "the final exported row is reachable at document end");
  assertSticky(previewEnd, "Excel preview");
  const finalExportedRow = await page.locator(".excel-preview-table tbody tr").last().boundingBox();
  assert.ok(finalExportedRow.y >= previewEnd.header.bottom - 1 && finalExportedRow.y + finalExportedRow.height <= previewEnd.footer.top + 1, "the final export row is visible above the download panel");
  assert.equal(await page.getByRole("button", { name: "Скачать Excel", exact: true }).isEnabled(), true, "download stays available in the sticky footer");
  await page.setViewportSize({ width: 843, height: 953 });
  await poll(geometry, value => value.maxLeft > 50 && synced(value) && value.bar.bottom >= value.height - 1, "narrow Excel preview has a native horizontal rail at page bottom");
  await scrollX(Number.MAX_SAFE_INTEGER);
  await page.screenshot({ path: "/private/tmp/table-page-scroll-excel-preview-843.png", fullPage: false });
  assert.deepEqual(downloads, [], "previewing and scrolling never starts a download");
  await page.close();
  page = sourcePage;

  // The small native users list has document flow without a virtual table adapter.
  await page.goto(`${base}/settings/general/users?mode=full`);
  const userList = page.locator(".users-page-scroll-list");
  await userList.locator("tbody tr").first().waitFor();
  assert.equal(await userList.locator("tbody tr").count(), 100);
  const usersGeometry = () => userList.evaluate(list => {
    const wrap = list.querySelector(".users-table-wrap"), header = list.querySelector("thead th"), footer = list.parentElement.querySelector(".table-edit-footer");
    const bounds = element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; };
    return { y: window.scrollY, max: document.scrollingElement.scrollHeight - window.innerHeight, overflow: getComputedStyle(wrap).overflowY,
      pageXMax: document.scrollingElement.scrollWidth - window.innerWidth, header: bounds(header), footer: bounds(footer), height: window.innerHeight,
      footerPosition: getComputedStyle(footer).position, rows: list.querySelectorAll("tbody tr").length };
  });
  const usersStart = await poll(usersGeometry, value => value.max > 3000 && value.overflow === "visible", "users list uses document flow");
  await userList.locator("tbody tr").nth(3).hover(); await page.mouse.wheel(0, 440);
  const usersMiddle = await poll(usersGeometry, value => value.y > usersStart.y + 200, "wheel over a user scrolls the document");
  assert.ok(usersMiddle.header.top >= -1 && usersMiddle.header.top <= 3, "users table headers remain sticky");
  assert.equal(usersMiddle.footerPosition, "sticky");
  assert.ok(usersMiddle.footer.bottom <= usersMiddle.height - 11, "users footer stays visible above the page bottom");
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  const usersEnd = await poll(usersGeometry, value => value.max - value.y <= 2, "last user is reachable at document end");
  const lastUser = await userList.locator("tbody tr").last().boundingBox();
  assert.ok(lastUser.y + lastUser.height <= usersEnd.footer.top + 1 && lastUser.y >= usersEnd.header.bottom - 1, "last user is visible above the action panel");
  assert.ok(usersEnd.pageXMax <= 1, "the two user columns do not overflow the document");
  await page.screenshot({ path: "/private/tmp/table-page-scroll-users.png", fullPage: false });
  await page.getByRole("textbox", { name: "Найти пользователя", exact: true }).fill("Нет такого прораба проверки");
  await poll(usersGeometry, value => value.rows === 0 && value.max <= 2 && value.y <= 1, "users search releases its long document range");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
  console.log("PASS: 1,000-row settings and native timesheets scroll the real document with bounded virtualization, sticky headers/totals/actions, pinned columns, native horizontal input, selection, keyboard visibility, resizing, narrow/empty results; nested work-type details keep one internal viewport; actual Excel preview popup and users list scroll without downloads");
} catch (failure) {
  console.error((await page?.locator("body").innerText())?.slice(-12_000));
  await page?.screenshot({ path: "/private/tmp/table-page-scroll-failure.png", fullPage: false });
  throw failure;
} finally { await browser?.close(); fixture?.kill(); }
