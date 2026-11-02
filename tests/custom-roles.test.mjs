import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { CustomRoleError, customRoleNameKey, inferCustomRoleBaseRole, normalizeCustomRoleInput, normalizeCustomRoleName, normalizeCustomRolePermissions } from "../app/customRoles.ts";
import { emptyPermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";
import { defaultProjectAccess, effectiveProjectAccess } from "../app/roles.ts";

const sourceUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const fileUrl = path => new URL(path, import.meta.url).href;
async function compile(path, replacements = {}) {
  let source = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, replacement] of Object.entries(replacements)) source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  return sourceUrl(source);
}
let harnessNumber = 0;
async function harness() {
  const rows = [], overrides = [], settings = new Map(), grants = new Map(), queries = [];
  let user = null;
  const db = {
    rows, overrides, settings, grants, queries,
    setUser(value) { user = value; },
    prepare(sql) {
      let values = [];
      const execute = () => {
        queries.push({ sql, values: structuredClone(values) });
        assert.equal((sql.match(/\?/g) ?? []).length, values.length, "SQL parameters match bindings");
        let result;
        if (/^(CREATE|ALTER)\b/.test(sql)) result = [];
        else if (sql.includes("INSERT INTO custom_roles")) {
          if (rows.some(row => row.nameKey === values[1])) throw Object.assign(new Error("unique violation"), { code: "23505" });
          const row = { id: rows.length + 1, name: values[0], nameKey: values[1], baseRole: values[2], permissions: JSON.parse(values[3]), revision: 1, active: 1, createdByUserId: values[4] };
          rows.push(row); result = [row];
        } else if (sql.startsWith("WITH inserted AS") || sql.startsWith("UPDATE app_users u SET custom_role_id")) result = [];
        else if (sql.includes("FROM custom_roles")) result = rows.filter(row => row.active === 1 && (!values.length || row.id === values[0])).sort((a,b) => a.nameKey.localeCompare(b.nameKey));
        else if (sql.includes("FROM user_permissions WHERE user_id")) result = overrides;
        else if (sql.includes("FROM user_sessions s JOIN app_users")) result = user ? [user] : [];
        else if (sql.includes("FROM user_project_access WHERE user_id")) result = settings.has(values[0]) ? [settings.get(values[0])] : [];
        else if (sql.includes("FROM user_project_access_sites access")) result = (grants.get(values[0]) ?? []).map(id => ({ id }));
        else throw new Error(`Unexpected SQL: ${sql.slice(0, 120)}`);
        return { results: structuredClone(result), meta: { changes: result.length, last_row_id: result[0]?.id ?? null } };
      };
      const statement = { bind(...next) { values = next; return statement; }, async all() { return execute(); }, async first() { return execute().results[0] ?? null; }, async run() { return execute(); } };
      return statement;
    },
    async transaction(callback) { return callback(db); },
    async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.all()); return results; },
  };
  const boundaryUrl = sourceUrl(`// ${++harnessNumber}\nexport let database; export function configure(value){database=value;} export function getDatabase(){return database;}`);
  const boundary = await import(boundaryUrl); boundary.configure(db);
  const serverUrl = await compile("../app/customRolesServer.ts", { "../db/client": boundaryUrl, "./customRoles.ts": fileUrl("../app/customRoles.ts"), "./projectAccessServer.ts": sourceUrl("export async function ensureUserProjectAccessSchema(){}") });
  const permissionsUrl = await compile("../app/permissions.ts", { "../db/client": boundaryUrl, "./permissionModel": fileUrl("../app/permissionModel.ts") });
  const accessUrl = await compile("../app/projectAccessServer.ts", { "../db/client": boundaryUrl, "./roles.ts": fileUrl("../app/roles.ts") });
  const authUrl = await compile("../app/auth.ts", {
    "../db/client": boundaryUrl, "./roles": fileUrl("../app/roles.ts"), "./permissions": permissionsUrl,
    "./customRolesServer": serverUrl, "./projectAccessServer": accessUrl,
    nodemailer: sourceUrl("export default {createTransport(){throw new Error('Email disabled in tests');}};"),
  });
  return { db, server: await import(serverUrl), permissions: await import(permissionsUrl), settings: await import(accessUrl), auth: await import(authUrl) };
}
process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;

test("custom role names are normalized, bounded and separated from built-in identities", () => {
  assert.equal(normalizeCustomRoleName("  Руководитель   проекта  "), "Руководитель проекта");
  assert.equal(customRoleNameKey("Учёт  Техники"), customRoleNameKey("учет техники"));
  for (const value of [null, "", "   ", "x".repeat(81), "Скрытая\u200bроль", "\0имя", "Супер-админ", "superadmin", "ADMIN"]) {
    assert.throws(() => normalizeCustomRoleName(value), CustomRoleError);
  }
});

test("role permission input rejects coerced booleans and unknown fields, then normalizes view dependencies", () => {
  for (const permissions of [null, [], { unknown: {} }, { workers_report: [] }, { workers_report: { view: "true" } }, { workers_report: { create: 1 } }, { workers_report: { approve: true } }]) {
    assert.throws(() => normalizeCustomRolePermissions(permissions), CustomRoleError);
  }
  const normalized = normalizeCustomRoleInput({ name: "Контроль площадки", permissions: { workers_report: { update: true } } });
  assert.equal(normalized.permissions.workers_report.view, true);
  assert.equal(normalized.permissions.workers_report.create, false);
  assert.equal(normalized.permissions.employees.view, false);
  assert.equal(normalized.baseRole, "engineer");
  assert.equal(inferCustomRoleBaseRole(normalizeCustomRolePermissions({ workers_report: { view: true } })), "viewer");
  assert.equal(inferCustomRoleBaseRole(emptyPermissionSet()), "viewer");
  assert.equal(inferCustomRoleBaseRole(normalizeCustomRolePermissions({ audit_log: { create: true } })), "viewer", "unsupported actions never grant a writable base role");
});

test("unknown built-in role identifiers fail closed instead of inheriting administrator permissions", () => {
  assert.deepEqual(rolePermissionTemplate("custom:invalid"), emptyPermissionSet());
  assert.equal(rolePermissionTemplate("superadmin").access_rights.update, true);
});

test("custom users need explicit project grants while existing built-in engineer defaults stay unchanged", async () => {
  assert.deepEqual(defaultProjectAccess("engineer"), { mode: "all", siteIds: [] });
  assert.deepEqual(defaultProjectAccess("engineer", 7, 3), { mode: "selected", siteIds: [] });
  assert.deepEqual(effectiveProjectAccess({ role: "engineer", customRoleId: 3, assignedSiteId: 7 }), { mode: "selected", siteIds: [] });
  const h = await harness();
  const user = { id: 9, role: "engineer", customRoleId: 3, assignedSiteId: 7 };
  assert.deepEqual((await h.settings.loadUserProjectAccess(user, h.db)).projectAccess, { mode: "selected", siteIds: [] });
  h.db.settings.set(9, { allProjects: 0, canViewPendingReports: 0 }); h.db.grants.set(9, [7,8]);
  assert.deepEqual((await h.settings.loadUserProjectAccess(user, h.db)).projectAccess, { mode: "selected", siteIds: [7,8] });
});

test("custom role store persists normalized reusable templates and handles concurrent duplicate names", async () => {
  const h = await harness();
  const writable = await h.server.createCustomRole({ name: " Координатор   техники ", permissions: { equipment_report: { create: true } } }, 4, h.db);
  assert.equal(writable.name, "Координатор техники");
  assert.equal(writable.baseRole, "engineer");
  assert.equal(writable.permissions.equipment_report.view, true);
  assert.equal(writable.revision, 1);
  const readonly = await h.server.createCustomRole({ name: "Контроль смет", permissions: { workers_report: { view: true } } }, 4, h.db);
  assert.equal(readonly.baseRole, "viewer");
  assert.deepEqual(await h.server.loadCustomRole(writable.id, h.db), writable);
  assert.deepEqual(new Set((await h.server.listCustomRoles(h.db)).map(role => role.id)), new Set([writable.id, readonly.id]));
  await assert.rejects(h.server.createCustomRole({ name: "координатор техники", permissions: {} }, 4, h.db), error => error.status === 409 && error.code === "ROLE_NAME_EXISTS");
  assert.equal(h.db.rows.length, 2, "duplicate failures do not replace the existing matrix");
  h.db.rows[0].active = 0;
  assert.equal(await h.server.loadCustomRole(writable.id, h.db), null);
  assert.equal(await h.server.loadCustomRole(2147483648, h.db), null);
  h.db.rows[1].baseRole = "superadmin";
  assert.deepEqual(await h.server.listCustomRoles(h.db), [], "corrupt roles cannot re-enter authorization");
});

test("effective permissions use custom defaults, preserve explicit overrides, and retain scope/read-only limits", async () => {
  const h = await harness();
  const role = await h.server.createCustomRole({ name: "Диспетчер", permissions: { equipment_report: { create: true, update: true } } }, 4, h.db);
  let effective = await h.permissions.loadEffectivePermissions(9, "engineer", { mode: "all", siteIds: [] }, h.db, role);
  assert.equal(effective.permissions.equipment_report.create, true);
  assert.equal(effective.permissions.workers_report.view, false);
  assert.equal(effective.permissionsCustomized, false);
  h.db.overrides.push({ resource: "equipment_report", canView: 1, canCreate: 0, canUpdate: 0, canDelete: 0 });
  effective = await h.permissions.loadEffectivePermissions(9, "engineer", { mode: "all", siteIds: [] }, h.db, role);
  assert.equal(effective.permissions.equipment_report.create, false);
  assert.equal(effective.permissionsCustomized, true);
  await assert.rejects(h.permissions.loadEffectivePermissions(9, "superadmin", undefined, h.db, role), /не соответствует/);
  const viewerRole = await h.server.createCustomRole({ name: "Сметный контроль", permissions: { workers_report: { view: true } } }, 4, h.db);
  h.db.overrides.push({ resource: "workers_report", canView: 1, canCreate: 1, canUpdate: 1, canDelete: 1 });
  effective = await h.permissions.loadEffectivePermissions(9, "viewer", { mode: "all", siteIds: [] }, h.db, viewerRole);
  assert.deepEqual(effective.permissions.workers_report, { view: true, create: false, update: false, delete: false });
});

test("sessions load assigned custom roles on every request and reject missing, inactive, or mismatched roles", async () => {
  const h = await harness();
  const role = await h.server.createCustomRole({ name: "Экономист", permissions: { workers_timesheet: { view: true } } }, 4, h.db);
  h.db.setUser({ id: 9, role: "viewer", customRoleId: role.id, fullName: "Тестовый пользователь", email: "qa@invalid.test", assignedSiteId: null });
  const request = new Request("http://localhost/api/auth/status", { headers: { cookie: "personnel_session=synthetic-test-token" } });
  let user = await h.auth.getAuthUser(request);
  assert.equal(user.customRoleName, "Экономист");
  assert.deepEqual(user.roleTemplate, role.permissions);
  assert.equal(user.permissions.workers_timesheet.view, true);
  assert.equal(user.permissions.workers_report.view, false);
  assert.deepEqual(user.projectAccess, { mode: "selected", siteIds: [] });
  assert.equal(user.canViewPendingReports, false);
  h.db.rows[0].active = 0; assert.equal(await h.auth.getAuthUser(request), null);
  h.db.rows[0].active = 1;
  h.db.setUser({ id: 9, role: "engineer", customRoleId: role.id }); assert.equal(await h.auth.getAuthUser(request), null);
  h.db.setUser({ id: 9, role: "viewer", customRoleId: 999 }); assert.equal(await h.auth.getAuthUser(request), null);
  h.db.setUser({ id: 9, role: "engineer", customRoleId: null });
  user = await h.auth.getAuthUser(request);
  assert.equal(user.permissions.workers_report.update, true, "existing built-in accounts preserve their working defaults");
});

test("development bootstrap creates custom role schema before auth reads and is idempotent", async () => {
  const h = await harness();
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    await Promise.all([h.server.ensureCustomRolesSchema(h.db), h.server.ensureCustomRolesSchema(h.db)]);
    const first = h.db.queries.length;
    assert.equal(first, 12);
    await h.server.ensureCustomRolesSchema(h.db);
    assert.equal(h.db.queries.length, first);
    assert.match(h.db.queries[1].sql, /custom_role_id INTEGER REFERENCES custom_roles\(id\) ON DELETE RESTRICT/);
  } finally { process.env.NODE_ENV = previous; }
});
