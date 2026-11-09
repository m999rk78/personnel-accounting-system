// Actual personnel workspace, personal row-order mock and browser preferences;
// all records are synthetic and the working database is never connected.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = 3164, base = `http://127.0.0.1:${port}`;
const fixture = spawn(process.execPath, [fileURLToPath(new URL("./personnel-report-smoke.mjs", import.meta.url)), "--scenario", "preferences", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
let browser, page, output = "";
const errors = [];
const poll = async (read, check, name) => {
  const deadline = Date.now() + 15_000; let actual;
  while (Date.now() < deadline) {
    actual = await read(); if (check(actual)) return actual;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${name}. Actual: ${JSON.stringify(actual)}`);
};
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output}`)), 60_000);
    const capture = chunk => { output += chunk; if (output.includes(`${base}/`)) { clearTimeout(timer); resolve(); } };
    fixture.stdout.on("data", capture); fixture.stderr.on("data", capture);
    fixture.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); });
    fixture.once("error", error => { clearTimeout(timer); reject(error); });
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 3000, height: 1050 } });
  page.setDefaultTimeout(12_000); page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  const tabs = () => page.getByRole("group", { name: "Показать отчёты" });
  const header = id => page.locator(`.ag-header-cell[col-id="${id}"]`);
  const width = async id => Math.round((await header(id).boundingBox()).width);
  const ready = async () => page.waitForFunction(() => document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled === false);
  const draft = async () => { await ready(); await tabs().getByRole("button", { name: /^Черновик/ }).click(); await page.locator('.ag-row [col-id="employeeName"]').first().waitFor(); };
  const visibleRows = async () => page.locator('.personnel-history-table .ag-row [col-id="employeeName"]').evaluateAll(cells => cells.map(cell => {
    const row = cell.closest('.ag-row'), id = row.getAttribute("row-id"), index = Number(row.getAttribute("row-index"));
    const dateRow = row.querySelector('[col-id="workDate"]') ? row : [...document.querySelectorAll('.ag-row')].find(item => item.getAttribute("row-id") === id && item.querySelector('[col-id="workDate"]'));
    return { id, index, name: cell.textContent.trim(), date: dateRow?.querySelector('[col-id="workDate"]')?.textContent.trim().slice(0, 10) ?? "" };
  }).sort((a, b) => a.index - b.index));
  const todayNames = async () => (await visibleRows()).filter(row => row.date === "28.10.2026").map(row => row.name);
  const expectToday = async expected => { await poll(todayNames, names => JSON.stringify(names) === JSON.stringify(expected), "today's displayed row order"); };
  const order = async (siteId = 1) => (await (await page.request.get(`${base}/api/table-order?scope=personnel-report-rows&siteId=${siteId}`)).json());
  async function changeSelector(name, value) {
    const previous = await page.locator(".personnel-report-workspace").elementHandle();
    await page.getByRole("combobox", { name, exact: true }).selectOption(value);
    await page.waitForFunction(element => !element.isConnected, previous); await ready();
  }
  async function resize(id, delta) {
    const before = await width(id), handle = await header(id).locator(".ag-header-cell-resize").boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + delta, handle.y + handle.height / 2, { steps: 12 }); await page.mouse.up();
    return poll(() => width(id), after => after >= before + delta - 3, `resized ${id} width`);
  }
  async function expectWidths(expected) {
    for (const [id, wanted] of Object.entries(expected)) await poll(() => width(id), actual => actual === wanted, `restored ${id} width`);
  }
  async function moveRow(name, placement) {
    await page.locator('.ag-row [col-id="employeeName"]').filter({ hasText: name }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: `Переместить в ${placement} этой даты`, exact: true }).click();
    await poll(() => order(), result => result.hasSavedOrder, "personal row order saved");
  }

  await page.goto(`${base}/personnel-report-smoke.html`); await draft();
  await expectToday(["Иван Тестовый", "Пётр Примеров", "Анна Демонстрационная"]);
  const original = { employeeName: await width("employeeName"), zone: await width("zone") };
  const expected = { employeeName: await resize("employeeName", 170), zone: await resize("zone", 130) };
  await header("employeeName").locator(".ag-header-cell-text").click();
  await expectToday(["Анна Демонстрационная", "Иван Тестовый", "Пётр Примеров"]);
  await page.reload(); await draft();
  await expectWidths(expected); await expectToday(["Анна Демонстрационная", "Иван Тестовый", "Пётр Примеров"]);
  assert.deepEqual((await visibleRows()).map(row => row.date), ["28.10.2026", "28.10.2026", "28.10.2026", "27.10.2026", "27.10.2026", "27.10.2026"]);

  // Leaving and reopening the report reuses the same personal widths/sort.
  await tabs().getByRole("button", { name: "Подтверждённые", exact: true }).click(); await expectWidths(expected);
  await draft(); await expectWidths(expected);
  await moveRow("Пётр Примеров", "начало");
  await expectToday(["Пётр Примеров", "Анна Демонстрационная", "Иван Тестовый"]);
  await page.reload(); await draft(); await expectWidths(expected);
  await expectToday(["Пётр Примеров", "Анна Демонстрационная", "Иван Тестовый"]);

  // Another user/project cannot inherit this user's manually arranged view.
  await changeSelector("Роль в проверке", "foreman2"); await draft();
  await expectWidths(original); await expectToday(["Иван Тестовый", "Пётр Примеров", "Анна Демонстрационная"]);
  await changeSelector("Роль в проверке", "foreman"); await draft(); await expectWidths(expected);
  await expectToday(["Пётр Примеров", "Анна Демонстрационная", "Иван Тестовый"]);
  await changeSelector("Проект в проверке", "2"); await expectWidths(original);
  assert.equal((await order(2)).hasSavedOrder, false);
  await changeSelector("Проект в проверке", "1"); await draft(); await expectWidths(expected);

  // Moving an unsaved row then giving it database IDs must keep its position.
  await page.getByRole("button", { name: "Добавить строку", exact: true }).click();
  await page.locator('.ag-row [col-id="employeeName"]').filter({ hasText: "Не заполнено" }).first().waitFor();
  await moveRow("Не заполнено", "начало");
  await expectToday(["Не заполнено", "Пётр Примеров", "Анна Демонстрационная", "Иван Тестовый"]);
  await page.getByRole("button", { name: /^Сохранить изменения/ }).click();
  await page.getByText("Изменения сохранены. Статусы отчётов сохранены; часы попадут в табель после подтверждения.", { exact: true }).waitFor();
  const saved = await order();
  assert.ok(saved.ids.every(id => !/^\d{4}-\d{2}-\d{2}\/[a-f0-9]{8}-/.test(id)), "saved UUIDs must be remapped to stable report row IDs");
  await page.reload(); await draft(); await expectWidths(expected);
  await expectToday(["Не заполнено", "Пётр Примеров", "Анна Демонстрационная", "Иван Тестовый"]);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/private/tmp/personnel-report-preferences-smoke.png", fullPage: true });
  console.log("PASS: personal widths and active sort survive reload/reentry; dates remain together; row moves persist and draft IDs remap; user/project isolation");
} catch (failure) {
  console.error((await page?.locator("body").innerText())?.slice(-14_000));
  await page?.screenshot({ path: "/private/tmp/personnel-report-preferences-failure.png", fullPage: true });
  throw failure;
} finally { await browser?.close(); fixture.kill(); }
