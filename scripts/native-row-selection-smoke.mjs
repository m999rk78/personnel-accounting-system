// Real native table components with synthetic data; no live API or database.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { parseSpreadsheetText } from "../app/spreadsheetClipboard.ts";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const columnShortcut = process.env.TABLE_COLUMN_SHORTCUT ?? "Control+Space";
const port = Number(process.argv[3] ?? 3197), base = `http://127.0.0.1:${port}`;
const fixture = name => fileURLToPath(new URL(`../tests/fixtures/${name}.html`, import.meta.url));
const config = { configFile: false, envDir: false, publicDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()], logLevel: "error",
  build: { outDir: await mkdtemp(join(tmpdir(), "native-row-selection-")), emptyOutDir: false, rolldownOptions: { input: ["native-row-selection", "excel-preview-selection"].map(fixture) } },
  preview: { host: "127.0.0.1", port, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const copy = async root => parseSpreadsheetText(await root.evaluate(element => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event);
    if (!event.defaultPrevented) throw new Error("Table did not own copy");
    return clipboardData.getData("text/plain");
  }));
  await page.goto(`${base}/native-row-selection.html`);
  const users = page.getByRole("grid", { name: "Данные пользователей", exact: true });
  const rows = users.locator("[data-native-table-row]");
  await rows.nth(1).locator(".users-table-status").click();
  await page.keyboard.press("Shift+Space");
  assert.equal(await users.locator('[data-native-row-selected="true"]').count(), 1);
  assert.equal((await copy(users))[0][0], "Тестовый пользователь 2");
  await page.keyboard.press("Shift+ArrowDown");
  assert.equal((await copy(users)).length, 2);
  await page.keyboard.press("Shift+ArrowUp");
  assert.equal((await copy(users)).length, 1);
  await rows.nth(3).getByRole("button").click({ modifiers: ["Shift"] });
  assert.equal((await copy(users)).length, 3);
  assert.equal(await page.getByRole("dialog").count(), 0, "Shift-click never opens user details");
  await rows.nth(0).getByRole("checkbox").click({ modifiers: ["Shift"] });
  assert.equal((await copy(users)).length, 2);
  assert.equal(await page.getByLabel("Изменений данных").innerText(), "0", "Range clicks never modify action checkboxes");
  await page.keyboard.press("Escape");
  assert.equal(await users.locator('[data-native-row-selected="true"]').count(), 0);
  await rows.nth(2).getByRole("checkbox").focus();
  await page.keyboard.press("Shift+Space");
  assert.equal((await copy(users))[0][0], "Тестовый пользователь 3");
  assert.equal(await page.getByLabel("Изменений данных").innerText(), "0");
  await rows.nth(2).locator(".users-table-status").click();
  await page.keyboard.press(columnShortcut);
  assert.deepEqual((await copy(users))[0], ["Роль", "Статус"]);
  assert.equal((await copy(users)).length, 5);
  await page.keyboard.press("Shift+ArrowLeft");
  assert.deepEqual((await copy(users))[0], ["ФИО", "Email", "Роль", "Статус"]);
  await page.keyboard.press("Shift+ArrowRight");
  assert.deepEqual((await copy(users))[0], ["Роль", "Статус"]);
  await rows.nth(0).getByRole("button").click({ modifiers: ["Shift"] });
  assert.deepEqual((await copy(users))[0], ["ФИО", "Email", "Роль", "Статус"]);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.keyboard.press("Shift+Space");
  assert.deepEqual((await copy(users)).map(row => row[0]), ["Тестовый пользователь 3"], "Column-to-row preserves active row");
  await page.keyboard.press(columnShortcut);
  assert.deepEqual((await copy(users))[0], ["ФИО", "Email"], "Row-to-column selects the active physical column, not all data");
  await page.getByRole("textbox", { name: "Найти пользователя", exact: true }).fill("пользователь 1");
  assert.equal(await users.locator('[data-native-row-selected="true"]').count(), 0, "Search clears the old range");
  console.log("PASS users: whole rows, extend/shrink/reverse, copy, filter reset, no dialog or checkbox mutation");
  console.log("PASS users columns: matching grouped fields/headings, horizontal extension, Shift-click and row-mode switching");

  await page.getByRole("button", { name: "Права", exact: true }).click();
  const matrix = page.getByRole("grid", { name: "Тестовые права", exact: true });
  const permissionRows = matrix.locator("[data-native-table-row]");
  const checkbox = permissionRows.nth(1).getByRole("checkbox").first();
  await checkbox.focus(); await page.keyboard.press("Shift+Space");
  assert.equal((await copy(matrix)).length, 1);
  await permissionRows.nth(3).locator("label.permission-cell").first().click({ modifiers: ["Shift"] });
  assert.equal((await copy(matrix)).length, 3);
  assert.equal(await page.getByLabel("Изменений данных").innerText(), "0", "Selecting permission rows cannot change access rights");
  await page.keyboard.press("ControlOrMeta+a");
  const all = await copy(matrix);
  assert.equal(all.length, await permissionRows.count() + 1);
  await permissionRows.nth(1).getByRole("cell").click();
  await checkbox.focus(); await page.keyboard.press(columnShortcut);
  assert.deepEqual((await copy(matrix))[0], ["Просмотр"]);
  await page.keyboard.press("Shift+ArrowRight");
  assert.deepEqual((await copy(matrix))[0], ["Просмотр", "Добавление"]);
  await permissionRows.nth(3).locator("label.permission-cell").nth(2).click({ modifiers: ["Shift"] });
  assert.deepEqual((await copy(matrix))[0], ["Просмотр", "Добавление", "Редактирование"]);
  assert.equal(await page.getByLabel("Изменений данных").innerText(), "0", "Selecting columns cannot toggle access rights");
  await page.keyboard.press("Shift+Space");
  assert.equal((await copy(matrix)).length, 1);
  assert.equal((await copy(matrix))[0][0], all[2][0], "Original permission row remains active");
  await page.keyboard.press(columnShortcut);
  await permissionRows.nth(1).getByRole("checkbox").first().focus();
  await page.keyboard.press(columnShortcut);
  assert.deepEqual((await copy(matrix))[0], ["Просмотр"], "Explicit focus on another action selects that column");
  assert.equal(await page.getByLabel("Изменений данных").innerText(), "0");
  console.log("PASS permission matrix: range selection does not toggle rights; Ctrl+A still includes headings");

  await page.goto(`${base}/excel-preview-selection.html`);
  const preview = page.getByRole("grid", { name: "Данные предпросмотра Excel", exact: true });
  await preview.locator("tbody tr").first().locator("td").first().click();
  await page.keyboard.press("Shift+Space");
  assert.deepEqual(await copy(preview), [["1", "Первый тестовый сотрудник", "6"]]);
  await page.keyboard.press("Shift+ArrowDown");
  assert.deepEqual(await copy(preview), [["1", "Первый тестовый сотрудник", "6"], ["2", "Второй тестовый сотрудник", "0"]]);
  await preview.locator("tbody tr").first().locator("td").last().click();
  await page.keyboard.press(columnShortcut);
  assert.deepEqual(await copy(preview), [["Часы"], ["6"], ["0"]]);
  await page.keyboard.press("Shift+ArrowLeft");
  assert.deepEqual(await copy(preview), [["ФИО", "Часы"], ["Первый тестовый сотрудник", "6"], ["Второй тестовый сотрудник", "0"]]);
  for (const [kind, column, expected] of [
    ["personnel-timesheet", 5, [["1", "2"], ["6", "0"]]],
    ["equipment-timesheet", 3, [["1", "2"], ["6 / П 2", "П 8"]]],
    ["placement", 1, [["ФИО", "Смена"], ["Тестовый сотрудник", "День"]]],
    ["equipment-placement", 1, [["Техника", "Смена"], ["Тестовая техника", "День"]]],
  ]) {
    await page.goto(`${base}/excel-preview-selection.html?kind=${kind}`);
    const cell = preview.locator(`tbody [data-native-table-column="${column}"]`).first();
    await cell.click(); await page.keyboard.press(columnShortcut); await page.keyboard.press("Shift+ArrowRight");
    assert.deepEqual(await copy(preview), expected, `${kind}: merged metadata never shifts copied leaf columns`);
    if (kind === "equipment-timesheet") {
      await preview.locator('tbody [data-native-table-column="5"]').click(); await page.keyboard.press(columnShortcut);
      assert.deepEqual(await copy(preview), [["3"], ["0"]], "Manual zero remains zero when copying equipment days");
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS Excel preview: row/column ranges in all five templates, matching leaf headers, downtime and manual zero; no runtime errors");
} finally { await browser?.close(); await server.httpServer.close(); }
