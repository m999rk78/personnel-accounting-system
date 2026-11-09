// Real personnel workspace and synthetic HTTP only; no environment files or DB.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = 3161;
const base = `http://127.0.0.1:${port}`;
const fixture = spawn(process.execPath, [fileURLToPath(new URL("./personnel-report-smoke.mjs", import.meta.url)), "--scenario", "tabs", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
let browser, page, output = "";
const errors = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output}`)), 60_000);
    const capture = chunk => { output += chunk; if (output.includes(`${base}/`)) { clearTimeout(timer); resolve(); } };
    fixture.stdout.on("data", capture); fixture.stderr.on("data", capture);
    fixture.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); });
    fixture.once("error", error => { clearTimeout(timer); reject(error); });
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 2800, height: 1050 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/personnel-report-smoke.html`);
  const tabs = page.getByRole("group", { name: "Показать отчёты" });
  const table = page.locator(".personnel-history-table");
  const cells = field => table.locator(`.ag-row [col-id="${field}"]`);
  const textValues = async field => (await cells(field).allTextContents()).map(text => text.trim());
  const selectTab = async name => {
    const button = tabs.getByRole("button", { name });
    await button.click();
    await page.waitForFunction(() => !document.querySelector(".ag-overlay-loading-center"));
    await page.waitForTimeout(150);
    assert.equal(await button.getAttribute("aria-pressed"), "true");
  };
  const checkTabs = async () => {
    await tabs.getByRole("button", { name: "Подтверждённые", exact: true }).waitFor();
    const labels = await tabs.getByRole("button").allTextContents();
    assert.equal(labels.length, 3);
    assert.deepEqual(labels.map(text => text.trim().replace(/\s*\d+$/, "")), ["Подтверждённые", "На проверке", "Черновик"]);
    assert.equal(await tabs.getByRole("button", { name: "Подтверждённые", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await tabs.getByRole("button", { name: /Все записи/ }).count(), 0);
  };
  const selectRole = async role => {
    await page.getByRole("combobox", { name: "Роль в проверке" }).selectOption(role);
    await checkTabs();
    await page.getByRole("button", { name: "Обновить отчёты", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled);
  };
  const expectApproved = async count => {
    await page.waitForFunction(count => document.querySelectorAll('.personnel-history-table .ag-row [col-id="status"]').length === count, count);
    assert.deepEqual(await textValues("status"), Array(count).fill("Подтверждён"));
    assert.equal(await page.getByRole("button", { name: "Раскрыть все", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Свернуть все", exact: true }).count(), 0);
  };
  const apiReports = async () => (await (await page.request.get(`${base}/api/personnel-report?siteId=1&all=true`)).json()).reports;
  const expectOwnDraft = async (ownerId, name, count) => {
    await selectTab(/^Черновик/);
    await page.waitForFunction(count => document.querySelectorAll('.personnel-history-table .ag-row [col-id="employeeName"]').length === count, count);
    assert.deepEqual(await textValues("employeeName"), Array(count).fill(name));
    assert.ok((await textValues("status")).every(status => ["Черновик", "На доработке"].includes(status)));
    const response = await apiReports();
    assert.ok(response.filter(report => ["draft", "rejected"].includes(report.status)).every(report => report.ownerUserId === ownerId));
  };

  // Each foreman sees a different crew, carried only from his own yesterday.
  for (const [role, ownerId, name] of [["foreman", 10, "Иван Тестовый"], ["foreman2", 11, "Пётр Примеров"]]) {
    if (role === "foreman") { await checkTabs(); await page.waitForFunction(() => !document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled); }
    else await selectRole(role);
    await expectApproved(1);
    assert.deepEqual(await textValues("employeeName"), [name]);
    await expectOwnDraft(ownerId, name, 3);
    assert.deepEqual((await textValues("workDate")).sort(), ["24.10.2026", "25.10.2026", "28.10.2026"]);
    assert.ok((await textValues("note")).some(note => note.includes(role === "foreman" ? "Алексей Тестовый" : "Борис Другая Бригада")));
    await page.getByRole("button", { name: /^Сохранить изменения/ }).click();
    await page.getByText("Изменения сохранены. Статусы отчётов сохранены; часы попадут в табель после подтверждения.", { exact: true }).waitFor();
    const saved = (await apiReports()).find(report => report.workDate === "2026-10-28" && report.ownerUserId === ownerId);
    assert.equal(saved.rows.length, 1); assert.equal(saved.rows[0].employeeName, name);
    await selectTab(/^На проверке/);
    await cells("status").first().waitFor();
    assert.deepEqual(await textValues("status"), ["На проверке"]);
    assert.deepEqual(await textValues("employeeName"), [name]);
  }

  await selectRole("engineer");
  await expectApproved(2);
  assert.deepEqual((await textValues("employeeName")).sort(), ["Иван Тестовый", "Пётр Примеров"].sort());
  await expectOwnDraft(20, "Анна Демонстрационная", 1);
  await selectTab(/^На проверке/);
  await cells("status").first().waitFor();
  assert.deepEqual(await textValues("status"), ["На проверке"]);
  const reviewChoice = page.getByRole("button", { name: "Отчёт для проверки", exact: true });
  await reviewChoice.click();
  await page.locator(".custom-select-menu").getByRole("option", { name: /Борис Другая Бригада/ }).click();
  await page.waitForFunction(() => document.querySelector('.personnel-history-table .ag-row [col-id="employeeName"]')?.textContent.includes("Пётр Примеров"));
  assert.equal(await page.getByRole("button", { name: "Подтвердить отчёт", exact: true }).isEnabled(), true);

  // A reviewer has a private personal draft too; Add and Copy land in that tab.
  await selectTab("Подтверждённые");
  await page.getByRole("button", { name: "Добавить строку", exact: true }).click();
  assert.equal(await tabs.getByRole("button", { name: /^Черновик/ }).getAttribute("aria-pressed"), "true");
  await page.waitForFunction(() => document.querySelectorAll('.personnel-history-table .ag-row [col-id="employeeName"]').length === 2);
  await page.getByRole("button", { name: "Отменить изменения", exact: true }).click();
  await selectTab("Подтверждённые");
  await expectApproved(2);
  const checkbox = table.locator('.ag-row [col-id="ag-Grid-SelectionColumn"] input[type="checkbox"]').first();
  await checkbox.check();
  await page.getByRole("button", { name: "Скопировать на сегодня (1)", exact: true }).click();
  assert.equal(await tabs.getByRole("button", { name: /^Черновик/ }).getAttribute("aria-pressed"), "true");
  await page.waitForFunction(() => {
    const statuses = [...document.querySelectorAll('.personnel-history-table .ag-row [col-id="status"]')].map(cell => cell.textContent.trim());
    return statuses.length === 2 && statuses.every(status => status === "Черновик");
  });
  assert.deepEqual(await textValues("status"), ["Черновик", "Черновик"]);

  await selectRole("superadmin");
  await expectApproved(2);
  await selectTab(/^Черновик/);
  await page.getByText("У вас пока нет черновиков", { exact: true }).waitFor();
  assert.equal(await cells("employeeName").count(), 0);
  assert.ok((await apiReports()).every(report => !["draft", "rejected"].includes(report.status)));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/private/tmp/personnel-report-tabs-smoke.png", fullPage: true });
  console.log("PASS: approved/submitted/own-draft tabs; two independent foremen and yesterday crews; private reviewer drafts; Add/Copy switch to draft; admin isolation");
} catch (failure) {
  console.error((await page?.locator("body").innerText())?.slice(-10_000));
  await page?.screenshot({ path: "/private/tmp/personnel-report-tabs-failure.png", fullPage: true });
  throw failure;
} finally {
  await browser?.close();
  fixture.kill();
}
