import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { emptyPermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";

const sourceUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const fileUrl = path => new URL(path, import.meta.url).href;
async function compile(path, replacements) {
  let source = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(replacements)) source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return sourceUrl(source);
}
let fixtureNumber = 0;
async function harness() {
  const rows = [], queries = [];
  const db = {
    rows, queries,
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
        else throw new Error(`Unexpected role API query: ${sql.slice(0, 100)}`);
        return { results: structuredClone(result), meta: { changes: result.length, last_row_id: result[0]?.id ?? null } };
      };
      const statement = { bind(...next) { values = next; return statement; }, async all() { return execute(); }, async first() { return execute().results[0] ?? null; } };
      return statement;
    },
  };
  const boundaryUrl = sourceUrl(`// ${++fixtureNumber}\nexport let actor,database; export function configure(user,db){actor=user;database=db;}
    export function getDatabase(){return database;} export async function getAuthUser(){return actor;}
    export function assertSameOrigin(request){if(request.headers.get('origin')!==new URL(request.url).origin)throw new Error('Invalid origin');}`);
  const boundary = await import(boundaryUrl);
  const modelUrl = fileUrl("../app/customRoles.ts");
  const serverUrl = await compile("../app/customRolesServer.ts", { "../db/client": boundaryUrl, "./customRoles.ts": modelUrl });
  const route = await import(await compile("../app/api/roles/route.ts", {
    "../../../db/client": boundaryUrl, "../../auth": boundaryUrl, "../../customRoles": modelUrl,
    "../../customRolesServer": serverUrl, "../../permissionModel": fileUrl("../app/permissionModel.ts"), "../../roles": fileUrl("../app/roles.ts"),
    "../../auditLog": sourceUrl("export async function withAuditTrail(request,handler){return handler(request);}"),
  }));
  return { db, route, as(user) { boundary.configure(user,db); } };
}
const actor = (overrides = {}) => ({ id: 4, fullName: "Тестовый администратор", role: "superadmin", assignedSiteId: null,
  projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("superadmin"), ...overrides });
const request = (payload, raw = false) => new Request("http://localhost/api/roles", {
  method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: raw ? payload : JSON.stringify(payload),
});
process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;

test("role endpoints require authentication and default viewers cannot list or create roles", async () => {
  const h = await harness(); h.as(null);
  assert.equal((await h.route.GET(new Request("http://localhost/api/roles"))).status, 401);
  assert.equal((await h.route.POST(request({ name: "Роль", permissions: {} }))).status, 401);
  h.as(actor({ role: "viewer", permissions: rolePermissionTemplate("viewer") }));
  assert.equal((await h.route.GET(new Request("http://localhost/api/roles"))).status, 403);
  assert.equal((await h.route.POST(request({ name: "Роль", permissions: {} }))).status, 403);
  assert.equal(h.db.queries.length, 0);
});

test("viewers cannot create roles even with forged write permissions, and scoped managers cannot create global roles", async () => {
  const h = await harness();
  for (const user of [
    actor({ role: "viewer" }),
    actor({ role: "engineer", projectAccess: { mode: "selected", siteIds: [7,8] } }),
    actor({ role: "engineer", projectAccess: { mode: "selected", siteIds: [] } }),
    actor({ role: "engineer", permissions: rolePermissionTemplate("engineer") }),
  ]) {
    h.as(user);
    assert.equal((await h.route.POST(request({ name: "Роль", permissions: {} }))).status, 403);
  }
  assert.equal(h.db.queries.length, 0);
  h.as(actor({ role: "engineer", projectAccess: { mode: "selected", siteIds: [] } }));
  assert.equal((await h.route.GET(new Request("http://localhost/api/roles"))).status, 403);
});

test("read access lists reusable templates without authorizing role management", async () => {
  const h = await harness();
  for (const user of [actor({ role: "viewer" }), actor({ role: "engineer", projectAccess: { mode: "selected", siteIds: [7] } }), actor({ role: "engineer", permissions: rolePermissionTemplate("engineer") })]) {
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
  for (const payload of [null, [], "name", 1, {}, { name: "" }, { name: "Инженер", permissions: {} }, { name: "Роль", permissions: [] }, { name: "Роль", permissions: { employees: { update: "true" } } }, { name: "Роль", permissions: { invalid_resource: { view: true } } }]) {
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
