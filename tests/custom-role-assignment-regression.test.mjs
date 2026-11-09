import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { emptyPermissionSet, normalizePermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";
import { canAccessProject } from "../app/roles.ts";
import { accessRequest, projectAccessHarness } from "./fixtures/project-access-boundary.mjs";

process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const request = (method, body) => new Request("http://localhost/api/data", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const customRole = (id, name, baseRole, permissions) => ({ id, name, baseRole, permissions, revision: 1, active: 1 });
function addRole(h, role) { h.db.state.customRoles.set(role.id, structuredClone(role)); return role; }
function userPayload(h, id, changes = {}) {
  const user = h.db.state.users.get(id);
  return { action: "update-user", userId: id, fullName: user.fullName, email: user.email, role: user.role,
    projectAccess: { mode: "selected", siteIds: [7] }, ...changes };
}

test("role creation requires explicit management rights rather than a particular role or project mode", async () => {
  const h = await projectAccessHarness(); const roles = await h.loadRolesRoute();
  const post = name => roles.POST(new Request("http://localhost/api/roles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, permissions: rolePermissionTemplate("viewer") }) }));
  h.boundary.configure(null, h.db);
  assert.equal((await post("Не авторизован")).status, 401);
  await h.asUser(3);
  assert.equal((await post("Нет права")).status, 403);
  assert.deepEqual(h.db.attemptedWrites, []);
  await h.asUser(3, { projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("superadmin") });
  assert.equal((await (await roles.GET(new Request("http://localhost/api/roles"))).json()).canManage, true);
  await h.asUser(2, { projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate("superadmin") });
  assert.equal((await (await roles.GET(new Request("http://localhost/api/roles"))).json()).canManage, true);
});

test("custom role matrices replace the builtin fallback, while legacy users keep the original defaults", async () => {
  const h = await projectAccessHarness();
  const rights = emptyPermissionSet(); rights.employees.view = true;
  const readRole = addRole(h, customRole(41, "Кадровый наблюдатель", "viewer", rights));
  const user = h.db.state.users.get(3); user.customRoleId = readRole.id;
  const access = await h.permissions.loadEffectivePermissions(user.id, user.role, { mode: "selected", siteIds: [7] }, h.db, readRole);
  assert.deepEqual(access.permissions, rights);
  assert.equal(access.permissionsCustomized, false);
  const legacy = await h.permissions.loadEffectivePermissions(2, "engineer", undefined, h.db);
  assert.deepEqual(legacy.permissions, normalizePermissionSet(rolePermissionTemplate("engineer")));
  await h.permissions.saveUserPermissions(user.id, rolePermissionTemplate("superadmin"), 4, h.db);
  const overridden = await h.permissions.loadEffectivePermissions(user.id, "viewer", { mode: "all", siteIds: [] }, h.db, readRole);
  assert.deepEqual(overridden.permissions, normalizePermissionSet(rolePermissionTemplate("superadmin")));
});

test("custom working roles with no saved grants cannot inherit an engineer's all-project default", async () => {
  const h = await projectAccessHarness();
  const user = { ...h.db.state.users.get(2), customRoleId: 42 };
  const scope = await h.settings.loadUserProjectAccess(user, h.db);
  assert.deepEqual(scope.projectAccess, { mode: "selected", siteIds: [] });
  assert.equal(canAccessProject(user, 7), false);
  assert.equal(canAccessProject({ ...user, ...scope }, 7), false);
  assert.deepEqual((await h.settings.loadUserProjectAccess(h.db.state.users.get(2), h.db)).projectAccess, { mode: "all", siteIds: [] });
});

test("actual user-list SQL excludes unassigned custom accounts even when an old assigned-site value remains", async () => {
  const h = await projectAccessHarness(); const data = await h.loadDataRoute();
  await h.asUser(2, { projectAccess: { mode: "selected", siteIds: [7] } });
  assert.equal((await h.route.GET(new Request("http://localhost/api/access-rights"))).status, 200);
  assert.equal((await data.GET(new Request("http://localhost/api/data?scope=settings&section=users&siteId=7"))).status, 200);
  const statements = h.db.queries.filter(query => query.sql.includes("FROM app_users u LEFT JOIN sites") || query.sql.includes("FROM app_users target WHERE active = 1"));
  assert.equal(statements.length, 2);
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(`CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT);
      CREATE TABLE app_users(id INTEGER PRIMARY KEY,full_name TEXT,email TEXT,role TEXT,assigned_site_id INTEGER,custom_role_id INTEGER,password_hash TEXT,active INTEGER);
      CREATE TABLE user_project_access(user_id INTEGER PRIMARY KEY,all_projects INTEGER);
      CREATE TABLE user_project_access_sites(user_id INTEGER,site_id INTEGER);
      INSERT INTO sites VALUES(7,'Северный'),(8,'Южный');
      INSERT INTO app_users VALUES
        (1,'Прораб','1@invalid.test','foreman',7,NULL,'hash',1),
        (2,'Инженер','2@invalid.test','engineer',NULL,NULL,'hash',1),
        (3,'Закрытая рабочая роль','3@invalid.test','engineer',7,41,'hash',1),
        (4,'Закрытая роль просмотра','4@invalid.test','viewer',7,42,'hash',1),
        (5,'Рабочая роль проекта','5@invalid.test','engineer',NULL,41,'hash',1),
        (6,'Чужая рабочая роль','6@invalid.test','engineer',NULL,41,'hash',1),
        (7,'Просмотр всех проектов','7@invalid.test','viewer',NULL,42,'hash',1),
        (8,'Просмотр без разрешений','8@invalid.test','viewer',7,NULL,'hash',1);
      INSERT INTO user_project_access VALUES(5,0),(6,0),(7,1);
      INSERT INTO user_project_access_sites VALUES(5,7),(6,8);`);
    for (const statement of statements) {
      // Keep the application query; translate only PostgreSQL's array membership.
      const source = statement.sql.replace(/= ANY\(\?::integer\[\]\)/g, "IN (SELECT value FROM json_each(?))");
      const values = statement.values.map(value => Array.isArray(value) ? JSON.stringify(value) : value);
      assert.deepEqual(sql.prepare(source).all(...values).map(row => row.id).sort((a, b) => a - b), [1, 2, 5, 7]);
    }
  } finally { sql.close(); }
});

test("assigning a custom role clears old individual rights and keeps project scope explicit", async () => {
  const h = await projectAccessHarness(); const data = await h.loadDataRoute(); await h.asUser(4);
  const rights = emptyPermissionSet(); rights.workers_timesheet.view = true;
  const readRole = addRole(h, customRole(41, "Табель только для чтения", "viewer", rights));
  await h.permissions.saveUserPermissions(2, rolePermissionTemplate("superadmin"), 4, h.db);
  const response = await data.PATCH(request("PATCH", userPayload(h, 2, { role: "viewer", customRoleId: readRole.id, canViewPendingReports: false })));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const user = h.db.state.users.get(2);
  assert.equal(user.role, "viewer"); assert.equal(user.customRoleId, readRole.id);
  assert.equal(h.db.state.permissions.has(2), false);
  const scope = await h.settings.loadUserProjectAccess(user, h.db);
  assert.deepEqual(scope.projectAccess, { mode: "selected", siteIds: [7] });
  const access = await h.permissions.loadEffectivePermissions(2, user.role, scope.projectAccess, h.db, readRole);
  assert.deepEqual(access.permissions, rights);
  const listed = await (await h.route.GET(new Request("http://localhost/api/access-rights"))).json();
  const listedUser = listed.users.find(item => item.id === 2);
  assert.equal(listedUser.customRoleId, readRole.id);
  assert.equal(listedUser.customRoleName, readRole.name);
  assert.deepEqual(listedUser.roleTemplate, rights);
});

test("returning to a builtin role also removes custom identity and custom individual overrides", async () => {
  const h = await projectAccessHarness(); const data = await h.loadDataRoute();
  const readRole = addRole(h, customRole(41, "Наблюдение проекта", "viewer", rolePermissionTemplate("viewer")));
  Object.assign(h.db.state.users.get(3), { customRoleId: readRole.id });
  await h.permissions.saveUserPermissions(3, emptyPermissionSet(), 4, h.db);
  await h.asUser(4);
  const response = await data.PATCH(request("PATCH", userPayload(h, 3, { role: "engineer", customRoleId: null })));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(h.db.state.users.get(3).customRoleId, null);
  assert.equal(h.db.state.users.get(3).role, "engineer");
  assert.equal(h.db.state.permissions.has(3), false);
});

test("assigning a custom role cannot demote the last super administrator", async t => {
  t.mock.method(console, "error", () => {});
  const h = await projectAccessHarness(); const data = await h.loadDataRoute(); await h.asUser(4);
  addRole(h, customRole(41, "Наблюдение", "viewer", rolePermissionTemplate("viewer")));
  const before = structuredClone(h.db.state);
  const response = await data.PATCH(request("PATCH", userPayload(h, 4, { role: "viewer", customRoleId: 41 })));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /последнего администратора/);
  assert.deepEqual(h.db.state, before);
});

test("changing only a custom user's name preserves its assigned role and individual overrides", async () => {
  const h = await projectAccessHarness(); const data = await h.loadDataRoute();
  const rights = emptyPermissionSet(); rights.workers_report.view = true;
  const readRole = addRole(h, customRole(41, "Контроль отчётов", "viewer", rights));
  Object.assign(h.db.state.users.get(3), { customRoleId: readRole.id });
  const override = { ...rights, equipment_report: { view: true, create: false, update: false, delete: false } };
  await h.permissions.saveUserPermissions(3, override, 4, h.db);
  await h.asUser(4);
  const response = await data.PATCH(request("PATCH", userPayload(h, 3, { fullName: "Новое имя наблюдателя" })));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(h.db.state.users.get(3).customRoleId, readRole.id);
  assert.equal(h.db.state.permissions.has(3), true);
});

test("saved identity, grants and permissions are reloaded for an existing session after same-base role changes", async () => {
  const h = await projectAccessHarness(); const data = await h.loadDataRoute(); const auth = await h.loadAuth();
  const firstRights = emptyPermissionSet(); firstRights.workers_report.view = true;
  const secondRights = emptyPermissionSet(); secondRights.equipment_timesheet.view = true;
  const first = addRole(h, customRole(41, "Персонал для контроля", "viewer", firstRights));
  const second = addRole(h, customRole(42, "Техника для контроля", "viewer", secondRights));
  const user = h.db.state.users.get(3); user.customRoleId = first.id;
  await h.settings.saveUserProjectAccess(user.id, { projectAccess: { mode: "selected", siteIds: [7, 8] }, canViewPendingReports: true }, 4, h.db);
  const oldOverride = normalizePermissionSet({ workers_report: { view: true }, employees: { view: true } });
  await h.permissions.saveUserPermissions(user.id, oldOverride, 4, h.db);
  const token = "synthetic-persistence-session";
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64");
  h.db.state.sessions.set(hash, user.id);
  const authRequest = new Request("http://localhost/api/auth/status", { headers: { cookie: `personnel_session=${token}` } });
  await h.asUser(4);

  // Omitted scope, role and pending settings must survive an ordinary profile edit.
  let response = await data.PATCH(request("PATCH", { action: "update-user", userId: user.id, fullName: "Обновлённое имя", email: user.email }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  let current = await auth.getAuthUser(authRequest);
  assert.equal(current.fullName, "Обновлённое имя");
  assert.equal(current.customRoleId, first.id); assert.equal(current.customRoleName, first.name);
  assert.deepEqual(current.projectAccess, { mode: "selected", siteIds: [7, 8] });
  assert.equal(current.canViewPendingReports, true);
  assert.deepEqual(current.permissions, oldOverride); assert.equal(current.permissionsCustomized, true);

  // Both roles have technical role=viewer: the custom ID must still count as a new identity.
  response = await data.PATCH(request("PATCH", { action: "update-user", userId: user.id, fullName: "Обновлённое имя", email: user.email, role: "viewer", customRoleId: second.id }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  current = await auth.getAuthUser(authRequest);
  assert.equal(current.customRoleId, second.id); assert.equal(current.customRoleName, second.name);
  assert.deepEqual(current.roleTemplate, secondRights);
  assert.deepEqual(current.permissions, secondRights); assert.equal(current.permissionsCustomized, false);
  assert.deepEqual(current.projectAccess, { mode: "selected", siteIds: [] });
  assert.equal(current.canViewPendingReports, false);

  // Clearing the custom ID restores built-in defaults without retaining old names/templates.
  response = await data.PATCH(request("PATCH", { action: "update-user", userId: user.id, fullName: "Обновлённое имя", email: user.email, role: "viewer", customRoleId: null, projectAccess: { mode: "selected", siteIds: [8] } }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  current = await auth.getAuthUser(authRequest);
  assert.equal(current.customRoleId, null); assert.equal(current.customRoleName, null);
  assert.equal(current.roleTemplate, undefined);
  assert.deepEqual(current.permissions, normalizePermissionSet(rolePermissionTemplate("viewer")));
  assert.deepEqual(current.projectAccess, { mode: "selected", siteIds: [8] });
  assert.equal(current.permissionsCustomized, false);
});

test("reset restores the custom template without restoring builtin sections or widening project grants", async () => {
  const h = await projectAccessHarness();
  const rights = emptyPermissionSet(); rights.equipment_timesheet.view = true;
  const readRole = addRole(h, customRole(41, "Контроль техники", "viewer", rights));
  h.db.state.users.get(3).customRoleId = readRole.id;
  await h.settings.saveUserProjectAccess(3, { projectAccess: { mode: "selected", siteIds: [8] }, canViewPendingReports: true }, 4, h.db);
  await h.permissions.saveUserPermissions(3, rolePermissionTemplate("superadmin"), 4, h.db);
  await h.asUser(4);
  const response = await h.route.POST(accessRequest({ userId: 3, reset: true }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json();
  assert.deepEqual(body.permissions, rights);
  assert.deepEqual(body.projectAccess, { mode: "selected", siteIds: [8] });
  assert.equal(body.canViewPendingReports, true);
  assert.equal(body.customized, false);
});

test("unknown custom roles and invalid grants reject atomically before invitations or rights changes", async t => {
  t.mock.method(console, "error", () => {});
  const h = await projectAccessHarness(); const data = await h.loadDataRoute(); await h.asUser(4);
  const rights = emptyPermissionSet(); rights.workers_report.view = true;
  addRole(h, customRole(41, "Отчёты", "viewer", rights));
  await h.permissions.saveUserPermissions(2, rolePermissionTemplate("engineer"), 4, h.db);
  const previous = structuredClone(h.db.state);
  const unknown = await data.PATCH(request("PATCH", userPayload(h, 2, { role: "viewer", customRoleId: 999 })));
  assert.equal(unknown.status, 400); assert.deepEqual(h.db.state, previous);
  const invalidGrant = await data.PATCH(request("PATCH", userPayload(h, 2, { role: "viewer", customRoleId: 41, projectAccess: { mode: "selected", siteIds: [999] } })));
  assert.equal(invalidGrant.status, 400); assert.deepEqual(h.db.state, previous);
  const invitations = h.boundary.invitations.length;
  const invalidCreate = await data.POST(request("POST", { action: "create-user", fullName: "Новый пользователь", email: "new@invalid.test", role: "viewer", customRoleId: 41, projectAccess: { mode: "selected", siteIds: [999] } }));
  assert.equal(invalidCreate.status, 400);
  assert.deepEqual(h.db.state, previous);
  assert.ok(h.db.attemptedWrites.some(write => write.sql.startsWith("INSERT INTO app_users")), "the failed grant must roll back an already inserted user");
  assert.equal(h.boundary.invitations.length, invitations);
});

test("custom role assignment at invitation creation does not send email before the transaction succeeds", async () => {
  const h = await projectAccessHarness(); const data = await h.loadDataRoute(); await h.asUser(4);
  const rights = emptyPermissionSet(); rights.workers_report.view = true;
  const readRole = addRole(h, customRole(41, "Просмотр отчётов", "viewer", rights));
  const response = await data.POST(request("POST", { action: "create-user", fullName: "Приглашённый наблюдатель", email: "invited@invalid.test", role: "viewer", customRoleId: readRole.id, projectAccess: { mode: "selected", siteIds: [7] }, canViewPendingReports: false }));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const body = await response.json();
  assert.equal(h.db.state.users.get(body.id).customRoleId, readRole.id);
  assert.equal(h.db.state.users.get(body.id).role, "viewer");
  assert.equal(h.boundary.invitations.at(-1), body.id);
  assert.equal(body.emailSent, false);
});

test("actual authentication loads custom metadata and template per request and fails closed on a broken assignment", async () => {
  const h = await projectAccessHarness(); const auth = await h.loadAuth();
  const rights = emptyPermissionSet(); rights.equipment_report.view = true;
  const readRole = addRole(h, customRole(41, "Наблюдатель техники", "viewer", rights));
  const user = h.db.state.users.get(3); user.customRoleId = readRole.id;
  await h.settings.saveUserProjectAccess(3, { projectAccess: { mode: "selected", siteIds: [7] } }, 4, h.db);
  const token = "synthetic-custom-role-session";
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64");
  h.db.state.sessions.set(hash, 3);
  const authRequest = new Request("http://localhost/api/auth/session", { headers: { cookie: `personnel_session=${token}` } });
  let actual = await auth.getAuthUser(authRequest);
  assert.equal(actual.customRoleId, readRole.id); assert.equal(actual.customRoleName, readRole.name);
  assert.deepEqual(actual.permissions, rights); assert.deepEqual(actual.roleTemplate, rights);
  assert.equal(canAccessProject(actual, 7), true); assert.equal(canAccessProject(actual, 8), false);
  h.db.state.customRoles.delete(readRole.id);
  actual = await auth.getAuthUser(authRequest);
  assert.equal(actual, null, "deleted/broken role must never become a builtin viewer or engineer");
  h.db.state.customRoles.set(readRole.id, { ...readRole, baseRole: "engineer" });
  actual = await auth.getAuthUser(authRequest);
  assert.equal(actual, null, "mismatched technical role must fail closed");
});
