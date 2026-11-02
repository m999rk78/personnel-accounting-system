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
const updated = new Set(), batches = [], nativeDialogs = [], errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("dialog", async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
function inspection() {
  const active = [...employees.values()].filter(employee => !updated.has(employee.id)).map(employee => ({ kind: "changed", employeeName: employee.fullName, localEmployeeId: employee.id, bitrix24Id: employee.bitrix24Id, details: `Должность: «${employee.position}» → «${cards.get(employee.bitrix24Id).position}»` }));
  return { status: "mismatch", checkedAt: "2026-11-02T10:00:00.000Z", sourceReceived: 1362, compared: 455, matched: updated.size,
    totalDifferences: active.length + 3, differences: [...extras, ...active].slice(0, 100), updatableEmployeeIds: active.map(employee => employee.localEmployeeId),
    differenceCounts: { changed: active.length, missing_locally: 1, dismissed_in_bitrix: 1, missing_in_bitrix: 1 }, acknowledgedDifferences: 1, autoLinkable: 0, needsReview: 1, unmatched: 1 };
}
await page.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url());
  let data;
  if (request.method() === "POST") {
    const payload = request.postDataJSON();
    assert.equal(url.pathname, "/api/data");
    if (payload.action === "inspect-bitrix24") data = inspection();
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
  } else if (url.pathname === "/api/data") data = { sites: [site], employees: [...employees.values()], projectEmployees: [], placementEmployees: [], reportEmployees: [], positionCatalog: [], employmentTypes: [], departments: [], positions: [], users: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false };
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
  for (const employee of extras) assert.equal(await review().getByRole("checkbox", { name: `Обновить из Битрикс24: ${employee.employeeName}`, exact: true }).isDisabled(), true);
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
  assert.equal(await selectAll().isDisabled(), true);
  assert.equal(await review().locator(".bitrix-review-selection-bar").count(), 0);
  console.log("PASS: retry updates only failed IDs; creation/dismissal/missing/acknowledged rows remain untouched; mobile dialog fits viewport");
  await review().getByRole("button", { name: "Закрыть результат проверки", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 1000 });
  updated.clear(); // A fresh nonempty mismatch set must remain read-only, not just an empty result.
  await page.goto("http://127.0.0.1:3123/bitrix-review-bulk.html?readonly=1");
  await page.getByRole("button", { name: "Проверить с Битрикс24", exact: true }).click(); await review().waitFor();
  assert.equal(await review().getByRole("checkbox").count(), 0);
  assert.equal(await review().locator(".bitrix-review-selection-bar").count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(nativeDialogs, []);
  console.log("PASS: users without employee update permission cannot select or run bulk updates");
} catch (error) {
  releaseFirst?.();
  console.error((await page.locator("body").innerText()).slice(-2200));
  await page.screenshot({ path: "/tmp/bitrix-review-bulk-failure.png" });
  throw error;
} finally { await browser.close(); await server.httpServer.close(); }
