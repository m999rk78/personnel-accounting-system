// Real personnel/equipment workspaces with isolated synthetic HTTP models.
// No environment files, production APIs, credentials, or database clients.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const configurations = [
  { kind: "personnel", port: 3180, entity: "employeeName" },
  { kind: "equipment", port: 3181, entity: "equipment" },
];

async function check({ kind, port, entity }) {
  const base = `http://127.0.0.1:${port}`;
  const fixture = spawn(process.execPath, [fileURLToPath(new URL(`./${kind}-report-smoke.mjs`, import.meta.url)), "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", page, context, rejectSave = false, rejectReportId = null, saveGate = null, releaseSave = null;
  const reports = new Map(), entries = new Map(), buffers = new Map(), mutations = [], errors = [];
  const stamp = "2026-10-27T12:00:00.000Z";
  const owners = { foreman: { id: 10, name: "Алексей Тестовый" }, foreman2: { id: 11, name: "Борис Другая Бригада" }, engineer: { id: 20, name: "Ирина Проверяющая" }, viewer: { id: 40, name: "Наблюдатель Проверки" }, delete_only: { id: 42, name: "Удаление без редактирования" } };
  function add(id, status, date, owner, entryId = null) {
    const row = { id: id + 100, reportId: id, siteId: 1, workDate: date, rowOrder: 0, createdAt: stamp, updatedAt: stamp,
      employeeId: 1, employeeName: "Иван Тестовый", employmentType: "ОПР", department: "Тестовый участок", positionSnapshot: "Монтажник", masterId: 1, masterName: "Анна Демонстрационная",
      equipmentId: 1, equipmentName: "ЭК-1 // ТЕСТ-001", equipmentType: "Экскаватор", organization: "Учебная механизация", brand: "Учебный", model: "ЭК-1", registrationNumber: "ТЕСТ-001",
      shiftId: 1, shiftName: "Дневная", zoneId: 1, zoneName: "Зона А", mainWorkTypeId: 1, mainWorkTypeName: "Монтаж", subworkTypeId: 1, subworkTypeName: "Установка конструкций", hours: 4,
      note: `Исходная запись ${id}`, approvedEntryId: entryId, approvedEntryRevision: entryId ? 4 : undefined };
    const report = { id, siteId: 1, workDate: date, ownerUserId: owner.id, ownerName: owner.name, status, revision: 7, createdAt: stamp, updatedAt: stamp,
      submittedAt: status === "draft" ? null : stamp, reviewedAt: status === "approved" ? stamp : null, reviewedByUserId: status === "approved" ? 20 : null,
      reviewedByName: status === "approved" ? owners.engineer.name : null, reviewComment: "", rows: [row] };
    reports.set(id, report);
    if (entryId) entries.set(entryId, { ...row, id: entryId, revision: 4, orderReportId: id, orderRowId: row.id, responsibleUserId: owner.id, responsibleUserName: owner.name });
  }
  add(701, "approved", "2026-10-27", owners.foreman2, 9900);
  add(702, "submitted", "2026-10-26", owners.foreman);
  add(703, "submitted", "2026-10-25", owners.foreman2);
  add(704, "draft", "2026-10-24", owners.engineer);
  entries.set(9904, { ...entries.get(9900), id: 9904, revision: 9, orderReportId: undefined, orderRowId: undefined, workDate: "2026-10-23", note: "Старая запись" });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${output}`)), 60_000);
      const capture = chunk => { output += chunk; if (output.includes(`${base}/`)) { clearTimeout(timer); resolve(); } };
      fixture.stdout.on("data", capture); fixture.stderr.on("data", capture);
      fixture.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); });
      fixture.once("error", error => { clearTimeout(timer); reject(error); });
    });
    context = await browser.newContext({ viewport: { width: 3500, height: 1100 }, hasTouch: true });
    page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(error.message));
    const roleOf = async request => new RegExp(`${kind}_smoke_role=([^;]+)`).exec((await request.allHeaders()).cookie ?? "")?.[1] ?? "foreman";
    await page.route(`**/api/${kind}-report?*`, async route => {
      const role = await roleOf(route.request()), actor = owners[role];
      const own = report => !["draft", "rejected"].includes(report.status) || report.ownerUserId === actor.id;
      await route.fulfill({ json: { reports: [...reports.values()].filter(own), entries: [...entries.values()], canReview: role === "engineer", availabilityMarks: [], from: "2026-10-01", to: "2026-10-30" } });
    });
    await page.route(`**/api/${kind}-report`, async route => {
      const body = route.request().postDataJSON(); mutations.push(structuredClone(body));
      assert.ok(["save", "save-approved-entry"].includes(body.action), `Unexpected report mutation: ${body.action}`);
      const gate = saveGate; saveGate = null; if (gate) await gate;
      if (rejectSave || body.reportId === rejectReportId) { rejectSave = false; rejectReportId = null; await route.fulfill({ status: 409, json: { error: "Тестовая ошибка сохранения. Повторите попытку.", code: "STALE_REPORT" } }); return; }
      if (body.action === "save-approved-entry") {
        const entry = entries.get(body.entryId); assert.equal(body.revision, entry.revision);
        const updated = { ...entry, ...body.row, id: entry.id, revision: entry.revision + 1 };
        entries.set(entry.id, updated); await route.fulfill({ json: { entry: updated } }); return;
      }
      const previous = reports.get(body.reportId); assert.ok(previous, "Only an existing, intentionally edited report is saved");
      assert.equal(body.revision, previous.revision);
      const next = { ...previous, revision: previous.revision + 1, rows: body.rows.map(input => {
        const original = previous.rows.find(row => row.id === input.id); assert.ok(original);
        const row = { ...original, ...input };
        if (row.approvedEntryId) {
          const entry = entries.get(row.approvedEntryId);
          row.approvedEntryRevision = entry.revision + 1;
          entries.set(entry.id, { ...entry, ...row, id: entry.id, revision: row.approvedEntryRevision });
        }
        return row;
      }) };
      reports.set(next.id, next); await route.fulfill({ json: { report: next } });
    });
    await page.route(`**/api/${kind}-report-draft?*`, async route => {
      const request = route.request(), role = await roleOf(request), previous = buffers.get(role) ?? { revision: 0, snapshot: null };
      if (request.method() === "GET") { await route.fulfill({ json: previous }); return; }
      const body = request.postDataJSON(); assert.equal(body.revision, previous.revision);
      const next = { revision: previous.revision + 1, snapshot: body.snapshot }; buffers.set(role, next); await route.fulfill({ json: next });
    });
    await page.route("**/api/table-order?*", route => route.fulfill({ json: { ids: [], canWrite: false, hasSavedOrder: false, importIds: [], hasImportOrder: false } }));
    await page.goto(`${base}/${kind}-report-smoke.html?sourceZone=1`);
    const table = page.locator(".personnel-history-table"), footer = page.locator(".personnel-history-footer");
    const save = () => footer.getByRole("button", { name: /^Сохранить (изменения|исправления)/ });
    const buttons = async () => (await footer.getByRole("button").allTextContents()).map(value => value.trim());
    const row = id => table.locator(`.ag-row[row-id="${id === 9904 ? "approved-9904" : `report-${id}-${id + 100}`}" ]`);
    const checkbox = id => row(id).locator('[col-id="ag-Grid-SelectionColumn"] input[type="checkbox"]');
    const ready = async count => {
      await page.waitForFunction(({ entity, count }) => document.querySelectorAll(`.personnel-history-table .ag-row [col-id="${entity}"]`).length === count, { entity, count });
      await page.waitForFunction(() => !document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled);
    };
    const tab = async (name, count) => { await page.getByRole("button", { name }).click(); await ready(count); };
    const setRole = async (value, count) => { await page.getByRole("combobox", { name: "Роль в проверке", exact: true }).selectOption(value); await ready(count); };
    const edit = async (id, text, commit = true) => {
      const cell = row(id).locator('[col-id="note"]'); await cell.dblclick();
      const input = cell.locator("textarea, input").first(); await input.fill(text);
      if (commit) await input.press("Enter");
    };
    const chooseReview = async id => {
      await page.getByRole("button", { name: "Отчёт для проверки", exact: true }).click();
      await page.locator(".custom-select-menu").getByRole("option", { name: new RegExp(id === 702 ? "26.10.2026" : "25.10.2026") }).click();
      await row(id).locator(`[col-id="${entity}"]`).waitFor();
    };
    const saveOnce = async (expectedCount, keyboard = false) => {
      if (keyboard === "touch") await save().tap();
      else if (keyboard) { await save().focus(); await page.keyboard.press("Enter"); }
      else await save().click();
      await save().waitFor({ state: "hidden" });
      await page.waitForFunction(() => !document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled);
      assert.equal(mutations.length, expectedCount, "A single click saves only the active scope");
    };

    await ready(2); await setRole("engineer", 2);
    assert.deepEqual(await buttons(), [], "Approved footer starts without buttons");
    await page.setViewportSize({ width: 939, height: 954 });
    await footer.scrollIntoViewIfNeeded();
    await footer.screenshot({ path: `/private/tmp/${kind}-report-footer-default.png` });
    await page.setViewportSize({ width: 3500, height: 1100 });
    await checkbox(701).check();
    await footer.getByRole("button", { name: "Скопировать на сегодня (1)", exact: true }).waitFor();
    assert.deepEqual(await buttons(), ["Скопировать на сегодня (1)", "Удалить из отчёта (1)"]);
    await page.setViewportSize({ width: 939, height: 954 });
    await footer.scrollIntoViewIfNeeded();
    await footer.screenshot({ path: `/private/tmp/${kind}-report-footer-selected.png` });
    await page.setViewportSize({ width: 3500, height: 1100 });
    await checkbox(701).uncheck();
    await page.waitForFunction(() => document.querySelectorAll(".personnel-history-footer button").length === 0, undefined, { timeout: 1000 });
    assert.deepEqual(await buttons(), [], "Deselection hides approved selection actions");
    await setRole("viewer", 2); await checkbox(701).check();
    assert.deepEqual(await buttons(), [], "Read-only roles cannot copy or delete records");
    await setRole("delete_only", 2); await checkbox(701).check();
    await footer.getByRole("button", { name: "Удалить из отчёта (1)", exact: true }).waitFor();
    assert.deepEqual(await buttons(), ["Удалить из отчёта (1)"], "Delete-only role never gains editing/copy buttons");
    await setRole("engineer", 2);
    await edit(701, "Исходная запись 701", false);
    await save().waitFor(); await save().click(); await save().waitFor({ state: "hidden" });
    assert.equal(mutations.length, 0, "Committing the same input value does not save or claim success");
    assert.equal(await page.getByText("Исправления сохранены. Подтверждённые отчёты и часы в табеле обновлены.", { exact: true }).count(), 0);

    await edit(701, "Эта правка отменена Escape", false); await save().waitFor();
    await page.locator("main > nav").getByText("Есть несохранённые изменения", { exact: true }).waitFor();
    const preventsUnload = () => page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
    assert.equal(await preventsUnload(), true, "Pending approved keystrokes are protected before blur");
    await row(701).locator('[col-id="note"] input').press("Escape");
    await save().waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector('.ag-row[row-id="report-701-801"] [col-id="note"]')?.textContent === "Исходная запись 701", undefined, { timeout: 1000 });
    assert.equal(await row(701).locator('[col-id="note"]').innerText(), "Исходная запись 701");
    assert.equal(mutations.length, 0, "Escape cancels pending input without saving");
    await page.locator("main > nav").getByText("Изменения сохранены", { exact: true }).waitFor();
    assert.equal(await preventsUnload(), false, "Escape removes pending-only leave protection");

    await tab(/^Черновик/, 1);
    await edit(704, "Мой несохранённый черновик");
    assert.deepEqual(await buttons(), ["Добавить строку", "Сохранить изменения", "Отправить на проверку…", "Отменить"], "Draft actions retain their existing workflow");
    await tab(/^На проверке/, 1);
    await row(702).locator(`[col-id="${entity}"]`).waitFor();
    assert.deepEqual(await buttons(), [], "Unrelated dirty draft must not add actions to submitted view");
    await checkbox(702).check(); assert.deepEqual(await buttons(), [], "Submitted selection creates no footer actions");
    await edit(702, "Проверка: первое сохранение прямо из редактора", false);
    await save().waitFor();
    assert.deepEqual(await buttons(), ["Сохранить изменения"]);
    await saveOnce(1);
    assert.equal(mutations[0].reportId, 702);
    assert.equal(mutations[0].rows[0].note, "Проверка: первое сохранение прямо из редактора");
    assert.equal(reports.get(704).rows[0].note, "Исходная запись 704", "Submitted save does not submit/save the working draft");

    await edit(702, "Несохранённое исправление первого проверяемого отчёта");
    await chooseReview(703); assert.deepEqual(await buttons(), [], "Other pending report's edits do not show Save here");
    await edit(703, "Исправление второго проверяемого отчёта", false);
    await saveOnce(2, true);
    assert.equal(mutations[1].reportId, 703);
    assert.equal(reports.get(702).rows[0].note, "Проверка: первое сохранение прямо из редактора");
    await chooseReview(702); await save().waitFor();

    await tab("Подтверждённые", 2);
    assert.deepEqual(await buttons(), [], "Edits in draft/review never add buttons to approved view");
    await edit(9904, "Исправление старой подтверждённой записи", false);
    await save().waitFor(); rejectSave = true; await save().click();
    await page.getByRole("alert").filter({ hasText: "Тестовая ошибка сохранения" }).waitFor();
    assert.equal(mutations.length, 3);
    assert.equal(entries.get(9904).note, "Старая запись");
    await save().waitFor({ state: "visible" });
    assert.match(await row(9904).locator('[col-id="note"]').innerText(), /Исправление старой/);
    await saveOnce(4);
    assert.equal(mutations[3].action, "save-approved-entry"); assert.equal(mutations[3].entryId, 9904);
    assert.equal(mutations[3].row.note, "Исправление старой подтверждённой записи");
    assert.deepEqual(await buttons(), []);
    await edit(701, "Правка подтверждённого отчёта", false); await save().waitFor(); await saveOnce(5);
    assert.equal(mutations[4].reportId, 701); assert.equal(mutations[4].rows[0].note, "Правка подтверждённого отчёта");
    assert.equal(reports.get(701).status, "approved");
    assert.equal(reports.get(702).rows[0].note, "Проверка: первое сохранение прямо из редактора", "Approved save preserves unrelated submitted edits");
    assert.equal(reports.get(704).rows[0].note, "Исходная запись 704");

    // Leaving a tab commits its pending input locally without writing another tab.
    await edit(701, "Правка при переключении вкладки", false); await save().waitFor();
    await tab(/^Черновик/, 1); assert.equal(mutations.length, 5);
    await tab("Подтверждённые", 2); await save().waitFor();
    assert.equal(await row(701).locator('[col-id="note"]').innerText(), "Правка при переключении вкладки");
    await saveOnce(6);

    // A selected edited row exposes Save alongside its permitted selection actions.
    await checkbox(701).check(); await footer.getByRole("button", { name: "Скопировать на сегодня (1)", exact: true }).waitFor();
    await edit(701, "Сохранение касанием выбранной строки", false); await save().waitFor();
    assert.deepEqual(await buttons(), ["Сохранить изменения", "Скопировать на сегодня (1)", "Удалить из отчёта (1)"]);
    await saveOnce(7, "touch");
    assert.equal(mutations[6].rows[0].note, "Сохранение касанием выбранной строки");
    assert.deepEqual(await buttons(), ["Скопировать на сегодня (1)", "Удалить из отчёта (1)"]);
    await checkbox(701).uncheck(); await page.waitForFunction(() => document.querySelectorAll(".personnel-history-footer button").length === 0);

    // A delayed response makes double-click protection observable, not timing dependent.
    await edit(9904, "Двойное нажатие — одна запись", false); await save().waitFor();
    saveGate = new Promise(resolve => { releaseSave = resolve; });
    await save().dblclick({ delay: 0 });
    const saving = footer.getByRole("button", { name: "Сохраняем…", exact: true });
    await saving.waitFor(); assert.equal(await saving.isDisabled(), true);
    assert.equal(mutations.length, 8, "Rapid double click sends exactly one request");
    releaseSave(); releaseSave = null;
    await saving.waitFor({ state: "hidden" }); await save().waitFor({ state: "hidden" });
    await ready(2); assert.equal(entries.get(9904).note, "Двойное нажатие — одна запись");

    // Multi-owner corrections keep successful work and retry only the failed owner.
    add(705, "approved", "2026-10-20", owners.foreman, 9905);
    await page.getByRole("button", { name: "Обновить отчёты", exact: true }).click(); await ready(3);
    await edit(701, "Первый отчёт из пакета"); await edit(705, "Второй отчёт из пакета");
    rejectReportId = 705; await save().click();
    await page.getByRole("alert").filter({ hasText: "Тестовая ошибка сохранения" }).waitFor();
    assert.deepEqual(mutations.slice(8).map(item => item.reportId), [701, 705]);
    assert.equal(reports.get(701).rows[0].note, "Первый отчёт из пакета");
    assert.equal(reports.get(705).rows[0].note, "Исходная запись 705");
    assert.equal(await row(705).locator('[col-id="note"]').innerText(), "Второй отчёт из пакета");
    await saveOnce(11);
    assert.deepEqual(mutations.slice(8).map(item => item.reportId), [701, 705, 705], "Retry never re-saves the already successful owner");
    assert.equal(reports.get(705).rows[0].note, "Второй отчёт из пакета");

    // A source-zone filter hides the edited row, but its Save action must survive.
    await row(701).locator('[col-id="zone"]').dblclick();
    await page.locator(".custom-select-menu").getByRole("option", { name: "Зона Б", exact: true }).click();
    await ready(2); await save().waitFor();
    assert.equal(await row(701).count(), 0, "Changed row really leaves the statistics source filter");
    await saveOnce(12);
    assert.equal(mutations[11].reportId, 701); assert.equal(mutations[11].rows[0].zoneId, 2);
    assert.equal(reports.get(701).rows[0].zoneId, 2);
    assert.equal(reports.get(704).rows[0].note, "Исходная запись 704");

    reports.delete(701); reports.delete(705); entries.clear();
    await page.getByRole("button", { name: "Обновить отчёты", exact: true }).click(); await ready(0);
    assert.deepEqual(await buttons(), [], "Empty approved view remains empty even with dirty drafts elsewhere");
    await tab(/^Черновик/, 1);
    assert.match(await row(704).locator('[col-id="note"]').innerText(), /Мой несохранённый черновик/);
    await tab(/^На проверке/, 1); await chooseReview(702); await save().waitFor();
    assert.match(await row(702).locator('[col-id="note"]').innerText(), /Несохранённое исправление первого/);
    await saveOnce(13); assert.equal(mutations[12].reportId, 702);
    assert.equal(reports.get(704).rows[0].note, "Исходная запись 704");
    await tab(/^Черновик/, 1);
    await save().click();
    await page.waitForFunction(() => [...document.querySelectorAll('.personnel-history-footer button')].find(button => button.textContent.startsWith("Сохранить изменения"))?.disabled);
    assert.equal(mutations.length, 14); assert.equal(mutations[13].reportId, 704);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/private/tmp/${kind}-report-footer-actions.png`, fullPage: true });
    console.log(`PASS ${kind}: clean/selected/empty approved; readonly rights; submitted selection hidden; pending editor first-click save; failure retry; active report/status isolation; draft workflow preserved; touch; Escape; switch with pending input; disabled double-click; partial batch retry; hidden source-filter correction`);
  } catch (failure) {
    console.error(`${kind} mutations: ${JSON.stringify(mutations)}`);
    console.error(`${kind}: ${await page?.locator("body").innerText()}`);
    await page?.screenshot({ path: `/private/tmp/${kind}-report-footer-actions-failure.png`, fullPage: true });
    throw failure;
  } finally { releaseSave?.(); await context?.close(); fixture.kill(); }
}
try { for (const config of configurations) await check(config); }
finally { await browser.close(); }
