// Explicit local-only integration check. All fixtures and reorders are rolled back.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : process.env.PGHOST;
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(host), "Use a loopback PostgreSQL database only.");
async function load(path, imports = {}) {
  let code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(imports)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const { PostgresDatabase, PostgresStatement } = await import(await load("../db/client.ts", { pg: import.meta.resolve("pg") }));
const pool = new pg.Pool({ ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}), ssl: false, max: 1, connectionTimeoutMillis: 5000 });
const connection = await pool.connect();
const database = new PostgresDatabase(pool);
// Production parallel reads use a pool. This rollback fixture deliberately has
// one connection, so serialize them instead of relying on pg's deprecated queue.
let fixtureQueue = Promise.resolve();
const serializedConnection = { query(...args) {
  const result = fixtureQueue.then(() => connection.query(...args));
  fixtureQueue = result.catch(() => undefined);
  return result;
} };
const executor = { prepare: (sql) => new PostgresStatement(database, sql, [], serializedConnection) };
const scoped = { ...executor, async transaction(callback) {
  await connection.query("SAVEPOINT reorder_operation");
  try { const result = await callback(executor); await connection.query("RELEASE SAVEPOINT reorder_operation"); return result; }
  catch (error) { await connection.query("ROLLBACK TO SAVEPOINT reorder_operation"); throw error; }
} };
globalThis.tableOrderTestDatabase = scoped;
const dbModule = `data:text/javascript,${encodeURIComponent("export const getDatabase = () => globalThis.tableOrderTestDatabase;")}`;
const server = await load("../app/tableRowOrderServer.ts", { "../db/client": dbModule, "./roles.ts": new URL("../app/roles.ts", import.meta.url).href, "./permissionModel": new URL("../app/permissionModel.ts", import.meta.url).href, "./workTypesRowOrder": new URL("../app/workTypesRowOrder.ts", import.meta.url).href, "./personnelReportRowOrder": new URL("../app/personnelReportRowOrder.ts", import.meta.url).href, "./equipmentReportRowOrder": new URL("../app/equipmentReportRowOrder.ts", import.meta.url).href, "./tableRowOrder": new URL("../app/tableRowOrder.ts", import.meta.url).href });
const auth = `data:text/javascript,${encodeURIComponent("export const getAuthUser = async () => globalThis.tableOrderTestUser; export function assertSameOrigin(request) { if (request.headers.get('origin') !== new URL(request.url).origin) throw new Error('Invalid origin'); }")}`;
const audit = `data:text/javascript,${encodeURIComponent("export const withAuditTrail = (request, handler) => handler(request);")}`;
// This existing suite covers legacy/project/personnel scopes. The dedicated
// equipment-report integration suite owns its additive schema and workflow.
const equipmentSchema = `data:text/javascript,${encodeURIComponent("export async function ensureEquipmentReportSchema(){ throw new Error('Equipment report schema must be initialized by its dedicated integration suite'); }")}`;
const { GET, POST } = await import(await load("../app/api/table-order/route.ts", { "../../../db/client": dbModule, "../../auth": auth, "../../auditLog": audit, "../../workTypesRowOrder": new URL("../app/workTypesRowOrder.ts", import.meta.url).href, "../../personnelReportRowOrder": new URL("../app/personnelReportRowOrder.ts", import.meta.url).href, "../../equipmentReportRowOrder": new URL("../app/equipmentReportRowOrder.ts", import.meta.url).href, "../../equipmentReportStore": equipmentSchema, "../../tableRowOrder": new URL("../app/tableRowOrder.ts", import.meta.url).href, "../../tableRowOrderServer": server }));
const user = (role, assignedSiteId = null) => ({ id: 1, role, assignedSiteId, permissions: rolePermissionTemplate(role) });
globalThis.tableOrderTestUser = user("superadmin");
const token = randomUUID();
const query = (sql, values = []) => connection.query(sql, values);
const get = async (scope, siteId) => { const response = await GET(new Request(`http://localhost/api/table-order?scope=${scope}&siteId=${siteId}`)); assert.equal(response.status, 200); return response.json(); };
const move = (scope, siteId, movingIds, placement, targetId, displayedIds) => POST(new Request("http://localhost/api/table-order", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ scope, siteId, movingIds, placement, targetId, displayedIds }) }));
try {
  await query("BEGIN");
  await query(await readFile(new URL("../drizzle-postgres/0020_table_row_orders.sql", import.meta.url), "utf8"));
  const sites = (await query("INSERT INTO sites (name, code) VALUES ('Order A', $1), ('Order B', $2) RETURNING id", [`order-a-${token}`, `order-b-${token}`])).rows.map((row) => row.id);
  const employees = (await query("INSERT INTO employees (full_name, employment_type, department, position) VALUES ($1, 'ОПР', 'Отдел', 'Должность'), ($2, 'ОПР', 'Отдел', 'Должность') RETURNING id", [`Order A ${token}`, `Order B ${token}`])).rows.map((row) => row.id);
  for (const site of sites) for (const employee of employees) await query("INSERT INTO employee_project_assignments (employee_id, site_id, source) VALUES ($1, $2, 'manual')", [employee, site]);
  const equipment = (await query("INSERT INTO equipment_units (site_id, identity_key, organization, equipment_type, model) VALUES ($1, $2, 'Организация', 'Кран', 'А'), ($1, $3, 'Организация', 'Кран', 'Б') RETURNING id", [sites[0], `order-a-${token}`, `order-b-${token}`])).rows.map((row) => row.id);
  for (const unit of equipment) await query("INSERT INTO equipment_project_assignments (equipment_id, site_id) VALUES ($1, $2)", [unit, sites[0]]);
  await query("INSERT INTO zones (site_id, name) VALUES ($1, 'Order A'), ($1, 'Order B')", [sites[0]]);

  // Master and detail grids share actual row keys, including every parent and orphan child.
  const columns = await query("SELECT column_name FROM information_schema.columns WHERE table_name='subwork_types' AND column_name='main_work_type_id'");
  if (!columns.rowCount) await query(await readFile(new URL("../drizzle-postgres/0022_work_type_hierarchy.sql", import.meta.url), "utf8"));
  const workParents = (await query("INSERT INTO main_work_types(site_id,name) VALUES ($1,'Работы А'),($1,'Пустой вид') RETURNING id", [sites[0]])).rows.map(row => row.id);
  const workChildren = (await query("INSERT INTO subwork_types(site_id,name,main_work_type_id) VALUES ($1,'Подвид А',$2),($1,'Подвид Б',$2),($1,'Без вида',NULL) RETURNING id", [sites[0], workParents[0]])).rows.map(row => row.id);
  const foreignWork = (await query("INSERT INTO subwork_types(site_id,name) VALUES ($1,'Чужой проект') RETURNING id", [sites[1]])).rows[0].id;
  const workScope = "directory-work-types";
  const childTokens = workChildren.map(id => `child-${id}`);
  const parentTokens = workParents.map(id => `parent-${id}`);
  const emptyToken = `parent-${workParents[1]}`;
  const originalWorkRows = (await get(workScope, sites[0])).ids;
  assert.deepEqual(new Set(originalWorkRows), new Set([...childTokens, ...parentTokens]));
  assert.equal(originalWorkRows.length, childTokens.length + parentTokens.length, "each active master and detail appears exactly once");
  const legacyFlatOrder = [childTokens[0], childTokens[1], emptyToken, childTokens[2]];
  await query("INSERT INTO table_row_orders(id,row_ids) VALUES ($1,$2::jsonb)", [`${workScope}:${sites[0]}`, JSON.stringify(legacyFlatOrder)]);
  assert.deepEqual((await get(workScope, sites[0])).ids, [...legacyFlatOrder, parentTokens[0]], "existing saved order is preserved and newly visible populated parents are appended");
  assert.equal((await move(workScope, sites[0], [childTokens[2]], "start")).status, 200);
  assert.equal((await get(workScope, sites[0])).ids[0], childTokens[2]);
  assert.equal((await move(workScope, sites[0], [emptyToken, childTokens[1]], "start", undefined, [childTokens[2], childTokens[0], emptyToken, childTokens[1]])).status, 200);
  assert.deepEqual((await get(workScope, sites[0])).ids, [emptyToken, childTokens[1], childTokens[2], childTokens[0], parentTokens[0]]);
  assert.equal((await move(workScope, sites[0], [`child-${foreignWork}`], "start")).status, 400);
  assert.equal((await move(workScope, sites[0], [workChildren[0]], "start")).status, 400);
  assert.equal((await move(workScope, sites[0], [childTokens[0], childTokens[0]], "start")).status, 400);
  assert.deepEqual((await query("SELECT main_work_type_id FROM subwork_types WHERE id=ANY($1) ORDER BY id", [workChildren])).rows.map(row => row.main_work_type_id), [workParents[0], workParents[0], null], "reordering never reassigns a subtype");
  await query("UPDATE subwork_types SET active=0 WHERE id=$1", [workChildren[1]]);
  assert.deepEqual((await get(workScope, sites[0])).ids, [emptyToken, childTokens[2], childTokens[0], parentTokens[0]]);
  assert.equal((await move(workScope, sites[0], [parentTokens[0]], "before", emptyToken, [parentTokens[0], emptyToken])).status, 200);
  const masterMove = (await get(workScope, sites[0])).ids;
  assert.deepEqual(masterMove.filter(id => id.startsWith("parent-")), [parentTokens[0], emptyToken]);
  assert.deepEqual(masterMove.filter(id => id.startsWith("child-")), [childTokens[2], childTokens[0]], "moving a master does not change its detail ordering or assignments");
  globalThis.tableOrderTestUser = { ...user("superadmin"), permissions: { ...rolePermissionTemplate("superadmin"), project_directories: { view: true, create: false, update: false, delete: true } } };
  assert.equal((await get(workScope, sites[0])).canWrite, false);
  assert.equal((await move(workScope, sites[0], [childTokens[0]], "start")).status, 403);
  globalThis.tableOrderTestUser = user("superadmin");

  assert.equal((await get("project-personnel", sites[0])).hasSavedOrder, false);
  assert.equal((await move("project-personnel", sites[0], [employees[1]], "start")).status, 200);
  assert.equal((await get("project-personnel", sites[0])).hasSavedOrder, true);
  assert.deepEqual((await get("project-personnel", sites[0])).ids, [employees[1], employees[0]]);
  assert.deepEqual((await get("project-personnel", sites[1])).ids, employees);
  assert.equal((await move("project-personnel", sites[0], [employees[1]], "after", employees[0])).status, 200);
  assert.deepEqual((await get("project-personnel", sites[0])).ids, employees);
  assert.equal((await move("project-personnel", sites[0], [employees[0]], "after", employees[1], [employees[1], employees[0]])).status, 200);
  assert.deepEqual((await get("project-personnel", sites[0])).ids, [employees[1], employees[0]]);
  assert.equal((await move("project-personnel", sites[0], [employees[1]], "after", employees[0])).status, 200);
  assert.equal((await move("project-personnel", sites[0], [employees[0]], "before", employees[1], [2_000_000_000])).status, 400);
  assert.equal((await move("project-equipment", sites[0], [equipment[1]], "start")).status, 200);
  assert.deepEqual((await get("project-equipment", sites[0])).ids, [equipment[1], equipment[0]]);
  assert.deepEqual((await get("project-personnel", sites[0])).ids, employees);

  for (const scope of ["employees", "equipment", "positions", "users", "projects", "directory-zone", "directory-mainWorkType", "directory-subworkType", "directory-master"]) await get(scope, sites[0]);

  // Regression: repeated employees in multiple records and dates are independent.
  const actor = (await query("INSERT INTO app_users (full_name, email, role, assigned_site_id) VALUES ($1, $2, 'foreman', $3) RETURNING id", [token, `${token}@invalid.test`, sites[0]])).rows[0].id;
  const otherActor = (await query("INSERT INTO app_users (full_name, email, role, assigned_site_id) VALUES ($1, $2, 'foreman', $3) RETURNING id", [`other-${token}`, `other-${token}@invalid.test`, sites[0]])).rows[0].id;
  const reportIds = [];
  for (const [date, owner] of [["2026-10-28", actor], ["2026-10-27", actor], ["2026-10-28", otherActor]]) {
    reportIds.push((await query(`INSERT INTO personnel_reports (site_id, work_date, owner_user_id, created_by_user_id, updated_by_user_id)
      VALUES ($1, $2, $3, $3, $3) RETURNING id`, [sites[0], date, owner])).rows[0].id);
  }
  const reportTokens = [];
  for (const [report, date, rank, employee] of [[reportIds[0], "2026-10-28", 0, employees[0]], [reportIds[0], "2026-10-28", 1, employees[1]], [reportIds[0], "2026-10-28", 2, employees[0]], [reportIds[1], "2026-10-27", 0, employees[0]], [reportIds[2], "2026-10-28", 0, employees[1]]]) {
    const row = (await query("INSERT INTO personnel_report_rows (report_id, row_order, employee_id, hours, note) VALUES ($1, $2, $3, 8, $4) RETURNING id", [report, rank, employee, token])).rows[0].id;
    reportTokens.push(`${date}/report-${report}-${row}`);
  }
  globalThis.tableOrderTestUser = { ...user("foreman", sites[0]), id: actor };
  const reportScope = "personnel-report-rows";
  assert.deepEqual((await get(reportScope, sites[0])).ids, reportTokens.slice(0, 4));
  assert.equal((await move(reportScope, sites[0], [reportTokens[2]], "before", reportTokens[0])).status, 200);
  assert.deepEqual((await get(reportScope, sites[0])).ids, [reportTokens[2], reportTokens[0], reportTokens[1], reportTokens[3]]);
  assert.deepEqual((await get("project-personnel", sites[0])).ids, employees);
  assert.equal((await move(reportScope, sites[0], [reportTokens[2]], "after", reportTokens[3])).status, 400);
  assert.equal((await move(reportScope, sites[0], [reportTokens[4]], "start")).status, 400);
  assert.equal((await move(reportScope, sites[0], [reportTokens[2]], "before", "2026-10-28/report-99999999-99999999")).status, 400);
  const blank = `2026-10-28/${randomUUID()}`;
  assert.equal((await move(reportScope, sites[0], [blank], "before", reportTokens[0], [reportTokens[2], reportTokens[0], reportTokens[1], blank, reportTokens[3]])).status, 200);
  assert.deepEqual((await get(reportScope, sites[0])).ids, [reportTokens[2], blank, reportTokens[0], reportTokens[1], reportTokens[3]]);
  const savedDraftId = (await query("INSERT INTO personnel_report_rows (report_id, row_order, employee_id, hours, note) VALUES ($1, 3, $2, 8, $3) RETURNING id", [reportIds[0], employees[0], token])).rows[0].id;
  const savedDraft = `2026-10-28/report-${reportIds[0]}-${savedDraftId}`;
  const remapped = await POST(new Request("http://localhost/api/table-order", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ scope: reportScope, siteId: sites[0], action: "remap", aliases: { [blank]: savedDraft } }) }));
  assert.equal(remapped.status, 200);
  assert.deepEqual((await get(reportScope, sites[0])).ids, [reportTokens[2], savedDraft, reportTokens[0], reportTokens[1], reportTokens[3]]);
  assert.equal((await move(reportScope, sites[0], ["2026-02-31/approved-1"], "start")).status, 400);
  assert.deepEqual((await query("SELECT hours, note FROM personnel_report_rows WHERE report_id = ANY($1) ORDER BY id", [reportIds])).rows, Array.from({ length: 6 }, () => ({ hours: 8, note: token })));
  globalThis.tableOrderTestUser = { ...user("foreman", sites[0]), id: otherActor };
  assert.deepEqual((await get(reportScope, sites[0])).ids, [reportTokens[4]]);
  globalThis.tableOrderTestUser = user("superadmin");
  assert.equal((await move("project-personnel", sites[0], [employees[0], employees[0]], "end")).status, 400);
  assert.equal((await move("project-personnel", sites[0], [2_000_000_000], "start")).status, 400);
  assert.equal((await move("project-personnel", sites[0], [employees[0]], "before")).status, 400);
  assert.deepEqual((await get("project-personnel", sites[0])).ids, employees);
  globalThis.tableOrderTestUser = user("engineer");
  assert.equal((await move("positions", sites[0], [1], "start")).status, 403);
  globalThis.tableOrderTestUser = user("foreman", sites[0]);
  assert.equal((await move("project-personnel", sites[1], [employees[0]], "start")).status, 403);
  assert.equal((await move("employees", sites[0], [employees[0]], "start")).status, 403);
  assert.equal((await move("project-personnel", sites[0], employees, "end")).status, 200);
  console.log("Row order integration passed: persistence, multi-row moves, project isolation, all scopes, validation, and permissions.");
} finally {
  await query("ROLLBACK");
  delete globalThis.tableOrderTestDatabase;
  delete globalThis.tableOrderTestUser;
  connection.release();
  await pool.end();
}
