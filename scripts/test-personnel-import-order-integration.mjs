// Explicit loopback-only integration. Actual application SQL runs against four
// TEMP tables, shadowing any real tables, and the entire check is rolled back.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { noCustomRolesUrl, noPermissionChangesUrl } from "../tests/fixtures/custom-role-imports.mjs";
import { compileModuleGraph } from "./lib/compile-module-graph.mjs";

const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : process.env.PGHOST;
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(host), "Use an explicitly configured loopback PostgreSQL database only.");
const sourceUrl = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
async function compile(path, replacements) {
  let code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(replacements)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return sourceUrl(code);
}
const { PostgresDatabase, PostgresStatement } = await import(await compile("../db/client.ts", { pg: import.meta.resolve("pg") }));
const pool = new pg.Pool({ ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}), ssl: false, max: 1, connectionTimeoutMillis: 5000 });
const connection = await pool.connect();
const database = new PostgresDatabase(pool);
const executor = { prepare: sql => new PostgresStatement(database, sql, [], connection) };
const scoped = { ...executor, async transaction(callback) {
  await connection.query("SAVEPOINT import_operation");
  try {
    const output = await callback(executor);
    await connection.query("RELEASE SAVEPOINT import_operation");
    return output;
  } catch (error) {
    await connection.query("ROLLBACK TO SAVEPOINT import_operation");
    await connection.query("RELEASE SAVEPOINT import_operation");
    throw error;
  }
} };
globalThis.personnelImportIntegrationDb = scoped;
globalThis.personnelDatabaseInitializationPromise = Promise.resolve();
const boundary = sourceUrl(`export const getDatabase=()=>globalThis.personnelImportIntegrationDb;
  export const getAuthUser=async()=>({id:17,role:'superadmin',assignedSiteId:null,projectAccess:{mode:'all',siteIds:[]},permissions:globalThis.personnelImportIntegrationPermissions});
  export function assertSameOrigin(request){if(request.headers.get('origin')!==new URL(request.url).origin)throw new Error('Invalid origin');}
  export async function ensureAuthSchema(){}
  export async function createInvitation(){throw new Error('No invitations in import integration');}
  export async function sendInvitationEmail(){throw new Error('No outgoing email in import integration');}`);
globalThis.personnelImportIntegrationPermissions = rolePermissionTemplate("superadmin");
const file = name => new URL(`../app/${name}.ts`, import.meta.url).href;
const noop = names => sourceUrl(names.map(name => `export async function ${name}(){return {};}`).join("\n"));
const dataReplacements = {
  "../../../db/client": boundary, "../../auth": boundary,
  "../../auditLog": sourceUrl("export const withAuditTrail=(request,handler)=>handler(request);"),
  "../../compressJsonResponse": sourceUrl("export async function compressJsonResponse(request,response){return response;}"),
  "../../permissions": noPermissionChangesUrl, "../../customRolesServer": noCustomRolesUrl,
  "../../projectAccessServer": noop(["loadUserProjectAccess", "saveUserProjectAccess"]),
  "../../projectMasters": noop(["ensureProjectMastersSchema", "syncProjectMasters"]),
  "../../workTypeHierarchyServer": noop(["saveSubworkDirectory"]),
  "../../bitrix24Sync": noop(["compareBitrixEmployees", "fetchBitrixEmployeeSnapshot", "normalizeBitrixText", "selectBitrixEmployeesForImport", "selectLinkedBitrixEmployeesForReview", "suggestBitrixEmployeeLinks", "suggestArchivedBitrixEmployeeLinks", "observeLegacyTerminalBitrixDuplicates", "isBitrixCentralOfficeEmployee", "bitrixOfficeTransferDirection"]),
  ...Object.fromEntries(["roles", "permissionModel", "projectScopedData", "readOptionalBatch", "settingsReadPolicy", "bitrix24Cooldown", "bitrixReviewSelection", "excelDirectoryImports", "personnelImportOrderServer"].map(name => [`../../${name}`, file(name)])),
};
let routeGraph;
let POST;
const query = (sql, values = []) => connection.query(sql, values);
const order = async key => (await query("SELECT row_ids FROM table_row_orders WHERE id=$1", [key])).rows[0]?.row_ids;
const snapshot = async () => ({
  employees: (await query("SELECT * FROM employees ORDER BY id")).rows,
  assignments: (await query("SELECT * FROM employee_project_assignments ORDER BY id")).rows,
  orders: (await query("SELECT * FROM table_row_orders ORDER BY id")).rows,
});
const post = async body => {
  const response = await POST(new Request("http://localhost/api/data", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }));
  return { status: response.status, payload: await response.json() };
};
const employee = (fullName, projectCode) => ({ fullName, employmentType: "ОПР", department: "Импорт", position: "Монтажник", projectCode });
const rows = [employee("Existing B", "ONE; TWO"), employee("New C", "TWO"), employee("Existing A", "ONE")];
try {
  routeGraph = await compileModuleGraph(new URL("../app/api/data/route.ts", import.meta.url), dataReplacements);
  ({ POST } = await import(routeGraph.url));
  await query("BEGIN");
  await query(`CREATE TEMP TABLE sites(id INTEGER PRIMARY KEY, code TEXT, name TEXT, active INTEGER DEFAULT 1) ON COMMIT DROP;
    CREATE TEMP TABLE employees(id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, full_name TEXT, employment_type TEXT, department TEXT, position TEXT, active INTEGER DEFAULT 1, source TEXT, site_id INTEGER, availability_status TEXT, sort_order INTEGER DEFAULT 0) ON COMMIT DROP;
    CREATE TEMP TABLE employee_project_assignments(id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, employee_id INTEGER,site_id INTEGER,source TEXT,active INTEGER DEFAULT 1,start_date DATE,end_date DATE) ON COMMIT DROP;
    CREATE TEMP TABLE table_row_orders(id TEXT PRIMARY KEY,row_ids JSONB DEFAULT '[]'::jsonb,updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP) ON COMMIT DROP;
    INSERT INTO sites VALUES(1,'ONE','First',1),(2,'TWO','Second',1),(3,'THREE','Untouched',1);
    INSERT INTO employees(id,full_name,employment_type,department,position,source,site_id,availability_status,sort_order) VALUES(1,'Existing A','ОПР','Before','Before','manual',1,'on_site',40),(2,'Existing B','ОПР','Before','Before','bitrix24',2,'vacation',10),(3,'Unrelated','ИТР','Before','Before','manual',1,'on_site',30);
    ALTER TABLE employees ALTER COLUMN id RESTART WITH 4;
    INSERT INTO employee_project_assignments(employee_id,site_id,source) VALUES(1,1,'manual'),(2,2,'manual'),(3,1,'manual');
    INSERT INTO table_row_orders(id,row_ids) VALUES('employees:0','[2,1,3]'),('project-personnel:1','[3,1]'),('project-personnel:2','[2]'),('import-order:employees:0','[3,1,2]'),('import-order:project-personnel:1','[3,1]'),('import-order:project-personnel:2','[2]'),('import-order:project-personnel:3','[99]');`);
  const manualBefore = [await order("employees:0"), await order("project-personnel:1"), await order("project-personnel:2")];
  assert.deepEqual(await post({ action: "import-employees", employees: rows }), { status: 201, payload: { count: 3, unassigned: 0 } });
  assert.deepEqual(await order("import-order:employees:0"), [2, 4, 1, 3]);
  assert.deepEqual(await order("import-order:project-personnel:1"), [2, 1, 3]);
  assert.deepEqual(await order("import-order:project-personnel:2"), [2, 4]);
  assert.deepEqual(await order("import-order:project-personnel:3"), [99]);
  assert.deepEqual((await query("SELECT sort_order FROM employees WHERE id<=3 ORDER BY id")).rows.map(row => row.sort_order), [40, 10, 30]);
  assert.equal((await query("SELECT availability_status FROM employees WHERE id=2")).rows[0].availability_status, "vacation");
  assert.equal((await post({ action: "import-employees", employees: [rows[2], rows[1], rows[0]] })).status, 201);
  assert.deepEqual(await order("import-order:employees:0"), [1, 4, 2, 3]);
  assert.equal(Number((await query("SELECT COUNT(*) AS count FROM employees")).rows[0].count), 4);

  assert.equal((await post({ action: "import-project-employees", siteId: 1, employeeIds: [4, 2, 4, 1] })).status, 201);
  assert.deepEqual(await order("import-order:project-personnel:1"), [4, 2, 1, 3]);
  assert.deepEqual(await order("import-order:project-personnel:2"), [4, 2]);
  assert.deepEqual([await order("employees:0"), await order("project-personnel:1"), await order("project-personnel:2")], manualBefore);

  const beforeInvalid = await snapshot();
  assert.equal((await post({ action: "import-employees", employees: [rows[0], rows[0]] })).status, 400);
  assert.equal((await post({ action: "import-project-employees", siteId: 1, employeeIds: [1, 999] })).status, 400);
  assert.deepEqual(await snapshot(), beforeInvalid);

  // Force a failure after profile, assignment and earlier order writes succeeded.
  await query(`CREATE FUNCTION pg_temp.reject_import_order_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='import-order:project-personnel:2' THEN RAISE EXCEPTION 'Synthetic import-order failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_import_order_write BEFORE UPDATE ON table_row_orders FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_import_order_write();`);
  const beforeFailure = await snapshot();
  const failed = await post({ action: "import-employees", employees: [employee("Existing A", "ONE; TWO"), employee("New rollback row", "TWO")] });
  assert.equal(failed.status, 400);
  assert.match(failed.payload.error, /Synthetic import-order failure/);
  assert.deepEqual(await snapshot(), beforeFailure);
  console.log("PASS: mixed existing/new file order, project subsequences, reimport, duplicate rejection, independent manual orders, Bitrix state and late-failure rollback; TEMP tables only.");
} finally {
  await query("ROLLBACK");
  connection.release();
  await pool.end();
  await routeGraph?.dispose();
  delete globalThis.personnelImportIntegrationDb;
  delete globalThis.personnelImportIntegrationPermissions;
  delete globalThis.personnelDatabaseInitializationPromise;
}
