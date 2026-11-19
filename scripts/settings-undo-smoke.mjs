// Real settings components, local drafts and intercepted synthetic HTTP only.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = Number(process.argv[3] ?? 3204);
const fixtures = new URL("../tests/fixtures/", import.meta.url);
const config = { configFile: false, envDir: false, publicDir: false, logLevel: "warn", root: fileURLToPath(fixtures), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "settings-undo-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("settings-undo.html", fixtures)) } },
  preview: { host: "127.0.0.1", port, strictPort: true } };
let server, browser, page, currentCase = "initialisation", releaseSave;
let deferSave = false;
const errors = [], checks = [], mutations = [];
const permission = { view: true, create: false, update: false, delete: false };
let roles = [1, 2].map(id => ({ id, name: id === 1 ? "Первая роль" : "Вторая роль", baseRole: "engineer", revision: 1, permissions: { employees: { ...permission } } }));
let users = [1, 2].map(id => ({ id, fullName: id === 1 ? "Тестовый сотрудник" : "Другой сотрудник", email: `${id}@example.invalid`, role: "engineer", assignedSiteId: id,
  assignedSiteName: id === 1 ? "Учебный проект" : "Второй проект", projectAccess: { mode: "selected", siteIds: [id] }, canViewPendingReports: true,
  permissions: { employees: { ...permission } }, roleTemplate: { employees: { view: true, create: true, update: true, delete: true } }, customized: true, permissionsManageable: true }));
try {
  await build(config); server = await preview(config);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1250, height: 950 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
    if (path === "/api/roles") {
      if (request.method() === "GET") return route.fulfill({ json: { roles, canManage: true } });
      const body = request.postDataJSON();
      if (deferSave) await new Promise(resolve => { releaseSave = resolve; });
      const role = { id: body.roleId ?? 3, name: body.name, baseRole: "engineer", revision: (roles.find(role => role.id === body.roleId)?.revision ?? 0) + 1, permissions: body.permissions };
      roles = [...roles.filter(item => item.id !== role.id), role];
      return route.fulfill({ json: { role } });
    }
    assert.equal(path, "/api/access-rights");
    if (request.method() === "GET") return route.fulfill({ json: { sites: [{ id: 1, name: "Учебный проект" }, { id: 2, name: "Второй проект" }], users, canManage: true, currentUserId: 99 } });
    const body = request.postDataJSON();
    const updated = { ...users.find(user => user.id === body.userId), permissions: body.permissions, projectAccess: body.projectAccess, canViewPendingReports: body.canViewPendingReports };
    users = users.map(user => user.id === body.userId ? updated : user);
    return route.fulfill({ json: { ...updated, customized: true } });
  });
  const open = mode => page.goto(`http://127.0.0.1:${port}/settings-undo.html?mode=${mode}`);
  const undo = () => page.keyboard.press("Control+z");
  const redo = () => page.keyboard.press("Control+Shift+z");
  const employee = action => page.locator('[data-permission-resource="employees"] input').nth(action);
  const checked = async (locator, expected) => assert.equal(await locator.isChecked(), expected, currentCase);
  const state = () => page.getByRole("status", { name: "Черновики проверки" }).evaluate(element => JSON.parse(element.textContent));

  currentCase = "roles: checkbox, templates, redo, saving lock and saved boundary";
  await open("roles");
  await page.getByRole("button", { name: /Первая роль/ }).click();
  const roleName = page.getByRole("textbox", { name: "Название роли", exact: true });
  await roleName.click(); await roleName.press("End"); await roleName.pressSequentially(" тест", { delay: 30 });
  await employee(2).locator("..").click();
  await roleName.focus(); await page.keyboard.press("ControlOrMeta+z");
  const nativeRoleName = await roleName.inputValue();
  await employee(2).focus(); await undo();
  await checked(employee(2), false);
  assert.equal(await roleName.inputValue(), nativeRoleName, "App undo restores the checkbox without reapplying native-undone text");
  await page.getByRole("button", { name: "Сбросить изменения", exact: true }).click();
  await employee(2).locator("..").click(); await undo(); await checked(employee(2), false);
  await redo(); await checked(employee(2), true);
  await page.getByRole("button", { name: "Полный доступ", exact: true }).click();
  await checked(employee(3), true); await undo(); await checked(employee(3), false);
  await page.getByRole("button", { name: "Сбросить изменения", exact: true }).click();
  await undo(); await checked(employee(2), false);
  await employee(2).locator("..").click();
  deferSave = true;
  await page.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await page.getByRole("button", { name: "Сохраняем…", exact: true }).waitFor();
  await undo(); await checked(employee(2), true);
  await page.waitForFunction(() => document.querySelector('.roles-panel-footer button[type="submit"]').disabled);
  assert.equal(typeof releaseSave, "function"); releaseSave(); deferSave = false;
  await page.getByText("Роль сохранена.", { exact: true }).waitFor();
  await undo(); await checked(employee(2), true);
  await page.getByRole("button", { name: /Вторая роль/ }).click();
  await undo(); await checked(employee(2), false);
  checks.push(currentCase);

  currentCase = "role modal: checkbox undo and redo inside native dialog";
  await open("role-dialog");
  await page.getByRole("dialog").waitFor();
  await employee(0).locator("..").click(); await undo(); await checked(employee(0), false);
  await redo(); await checked(employee(0), true);
  checks.push(currentCase);

  currentCase = "individual rights: permission/project snapshot, saved boundary and user switch";
  await open("access");
  await employee(2).waitFor();
  await employee(2).locator("..").click(); await undo(); await checked(employee(2), false);
  await redo(); await checked(employee(2), true);
  await page.getByRole("button", { name: "Все проекты", exact: true }).click();
  await undo();
  assert.equal(await page.getByRole("button", { name: "Выбранные проекты", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Сохранить доступ", exact: true }).click();
  await page.getByText("Индивидуальные права сохранены.", { exact: true }).waitFor();
  await undo(); await checked(employee(2), true);
  await page.getByRole("button", { name: /Другой сотрудник/ }).click();
  await undo(); await checked(employee(2), false);
  checks.push(currentCase);

  currentCase = "user dialog: dropdown role undo/redo and independent user scope";
  await open("users");
  const userDialog = page.getByRole("dialog", { name: "Редактирование пользователя", exact: true });
  await userDialog.getByRole("button", { name: "Роль пользователя", exact: true }).click();
  await page.getByRole("option", { name: "Вторая роль", exact: true }).click();
  assert.equal((await state()).users[0].customRoleId, 2);
  await undo(); assert.equal((await state()).users[0].customRoleId, 1);
  await redo(); assert.equal((await state()).users[0].customRoleId, 2);
  await userDialog.getByRole("button", { name: "Следующий пользователь", exact: true }).click();
  await undo(); assert.equal((await state()).users[1].customRoleId, 2);
  checks.push(currentCase);

  currentCase = "project dialog: native text undo, blur undo, saving lock and saved scope";
  await open("projects");
  let name = page.getByRole("textbox", { name: "Название проекта", exact: true });
  await name.click(); await name.press("End"); await name.pressSequentially(" тест", { delay: 30 });
  const typedName = await name.inputValue();
  await page.keyboard.press("ControlOrMeta+z");
  const undoneName = await name.inputValue();
  assert.ok(undoneName !== typedName && typedName.startsWith(undoneName), "Native text undo stays inside the input; browser text grouping may differ");
  await name.press("Tab"); await undo();
  assert.equal(await name.inputValue(), undoneName, "App undo after blur never reapplies native-undone text");
  await open("projects"); name = page.getByRole("textbox", { name: "Название проекта", exact: true });
  await name.fill("Изменённый проект"); await name.press("Tab"); await undo();
  assert.equal(await name.inputValue(), "Учебный проект");
  await redo(); assert.equal(await name.inputValue(), "Изменённый проект");
  await page.getByRole("button", { name: "Сохранить все (2)", exact: true }).click();
  await undo(); assert.equal(await name.inputValue(), "Изменённый проект");
  await page.getByRole("button", { name: "Завершить тестовое сохранение", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Изменить проект", exact: true }).first().click();
  name = page.getByRole("textbox", { name: "Название проекта", exact: true });
  await undo(); assert.equal(await name.inputValue(), "Изменённый проект");
  checks.push(currentCase);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, runtimeErrors: errors.length, interceptedMutations: mutations }));
} catch (error) {
  console.error(`FAILED ${currentCase}: ${error.message}`);
  await page?.screenshot({ path: join(tmpdir(), "settings-undo-failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  releaseSave?.();
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
