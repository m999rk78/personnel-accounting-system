import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { emptyPermissionSet, patchPermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";

const sourceUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const fileUrl = path => new URL(path, import.meta.url).href;
async function compile(path, replacements) {
  let source = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(replacements)) source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return sourceUrl(source);
}
let fixtureNumber = 0;
async function harness() {
  const rows = [], queries = [], users = [], permissionRows = [];
  const db = {
    rows, queries, users, permissionRows,
    async transaction(callback) {
      const before = structuredClone({ rows, users });
      try { return await callback(db); }
      catch (error) { rows.splice(0, rows.length, ...before.rows); users.splice(0, users.length, ...before.users); throw error; }
    },
    prepare(sql) {
      let values = [];
      const execute = () => {
        queries.push({ sql, values: structuredClone(values) });
        assert.equal((sql.match(/\?/g) ?? []).length, values.length);
        let result;
        if (sql.includes("INSERT INTO custom_roles")) {
          if (rows.some(row => row.nameKey === values[1])) throw Object.assign(new Error("unique violation"), { code: "23505" });
          const row = { id: rows.length + 1, name: values[0], nameKey: values[1], baseRole: values[2], permissions: JSON.parse(values[3]), revision: 1, active: 1, createdByUserId: values[4] };
          rows.push(row); result = [row];
        } else if (sql.includes("FROM custom_roles")) result = rows.filter(row => row.active === 1 && (!values.length || row.id === values[0])).sort((a,b) => a.nameKey.localeCompare(b.nameKey));
        else if (sql.includes("pg_advisory_xact_lock")) result = [];
        else if (sql.includes("FROM user_permissions WHERE user_id")) result = permissionRows.filter(row => row.userId === values[0]);
        else if (sql.startsWith("UPDATE custom_roles SET name")) {
          if (rows.some(row => row.nameKey === values[1] && row.id !== values[4])) throw Object.assign(new Error("unique violation"), { code: "23505" });
          const row = rows.find(row => row.id === values[4] && row.revision === values[5] && row.active === 1);
          if (row) Object.assign(row, { name: values[0], nameKey: values[1], baseRole: values[2], permissions: JSON.parse(values[3]), revision: row.revision + 1 });
          result = row ? [row] : [];
        } else if (sql.startsWith("UPDATE app_users SET role")) { if (db.failUserUpdate) throw new Error("Synthetic user update failure"); result = users.filter(user => user.customRoleId === values[1]); result.forEach(user => { user.role = values[0]; }); }
        else if (sql.startsWith("SELECT COUNT(*) AS count FROM app_users")) result = [{ count: users.filter(user => user.customRoleId === values[0] && user.active === 1).length }];
        else if (sql.startsWith("UPDATE custom_roles SET active")) { result = rows.filter(row => row.id === values[1] && row.active === 1); result.forEach(row => { row.active = 0; row.nameKey = values[0]; row.revision++; }); }
        else throw new Error(`Unexpected role API query: ${sql.slice(0, 100)}`);
        return { results: structuredClone(result), meta: { changes: result.length, last_row_id: result[0]?.id ?? null } };
      };
      const statement = { bind(...next) { values = next; return statement; }, async all() { return execute(); }, async first() { return execute().results[0] ?? null; }, async run() { return execute(); } };
      return statement;
    },
  };
  const boundaryUrl = sourceUrl(`// ${++fixtureNumber}\nexport let actor,database; export function configure(user,db){actor=user;database=db;}
    export function getDatabase(){return database;} export async function getAuthUser(){return actor;}
    export function assertSameOrigin(request){if(request.headers.get('origin')!==new URL(request.url).origin)throw new Error('Invalid origin');}`);
  const boundary = await import(boundaryUrl);
  const modelUrl = fileUrl("../app/customRoles.ts");
  const serverUrl = await compile("../app/customRolesServer.ts", { "../db/client": boundaryUrl, "./customRoles.ts": modelUrl, "./permissionModel.ts": fileUrl("../app/permissionModel.ts") });
  const route = await import(await compile("../app/api/roles/route.ts", {
    "../../../db/client": boundaryUrl, "../../auth": boundaryUrl, "../../customRoles": modelUrl,
    "../../customRolesServer": serverUrl, "../../permissionModel": fileUrl("../app/permissionModel.ts"), "../../roles": fileUrl("../app/roles.ts"),
    "../../auditLog": sourceUrl("export async function withAuditTrail(request,handler){return handler(request);}"),
  }));
  const { loadEffectivePermissions } = await import(await compile("../app/permissions.ts", {
    "../db/client": boundaryUrl, "./permissionModel": fileUrl("../app/permissionModel.ts"),
  }));
  return { db, route, loadEffectivePermissions, as(user) { boundary.configure(user,db); } };
}
const actor = (overrides = {}) => ({ id: 4, fullName: "Тестовый администратор", role: "superadmin", assignedSiteId: null,
  projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("superadmin"), ...overrides });
const request = (payload, raw = false) => new Request("http://localhost/api/roles", {
  method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: raw ? payload : JSON.stringify(payload),
});
process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;

const changeRequest = (method, payload) => new Request("http://localhost/api/roles", { method, headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(payload) });

test("role update/delete require the same explicit management permission as creation", async () => {
  const h = await harness();
  for (const user of [null, actor({ role: "viewer", permissions: rolePermissionTemplate("viewer") }), actor({ role: "foreman", permissions: rolePermissionTemplate("foreman") }), actor({ role: "engineer", permissions: rolePermissionTemplate("engineer") })]) {
    h.as(user);
    for (const method of ["PATCH", "DELETE"]) assert.equal((await h.route[method](changeRequest(method, { roleId: 1, revision: 1, name: "Другая", permissions: {} }))).status, user ? 403 : 401);
  }
  assert.equal(h.db.queries.length, 0);
});

test("editing a role changes name/matrix/revision and synchronizes assigned base identities atomically", async () => {
  const h = await harness(); h.as(actor());
  const { role } = await (await h.route.POST(request({ name: "Рабочая роль", permissions: { workers_report: { update: true } } }))).json();
  h.db.users.push({ id: 8, customRoleId: role.id, role: "engineer", active: 1 }, { id: 9, customRoleId: null, role: "superadmin", active: 1 });
  const response = await h.route.PATCH(changeRequest("PATCH", { roleId: role.id, revision: role.revision, name: "Наблюдение", permissions: { workers_report: { view: true } } }));
  assert.equal(response.status, 200);
  const { role: saved } = await response.json();
  assert.equal(saved.id, role.id); assert.equal(saved.revision, 2); assert.equal(saved.baseRole, "viewer");
  assert.equal(h.db.users[0].role, "viewer"); assert.equal(h.db.users[1].role, "superadmin");
  assert.equal(saved.permissions.workers_report.update, false);
  const stale = await h.route.PATCH(changeRequest("PATCH", { roleId: role.id, revision: 1, name: "Устаревшая", permissions: {} }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "ROLE_REVISION_CONFLICT");
  assert.equal(h.db.rows[0].name, "Наблюдение");
  h.db.failUserUpdate = true;
  const failed = await h.route.PATCH(changeRequest("PATCH", { roleId: role.id, revision: 2, name: "Не сохранять", permissions: { workers_report: { update: true } } }));
  assert.equal(failed.status, 500);
  assert.equal(h.db.rows[0].revision, 2); assert.equal(h.db.rows[0].baseRole, "viewer"); assert.equal(h.db.users[0].role, "viewer");
});

test("catalog deletion blocks assigned roles, stale versions, builtins and missing IDs; unused roles are archived", async () => {
  const h = await harness(); h.as(actor());
  const { role } = await (await h.route.POST(request({ name: "Роль удаления", permissions: {} }))).json();
  h.db.users.push({ id: 8, role: "viewer", customRoleId: role.id, active: 1 });
  let response = await h.route.DELETE(changeRequest("DELETE", { roleId: role.id, revision: role.revision }));
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "ROLE_IN_USE");
  assert.equal(h.db.rows[0].active, 1);
  response = await h.route.DELETE(changeRequest("DELETE", { roleId: role.id, revision: 7 })); assert.equal(response.status, 409);
  response = await h.route.DELETE(changeRequest("DELETE", { roleId: -1, revision: 1 })); assert.equal(response.status, 400);
  response = await h.route.DELETE(changeRequest("DELETE", { roleId: 999, revision: 1 })); assert.equal(response.status, 404);
  h.db.users[0].customRoleId = null;
  response = await h.route.DELETE(changeRequest("DELETE", { roleId: role.id, revision: role.revision })); assert.equal(response.status, 200);
  assert.equal(h.db.rows[0].active, 0);
  assert.deepEqual((await (await h.route.GET(new Request("http://localhost/api/roles"))).json()).roles, []);
  assert.equal((await h.route.POST(request({ name: "Роль удаления", permissions: {} }))).status, 201, "archived names can be reused without losing historical rows");
});

test("role rename uniqueness and malformed mutations fail without altering existing templates", async () => {
  const h = await harness(); h.as(actor());
  await h.route.POST(request({ name: "Первый шаблон", permissions: {} }));
  await h.route.POST(request({ name: "Второй шаблон", permissions: {} }));
  const response = await h.route.PATCH(changeRequest("PATCH", { roleId: 1, revision: 1, name: "Второй шаблон", permissions: {} }));
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "ROLE_NAME_EXISTS");
  assert.equal(h.db.rows[0].name, "Первый шаблон"); assert.equal(h.db.rows[0].revision, 1);
  for (const method of ["PATCH", "DELETE"]) for (const payload of [null, [], {}, { roleId: 1, revision: 0 }, { roleId: "1", revision: 1 }]) assert.equal((await h.route[method](changeRequest(method, payload))).status, 400);
});

test("renaming a legacy role and changing unrelated rights preserve individual statistics restrictions", async () => {
  const h = await harness(); h.as(actor());
  const permissions = rolePermissionTemplate("engineer");
  delete permissions.workers_statistics; delete permissions.equipment_statistics;
  h.db.rows.push({ id: 1, name: "Прежний инженер", nameKey: "прежний инженер", baseRole: "engineer", permissions, revision: 1, active: 1 });
  h.db.permissionRows.push({ userId: 8, resource: "workers_report_approved", canView: 0, canCreate: 0, canUpdate: 0, canDelete: 0 });
  let [role] = (await (await h.route.GET(new Request("http://localhost/api/roles"))).json()).roles;
  for (const changeOtherRight of [false, true]) {
    const next = structuredClone(role.permissions);
    if (changeOtherRight) next.positions.update = true;
    const response = await h.route.PATCH(changeRequest("PATCH", { roleId: role.id, revision: role.revision, name: "Переименованный инженер", permissions: next }));
    assert.equal(response.status, 200);
    ({ role } = await response.json());
    assert.deepEqual(role.inheritedStatisticsPermissions, ["workers_statistics", "equipment_statistics"]);
    assert.equal(Object.hasOwn(h.db.rows[0].permissions, "workers_statistics"), false);
    assert.equal(Object.hasOwn(h.db.rows[0].permissions, "equipment_statistics"), false);
    const effective = await h.loadEffectivePermissions(8, "engineer", undefined, h.db, role);
    assert.equal(effective.permissions.workers_report_approved.view, false);
    assert.equal(effective.permissions.workers_statistics.view, false);
    assert.equal(effective.permissions.equipment_statistics.view, true);
    assert.equal(effective.permissions.positions.update, changeOtherRight);
  }
});

test("changing a legacy statistics checkbox persists an explicit independent choice", async () => {
  for (const [resource, approvedReport] of [["workers_statistics", "workers_report_approved"], ["equipment_statistics", "equipment_report_approved"]]) {
    const h = await harness(); h.as(actor());
    const permissions = rolePermissionTemplate("engineer");
    delete permissions.workers_statistics; delete permissions.equipment_statistics;
    h.db.rows.push({ id: 1, name: "Прежний инженер", nameKey: "прежний инженер", baseRole: "engineer", permissions, revision: 1, active: 1 });
    h.db.permissionRows.push({ userId: 8, resource: approvedReport, canView: 0, canCreate: 0, canUpdate: 0, canDelete: 0 });
    let [role] = (await (await h.route.GET(new Request("http://localhost/api/roles"))).json()).roles;
    for (const enabled of [false, true, true]) {
      const next = structuredClone(role.permissions);
      next[resource].view = enabled;
      const response = await h.route.PATCH(changeRequest("PATCH", { roleId: role.id, revision: role.revision, name: `Статистика ${role.revision}`, permissions: next }));
      assert.equal(response.status, 200);
      ({ role } = await response.json());
      assert.equal(h.db.rows[0].permissions[resource].view, enabled);
      assert.equal(role.inheritedStatisticsPermissions.includes(resource), false);
      const effective = await h.loadEffectivePermissions(8, "engineer", undefined, h.db, role);
      assert.equal(effective.permissions[approvedReport].view, false);
      assert.equal(effective.permissions[resource].view, enabled);
    }
  }
});

test("changing legacy report visibility preserves the unchanged independent statistics checkbox", async () => {
  for (const [resource, report] of [["workers_statistics", "workers_report"], ["equipment_statistics", "equipment_report"]]) {
    for (const initiallyAllowed of [false, true]) {
      const h = await harness(); h.as(actor());
      const permissions = patchPermissionSet(rolePermissionTemplate("engineer"), report, "view", initiallyAllowed);
      delete permissions.workers_statistics; delete permissions.equipment_statistics;
      h.db.rows.push({ id: 1, name: "Прежний инженер", nameKey: "прежний инженер", baseRole: "engineer", permissions, revision: 1, active: 1 });
      const [role] = (await (await h.route.GET(new Request("http://localhost/api/roles"))).json()).roles;
      assert.equal(role.permissions[resource].view, initiallyAllowed);
      const next = patchPermissionSet(role.permissions, report, "view", !initiallyAllowed);
      assert.equal(next[resource].view, initiallyAllowed, "The report checkbox must leave statistics unchanged");
      const response = await h.route.PATCH(changeRequest("PATCH", { roleId: role.id, revision: role.revision, name: role.name, permissions: next }));
      assert.equal(response.status, 200);
      const { role: saved } = await response.json();
      assert.equal(h.db.rows[0].permissions[resource].view, initiallyAllowed);
      assert.equal(saved.inheritedStatisticsPermissions.includes(resource), false);
      const effective = await h.loadEffectivePermissions(8, "engineer", undefined, h.db, saved);
      assert.equal(effective.permissions[resource].view, initiallyAllowed);
      assert.equal(effective.permissions[report].view, !initiallyAllowed);
    }
  }
});

test("new role statistics choices are explicit even when they match report visibility", async () => {
  const h = await harness(); h.as(actor());
  const permissions = rolePermissionTemplate("engineer");
  const response = await h.route.POST(request({ name: "Новый инженер", permissions }));
  assert.equal(response.status, 201);
  const { role } = await response.json();
  assert.equal(role.inheritedStatisticsPermissions, undefined);
  for (const resource of ["workers_statistics", "equipment_statistics"]) assert.equal(h.db.rows[0].permissions[resource].view, true);
  h.db.permissionRows.push({ userId: 8, resource: "workers_report_approved", canView: 0, canCreate: 0, canUpdate: 0, canDelete: 0 });
  const effective = await h.loadEffectivePermissions(8, "engineer", undefined, h.db, role);
  assert.equal(effective.permissions.workers_statistics.view, true);
  assert.equal(effective.permissions.workers_report_approved.view, false);
});

test("role endpoints require authentication and default viewers cannot list or create roles", async () => {
  const h = await harness(); h.as(null);
  assert.equal((await h.route.GET(new Request("http://localhost/api/roles"))).status, 401);
  assert.equal((await h.route.POST(request({ name: "Роль", permissions: {} }))).status, 401);
  h.as(actor({ role: "viewer", permissions: rolePermissionTemplate("viewer") }));
  assert.equal((await h.route.GET(new Request("http://localhost/api/roles"))).status, 403);
  assert.equal((await h.route.POST(request({ name: "Роль", permissions: {} }))).status, 403);
  assert.equal(h.db.queries.length, 0);
});

test("explicit managers of every role and project mode can create, change and delete reusable roles", async () => {
  for (const role of ["viewer", "foreman", "engineer"]) for (const projectAccess of [{ mode: "all", siteIds: [] }, { mode: "selected", siteIds: [7] }]) {
    const h = await harness(); h.as(actor({ role, projectAccess }));
    const created = await h.route.POST(request({ name: `Настраиваемая роль ${role}`, permissions: {} }));
    assert.equal(created.status, 201);
    const { role: saved } = await created.json();
    const patched = await h.route.PATCH(changeRequest("PATCH", { roleId: saved.id, revision: saved.revision, name: `Изменено ${role}`, permissions: { workers_report: { update: true } } }));
    assert.equal(patched.status, 200);
    const { role: updated } = await patched.json();
    assert.equal((await h.route.DELETE(changeRequest("DELETE", { roleId: updated.id, revision: updated.revision }))).status, 200);
  }
});

test("read access lists reusable templates without authorizing role management", async () => {
  const h = await harness();
  for (const role of ["viewer", "foreman", "engineer"]) {
    const permissions = emptyPermissionSet(); permissions.access_rights.view = true;
    const user = actor({ role, permissions, projectAccess: { mode: "selected", siteIds: [7] } });
    h.as(user);
    const response = await h.route.GET(new Request("http://localhost/api/roles"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { roles: [], canManage: false });
  }
  const permissions = emptyPermissionSet(); permissions.system_users.create = true;
  h.as(actor({ role: "engineer", permissions }));
  assert.equal((await h.route.GET(new Request("http://localhost/api/roles"))).status, 200, "account creators need the role selector catalog");
});

test("invalid role payloads return 400 before any SQL mutation", async () => {
  const h = await harness(); h.as(actor());
  for (const payload of [null, [], "name", 1, {}, { name: "" }, { name: "Супер-админ", permissions: {} }, { name: "Роль", permissions: [] }, { name: "Роль", permissions: { employees: { update: "true" } } }, { name: "Роль", permissions: { invalid_resource: { view: true } } }]) {
    const response = await h.route.POST(request(payload));
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.equal((await h.route.POST(request("{",true))).status, 400);
  assert.equal(h.db.queries.length, 0);
});

test("authorized creation, duplicate-name conflict and catalog metadata use the actual role store", async () => {
  const h = await harness(); h.as(actor({ role: "engineer" }));
  let response = await h.route.POST(request({ name: " Координатор   техники ", permissions: { equipment_report: { update: true } } }));
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.id, created.role.id);
  assert.equal(created.role.name, "Координатор техники");
  assert.equal(created.role.baseRole, "engineer");
  assert.equal(created.role.permissions.equipment_report.view, true);
  assert.equal(created.role.permissions.equipment_report.update, true);
  assert.equal(created.role.permissions.workers_report.view, false);
  assert.equal(created.role.revision, 1);
  assert.equal(h.db.rows[0].createdByUserId, 4);
  response = await h.route.POST(request({ name: "координатор техники", permissions: {} }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "ROLE_NAME_EXISTS");
  assert.equal(h.db.rows.length, 1);
  response = await h.route.GET(new Request("http://localhost/api/roles"));
  const list = await response.json();
  assert.equal(list.canManage, true);
  assert.deepEqual(list.roles, [created.role]);
});
