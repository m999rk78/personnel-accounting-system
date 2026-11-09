// Loopback only. The isolated schema, fixtures, audit events and every change roll back together.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { archiveWorkTypesDirectory, saveWorkTypesDirectory } from "../app/workTypesEditingServer.ts";

const hostname = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : process.env.PGHOST;
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname), "Use a loopback PostgreSQL database only.");
async function load(path, imports = {}) {
  let code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(imports)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const { PostgresDatabase, PostgresStatement } = await import(await load("../db/client.ts", { pg: import.meta.resolve("pg") }));
const pool = new pg.Pool({ ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}), ssl: false, max: 1, connectionTimeoutMillis: 5000 });
const connection = await pool.connect();
const database = new PostgresDatabase(pool);
const executor = { prepare: sql => new PostgresStatement(database, sql, [], connection), async batch(statements) {
  const results = [];
  for (const statement of statements) results.push(await statement.executeWith(connection));
  return results;
} };
const scoped = { ...executor, async transaction(callback) {
  await connection.query("SAVEPOINT work_types_editing_operation");
  try { const result = await callback(executor); await connection.query("RELEASE SAVEPOINT work_types_editing_operation"); return result; }
  catch (error) { await connection.query("ROLLBACK TO SAVEPOINT work_types_editing_operation"); await connection.query("RELEASE SAVEPOINT work_types_editing_operation"); throw error; }
} };
globalThis.workTypesEditingTestDatabase = scoped;
const dbModule = `data:text/javascript,${encodeURIComponent("export const getDatabase = () => globalThis.workTypesEditingTestDatabase;")}`;
const authModule = `data:text/javascript,${encodeURIComponent("export const getAuthUser = async () => globalThis.workTypesEditingTestUser; export function assertSameOrigin(request) { if (request.headers.get('origin') !== new URL(request.url).origin) throw new Error('Invalid origin'); }")}`;
const auditModule = await load("../app/auditLog.ts", { "../db/client": dbModule, "./auth": authModule });
const { POST } = await import(await load("../app/api/work-types/route.ts", {
  "../../../db/client": dbModule, "../../auth": authModule, "../../auditLog": auditModule,
  "../../permissionModel": new URL("../app/permissionModel.ts", import.meta.url).href,
  "../../roles": new URL("../app/roles.ts", import.meta.url).href,
  "../../workTypeHierarchyServer": new URL("../app/workTypeHierarchyServer.ts", import.meta.url).href,
  "../../workTypesEditingServer": new URL("../app/workTypesEditingServer.ts", import.meta.url).href,
}));
const user = (access = {}, role = "superadmin", assignedSiteId = null) => ({ id: 1, fullName: "Проверка", role, assignedSiteId, permissions: { ...rolePermissionTemplate(role), project_directories: { view: true, create: true, update: true, delete: true, ...access } } });
globalThis.workTypesEditingTestUser = user();
const query = (sql, values = []) => connection.query(sql, values);
const request = (payload, origin = "http://localhost") => POST(new Request("http://localhost/api/work-types", { method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(payload) }));
const save = (parents = [], children = []) => request({ action: "save", siteId: 1, parents, children });
const archive = (parents = [], children = []) => request({ action: "archive", siteId: 1, parents, children });
const snapshot = async () => ({
  parents: (await query("SELECT id, site_id, name, active FROM main_work_types ORDER BY id")).rows,
  children: (await query("SELECT id, site_id, name, main_work_type_id, active FROM subwork_types ORDER BY id")).rows,
  audit: (await query("SELECT id, action_key FROM audit_events ORDER BY id")).rows,
});
const unchanged = async (operation, pattern) => {
  const before = await snapshot();
  await assert.rejects(operation, pattern);
  assert.deepEqual(await snapshot(), before, "a rejected operation must preserve the entire catalog and audit trail");
};
const rejected = async (operation, status) => {
  const before = await snapshot();
  const response = await operation();
  assert.equal(response.status, status, JSON.stringify(await response.json()));
  assert.deepEqual(await snapshot(), before, "a rejected request must preserve the entire catalog and audit trail");
};
try {
  await query("BEGIN");
  const schema = `work_types_editing_test_${randomUUID().replaceAll("-", "")}`;
  await query(`CREATE SCHEMA ${schema}`);
  await query(`SET LOCAL search_path TO ${schema}`);
  await query(`CREATE TABLE sites(id serial PRIMARY KEY, name text, active integer DEFAULT 1);
    CREATE TABLE app_users(id integer PRIMARY KEY);
    CREATE TABLE main_work_types(id serial PRIMARY KEY, site_id integer REFERENCES sites(id), name text, active integer DEFAULT 1);
    CREATE TABLE subwork_types(id serial PRIMARY KEY, site_id integer REFERENCES sites(id), name text, main_work_type_id integer REFERENCES main_work_types(id), active integer DEFAULT 1,
      CONSTRAINT test_write_failure CHECK (name <> '__fail_save__' AND (name <> '__fail_archive__' OR active = 1)));
    CREATE TABLE placement_entries(site_id integer, main_work_type_id integer REFERENCES main_work_types(id), subwork_type_id integer REFERENCES subwork_types(id));
    CREATE TABLE equipment_entries(site_id integer, main_work_type_id integer REFERENCES main_work_types(id), subwork_type_id integer REFERENCES subwork_types(id));
    CREATE TABLE personnel_reports(id integer PRIMARY KEY, site_id integer);
    CREATE TABLE personnel_report_rows(report_id integer, main_work_type_id integer REFERENCES main_work_types(id), subwork_type_id integer REFERENCES subwork_types(id));
    INSERT INTO app_users VALUES (1);
    INSERT INTO sites(name,active) VALUES ('Проект А',1),('Проект Б',1),('Закрытый проект',0);
    INSERT INTO main_work_types(site_id,name,active) VALUES (1,'Вид А',1),(1,'Вид Б',1),(2,'Чужой вид',1),(1,'Архивный вид',0),(3,'Закрытый вид',1);
    INSERT INTO subwork_types(site_id,name,main_work_type_id,active) VALUES (1,'Подвид А',1,1),(1,'Подвид Б',1,1),(1,'Не распределён',NULL,1),(2,'Чужой подвид',3,1),(1,'Архивный подвид',1,0),(1,'__fail_archive__',2,1);
    INSERT INTO placement_entries VALUES (1,1,1);
    INSERT INTO equipment_entries VALUES (1,1,1);
    INSERT INTO personnel_reports VALUES (1,1);
    INSERT INTO personnel_report_rows VALUES (1,1,1);`);
  // Production disables runtime DDL: migrate the isolated fixture schema as a
  // deployed database would, instead of depending on development bootstrap.
  const auditMigration = await readFile(new URL("../drizzle-postgres/0014_audit_events.sql", import.meta.url), "utf8");
  for (const statement of auditMigration.split("--> statement-breakpoint")) if (statement.trim()) await query(statement);
  const { ensureAuditSchema } = await import(auditModule);
  await ensureAuditSchema();
  const history = async () => ({ placement: (await query("SELECT * FROM placement_entries")).rows, equipment: (await query("SELECT * FROM equipment_entries")).rows, report: (await query("SELECT * FROM personnel_report_rows")).rows });
  const originalHistory = await history();

  const response = await save([{ clientKey: "new-parent", name: "  Новый вид  " }, { id: 1, clientKey: "parent-1", name: "Исправленный вид", originalName: "Вид А" }], [
    { clientKey: "new-child", name: " Новый подвид ", parentId: null, parentKey: "new-parent" },
    { id: 1, clientKey: "child-1", name: "Исправленный подвид", parentId: 2, originalName: "Подвид А", originalParentId: 1 },
    { id: 3, clientKey: "child-3", name: "Без назначения", parentId: null, originalName: "Не распределён", originalParentId: null },
  ]);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(saved.parents.map(row => row.clientKey), ["new-parent", "parent-1"]);
  assert.deepEqual(saved.children.map(row => row.clientKey), ["new-child", "child-1", "child-3"]);
  assert.equal(saved.parents[1].id, 1);
  assert.equal(saved.children[1].id, 1);
  assert.deepEqual((await query("SELECT name, main_work_type_id FROM subwork_types WHERE id=$1", [saved.children[0].id])).rows[0], { name: "Новый подвид", main_work_type_id: saved.parents[0].id });
  assert.deepEqual((await query("SELECT name, main_work_type_id FROM subwork_types WHERE id=1")).rows[0], { name: "Исправленный подвид", main_work_type_id: 2 });
  const firstAudit = (await query("SELECT action_key, summary, before_data, after_data FROM audit_events ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(firstAudit.action_key, "work_types.save");
  assert.match(firstAudit.summary, /Сохранил изменения/);
  assert.deepEqual(firstAudit.before_data.parents, [{ id: 1, name: "Вид А", active: 1 }]);
  assert.equal(firstAudit.before_data.children.find(row => row.id === 1).parentId, 1);
  assert.deepEqual(firstAudit.after_data.result, saved);
  assert.deepEqual(await history(), originalHistory, "editing catalog rows preserves all historical references");

  const row = (overrides = {}) => ({ id: 1, clientKey: "child-1", name: "Новое имя", parentId: 2, ...overrides });
  const batch = (parents = [], children = []) => ({ parents, children });
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ clientKey: "p", name: "Не сохранять" }], [row({ originalName: "Подвид А" })])), /уже изменён/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([], [row({ originalParentId: 1 })])), /уже изменён/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ id: 1, clientKey: "p", name: "Новое", originalName: "Вид А" }])), /уже изменён/);
  for (const id of [4, 5, 1_000_000]) await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([], [row({ id })])), /не найден/);
  for (const id of [3, 4, 1_000_000]) await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ id, clientKey: "p", name: "Новое" }])), /не найден/);
  for (const parentId of [3, 4, 1_000_000]) await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([], [row({ parentId })])), /действующий вид/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 3, batch([{ clientKey: "p", name: "Новое" }])), /закрыт/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ clientKey: "p", name: " ВИД  Б " }])), /уже есть/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ clientKey: "p1", name: "Учёт техники" }, { clientKey: "p2", name: " УЧЕТ   ТЕХНИКИ " }])), /уже есть/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([], [{ clientKey: "c", name: "ПОДВИД Б", parentId: 1 }])), /уже есть/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ clientKey: "p", name: "Новый родитель" }], [{ clientKey: "c1", name: "Учёт", parentId: null, parentKey: "p" }, { clientKey: "c2", name: "Учет", parentId: null, parentKey: "p" }])), /уже есть/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([], [{ clientKey: "c", name: "Без назначения", parentId: null }])), /уже есть/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([], [row(), row({ clientKey: "different" })])), /без повторений/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ clientKey: "same", name: "А" }, { clientKey: "same", name: "Б" }])), /уникальные ключи/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([], [row({ parentKey: "missing", parentId: null })])), /не найден среди/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ id: 1, clientKey: "existing", name: "Исправленный вид" }], [row({ parentKey: "existing", parentId: null })])), /не найден среди/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ clientKey: "p", name: "Родитель" }], [row({ parentKey: "p" })])), /не найден среди/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ clientKey: "p", name: " ".repeat(4) }])), /название/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([], [row({ name: "я".repeat(241) })])), /240/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch()), /от 1 до 500/);
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch(Array.from({ length: 501 }, (_, index) => ({ clientKey: `p-${index}`, name: `Строка ${index}` })))), /от 1 до 500/);
  const fullBatch = await saveWorkTypesDirectory(scoped, 1, batch(Array.from({ length: 500 }, (_, index) => ({ clientKey: `limit-${index}`, name: `Предел ${index}` }))));
  assert.equal(fullBatch.parents.length, 500, "the supported save batch limit succeeds atomically");
  await saveWorkTypesDirectory(scoped, 1, batch([{ id: 1, clientKey: "p1", name: "Вид Б" }, { id: 2, clientKey: "p2", name: "Исправленный вид" }], [{ clientKey: "same-name-other-parent", name: "Подвид Б", parentId: 2 }]));
  assert.deepEqual((await query("SELECT name FROM main_work_types WHERE id IN (1,2) ORDER BY id")).rows.map(row => row.name), ["Вид Б", "Исправленный вид"], "name swaps are validated using the final catalog state");

  // The CHECK fails only after a parent insert/update and an earlier child update have executed.
  await unchanged(() => saveWorkTypesDirectory(scoped, 1, batch([{ clientKey: "rollback-parent", name: "Откатить создание" }, { id: 1, clientKey: "rollback-update", name: "Откатить изменение" }], [row(), { clientKey: "failed-child", name: "__fail_save__", parentId: null, parentKey: "rollback-parent" }])), /test_write_failure/);
  await rejected(() => save([{ clientKey: "route-rollback", name: "Откатить запрос" }], [{ clientKey: "fail", name: "__fail_save__", parentId: null, parentKey: "route-rollback" }]), 400);

  globalThis.workTypesEditingTestUser = user({ update: false });
  assert.equal((await save([{ clientKey: "create-only", name: "Только добавление" }])).status, 200);
  await rejected(() => save([], [row()]), 403);
  await rejected(() => save([{ clientKey: "mixed", name: "Не сохранять" }], [row()]), 403);
  globalThis.workTypesEditingTestUser = user({ create: false });
  assert.equal((await save([], [row({ name: "Исправленный подвид" })])).status, 200);
  await rejected(() => save([{ clientKey: "p", name: "Нет добавления" }]), 403);
  await rejected(() => save([], [{ clientKey: "c", name: "Нет добавления", parentId: 1 }]), 403);
  globalThis.workTypesEditingTestUser = user({ view: false });
  await rejected(() => save([{ clientKey: "p", name: "Нет просмотра" }]), 403);
  await rejected(() => archive([1]), 403);
  globalThis.workTypesEditingTestUser = user({ delete: false });
  await rejected(() => archive([1]), 403);
  globalThis.workTypesEditingTestUser = user({}, "foreman", 1);
  await rejected(() => request({ action: "save", siteId: 2, parents: [{ clientKey: "p", name: "Чужой проект" }], children: [] }), 403);
  await rejected(() => request({ action: "archive", siteId: 2, parents: [3], children: [] }), 403);
  globalThis.workTypesEditingTestUser = null;
  await rejected(() => archive([1]), 401);
  globalThis.workTypesEditingTestUser = user();
  await rejected(() => request({ action: "archive", siteId: 1, parents: [1], children: [] }, "https://invalid.test"), 400);
  await rejected(() => save([null]), 400);
  await rejected(() => request(null), 400);

  for (const parents of [[3], [4], [1_000_000]]) await unchanged(() => archiveWorkTypesDirectory(scoped, 1, { parents, children: [2] }), /не найден/);
  for (const children of [[4], [5], [1_000_000]]) await unchanged(() => archiveWorkTypesDirectory(scoped, 1, { parents: [1], children }), /не найден/);
  await unchanged(() => archiveWorkTypesDirectory(scoped, 1, { parents: [], children: [] }), /от 1 до 5000/);
  await unchanged(() => archiveWorkTypesDirectory(scoped, 1, { parents: [-1], children: [] }), /корректные/);
  await unchanged(() => archiveWorkTypesDirectory(scoped, 1, { parents: Array.from({ length: 5001 }, () => 1), children: [] }), /от 1 до 5000/);
  await unchanged(() => archiveWorkTypesDirectory(scoped, 3, { parents: [5], children: [] }), /закрыт/);
  // Parent archival executes first; a failure in the child update must restore it too.
  await unchanged(() => archiveWorkTypesDirectory(scoped, 1, { parents: [2], children: [] }), /test_write_failure/);
  await rejected(() => archive([2]), 400);

  globalThis.workTypesEditingTestUser = user({ create: false, update: false });
  const archivedResponse = await archive([1, 1], [2, 2, 3]);
  assert.equal(archivedResponse.status, 200);
  assert.deepEqual(await archivedResponse.json(), { parents: 1, children: 2, count: 3 }, "explicit children and cascaded children are counted once");
  assert.deepEqual((await query("SELECT id, active FROM subwork_types WHERE id IN (1,2,3,4,5) ORDER BY id")).rows.map(row => row.active), [1, 0, 0, 1, 0]);
  const archiveAudit = (await query("SELECT action_key, summary, before_data FROM audit_events ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(archiveAudit.action_key, "work_types.archive");
  assert.match(archiveAudit.summary, /Архивировал/);
  assert.deepEqual(archiveAudit.before_data.parents.map(row => row.id), [1]);
  assert.deepEqual(archiveAudit.before_data.children.map(row => row.id), [2, 3]);
  await rejected(() => archive([1]), 400);
  assert.deepEqual(await history(), originalHistory, "archival preserves placement, equipment and personnel report records");

  globalThis.workTypesEditingTestUser = user();
  const importResponse = await request({ siteId: 1, entries: [{ name: "Импорт", subworkName: "Импорт подвида" }] });
  assert.equal(importResponse.status, 200, JSON.stringify(await importResponse.json()));
  const imported = (await query("SELECT id FROM main_work_types WHERE name='Импорт'")).rows[0].id;
  const assignResponse = await request({ action: "assign", siteId: 1, mainWorkTypeId: imported, ids: [1] });
  assert.equal(assignResponse.status, 200);
  assert.deepEqual(await assignResponse.json(), { count: 1 });
  assert.equal((await query("SELECT name FROM subwork_types WHERE id=1")).rows[0].name, "Исправленный подвид");
  assert.deepEqual(await history(), originalHistory);
  console.log("Work types inline editing passed: atomic parent/child save, stale edits, duplicates, references, 500-row limit, per-item permissions, cascade archive/counts, real audit history and forced write rollback. Import and assign preserved. All data rolled back.");
} finally {
  await query("ROLLBACK");
  delete globalThis.workTypesEditingTestDatabase;
  delete globalThis.workTypesEditingTestUser;
  connection.release();
  await pool.end();
}
