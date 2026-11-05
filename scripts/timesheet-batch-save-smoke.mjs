// Actual application, mocked HTTP only. No .env, credentials or database access.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const config = { configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "timesheet-batch-save-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/timesheet-batch-save.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3156, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = [], writes = [], records = new Map(), failures = new Map();
  page.on("pageerror", error => errors.push(error.message));
  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const employees = ["Иванов Иван", "Петров Пётр", "Сидоров Сергей"].map((fullName, index) => ({ id: index + 1, fullName, employmentType: "ОПР", department: "МУТТ", position: "Монтажник", source: "manual", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
  const units = employees.map(({ id }) => ({ id, name: `Кран ${id}`, equipmentType: "Кран", brand: "Тест", model: `Модель ${id}`, registrationNumber: `ТЕСТ${id}`, inventoryNumber: `TEST-${id}`, organization: "Учебная организация", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", unavailableFrom: null, note: "" }));
  const options = { shifts: [{ id: 1, name: "день" }], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [] };
  const recordKey = (kind, id, date) => `${kind}:${id}:${date}`;
  const lostReplies = new Set();
  let pending = 0, maxPending = 0;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") {
      assert.equal(request.method(), "POST");
      assert.ok(["/api/timesheet", "/api/equipment"].includes(url.pathname), `Unexpected mutation ${url.pathname}`);
      const body = request.postDataJSON(), kind = url.pathname === "/api/timesheet" ? "workers" : "equipment";
      if (kind === "equipment") assert.equal(body.action, "save-timesheet-mark");
      assert.equal(body.siteId, 1);
      const id = body.employeeId ?? body.equipmentId, key = recordKey(kind, id, body.workDate);
      writes.push({ ...body, kind, key });
      pending++; maxPending = Math.max(maxPending, pending);
      await new Promise(resolve => setTimeout(resolve, 30));
      pending--;
      if ((failures.get(key) ?? 0) > 0) {
        failures.set(key, failures.get(key) - 1);
        return route.fulfill({ status: 503, json: { error: "Учебный сбой сохранения" } });
      }
      const clear = kind === "workers" ? !body.value : body.clear;
      let mark;
      if (clear) records.delete(key);
      else {
        mark = kind === "workers"
          ? { employeeId: id, workDate: body.workDate, hours: /^\d+$/.test(body.value) ? Number(body.value) : null, code: /^\d+$/.test(body.value) ? null : body.value, note: body.note ?? "", updatedBy: "Проверка" }
          : { equipmentId: id, workDate: body.workDate, productiveHours: body.productiveHours, downtimeHours: body.downtimeHours, note: body.note ?? "", updatedBy: "Проверка" };
        records.set(key, mark);
      }
      if (lostReplies.delete(key)) return route.abort("failed");
      return route.fulfill({ json: clear ? { deleted: true } : { mark } });
    }
    let body;
    if (url.pathname === "/api/table-order") body = { ids: [1, 2, 3], canWrite: false, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report")) body = { reports: [], entries: [], canReview: true, availabilityMarks: [] };
    else if (url.pathname === "/api/timesheet") body = { siteId: 1, siteName: sites[0].name, month: url.searchParams.get("month"), canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees, entries: [], marks: [...records].filter(([key]) => key.startsWith("workers:")).map(([, mark]) => mark) };
    else if (url.pathname === "/api/equipment") body = { siteId: 1, siteName: sites[0].name, workDate: "2026-11-05", month: url.searchParams.get("month"), canEditDaily: true, canCreateDaily: true, canUpdateDaily: true, canDeleteDaily: true, canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, canManageRegistry: true, canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true, canManageAssignments: true, canCreateAssignments: true, canUpdateAssignments: true, canDeleteAssignments: true, currentUserRole: "superadmin", currentUserName: "Проверка сохранения", reportSubmitted: false, foremanProgress: [], units, availableUnits: units, sites, entries: [], marks: [...records].filter(([key]) => key.startsWith("equipment:")).map(([, mark]) => mark), dailyTimesheetMarks: [], filledDates: [], ...options };
    else if (url.pathname === "/api/roles") body = { roles: [], canManage: true };
    else {
      assert.equal(url.pathname, "/api/data");
      body = { sites, employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees, positionCatalog: [], employmentTypes: [{ id: 1, name: "ОПР" }], departments: [{ id: 1, name: "МУТТ" }], positions: [{ id: 1, name: "Монтажник" }], users: [], ...options, entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false, projectStats: [], bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } } };
    }
    await route.fulfill({ json: body });
  });

  const cell = column => page.locator(`[data-timesheet-row="0"][data-timesheet-column="${column}"]`);
  const status = () => page.locator(".timesheet-save-status");
  const retry = () => page.locator(".timesheet-save-retry");
  async function waitText(pattern) { await page.waitForFunction(source => new RegExp(source).test(document.querySelector(".timesheet-save-status")?.textContent ?? ""), pattern.source); }
  async function paste(text, column = 0) {
    await cell(column).click();
    await page.locator(".timesheet-grid-shell").evaluate((element, value) => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    }, text);
  }
  for (const kind of ["workers", "equipment"]) {
    records.clear(); failures.clear(); lostReplies.clear(); writes.length = 0; maxPending = 0;
    const middle = recordKey(kind, 1, "2026-11-02"); failures.set(middle, 2);
    const path = `/timesheets/${kind}?month=2026-11`;
    await page.goto(`http://127.0.0.1:3156/timesheet-batch-save.html?route=${encodeURIComponent(path)}`);
    await cell(0).waitFor();
    await paste("8\t7\t6");
    await waitText(/Сохранено ячеек: 2 из 3/);
    assert.equal(writes.length, 3);
    assert.equal(await cell(0).getAttribute("data-save-state"), "saved");
    assert.equal(await cell(1).getAttribute("data-save-state"), "error");
    assert.equal(await cell(2).getAttribute("data-save-state"), "saved");
    assert.match(await cell(0).innerText(), /8/); assert.match(await cell(2).innerText(), /6/);
    assert.equal(records.size, 2);
    await retry().click(); await waitText(/Сохранено ячеек: 2 из 3/);
    await page.waitForFunction(() => !document.querySelector(".timesheet-save-retry")?.disabled);
    assert.equal(writes.length, 4); assert.equal(writes[3].key, middle);
    await retry().click(); await waitText(/Сохранено ячеек: 3 из 3/);
    assert.equal(writes.length, 5); assert.equal(writes[4].key, middle);
    assert.equal(writes.filter(write => write.workDate === "2026-11-01").length, 1);
    assert.equal(writes.filter(write => write.workDate === "2026-11-03").length, 1);
    assert.equal(await retry().count(), 0); assert.equal(records.size, 3);
    for (let column = 0; column < 3; column++) assert.equal(await cell(column).getAttribute("data-save-state"), "saved");
    await page.screenshot({ path: `/tmp/timesheet-batch-save-${kind}-success.png` });
    console.log(`PASS: ${kind}: partial success, persistent failure, retry touches failed cell only`);

    // Retry belongs to the same clipboard operation, so one Undo restores all three original cells.
    await cell(0).click(); await page.keyboard.press("ControlOrMeta+z");
    await waitText(/Сохранено ячеек: 3 из 3/);
    await page.waitForFunction(() => document.querySelector(".timesheet-save-status")?.getAttribute("aria-busy") === "false");
    assert.equal(writes.length, 8); assert.equal(records.size, 0);
    assert.ok(writes.slice(5).every(write => kind === "workers" ? write.value === "" : write.clear === true));
    console.log(`PASS: ${kind}: one Undo includes only confirmed initial and retried cells`);

    // A manual correction must remove the stale failed request before Retry can overwrite it.
    failures.set(middle, 1); await paste("4", 1); await waitText(/Не подтверждено сохранение: 1/);
    await cell(1).dblclick();
    const input = cell(1).locator("input"); await input.fill("9"); await input.press("Enter");
    await input.waitFor({ state: "detached" });
    assert.equal(await retry().count(), 0);
    assert.equal(await cell(1).getAttribute("data-save-state"), null);
    const corrected = records.get(middle); assert.equal(corrected.hours ?? corrected.productiveHours, 9);
    console.log(`PASS: ${kind}: manual correction removes stale retry job`);

    // A malformed cell is reported individually while valid siblings still save.
    const beforeInvalid = writes.length;
    await paste("8\tbad\t6"); await waitText(/Сохранено ячеек: 2 из 3/);
    assert.equal(writes.length, beforeInvalid + 2, "Invalid value must never reach the API");
    assert.equal(await cell(1).getAttribute("data-save-state"), "error");
    await page.locator(".timesheet-save-failures summary").click();
    assert.match(await page.locator(".timesheet-save-failure-list").innerText(), /bad/i);
    await cell(1).dblclick(); await cell(1).locator("input").fill("9"); await cell(1).locator("input").press("Enter");
    await cell(1).locator("input").waitFor({ state: "detached" });
    assert.equal(await retry().count(), 0);
    console.log(`PASS: ${kind}: invalid pasted values are identified without losing valid sibling saves`);

    const beforeDelete = writes.length;
    failures.set(middle, 1);
    await cell(0).click(); await cell(2).click({ modifiers: ["Shift"] }); await page.keyboard.press("Delete");
    await waitText(/Сохранено ячеек: 2 из 3/);
    assert.equal(writes.length, beforeDelete + 3); assert.equal(records.size, 1);
    await retry().click(); await waitText(/Сохранено ячеек: 3 из 3/);
    assert.equal(writes.length, beforeDelete + 4); assert.equal(writes.at(-1).key, middle); assert.equal(records.size, 0);
    console.log(`PASS: ${kind}: deleting a range and retrying clears only its failed cell`);

    // The server may commit before the response is lost. Clearing an uncertain
    // blank cell must contact the server even though no local mark was received.
    for (const correction of ["paste", "inline", "delete"]) {
      const beforeLostReply = writes.length;
      lostReplies.add(middle); await paste("5", 1);
      await waitText(/Не подтверждено сохранение: 1/);
      assert.ok(records.has(middle), "Synthetic server committed before losing its reply");
      if (correction === "paste") {
        await paste("\n", 1); await waitText(/Сохранено ячеек: 1 из 1/);
      } else if (correction === "delete") {
        await cell(1).click(); await page.keyboard.press("Delete");
        await waitText(/Сохранено ячеек: 1 из 1/);
      } else {
        await cell(1).dblclick(); await cell(1).locator("input").fill("");
        await cell(1).locator("input").press("Enter");
        await cell(1).locator("input").waitFor({ state: "detached" });
      }
      assert.equal(writes.length, beforeLostReply + 2, "Correction must send a real clear request");
      assert.equal(records.has(middle), false);
      assert.equal(await retry().count(), 0);
    }
    console.log(`PASS: ${kind}: clearing an unacknowledged committed cell through paste, inline editing and Delete reaches the server`);

    failures.set(middle, 1); await paste("5", 1); await waitText(/Не подтверждено сохранение: 1/);
    await page.setViewportSize({ width: 843, height: 953 });
    const box = await status().boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 843 + 1, "Status panel fits narrow viewport");
    await page.screenshot({ path: `/tmp/timesheet-batch-save-${kind}-failure-843.png` });
    await page.getByRole("button", { name: "Следующий месяц", exact: true }).click();
    const dialog = page.getByRole("alertdialog"); await dialog.waitFor();
    await dialog.getByRole("button", { name: "Остаться", exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("month"), "2026-11");
    assert.equal(await retry().count(), 1);
    await page.getByRole("button", { name: "Следующий месяц", exact: true }).click();
    await dialog.getByRole("button", { name: /Сменить без сохранения|Перейти без сохранения/ }).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("month") === "2026-12");
    await cell(0).waitFor(); assert.equal(await retry().count(), 0);
    assert.equal(await page.locator('[data-save-state="error"]').count(), 0);
    assert.ok(maxPending <= 4, "Bounded save concurrency");
    console.log(`PASS: ${kind}: month navigation warns about failed edits and resets old retry state`);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  assert.deepEqual(errors, [], "No runtime errors");
  console.log("PASS: both actual timesheets save and retry with synthetic requests only");
} finally { await browser?.close(); await server.httpServer.close(); }
