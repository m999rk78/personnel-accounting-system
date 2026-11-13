// Real application UI with an in-memory employee catalog and synthetic Bitrix cards.
// No production, database, credentials or actual Bitrix requests.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const config = {
  configFile: false, envDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false,
  plugins: [react()], build: { outDir: await mkdtemp(join(tmpdir(), "bitrix-review-bulk-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/bitrix-review-bulk.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3123, strictPort: true },
};
await build(config);
const server = await preview(config);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(12_000);
const site = { id: 1, name: "Тестовый объект", code: "TEST", timezone: "Europe/Moscow" };
const employees = new Map(Array.from({ length: 451 }, (_, index) => {
  const id = index + 1;
  return [id, { id, bitrix24Id: `B${id}`, fullName: `Тестовый сотрудник ${String(id).padStart(3, "0")}`, employmentType: "ОПР", department: "Старый отдел", position: "Старая должность", source: "bitrix24", siteId: 1, siteName: site.name, bitrixCheckStatus: "mismatch", bitrixCheckAcknowledged: false }];
}));
const cards = new Map([...employees.values()].map(employee => [employee.bitrix24Id, { department: `Отдел карточки ${employee.id}`, position: `Должность карточки ${employee.id}` }]));
const extras = [
  { kind: "missing_locally", employeeName: "Новый сотрудник", bitrix24Id: "B900", details: "Нужно выбрать должность и объект" },
  { kind: "dismissed_in_bitrix", employeeName: "Уволенный сотрудник", bitrix24Id: "B901", localEmployeeId: 901, details: "Уволен в Битрикс24" },
  { kind: "missing_in_bitrix", employeeName: "Отсутствующий сотрудник", bitrix24Id: "B902", localEmployeeId: 902, details: "Карточка отсутствует" },
  { kind: "changed", employeeName: "Подтверждённый сотрудник", bitrix24Id: "B903", localEmployeeId: 903, acknowledged: true, details: "Допустимое расхождение" },
];
let failOne = true, releaseFirst;
let archivePreviewMode = false, archiveApplied = false, archiveReturnMode = false, ignorePreviewMode = false;
const archiveRequests = [];
const ignored = new Set();
const archiveTarget = { id: 9000, bitrix24Id: null, fullName: "Сотрудник из действующего справочника", employmentType: "ОПР",
  department: "Монтаж", position: "Монтажник", source: "excel", siteId: 1, siteName: site.name };
const unselectedTarget = { ...archiveTarget, id: 9001, fullName: "Неотмеченный сотрудник" };
const updated = new Set(), batches = [], nativeDialogs = [], errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("dialog", async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
function inspection() {
  if (archiveReturnMode) return {
    status: "ok", checkedAt: "2026-11-02T10:00:00.000Z", compared: 0, matched: 0, totalDifferences: 0,
    autoLinkable: 0, autoLinkOptions: [], updatableEmployeeIds: [], differences: [], differenceCounts: {},
    archiveReturns: [{ bitrix24Id: "RETURNED", employeeName: "Вернувшийся сотрудник",
      details: "После увольнения сотрудник снова назначен в Битрикс24. Объект: «Новая площадка»." }],
  };
  if (ignorePreviewMode) {
    const first = { kind: "changed", bitrix24Id: "B1", localEmployeeId: 1, employeeName: "Различие можно игнорировать", details: "Должность отличается", acknowledged: ignored.has(1) };
    const second = { kind: "blacklisted_in_bitrix", bitrix24Id: "B2", localEmployeeId: 2, employeeName: "Чёрный список", details: "Чёрный список в Битрикс24" };
    return { status: "mismatch", checkedAt: "2026-11-02T10:00:00.000Z", compared: 2, matched: 0, autoLinkable: 0,
      totalDifferences: ignored.has(1) ? 1 : 2, differenceCounts: { changed: ignored.has(1) ? 0 : 1, blacklisted_in_bitrix: 1 },
      differences: ignored.has(1) ? [second, first] : [first, second], updatableEmployeeIds: ignored.has(1) ? [2] : [1, 2],
      ignorableEmployeeIds: ignored.has(1) ? [] : [1], acknowledgedDifferences: ignored.size, warningFingerprints: { 1: "fingerprint-1", 2: "fingerprint-2" },
    };
  }
  if (archivePreviewMode) return {
    status: "mismatch", checkedAt: "2026-11-02T10:00:00.000Z", compared: archiveApplied ? 1 : 0, matched: 0,
    activeUnlinked: archiveApplied ? 1 : 2, totalDifferences: 3, archiveAutoLinkable: 0,
    autoLinkable: 1, archiveLinkRevision: archiveApplied ? undefined : "synthetic-preview",
    autoLinkOptions: [{ bitrix24Id: "UNSELECTED", archivedLink: false }],
    archiveTransferOptions: archiveApplied ? [] : [{ bitrix24Id: "ARCH1", employeeId: archiveTarget.id }],
    differences: [archiveApplied
      ? { kind: "changed", bitrix24Id: "ARCH1", localEmployeeId: archiveTarget.id, employeeName: archiveTarget.fullName, details: "Объект: «Тестовый объект» → «Новый объект»" }
      : { kind: "missing_locally", archivedLink: true, bitrix24Id: "ARCH1", suggestedEmployeeIds: [archiveTarget.id], employeeName: archiveTarget.fullName, details: "Связь осталась в архиве, должность отличается" },
    { kind: "missing_locally", bitrix24Id: "UNSELECTED", suggestedEmployeeIds: [unselectedTarget.id], employeeName: unselectedTarget.fullName, details: "Найдено точное совпадение" },
    { kind: "missing_locally", archivedLink: true, bitrix24Id: "AMBIGUOUS", suggestedEmployeeIds: [9100, 9101], employeeName: "Неоднозначная пара", details: "Найдено несколько кандидатов" }],
    updatableEmployeeIds: archiveApplied ? [archiveTarget.id] : [],
  };
  const active = [...employees.values()].filter(employee => !updated.has(employee.id)).map(employee => ({ kind: "changed", employeeName: employee.fullName, localEmployeeId: employee.id, bitrix24Id: employee.bitrix24Id, details: `Должность: «${employee.position}» → «${cards.get(employee.bitrix24Id).position}»` }));
  return { status: "mismatch", checkedAt: "2026-11-02T10:00:00.000Z", sourceReceived: 1362, compared: 455, matched: updated.size,
    totalDifferences: active.length + 3, differences: [...extras, ...active].slice(0, 100), updatableEmployeeIds: active.map(employee => employee.localEmployeeId), ignorableEmployeeIds: active.map(employee => employee.localEmployeeId),
    differenceCounts: { changed: active.length, missing_locally: 1, dismissed_in_bitrix: 1, missing_in_bitrix: 1 }, acknowledgedDifferences: 1, autoLinkable: 0, needsReview: 1, unmatched: 1 };
}
await page.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url());
  let data;
  if (request.method() === "POST") {
    const payload = request.postDataJSON();
    assert.equal(url.pathname, "/api/data");
    if (payload.action === "inspect-bitrix24") data = inspection();
    else if (ignorePreviewMode) {
      assert.deepEqual(payload, { action: "acknowledge-selected-bitrix24-differences", employeeIds: [1], warningFingerprints: { 1: "fingerprint-1" } });
      ignored.add(1);
      data = { ok: true, acknowledgedCount: 1, employeeIds: [1] };
    }
    else if (archivePreviewMode) {
      assert.deepEqual(payload, { action: "link-bitrix24-employees", archiveTransferLinks: [{ bitrix24Id: "ARCH1", employeeId: archiveTarget.id }], allowArchivedLink: true, archiveLinkRevision: "synthetic-preview" });
      archiveRequests.push(payload);
      archiveApplied = true;
      archiveTarget.bitrix24Id = "ARCH1";
      data = { ...inspection(), linked: 1 };
    }
    else {
      assert.equal(payload.action, "update-selected-bitrix24-employees", "Never create/delete/acknowledge through bulk update");
      assert.ok(payload.employeeIds.length > 0 && payload.employeeIds.length <= 200);
      assert.ok(payload.employeeIds.every(id => employees.has(id) && !updated.has(id)), "Only selected active mismatches may be sent, never previously completed employees");
      batches.push(payload.employeeIds);
      if (batches.length === 1) await new Promise(resolve => { releaseFirst = resolve; });
      const updatedEmployees = [], failedEmployees = [];
      for (const id of payload.employeeIds) {
        const employee = employees.get(id);
        if (id === 7 && failOne) { failedEmployees.push({ id, name: employee.fullName, error: "Тестовая ошибка отдельной карточки" }); continue; }
        Object.assign(employee, cards.get(employee.bitrix24Id), { bitrixCheckStatus: null });
        updated.add(id); updatedEmployees.push({ id, name: employee.fullName });
      }
      data = { ...inspection(), updatedEmployees, failedEmployees };
    }
  } else if (url.pathname === "/api/data") data = { sites: [site], employees: archivePreviewMode ? [archiveTarget, unselectedTarget] : [...employees.values()], projectEmployees: [], placementEmployees: [], reportEmployees: [], positionCatalog: [], employmentTypes: [], departments: [], positions: [], users: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false };
  else if (url.pathname === "/api/table-order") data = { ids: [...employees.keys()], canWrite: false, hasSavedOrder: false };
  else throw new Error(`Unexpected isolated API ${url.pathname}`);
  await route.fulfill({ json: data });
});
const review = () => page.getByRole("dialog", { name: "Нужно проверить сотрудников", exact: true });
const selectAll = () => review().getByRole("checkbox", { name: "Выбрать всех для обновления из Битрикс24", exact: true });
const bulkButton = () => review().locator(".bitrix-review-bulk-update");
const popup = () => page.getByRole("alertdialog");
try {
  await page.goto("http://127.0.0.1:3123/bitrix-review-bulk.html");
  await page.evaluate(() => history.pushState({}, "", location.href)); // Internal Back, not leaving for the blank startup tab.
  await page.getByRole("button", { name: "Проверить с Битрикс24", exact: true }).click();
  await review().waitFor();
  assert.equal(await review().getByRole("listitem").count(), 100);
  assert.equal(await bulkButton().isDisabled(), true);
  for (const employee of extras) assert.equal(await review().getByRole("checkbox", { name: `Обновить из Битрикс24: ${employee.employeeName}`, exact: true }).count(), 0);
  const first = review().getByRole("checkbox", { name: "Обновить из Битрикс24: Тестовый сотрудник 001", exact: true });
  await first.check();
  assert.equal(await selectAll().evaluate(input => input.indeterminate), true);
  await selectAll().check();
  assert.match(await bulkButton().innerText(), /451/);
  await page.screenshot({ path: "/tmp/bitrix-review-bulk-desktop.png" });
  await bulkButton().click(); await popup().waitFor();
  await popup().getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(batches.length, 0, "Cancel must not update records");
  await bulkButton().click(); await popup().waitFor();
  await popup().getByRole("button", { name: "Обновить выбранных (451)", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".bitrix-review-bulk-update")?.textContent === "Обновляем…");
  assert.equal(await review().getByRole("button", { name: "Закрыть результат проверки", exact: true }).isDisabled(), true);
  await page.evaluate(() => history.back());
  await page.waitForURL("**/settings/general/employees");
  await page.waitForFunction(() => document.querySelector(".bitrix-check-dialog") !== null);
  assert.ok(releaseFirst); releaseFirst();
  await review().getByRole("status").filter({ hasText: "Обновлено сотрудников: 450" }).waitFor();
  assert.deepEqual(batches.map(batch => batch.length), [200, 200, 51]);
  assert.equal(updated.size, 450);
  assert.match(await bulkButton().innerText(), /\(1\)/);
  assert.match(await review().getByRole("alert").innerText(), /Тестовая ошибка отдельной карточки/);
  for (const id of updated) assert.equal(employees.get(id).position, `Должность карточки ${id}`, "Each employee must keep their own source values");
  assert.equal(employees.get(7).position, "Старая должность");
  console.log("PASS: select all covers 451 IDs beyond the 100-row preview; bounded batches and partial failures retain correct per-employee values");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/bitrix-review-bulk-mobile.png" });
  const box = await review().boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844);
  failOne = false;
  await bulkButton().click(); await popup().waitFor();
  await popup().getByRole("button", { name: "Обновить выбранных (1)", exact: true }).click();
  await review().getByRole("status").filter({ hasText: "Обновлено сотрудников: 1." }).waitFor();
  assert.equal(updated.size, 451);
  assert.deepEqual(batches.at(-1), [7]);
  assert.equal(await selectAll().count(), 0);
  assert.equal(await review().locator(".bitrix-review-selection-bar").count(), 0);
  const reviewList = review().getByRole("list", { name: "Список сотрудников проверки" });
  await reviewList.getByRole("button", { name: /Уволенный сотрудник/ }).click();
  await review().getByRole("heading", { name: "Уволенный сотрудник", exact: true }).waitFor();
  await reviewList.getByRole("button", { name: /Новый сотрудник/ }).click();
  await review().getByRole("heading", { name: "Новый сотрудник", exact: true }).waitFor();
  assert.equal(await review().getByRole("button", { name: "Добавить сотрудника", exact: true }).isVisible(), true);
  console.log("PASS: retry updates only failed IDs; creation/dismissal/missing/acknowledged rows remain untouched; mobile dialog fits viewport");
  await review().getByRole("button", { name: "Закрыть результат проверки", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 1000 });
  updated.clear(); // A fresh nonempty mismatch set must remain read-only, not just an empty result.
  await page.goto("http://127.0.0.1:3123/bitrix-review-bulk.html?readonly=1");
  await page.getByRole("button", { name: "Проверить с Битрикс24", exact: true }).click(); await review().waitFor();
  assert.equal(await review().getByRole("checkbox").count(), 0);
  assert.equal(await review().locator(".bitrix-review-selection-bar").count(), 0);
  console.log("PASS: users without employee update permission cannot select or run bulk updates");
  archivePreviewMode = true;
  await page.goto("http://127.0.0.1:3123/bitrix-review-bulk.html");
  await page.getByRole("button", { name: "Проверить с Битрикс24", exact: true }).click();
  await review().waitFor();
  assert.equal(await review().getByRole("checkbox").count(), 3);
  assert.equal(await review().getByRole("button", { name: "Добавить сотрудника", exact: true }).count(), 0);
  assert.equal(await review().getByRole("button", { name: "Сопоставить выбранных (0)", exact: true }).isDisabled(), true);
  const selectAllForLink = review().getByRole("checkbox", { name: "Выбрать всех для сопоставления с Битрикс24", exact: true });
  await selectAllForLink.check();
  await review().getByRole("button", { name: "Сопоставить выбранных (2)", exact: true }).waitFor();
  assert.equal(await review().getByRole("checkbox", { name: `Перенести связь из архива: ${archiveTarget.fullName}`, exact: true }).isChecked(), true);
  assert.equal(await review().getByRole("checkbox", { name: /Неоднозначная пара/ }).count(), 0);
  await review().getByRole("checkbox", { name: `Сопоставить с Битрикс24: ${unselectedTarget.fullName}`, exact: true }).uncheck();
  assert.equal(await selectAllForLink.evaluate(input => input.indeterminate), true);
  const linkArchive = review().getByRole("button", { name: "Перенести связь (1)", exact: true });
  await linkArchive.click();
  await popup().getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(archiveRequests.length, 0);
  await linkArchive.click();
  await popup().getByRole("button", { name: "Перенести связь", exact: true }).click();
  await review().getByText("Объект: «Тестовый объект» → «Новый объект»", { exact: true }).waitFor();
  assert.equal(archiveRequests.length, 1);
  assert.equal(archiveTarget.siteName, site.name, "Linking must not apply a Bitrix project change");
  assert.equal(unselectedTarget.bitrix24Id, null, "The unchecked card must remain unlinked");
  await review().getByRole("button", { name: "Обновление", exact: true }).click();
  assert.equal(await selectAll().isVisible(), true);
  await review().getByRole("button", { name: "Сопоставление", exact: true }).click();
  assert.equal(await selectAllForLink.isVisible(), true);
  console.log("PASS: select-all and unchecking send only selected exact matches; archive confirmation and the separate update mode are preserved");
  await review().getByRole("button", { name: "Закрыть результат проверки", exact: true }).click();
  ignorePreviewMode = true;
  await page.getByRole("button", { name: "Проверить с Битрикс24", exact: true }).click();
  await selectAll().check();
  await review().getByRole("button", { name: "Игнорировать различия (1)", exact: true }).click();
  await review().getByRole("status").filter({ hasText: "Данные оставлены как есть у сотрудников: 1" }).waitFor();
  assert.equal(await review().locator(".bitrix-check-summary .attention strong").innerText(), "1");
  await review().getByText("Различия проигнорированы", { exact: true }).waitFor();
  assert.equal(await review().getByRole("checkbox", { name: "Архивировать по данным Битрикс24: Чёрный список" }).isChecked(), true);
  assert.equal(ignored.size, 1);
  await review().getByRole("button", { name: "Закрыть результат проверки", exact: true }).click();
  ignorePreviewMode = false;
  archiveReturnMode = true;
  await page.getByRole("button", { name: "Проверить с Битрикс24", exact: true }).click();
  const returnReview = page.getByRole("dialog", { name: "Всё в порядке", exact: true });
  const returnNote = returnReview.getByText(/Новая площадка/);
  assert.equal(await returnNote.isVisible(), false);
  assert.equal(await returnReview.locator(".bitrix-check-summary .attention strong").innerText(), "0");
  await returnReview.getByText("Возможный повторный приём (1)", { exact: true }).click();
  await returnNote.waitFor();
  assert.equal(await returnReview.getByRole("checkbox").count(), 0);
  assert.equal(await returnReview.getByRole("button", { name: /Сопоставить|Перенести связь|Обновить из|Добавить сотрудника/ }).count(), 0);
  assert.equal(archiveRequests.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(nativeDialogs, []);
  console.log("PASS: only eligible differences are ignored; a possible archive return is a separate read-only notice outside routine statistics");
} catch (error) {
  releaseFirst?.();
  console.error((await page.locator("body").innerText()).slice(-2200));
  await page.screenshot({ path: "/tmp/bitrix-review-bulk-failure.png" });
  throw error;
} finally { await browser.close(); await server.httpServer.close(); }
