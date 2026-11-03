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
const sidebarRole = name => page.locator(".roles-sidebar-item").filter({ hasText: name });
const panel = () => page.locator(".roles-permissions-panel");
async function openRoles() {
  await page.getByRole("button", { name: "Общие настройки", exact: true }).click();
  await page.locator(".settings-list-item").filter({ hasText: "Пользователи и права" }).click();
  await page.getByRole("tab", { name: "Роли и права", exact: true }).click();
  await page.locator(".roles-sidebar footer button").waitFor();
}
async function openUserRole() {
  await page.getByRole("tab", { name: "Пользователи", exact: true }).click();
  await page.getByRole("button", { name: "Открыть пользователя Существующий пользователь", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Существующий пользователь", exact: true });
  assert.match(await details.innerText(), /user@example.invalid/);
  await details.getByRole("button", { name: "Изменить роль", exact: true }).click();
  return page.getByRole("dialog", { name: "Изменить роль пользователя", exact: true });
}
try {
  await page.goto("http://127.0.0.1:3124/confirmation-dialogs.html"); await openRoles();
  assert.equal(await page.locator(".roles-sidebar-item").count(), 4);
  assert.equal(await panel().getByRole("button", { name: "Удалить роль", exact: true }).count(), 0);
  await page.locator(".roles-sidebar footer button").click();
  await panel().getByRole("textbox", { name: "Название роли", exact: true }).fill("Координатор");
  await panel().getByRole("checkbox", { name: "Редактирование: Отчёт рабочих", exact: true }).locator("..").click();
  await panel().getByRole("button", { name: "Создать роль", exact: true }).click(); await sidebarRole("Координатор").waitFor();
  await panel().getByRole("textbox", { name: "Название роли", exact: true }).fill("Координатор производства");
  await panel().getByRole("checkbox", { name: "Добавление: Отчёт техники", exact: true }).locator("..").click();
  await panel().getByRole("button", { name: "Сохранить изменения", exact: true }).click(); await sidebarRole("Координатор производства").waitFor();
  assert.equal(roles.find(role => role.id === 100).revision, 2); assert.equal(roles.find(role => role.id === 100).permissions.equipment_report.create, true);
  await page.screenshot({ path: "/tmp/users-rights-roles.png" });
  // Search only filters the display, and unsaved drafts cannot disappear on tab change.
  await panel().getByRole("searchbox", { name: "Найти раздел прав", exact: true }).fill("техники");
  assert.equal(await panel().getByRole("checkbox", { name: "Просмотр: Отчёт рабочих", exact: true }).count(), 0);
  await panel().getByRole("searchbox", { name: "Найти раздел прав", exact: true }).fill("");
  await panel().getByRole("textbox", { name: "Название роли", exact: true }).fill("Не сохранять");
  await page.getByRole("tab", { name: "Пользователи", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Остаться", exact: true }).click();
  assert.equal(await panel().getByRole("textbox", { name: "Название роли", exact: true }).inputValue(), "Не сохранять");
  await panel().getByRole("button", { name: "Сбросить изменения", exact: true }).click();
  let dialog = await openUserRole();
  assert.equal(await dialog.getByRole("textbox", { name: "ФИО", exact: true }).count(), 0);
  await dialog.getByRole("button", { name: "Роль пользователя", exact: true }).click();
  await page.getByRole("option", { name: "Координатор производства", exact: true }).click();
  await dialog.getByRole("button", { name: "Сохранить роль пользователя", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  assert.equal(assignments[0].customRoleId, 100); assert.equal(users[1].customRoleName, "Координатор производства");
  console.log("PASS: create/edit catalog role and assign it to an existing user without changing profile data");
  assert.equal(await page.getByRole("columnheader", { name: "ФИО", exact: true }).count(), 1);
  assert.equal(await page.getByRole("columnheader", { name: "Роль", exact: true }).count(), 1);
  assert.equal(await page.locator(".users-table").getByRole("link", { name: "user@example.invalid" }).count(), 0);
  await page.screenshot({ path: "/tmp/users-rights-users.png" });
  await openRoles();
  await sidebarRole("Координатор производства").click();
  await panel().getByRole("button", { name: "Удалить роль", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Удалить роль", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Сначала назначьте" }).waitFor(); assert.equal(roles.length, 4);
  dialog = await openUserRole();
  await dialog.getByRole("button", { name: "Роль пользователя", exact: true }).click();
  await page.getByRole("option", { name: "Инженер", exact: true }).click();
  await dialog.getByRole("button", { name: "Сохранить роль пользователя", exact: true }).click(); await dialog.waitFor({ state: "detached" });
  assert.equal(users[1].customRoleId, 11);
  await openRoles(); await sidebarRole("Координатор производства").click(); await panel().getByRole("button", { name: "Удалить роль", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Удалить роль", exact: true }).click();
  await sidebarRole("Координатор производства").waitFor({ state: "detached" }); assert.equal(roles.length, 3);
  await sidebarRole("Прораб").click();
  await panel().getByRole("textbox", { name: "Название роли", exact: true }).fill("Начальник смены");
  await panel().getByRole("button", { name: "Сохранить изменения", exact: true }).click(); await sidebarRole("Начальник смены").waitFor();
  assert.equal(roles.find(role => role.legacyRoleKey === "foreman").name, "Начальник смены");
  await sidebarRole("Просмотр").click(); await panel().getByRole("button", { name: "Удалить роль", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Удалить роль", exact: true }).click();
  await sidebarRole("Просмотр").waitFor({ state: "detached" });
  await sidebarRole("Супер-админ").click();
  assert.equal(await panel().getByRole("button", { name: "Сохранить изменения", exact: true }).count(), 0);
  assert.equal(await panel().getByRole("checkbox").first().isDisabled(), true);
  await sidebarRole("Начальник смены").click();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 913, height: 953 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 680) await page.getByRole("button", { name: "Свернуть меню", exact: true }).click();
    const checkbox = panel().getByRole("checkbox", { name: "Удаление: Справочники проекта", exact: true });
    await checkbox.focus(); await page.keyboard.press("Space"); await page.keyboard.press("Space");
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(bodyWidth <= viewport.width + 1, `No page-level horizontal overflow at ${viewport.width}: ${bodyWidth}`);
    const footer = await panel().locator(".roles-panel-footer").boundingBox(), box = await panel().boundingBox();
    assert.ok(Math.abs(footer.y + footer.height - box.y - box.height) < 3, "Footer stays at panel bottom");
    await page.screenshot({ path: `/tmp/users-rights-${viewport.width}.png`, fullPage: true });
  }
  // Each tab is hidden if its permission is missing, rather than showing disabled controls.
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const accessMode of ["users-only", "roles-only", "read-only"]) {
    await page.goto(`http://127.0.0.1:3124/confirmation-dialogs.html?access=${accessMode}`);
    await page.locator(".settings-list-item").filter({ hasText: "Пользователи и права" }).click();
    assert.equal(await page.getByRole("tab", { name: "Пользователи", exact: true }).count(), accessMode === "roles-only" ? 0 : 1);
    assert.equal(await page.getByRole("tab", { name: "Роли и права", exact: true }).count(), accessMode === "users-only" ? 0 : 1);
    if (accessMode !== "roles-only") {
      await page.getByRole("button", { name: "Открыть пользователя Существующий пользователь", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "Существующий пользователь", exact: true });
      assert.equal(await dialog.getByRole("button", { name: "Редактировать", exact: true }).count(), 0);
      assert.equal(await dialog.getByRole("button", { name: "Изменить роль", exact: true }).count(), 0);
      await dialog.getByRole("button", { name: "Закрыть карточку пользователя", exact: true }).click();
    }
    if (accessMode !== "users-only") {
      await page.getByRole("tab", { name: "Роли и права", exact: true }).click();
      await sidebarRole("Инженер").click();
      assert.equal(await panel().getByRole("button", { name: "Сохранить изменения", exact: true }).count(), 0);
      assert.equal(await panel().getByRole("checkbox").first().isDisabled(), true);
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(native, []);
  console.log("PASS: in-use deletion rejected; previous Foreman/Engineer/Viewer templates are editable/deletable; only Super-admin remains protected");
} catch (error) { console.error((await page.locator("body").innerText()).slice(-2200)); await page.screenshot({ path: "/tmp/role-management-failure.png" }); throw error; }
finally { await browser.close(); await server.httpServer.close(); }
