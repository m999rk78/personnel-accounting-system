// Real roles interface with synthetic APIs only; no environment or database.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { managedDefaultRoleSeeds, normalizeCustomRoleInput } from "../app/customRoles.ts";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const outDir = await mkdtemp(join(tmpdir(), "role-status-permissions-"));
const port = 3181;
const config = { configFile: false, envDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false, plugins: [react()],
  build: { outDir, emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/confirmation-dialogs.html", import.meta.url)) } }, preview: { host: "127.0.0.1", port, strictPort: true } };
let browser, server;
const roles = managedDefaultRoleSeeds().map((seed, index) => ({ id: 10 + index, name: seed.name, baseRole: seed.key, permissions: seed.permissions, revision: 1, legacyRoleKey: seed.key }));
const errors = [], mutations = [];
const site = { id: 1, name: "Учебный объект", code: "TEST", timezone: "Europe/Moscow" };
const actor = { id: 1, fullName: "Тестовый администратор", email: "test@example.invalid", role: "superadmin", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("superadmin") };
try {
  await build(config);
  server = await preview(config);
  browser = await chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
  page.setDefaultTimeout(12_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), body = req.postDataJSON();
    let data;
    if (url.pathname === "/api/roles") {
      if (req.method() === "GET") data = { roles, canManage: true };
      else {
        assert.ok(["POST", "PATCH"].includes(req.method()));
        const normalized = normalizeCustomRoleInput(body);
        const previous = roles.find(role => role.id === body.roleId);
        assert.ok(req.method() === "POST" || previous?.revision === body.revision);
        const role = { id: previous?.id ?? 100, name: normalized.name, baseRole: previous?.baseRole === "foreman" ? "foreman" : normalized.baseRole, permissions: normalized.permissions, revision: previous ? previous.revision + 1 : 1 };
        if (previous) roles.splice(roles.indexOf(previous), 1, role); else roles.push(role);
        mutations.push(structuredClone(body)); data = { role };
      }
    } else if (url.pathname === "/api/data") {
      assert.equal(req.method(), "GET");
      data = { sites: [site], users: [actor], employees: [], projectEmployees: [], placementEmployees: [], reportEmployees: [], positionCatalog: [], employmentTypes: [], departments: [], positions: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false };
    } else if (url.pathname === "/api/access-rights") data = { users: [actor], sites: [site], canManage: true, currentUserId: 1 };
    else if (url.pathname === "/api/table-order") data = { ids: [], canWrite: false, hasSavedOrder: false };
    else if (url.pathname.endsWith("-report-draft")) { assert.equal(req.method(), "GET"); data = { revision: 0, snapshot: null }; }
    else if (url.pathname.endsWith("-report")) data = { reports: [], entries: [], canReview: true, from: null, to: null, availabilityMarks: [] };
    else throw new Error(`Unexpected synthetic API ${url.pathname}`);
    await route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${port}/confirmation-dialogs.html`);
  await page.getByRole("button", { name: "Общие настройки", exact: true }).click();
  await page.locator(".settings-list-item").filter({ hasText: "Пользователи и права" }).click();
  await page.getByRole("tab", { name: "Роли и права", exact: true }).click();
  const panel = page.locator(".roles-permissions-panel");
  const check = (label, title) => panel.getByRole("checkbox", { name: `${label}: ${title}`, exact: true });
  const toggle = async (label, title, enabled) => { const checkbox = check(label, title); if (await checkbox.isChecked() !== enabled) await checkbox.locator("..").click(); };
  const row = key => panel.locator(`[data-permission-resource="${key}"]`);
  const selectRole = name => page.locator(".roles-sidebar-item").filter({ hasText: name }).click();
  await selectRole("Прораб");
  assert.equal(await panel.locator(".permission-status-row").count(), 6);
  for (const title of ["Отчёт рабочих", "Отчёт техники"]) {
    assert.equal(await check("Редактирование", `${title} — Черновики`).isChecked(), true);
    for (const status of ["На проверке", "Подтверждённые"]) {
      assert.equal(await check("Просмотр", `${title} — ${status}`).isChecked(), true);
      assert.equal(await check("Редактирование", `${title} — ${status}`).isChecked(), false);
      assert.equal(await check("Редактирование", `${title} — ${status}`).isDisabled(), false);
    }
  }
  await page.locator(".roles-sidebar footer button").click();
  await panel.getByRole("textbox", { name: "Название роли", exact: true }).fill("Прораб — свои черновики");
  for (const title of ["Отчёт рабочих", "Отчёт техники"]) {
    for (const action of ["Редактирование", "Добавление", "Удаление"]) await toggle(action, `${title} — Черновики`, true);
    for (const status of ["Подтверждённые", "На проверке"]) await toggle("Просмотр", `${title} — ${status}`, true);
  }
  await panel.getByRole("button", { name: "Создать роль", exact: true }).click();
  await panel.getByRole("button", { name: "Сохранить изменения", exact: true }).waitFor();
  const saved = roles.find(role => role.id === 100);
  assert.equal(saved.permissions.workers_report_draft.update, true);
  assert.equal(saved.permissions.workers_report_approved.update, false);
  assert.equal(saved.permissions.workers_report_submitted.update, false);
  await page.locator(".roles-sidebar").getByRole("button", { name: "Обновить роли", exact: true }).click();
  await selectRole(saved.name);
  assert.equal(await check("Редактирование", "Отчёт рабочих — Черновики").isChecked(), true);
  assert.equal(await check("Редактирование", "Отчёт рабочих — Подтверждённые").isChecked(), false);
  await toggle("Редактирование", "Отчёт рабочих", false);
  for (const key of ["workers_report_draft", "workers_report_submitted", "workers_report_approved"]) assert.equal(await row(key).getByRole("checkbox", { name: /^Редактирование:/ }).isChecked(), false);
  await toggle("Редактирование", "Отчёт рабочих — Черновики", true);
  assert.equal(await check("Редактирование", "Отчёт рабочих").isChecked(), true);
  assert.equal(await check("Редактирование", "Отчёт рабочих — Подтверждённые").isChecked(), false);
  await toggle("Редактирование", "Отчёт рабочих — Подтверждённые", true);
  await toggle("Редактирование", "Отчёт рабочих — Подтверждённые", false);
  await toggle("Удаление", "Отчёт рабочих — Черновики", false);
  await panel.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await page.locator(".roles-sidebar").getByRole("button", { name: "Обновить роли", exact: true }).click();
  await selectRole(saved.name);
  assert.equal(await check("Редактирование", "Отчёт рабочих — Черновики").isChecked(), true);
  assert.equal(await check("Редактирование", "Отчёт рабочих — Подтверждённые").isChecked(), false);
  assert.equal(roles.find(role => role.id === 100).permissions.workers_report_approved.update, false);
  assert.equal(roles.find(role => role.id === 100).permissions.workers_report_draft.delete, false);
  assert.equal(mutations.length, 2);
  await page.setViewportSize({ width: 843, height: 1050 });
  const parentIndent = await row("workers_report").locator('[role="cell"]').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
  const childIndent = await row("workers_report_draft").locator('[role="cell"]').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
  assert.ok(childIndent > parentIndent, "Status rows have a visible child hierarchy");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "No page-level horizontal overflow at843px");
  await panel.locator(".roles-matrix-scroll").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: "/private/tmp/role-status-permissions-843.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS:6 status rows, foreman draft-only writes, role save/reload, explicit denies, parent cascade, child bound restoration,843px hierarchy");
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await rm(outDir, { recursive: true, force: true });
}
