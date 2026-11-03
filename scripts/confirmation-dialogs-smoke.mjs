// Actual app and modal components; synthetic GET responses only, no database.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const config = {
  configFile: false, envDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false,
  plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "confirmation-dialogs-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/confirmation-dialogs.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3122, strictPort: true },
};
await build(config);
const server = await preview(config);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(10_000);
const errors = [], nativeDialogs = [], mutations = [];
page.on("pageerror", error => errors.push(error.message));
page.on("dialog", async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
const sites = [{ id: 1, name: "Первый тестовый проект", code: "TEST-1", timezone: "Europe/Moscow" }, { id: 2, name: "Второй тестовый проект", code: "TEST-2", timezone: "Europe/Moscow" }];
const rightsUsers = [
  { id: 1, fullName: "Первый пользователь", email: "one@example.invalid", role: "engineer", assignedSiteId: null, assignedSiteName: null, projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("engineer"), customized: false },
  { id: 2, fullName: "Второй пользователь", email: "two@example.invalid", role: "engineer", assignedSiteId: null, assignedSiteName: null, projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("engineer"), customized: false },
];
let rightsReads = 0;
await page.route("**/api/**", async route => {
  const request = route.request();
  if (request.method() !== "GET") mutations.push(request.url());
  assert.equal(request.method(), "GET", "Confirmation must not save or delete records");
  const url = new URL(request.url());
  let data;
  if (url.pathname === "/api/data") data = { sites, employees: [], projectEmployees: [], placementEmployees: [], reportEmployees: [], positionCatalog: [], employmentTypes: [], departments: [], positions: [], users: rightsUsers, shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false };
  else if (url.pathname === "/api/table-order") data = { ids: [], canWrite: false, hasSavedOrder: false };
  else if (url.pathname === "/api/equipment") data = { siteName: sites[0].name, units: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [] };
  else if (url.pathname.endsWith("-report")) data = { reports: [], entries: [], canReview: true, from: null, to: null, availabilityMarks: [] };
  else if (url.pathname === "/api/access-rights") { rightsReads++; data = { users: rightsUsers, sites, canManage: true, currentUserId: 99 }; }
  else if (url.pathname === "/api/roles") data = { roles: [], canManage: true };
  else throw new Error(`Unexpected isolated request: ${url.pathname}`);
  await route.fulfill({ json: data });
});
const popup = () => page.getByRole("alertdialog");
const nav = name => page.getByRole("button", { name, exact: true });
async function cancel() { await popup().getByRole("button", { name: "Остаться", exact: true }).click(); await popup().waitFor({ state: "detached" }); }
async function accept() { await popup().getByRole("button", { name: /без сохранения/ }).click(); await popup().waitFor({ state: "detached" }); }
async function assertModal() {
  await popup().waitFor();
  assert.equal(await popup().evaluate(dialog => dialog.matches(":modal")), true);
  assert.equal(await popup().getByRole("button").first().evaluate(button => document.activeElement === button), true, "Safe action receives initial focus");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  assert.equal(await popup().evaluate(dialog => dialog.contains(document.activeElement)), true, "Focus must stay in the confirmation");
}
try {
  await page.goto("http://127.0.0.1:3122/confirmation-dialogs.html");
  await page.getByRole("button", { name: "Добавить строку", exact: true }).waitFor();
  await nav("Общие настройки").click();
  await nav("Отчёт персонала").click();
  await page.getByRole("button", { name: "Добавить строку", exact: true }).click();
  await nav("Отчёт техники").click();
  await assertModal();
  await page.screenshot({ path: "/tmp/app-confirmation-desktop.png" });
  await cancel();
  assert.ok(new URL(page.url()).pathname.endsWith("/reports/workers"));
  assert.equal(await page.locator(".personnel-report-workspace .ag-row").count() > 0, true, "Cancel must preserve the unsaved report row");
  await nav("Отчёт техники").click(); await assertModal();
  await page.keyboard.press("Escape"); await popup().waitFor({ state: "detached" });
  assert.ok(new URL(page.url()).pathname.endsWith("/reports/workers"));
  await nav("Отчёт техники").click(); await assertModal();
  await page.mouse.click(4, 4); await popup().waitFor({ state: "detached" });
  assert.ok(new URL(page.url()).pathname.endsWith("/reports/workers"));
  // Browser Back must use the same confirmation and restore the URL on Cancel.
  await page.evaluate(() => history.back()); await assertModal(); await cancel();
  assert.ok(new URL(page.url()).pathname.endsWith("/reports/workers"));
  await page.evaluate(() => history.back()); await assertModal(); await accept();
  assert.equal(new URL(page.url()).pathname, "/settings/general");
  console.log("PASS: sidebar and browser Back use app confirmation; Cancel/Escape preserve report and URL");

  await nav("Отчёт персонала").click();
  await page.getByRole("button", { name: "Добавить строку", exact: true }).click();
  await nav("Отчёт техники").click(); await assertModal(); await accept();
  assert.ok(new URL(page.url()).pathname.endsWith("/reports/equipment"));
  await page.getByRole("button", { name: "Добавить строку", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать проект", exact: true }).click();
  await page.getByRole("option", { name: /Второй тестовый проект/ }).click();
  await assertModal(); await cancel();
  assert.match(await page.getByRole("button", { name: "Выбрать проект", exact: true }).innerText(), /Первый/);
  await page.getByRole("button", { name: "Выбрать проект", exact: true }).click();
  await page.getByRole("option", { name: /Второй тестовый проект/ }).click();
  await assertModal(); await accept();
  assert.match(await page.getByRole("button", { name: "Выбрать проект", exact: true }).innerText(), /Второй/);
  console.log("PASS: equipment report project change awaits app confirmation");

  await nav("Общие настройки").click();
  await page.locator(".settings-list-item").filter({ hasText: "Пользователи и права" }).click();
  await page.getByRole("button", { name: "Открыть пользователя Первый пользователь", exact: true }).click();
  await page.getByRole("dialog", { name: "Первый пользователь", exact: true }).getByRole("button", { name: "Индивидуальные права", exact: true }).click();
  const userAccess = page.getByRole("dialog", { name: "Индивидуальные права", exact: true });
  const permission = page.getByRole("checkbox", { name: "Удаление: Отчёт рабочих", exact: true });
  await permission.locator("..").click();
  await page.keyboard.press("Escape"); await assertModal();
  await cancel();
  assert.equal(await permission.isChecked(), false);
  const reads = rightsReads;
  await userAccess.getByRole("button", { name: "Обновить", exact: true }).click(); await assertModal(); await cancel();
  assert.equal(rightsReads, reads);
  await userAccess.getByRole("button", { name: "Обновить", exact: true }).click(); await assertModal(); await accept();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Удаление: Отчёт рабочих"]')?.checked);
  await page.waitForFunction(() => [...document.querySelectorAll(".embedded-user-access button")].find(button => button.textContent === "Сохранить доступ")?.disabled);
  assert.ok(rightsReads > reads);
  await userAccess.getByRole("button", { name: "Закрыть", exact: true }).click(); await userAccess.waitFor({ state: "detached" });
  console.log("PASS: individual access stays in the chosen profile; Escape/refresh preserve unsaved rights on Cancel");

  await page.getByRole("tab", { name: "Роли и права", exact: true }).click();
  await page.locator(".roles-sidebar footer button").click();
  const roleDialog = page.locator(".roles-permissions-panel");
  await roleDialog.getByRole("textbox", { name: "Название роли", exact: true }).fill("Несохранённая роль");
  for (const viewport of [{ width: 913, height: 953 }, { width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 390, height: 480 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 680 && await page.getByRole("button", { name: "Свернуть меню", exact: true }).count()) await page.getByRole("button", { name: "Свернуть меню", exact: true }).click();
    for (const name of ["Просмотр: Техника проекта", "Редактирование: Отчёт рабочих", "Удаление: Справочники проекта"]) {
      const checkbox = roleDialog.getByRole("checkbox", { name, exact: true });
      await checkbox.locator("..").click();
      await checkbox.focus();
      await page.keyboard.press("Space");
      const layout = await roleDialog.evaluate(dialog => {
        const box = dialog.getBoundingClientRect(), header = dialog.querySelector(".roles-panel-heading").getBoundingClientRect(), footer = dialog.querySelector(".roles-panel-footer").getBoundingClientRect();
        const input = document.activeElement, inputBox = input.getBoundingClientRect(), label = input.closest("label").getBoundingClientRect();
        return { scrollTop: dialog.scrollTop, top: box.top, bottom: box.bottom, headerTop: header.top, footerBottom: footer.bottom,
          inputContained: inputBox.top >= label.top - 1 && inputBox.bottom <= label.bottom + 1 };
      });
      assert.equal(layout.scrollTop, 0, JSON.stringify(layout));
      assert.ok(layout.headerTop >= layout.top && layout.footerBottom <= layout.bottom + 1 && layout.bottom - layout.footerBottom < 3, JSON.stringify(layout));
      assert.equal(layout.inputContained, true, "Hidden checkbox must not escape its own permission cell");
    }
  }
  await page.setViewportSize({ width: 913, height: 953 });
  await page.screenshot({ path: "/tmp/role-editor-layout-fixed.png" });
  console.log("PASS: inline role header/footer stay in place when focusing permissions on desktop, mobile and short viewports");
  await page.getByRole("tab", { name: "Пользователи", exact: true }).click(); await assertModal();
  await page.keyboard.press("Escape"); await popup().waitFor({ state: "detached" });
  assert.equal(await roleDialog.getByRole("textbox", { name: "Название роли", exact: true }).inputValue(), "Несохранённая роль");
  await page.getByRole("tab", { name: "Пользователи", exact: true }).click(); await assertModal();
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await popup().boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844);
  await page.screenshot({ path: "/tmp/app-confirmation-mobile.png" });
  await accept(); await roleDialog.waitFor({ state: "detached" });
  console.log("PASS: tab changes use app confirmation, focus trap, Escape and mobile layout");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("tab", { name: "Роли и права", exact: true }).click();
  await page.locator(".roles-sidebar footer button").click();
  const previousPermission = await permission.isChecked();
  await permission.locator("..").click();
  await page.getByRole("button", { name: "← К общим настройкам", exact: true }).click(); await assertModal(); await cancel();
  assert.equal(await permission.isChecked(), !previousPermission);
  await page.getByRole("button", { name: "← К общим настройкам", exact: true }).click(); await assertModal(); await accept();
  assert.equal(new URL(page.url()).pathname, "/settings/general");
  assert.deepEqual(errors, []);
  assert.deepEqual(nativeDialogs, [], "No native confirm/alert/prompt dialogs may open");
  assert.deepEqual(mutations, []);
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-2500));
  await page.screenshot({ path: "/tmp/confirmation-dialogs-failure.png" });
  throw error;
} finally { await browser.close(); await server.httpServer.close(); }
