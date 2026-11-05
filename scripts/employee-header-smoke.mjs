// Real application and original employee table. Fake actors/data only; no env, real API or DB.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const config = { configFile: false, envDir: false, publicDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "employee-header-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/employee-header.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3150, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = [], writes = [];
  const sites = [{ id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" }];
  const employees = ["Иванов Сергей Петрович", "Макаров Алексей Алексеевич", "Петров Андрей Николаевич", "Смирнова Елена Викторовна"].map((fullName, index) => ({ id: index + 1, fullName, employmentType: "ОПР", department: "МУТТ", position: "Монтажник", source: "manual", siteId: 1, siteName: sites[0].name, availabilityStatus: "active", bitrix24Stage: "", syncError: null }));
  let cooldown = false, releaseCheck, checkStarted = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    let body;
    if (request.method() !== "GET") {
      const payload = request.postDataJSON(); writes.push(payload.action);
      assert.equal(url.pathname, "/api/data"); assert.equal(payload.action, "inspect-bitrix24");
      checkStarted = true;
      await new Promise(resolve => { releaseCheck = resolve; });
      body = { status: "ok", matched: 4, totalDifferences: 0, differences: [], autoLinkable: 0, acknowledgedDifferences: 0 };
    } else if (url.pathname === "/api/table-order") body = { ids: employees.map(employee => employee.id), canWrite: false, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report")) body = { reports: [], entries: [], canReview: true, availabilityMarks: [] };
    else {
      assert.equal(url.pathname, "/api/data");
      body = { sites, employees, projectEmployees: [], placementEmployees: [], reportEmployees: [], positionCatalog: [], employmentTypes: [{ id: 1, name: "ОПР" }], departments: [{ id: 1, name: "МУТТ" }], positions: [{ id: 1, name: "Монтажник" }], users: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false,
        bitrix24Cooldowns: { inspect: { nextAllowedAt: cooldown ? new Date(Date.now() + 120_000).toISOString() : null }, sync: { nextAllowedAt: null } } };
    }
    await route.fulfill({ json: body });
  });
  const heading = () => page.locator(".employees-page-heading");
  const back = () => heading().getByRole("button", { name: "К общим настройкам", exact: true });
  const excel = () => heading().getByRole("button", { name: "Excel", exact: true });
  async function open(mode = "") {
    await page.goto(`http://127.0.0.1:3150/employee-header.html${mode ? `?mode=${mode}` : ""}`);
    await page.getByRole("button", { name: "Общие настройки", exact: true }).click();
    await page.locator(".settings-list-item").filter({ hasText: "Кадровые данные" }).click();
    await page.locator(".employee-section .ag-row").first().waitFor();
  }
  async function closeMenu() { await page.keyboard.press("Escape"); await page.getByRole("menu", { name: "Действия с Excel", exact: true }).waitFor({ state: "detached" }); }
  await open();
  assert.equal(await back().innerText(), "Общие настройки");
  assert.equal(await excel().evaluate(element => getComputedStyle(element).backgroundColor), "rgb(24, 24, 27)");
  const tableHeaders = await page.locator(".employee-section .ag-header-cell-text").allTextContents();
  assert.ok(tableHeaders.includes("ФИО") && tableHeaders.includes("Должность") && tableHeaders.includes("Проверка Б24 / расхождение"));
  assert.equal(await page.locator(".employee-section .ag-row").count(), 4);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 913, height: 861 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 390, height: 480 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 680 && await page.getByRole("button", { name: "Свернуть меню", exact: true }).count()) await page.getByRole("button", { name: "Свернуть меню", exact: true }).click();
    const titleBox = await heading().getByRole("heading", { name: "Сотрудники", exact: true }).boundingBox(), backBox = await back().boundingBox();
    assert.ok(backBox.y + backBox.height <= titleBox.y + 1, `Back link above title at ${viewport.width}`);
    const actions = await heading().locator(".employees-heading-actions").boundingBox();
    assert.ok(actions.x + actions.width <= viewport.width + 1 && actions.x >= 0, `Header actions fit at ${viewport.width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal page overflow at ${viewport.width}`);
    const footer = await page.getByRole("button", { name: "Добавить сотрудника", exact: true }).boundingBox();
    assert.ok(footer.y + footer.height <= viewport.height + 1, `Original footer visible at ${viewport.width}`);
    await excel().focus(); await page.keyboard.press("ArrowDown");
    const menu = page.getByRole("menu", { name: "Действия с Excel", exact: true });
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Экспорт в Excel", "Импорт из Excel", "Скачать шаблон"]);
    const box = await menu.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, "Menu stays inside viewport");
    await closeMenu();
    assert.equal(await excel().evaluate(element => document.activeElement === element), true);
    if (viewport.width === 1440 || viewport.width === 390 && viewport.height === 844) await page.screenshot({ path: `/tmp/employee-header-variant2-${viewport.width}.png` });
  }
  console.log("PASS: variant-2 header, original columns/rows/footer, Excel keyboard/menu and desktop/phone layouts");
  await page.setViewportSize({ width: 1440, height: 900 });
  await excel().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Импорт из Excel", exact: true }).click();
  assert.equal((await chooser).isMultiple(), false);
  const check = () => heading().getByRole("button", { name: "Проверить с Битрикс24", exact: true });
  await check().click();
  await heading().getByRole("button", { name: "Проверяем…", exact: true }).waitFor();
  assert.equal(checkStarted, true);
  assert.equal(await heading().getByRole("button", { name: "Проверяем…", exact: true }).isDisabled(), true);
  await excel().click();
  assert.equal(await page.getByRole("menuitem", { name: "Импорт из Excel", exact: true }).isDisabled(), true);
  await closeMenu(); releaseCheck();
  await page.getByRole("dialog", { name: "Всё в порядке", exact: true }).waitFor();
  await page.getByRole("button", { name: "Закрыть результат проверки", exact: true }).click();
  await page.getByRole("button", { name: "Добавить сотрудника", exact: true }).click();
  const draft = page.locator('.ag-row[row-id^="employee-new-"]');
  await draft.waitFor(); await draft.locator('[col-id="fullName"]').dblclick();
  await draft.getByRole("textbox").fill("Несохранённый сотрудник"); await page.keyboard.press("Tab");
  await back().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Остаться", exact: true }).click();
  assert.equal(new URL(page.url()).pathname, "/settings/general/employees");
  assert.match(await draft.innerText(), /Несохранённый сотрудник/);
  await back().click(); await page.getByRole("alertdialog").getByRole("button", { name: "Перейти без сохранения", exact: true }).click();
  assert.equal(new URL(page.url()).pathname, "/settings/general");
  await page.locator(".settings-list-item").filter({ hasText: "Список должностей" }).click();
  assert.equal(await page.locator(".settings-page-heading .excel-menu-trigger").evaluate(element => getComputedStyle(element).backgroundColor), "rgb(24, 24, 27)", "Other workspace pages share the same Excel style");
  console.log("PASS: Bitrix loading state, import action, Back/Cancel draft protection and shared Excel style");
  cooldown = true; await open();
  assert.equal(await check().isDisabled(), true);
  assert.match(await heading().locator(".cooldown-button-wrapper").getAttribute("title"), /Повторная проверка/);
  cooldown = false;
  for (const mode of ["readonly", "restricted"]) {
    await open(mode); await excel().click();
    await page.getByRole("menu", { name: "Действия с Excel", exact: true }).waitFor();
    assert.deepEqual(await page.getByRole("menu", { name: "Действия с Excel", exact: true }).getByRole("menuitem").allTextContents(), ["Экспорт в Excel"]);
    await closeMenu();
    assert.equal(await check().count(), mode === "restricted" ? 0 : 1);
  }
  assert.deepEqual(writes, ["inspect-bitrix24"]); assert.deepEqual(errors, []);
  console.log("PASS: existing cooldown and role/project permission restrictions are preserved");
} finally { await browser?.close(); await server.httpServer.close(); }
