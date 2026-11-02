// Full application, synthetic role/user APIs. No credentials or external database.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { managedDefaultRoleSeeds, normalizeCustomRoleInput } from "../app/customRoles.ts";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const config = { configFile: false, envDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false, plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "role-management-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/confirmation-dialogs.html", import.meta.url)) } }, preview: { host: "127.0.0.1", port: 3124, strictPort: true } };
await build(config);
const server = await preview(config), browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(12_000);
const roles = managedDefaultRoleSeeds().map((seed, index) => ({ id: 10 + index, name: seed.name, baseRole: seed.key, permissions: seed.permissions, revision: 1, legacyRoleKey: seed.key })), errors = [], native = [], assignments = [];
const site = { id: 1, name: "Тестовый объект", code: "TEST", timezone: "Europe/Moscow" };
const users = [
  { id: 1, fullName: "Администратор", email: "admin@example.invalid", role: "superadmin", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, status: "active" },
  { id: 2, fullName: "Существующий пользователь", email: "user@example.invalid", role: "engineer", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, status: "active" },
];
page.on("pageerror", error => errors.push(error.message)); page.on("dialog", async dialog => { native.push(dialog.type()); await dialog.dismiss(); });
await page.route("**/api/**", async route => {
  const req = route.request(), url = new URL(req.url()), body = req.method() === "GET" ? {} : req.postDataJSON();
  let data, status = 200;
  if (url.pathname === "/api/roles") {
    if (req.method() === "GET") data = { roles, canManage: true };
    else if (req.method() === "DELETE") {
      if (users.some(user => user.customRoleId === body.roleId)) { data = { error: "Сначала назначьте пользователям другую роль.", code: "ROLE_IN_USE" }; status = 409; }
      else { roles.splice(roles.findIndex(role => role.id === body.roleId), 1); data = { ok: true, id: body.roleId }; }
    } else {
      const normalized = normalizeCustomRoleInput(body);
      const previous = roles.find(role => role.id === body.roleId);
      assert.ok(req.method() === "POST" || previous?.revision === body.revision);
      const role = { id: previous?.id ?? 100, name: normalized.name, baseRole: previous?.baseRole === "foreman" ? "foreman" : normalized.baseRole, permissions: normalized.permissions, revision: previous ? previous.revision + 1 : 1, ...(previous?.legacyRoleKey ? { legacyRoleKey: previous.legacyRoleKey } : {}) };
      if (previous) roles.splice(roles.indexOf(previous), 1, role); else roles.push(role);
      users.filter(user => user.customRoleId === role.id).forEach(user => { user.role = role.baseRole; });
      data = { role, id: role.id }; status = previous ? 200 : 201;
    }
  } else if (url.pathname === "/api/data") {
    if (req.method() === "PATCH") {
      assert.equal(body.action, "update-user"); assert.equal(body.userId, 2);
      const user = users.find(user => user.id === body.userId), role = roles.find(role => role.id === body.customRoleId);
      assert.equal(body.fullName, user.fullName); assert.equal(body.email, user.email);
      Object.assign(user, body, { id: body.userId, role: role?.baseRole ?? body.role, customRoleName: role?.name ?? null }); assignments.push(body);
      data = { ok: true };
    } else {
      assert.equal(req.method(), "GET");
      data = { sites: [site], users, employees: [], projectEmployees: [], placementEmployees: [], reportEmployees: [], positionCatalog: [], employmentTypes: [], departments: [], positions: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false };
    }
  } else if (url.pathname === "/api/access-rights") data = { users: users.map(user => ({ ...user, customRoleName: roles.find(role => role.id === user.customRoleId)?.name ?? null, roleTemplate: roles.find(role => role.id === user.customRoleId)?.permissions ?? rolePermissionTemplate(user.role), permissions: roles.find(role => role.id === user.customRoleId)?.permissions ?? rolePermissionTemplate(user.role), canViewPendingReports: user.role !== "viewer", customized: false })), sites: [site], canManage: true, currentUserId: 1 };
  else if (url.pathname === "/api/table-order") data = { ids: [1, 2], canWrite: false, hasSavedOrder: false };
  else if (url.pathname.endsWith("-report")) data = { reports: [], entries: [], canReview: true, from: null, to: null, availabilityMarks: [] };
  else throw new Error(`Unexpected synthetic API ${url.pathname}`);
  await route.fulfill({ json: data, status });
});
const roleRow = () => page.locator(".role-catalog-row").filter({ hasText: "Координатор производства" });
async function openRoles() {
  await page.getByRole("button", { name: "Общие настройки", exact: true }).click();
  await page.locator(".settings-list-item").filter({ hasText: "Права доступа" }).click();
  await page.getByRole("button", { name: "Добавить роль", exact: true }).waitFor();
  if (!await page.locator(".access-role-catalog").evaluate(details => details.open)) await page.locator(".access-role-catalog > summary").click();
}
async function openUserRole() {
  await page.getByRole("button", { name: "Общие настройки", exact: true }).click();
  await page.locator(".settings-list-item").filter({ hasText: "Пользователи системы" }).click();
  await page.locator(".user-access-card").filter({ hasText: "Существующий пользователь" }).getByRole("button", { name: "Изменить роль", exact: true }).click();
  return page.getByRole("dialog", { name: "Изменить роль пользователя", exact: true });
}
try {
  await page.goto("http://127.0.0.1:3124/confirmation-dialogs.html"); await openRoles();
  assert.equal(await page.locator(".role-catalog-row").count(), 4);
  assert.equal(await page.getByRole("button", { name: /^Удалить роль/ }).count(), 3);
  await page.getByRole("button", { name: "Добавить роль", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Добавить роль", exact: true });
  await dialog.getByRole("textbox", { name: "Название роли", exact: true }).fill("Координатор");
  await dialog.getByRole("checkbox", { name: "Редактирование: Отчёт рабочих", exact: true }).locator("..").click();
  await dialog.getByRole("button", { name: "Сохранить роль", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  await page.locator(".role-catalog-row").filter({ hasText: "Координатор" }).getByRole("button", { name: "Редактировать", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Редактировать роль", exact: true });
  await dialog.getByRole("textbox", { name: "Название роли", exact: true }).fill("Координатор производства");
  await dialog.getByRole("checkbox", { name: "Добавление: Отчёт техники", exact: true }).locator("..").click();
  await dialog.getByRole("button", { name: "Сохранить роль", exact: true }).click(); await dialog.waitFor({ state: "detached" }); await roleRow().waitFor();
  assert.equal(roles.find(role => role.id === 100).revision, 2); assert.equal(roles.find(role => role.id === 100).permissions.equipment_report.create, true);
  await page.screenshot({ path: "/tmp/roles-catalog.png" });
  dialog = await openUserRole();
  assert.equal(await dialog.getByRole("textbox", { name: "ФИО", exact: true }).count(), 0);
  await dialog.getByRole("button", { name: "Роль пользователя", exact: true }).click();
  await page.getByRole("option", { name: "Координатор производства", exact: true }).click();
  await dialog.getByRole("button", { name: "Сохранить роль пользователя", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  assert.equal(assignments[0].customRoleId, 100); assert.equal(users[1].customRoleName, "Координатор производства");
  console.log("PASS: create/edit catalog role and assign it to an existing user without changing profile data");
  await openRoles();
  await roleRow().getByRole("button", { name: "Удалить роль Координатор производства", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Удалить роль", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Сначала назначьте" }).waitFor(); assert.equal(roles.length, 4);
  dialog = await openUserRole();
  await dialog.getByRole("button", { name: "Роль пользователя", exact: true }).click();
  await page.getByRole("option", { name: "Инженер", exact: true }).click();
  await dialog.getByRole("button", { name: "Сохранить роль пользователя", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  assert.equal(users[1].customRoleId, 11);
  await openRoles(); await roleRow().getByRole("button", { name: "Удалить роль Координатор производства", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Удалить роль", exact: true }).click();
  await roleRow().waitFor({ state: "detached" }); assert.equal(roles.length, 3);
  await page.locator(".role-catalog-row").filter({ hasText: "Прораб" }).getByRole("button", { name: "Редактировать", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Редактировать роль", exact: true });
  await dialog.getByRole("textbox", { name: "Название роли", exact: true }).fill("Начальник смены");
  await dialog.getByRole("button", { name: "Сохранить роль", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  assert.equal(roles.find(role => role.legacyRoleKey === "foreman").name, "Начальник смены");
  await page.getByRole("button", { name: "Удалить роль Просмотр", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Удалить роль", exact: true }).click();
  await page.getByRole("button", { name: "Удалить роль Просмотр", exact: true }).waitFor({ state: "detached" });
  await page.screenshot({ path: "/tmp/roles-catalog.png" });
  await page.locator(".role-catalog-row").filter({ hasText: "Супер-админ" }).getByRole("button", { name: "Просмотреть", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Супер-админ", exact: true });
  assert.equal(await dialog.getByRole("button", { name: "Сохранить роль", exact: true }).count(), 0);
  assert.deepEqual(errors, []); assert.deepEqual(native, []);
  console.log("PASS: in-use deletion rejected; previous Foreman/Engineer/Viewer templates are editable/deletable; only Super-admin remains protected");
} catch (error) { console.error((await page.locator("body").innerText()).slice(-2200)); await page.screenshot({ path: "/tmp/role-management-failure.png" }); throw error; }
finally { await browser.close(); await server.httpServer.close(); }
