// Browser coverage of the real workspace with an in-memory HTTP model only.
// Never connects to an environment file, database, or the developer's server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = 3178;
const base = `http://127.0.0.1:${port}`;
const fixture = spawn(process.execPath, [fileURLToPath(new URL("./personnel-report-smoke.mjs", import.meta.url)), "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
let browser, page, output = "", rejectNextDelete = false;
const errors = [], mutations = [];
const date = "2026-10-27", now = `${date}T16:00:00.000Z`;
const reports = new Map(), entries = new Map();
const actors = { foreman: { id: 10, name: "Алексей Тестовый" }, foreman2: { id: 11, name: "Борис Другая Бригада" }, engineer: { id: 20, name: "Ирина Проверяющая" }, superadmin: { id: 30, name: "Администратор Проверки" }, viewer: { id: 40, name: "Наблюдатель Проверки" } };
function addReport(id, workDate, owner, members) {
  const report = { id, siteId: 1, workDate, ownerUserId: owner.id, ownerName: owner.name, status: "approved", revision: 7, createdAt: now, updatedAt: now, submittedAt: now, reviewedAt: now, reviewedByUserId: 20, reviewedByName: actors.engineer.name, reviewComment: "", rows: [] };
  for (const [rowId, entryId, employeeId, hours] of members) {
    const row = { id: rowId, reportId: id, siteId: 1, workDate, rowOrder: report.rows.length, createdAt: now, updatedAt: now, employeeId, employeeName: employeeId === 1 ? "Иван Тестовый" : "Пётр Примеров", employmentType: "ОПР", department: "Тестовый участок", positionSnapshot: "Монтажник", shiftId: 1, shiftName: "Дневная", zoneId: 1, zoneName: "Зона А", mainWorkTypeId: 1, mainWorkTypeName: "Монтаж", subworkTypeId: 1, subworkTypeName: "Установка конструкций", masterId: 1, masterName: "Анна Демонстрационная", hours, note: `Сохранённая строка ${rowId}`, approvedEntryId: entryId, approvedEntryRevision: 4 };
    report.rows.push(row);
    entries.set(entryId, { ...row, id: entryId, revision: 4, orderReportId: id, orderRowId: rowId, responsibleUserId: owner.id, responsibleUserName: owner.name });
  }
  reports.set(id, report);
}
addReport(701, date, actors.foreman, [[801, 9900, 1, 4], [802, 9901, 2, 3]]);
addReport(702, "2026-10-26", actors.foreman2, [[803, 9902, 1, 5]]);
addReport(703, "2026-10-28", actors.foreman2, [[804, 9903, 2, 6]]);
entries.set(9904, { ...entries.get(9900), id: 9904, orderReportId: undefined, orderRowId: undefined, workDate: "2026-10-25", revision: 9, hours: 2, note: "Старая запись без отчёта" });
const rowKeys = { 9900: "report-701-801", 9901: "report-701-802", 9902: "report-702-803", 9903: "report-703-804", 9904: "approved-9904" };
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output}`)), 60_000);
    const capture = chunk => { output += chunk; if (output.includes(`${base}/`)) { clearTimeout(timer); resolve(); } };
    fixture.stdout.on("data", capture); fixture.stderr.on("data", capture);
    fixture.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); });
    fixture.once("error", error => { clearTimeout(timer); reject(error); });
  });
  browser = await chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  page = await browser.newPage({ viewport: { width: 2400, height: 1050 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/personnel-report?*", async route => {
    const request = route.request();
    const role = /personnel_smoke_role=([^;]+)/.exec((await request.allHeaders()).cookie ?? "")?.[1] ?? "foreman";
    const actor = actors[role];
    const own = item => role !== "foreman" && role !== "foreman2" || (item.ownerUserId ?? item.responsibleUserId) === actor.id;
    await route.fulfill({ json: { reports: [...reports.values()].filter(own), entries: [...entries.values()].filter(own), canReview: role === "engineer" || role === "superadmin", from: "2026-10-01", to: "2026-10-28" } });
  });
  await page.route("**/api/personnel-report", async route => {
    const body = route.request().postDataJSON();
    mutations.push(structuredClone(body));
    if (body.action !== "delete-approved-rows") { errors.push(`Unexpected mutation ${body.action}`); await route.fulfill({ status: 400, json: { error: "Неожиданное действие стенда" } }); return; }
    if (rejectNextDelete) {
      rejectNextDelete = false;
      await route.fulfill({ status: 409, json: { error: "Запись уже изменена в другой вкладке. Обновите таблицу и повторите удаление.", code: "STALE_REPORT" } });
      return;
    }
    const removed = new Set(body.rows.map(row => row.entryId));
    for (const id of removed) entries.delete(id);
    for (const report of reports.values()) {
      const remaining = report.rows.filter(row => !removed.has(row.approvedEntryId));
      if (remaining.length !== report.rows.length) { report.rows = remaining; report.revision++; }
    }
    await route.fulfill({ json: { deletedEntryIds: [...removed] } });
  });
  await page.route("**/api/table-order?*", route => route.fulfill({ json: { ids: [...entries.values()].map(entry => `${entry.workDate}/${rowKeys[entry.id]}`), canWrite: false, hasSavedOrder: false, importIds: [], hasImportOrder: false } }));
  await page.goto(`${base}/personnel-report-smoke.html`);
  const table = page.locator(".personnel-history-table");
  const deleteButton = () => page.getByRole("button", { name: /^Удалить из отчёта \(/ });
  const row = id => table.locator(`.ag-row[row-id="${rowKeys[id]}"]`);
  const select = async ids => {
    for (const id of ids) await row(id).locator('[col-id="ag-Grid-SelectionColumn"] input[type="checkbox"]').check();
  };
  const waitReady = async count => {
    await page.waitForFunction(count => document.querySelectorAll('.personnel-history-table .ag-row [col-id="employeeName"]').length === count, count);
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled);
  };
  const role = async (value, count) => { await page.getByRole("combobox", { name: "Роль в проверке" }).selectOption(value); await waitReady(count); };
  const dialog = () => page.getByRole("dialog", { name: "Удалить записи из отчётов?", exact: true });
  const confirm = () => dialog().getByRole("button", { name: /^Удалить записи \(/ });

  await waitReady(3); // Two linked rows and the foreman's standalone legacy row.
  await select([9900]);
  assert.equal(await deleteButton().count(), 0, "A foreman cannot delete approved records");
  await role("viewer", 5);
  await select([9900]);
  assert.equal(await deleteButton().count(), 0, "A viewer cannot delete approved records");
  await role("engineer", 5);

  // Cancelling a reviewable confirmation is strictly read-only.
  await select([9900]);
  await deleteButton().click();
  await dialog().waitFor();
  await dialog().getByText("Иван Тестовый", { exact: true }).waitFor();
  assert.match(await dialog().innerText(), /27\.10\.2026/);
  await dialog().getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(mutations.length, 0);
  assert.equal(entries.size, 5);

  // Existing unsaved corrections must never be silently discarded by deletion.
  await row(9900).locator('[col-id="note"]').dblclick();
  const noteInput = row(9900).locator('[col-id="note"] textarea, [col-id="note"] input').first();
  await noteInput.fill("Несохранённое исправление");
  await noteInput.press("Enter");
  await page.getByRole("button", { name: "Отменить изменения", exact: true }).waitFor();
  await deleteButton().click();
  assert.equal(mutations.length, 0);
  if (await dialog().isVisible()) {
    assert.equal(await confirm().isEnabled(), false);
    assert.match(await dialog().innerText(), /сохран|отмен/i);
    await dialog().getByRole("button", { name: "Отмена", exact: true }).click();
  } else {
    await page.getByRole("alert").filter({ hasText: /сохран|отмен/i }).waitFor();
  }
  assert.match(await row(9900).locator('[col-id="note"]').innerText(), /Несохранённое исправление/);
  await page.getByRole("button", { name: "Отменить изменения", exact: true }).click();

  // Only the selected occurrence is removed: the same employee on another day remains.
  await select([9900]);
  await deleteButton().click();
  await confirm().click();
  await waitReady(4);
  assert.deepEqual(mutations[0], { action: "delete-approved-rows", siteId: 1, rows: [{ entryId: 9900, revision: 4, reportId: 701, reportRevision: 7 }] });
  assert.equal(entries.has(9900), false);
  assert.equal(entries.has(9902), true, "The same employee's record on another day survives");
  assert.deepEqual(reports.get(701).rows.map(item => item.id), [802]);
  assert.equal(reports.get(701).status, "approved");

  // One batch covers several dates, owners, the last report row, and legacy data.
  await select([9901, 9902, 9904]);
  await deleteButton().click();
  await dialog().waitFor();
  await page.setViewportSize({ width: 843, height: 953 });
  const bounds = await dialog().boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 843, "Confirmation fits a narrow workspace");
  assert.deepEqual(await confirm().evaluate(button => ({ background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color })), { background: "rgb(180, 35, 24)", color: "rgb(255, 255, 255)" }, "The destructive confirmation has a red background and white text");
  await page.screenshot({ path: "/private/tmp/personnel-report-approved-delete-dialog.png", fullPage: true });
  await page.setViewportSize({ width: 2400, height: 1050 });
  rejectNextDelete = true;
  await confirm().click();
  await dialog().getByRole("alert").filter({ hasText: /другой вкладке/ }).waitFor();
  assert.equal(await dialog().isVisible(), true, "Conflict stays visible in the confirmation");
  assert.equal(entries.size, 4, "Conflict does not partially delete rows");
  assert.equal(await row(9901).count(), 1);
  await dialog().getByRole("button", { name: "Отмена", exact: true }).click();
  await deleteButton().click();
  await confirm().click();
  await waitReady(1);
  assert.deepEqual(mutations[2], { action: "delete-approved-rows", siteId: 1, rows: [
    { entryId: 9901, revision: 4, reportId: 701, reportRevision: 8 },
    { entryId: 9902, revision: 4, reportId: 702, reportRevision: 7 },
    { entryId: 9904, revision: 9 },
  ] });
  assert.deepEqual([...entries.keys()], [9903]);
  for (const id of [701, 702]) { assert.equal(reports.get(id).rows.length, 0); assert.equal(reports.get(id).status, "approved"); }
  assert.equal(await deleteButton().count(), 0, "Selection is cleared after success");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/private/tmp/personnel-report-approved-delete.png", fullPage: true });
  console.log("PASS: approved row selection/cancel; foreman/viewer restrictions; unsaved edits; exact occurrence; several dates/owners; last row; legacy rows; atomic conflict; revision payloads");
} catch (failure) {
  console.error((await page?.locator("body").innerText())?.slice(-12_000));
  await page?.screenshot({ path: "/private/tmp/personnel-report-approved-delete-failure.png", fullPage: true });
  throw failure;
} finally {
  await browser?.close();
  fixture.kill();
}
