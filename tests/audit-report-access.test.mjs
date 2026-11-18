import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { emptyPermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = moduleUrl(`export let actor, db;
  export function configure(user, database) { actor = user; db = database; }
  export const getAuthUser = async () => actor;
  export const getDatabase = () => db;
  export async function ensureAuditSchema() {}
`);
const boundary = await import(boundaryUrl);
async function load(path, replacements) {
  let code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(JSON.stringify(from), JSON.stringify(to));
  return import(moduleUrl(code));
}
const route = await load("../app/api/audit-log/route.ts", {
  "../../../db/client": boundaryUrl, "../../auth": boundaryUrl, "../../auditLog": boundaryUrl,
  "../../roles": new URL("../app/roles.ts", import.meta.url).href,
  "../../permissionModel": new URL("../app/permissionModel.ts", import.meta.url).href,
});
const audit = await load("../app/auditLog.ts", { "../db/client": boundaryUrl, "./auth": boundaryUrl });

const events = [
  [1, "directories", "directory.save", "directory", "", "/api/work-types"],
  [2, "reports", "personnel_report.save", "personnel_report_draft", "", "/api/personnel-report"],
  [3, "reports", "equipment_report.approve", "equipment_report_draft", "", "/api/equipment-report"],
  [4, "legacy", "personnel_report.save", "employee", "", "/api/data"],
  [5, "legacy", "legacy.save", "equipment_report_draft", "", "/api/equipment"],
  [6, "directories", "table.reorder", "table_row_order", "personnel-report-rows", "/api/table-order"],
  [7, "directories", "table.reorder", "table_row_order", "equipment-report-rows", "/api/table-order"],
  [8, "reports", "legacy.save", "unknown", "", "/api/data"],
  [9, "legacy", "personnel_report.save", "equipment_report_draft", "", "/api/data"],
  [10, "timesheets", "personnel_timesheet.set", "employee_timesheet", "", "/api/timesheet"],
  [11, "directories", "employee.delete", "employee", "11", "/api/data"],
  [12, "equipment", "equipment.update", "equipment", "12", "/api/equipment"],
];
function fixture(permissions, overrides = {}) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE audit_events (id INTEGER, actor_user_id INTEGER, actor_name TEXT, actor_role TEXT,
    category TEXT NOT NULL, action_key TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    site_id INTEGER, site_name TEXT, summary TEXT, before_data TEXT, after_data TEXT, request_path TEXT, created_at TEXT);`);
  const insert = sql.prepare("INSERT INTO audit_events (id, category, action_key, entity_type, entity_id, request_path, site_id, before_data, after_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of events) insert.run(...row, row[0] === 5 ? 8 : 7, JSON.stringify({ note: "Старое содержимое отчёта" }), JSON.stringify({ ok: true }));
  const queries = [];
  const db = { prepare(query) {
    let values = [];
    return { bind(...next) { values = next; return this; }, async all() {
      queries.push({ query, values });
      const parameters = [];
      let index = 0;
      const sqliteQuery = query.replace(/= ANY\(\?::integer\[\]\)|\?/g, match => {
        const value = values[index++];
        if (match.startsWith("= ANY")) { parameters.push(...value); return `IN (${value.map(() => "?").join(",")})`; }
        parameters.push(value); return "?";
      });
      return { results: sql.prepare(sqliteQuery).all(...parameters) };
    } };
  } };
  boundary.configure({ id: 7, role: "engineer", assignedSiteId: null, permissions, ...overrides }, db);
  return { sql, queries };
}
function rights(...reports) {
  const permissions = emptyPermissionSet(); permissions.audit_log.view = true;
  for (const resource of reports) {
    permissions[resource].view = true;
    for (const status of ["draft", "submitted", "approved"]) permissions[`${resource}_${status}`].view = true;
  }
  return permissions;
}
const get = async (query = "") => {
  const response = await route.GET(new Request(`http://localhost/api/audit-log${query}`));
  assert.equal(response.status, 200);
  return response.json();
};

test("audit report history never inherits access from another report or an incomplete status grant", async () => {
  for (const [resource, allowedIds] of [["workers_report", [12, 11, 10, 6, 4, 2, 1]], ["equipment_report", [12, 11, 10, 7, 5, 3, 1]]]) {
    const permissions = rights(resource), h = fixture(permissions);
    assert.deepEqual((await get()).events.map(row => row.id), allowedIds);
    h.sql.close();
    for (const status of ["draft", "submitted", "approved"]) {
      const restricted = structuredClone(permissions); restricted[`${resource}_${status}`].view = false;
      const h = fixture(restricted);
      assert.deepEqual((await get()).events.map(row => row.id), [12, 11, 10, 1], `${resource}: denied ${status}`);
      h.sql.close();
    }
  }
});

test("audit full access retains both domains and unknown legacy events; project scope and pagination still apply", async () => {
  const full = fixture(rolePermissionTemplate("superadmin"));
  assert.deepEqual((await get()).events.map(row => row.id), [...events].reverse().map(row => row[0]));
  full.sql.close();
  const scoped = fixture(rights("workers_report"), { projectAccess: { mode: "selected", siteIds: [7] } });
  const result = await get("?beforeId=7&limit=2");
  assert.deepEqual(result.events.map(row => row.id), [6, 4]);
  assert.equal(result.hasMore, true);
  assert.deepEqual(scoped.queries[0].values, [[7], 7, 2]);
  scoped.sql.close();
});

test("legacy unrelated report snapshots are omitted from catalog audit events without deleting the event", async () => {
  const h = fixture(rolePermissionTemplate("superadmin"));
  const rows = (await get()).events;
  for (const id of [11, 12]) {
    const row = rows.find(row => row.id === id);
    assert.equal(row.beforeData, null);
    assert.equal(row.afterData, JSON.stringify({ ok: true }));
  }
  assert.ok(rows.find(row => row.id === 2).beforeData);
  assert.ok(rows.find(row => row.id === 10).beforeData);
  h.sql.close();
});

test("catalog IDs are never treated as report row IDs when preparing audit snapshots", async () => {
  const reads = [];
  boundary.configure({ id: 7, fullName: "Тестовый пользователь", role: "engineer" }, { prepare(query) {
    reads.push(query);
    return { bind() { return this; }, async first() { return { id: 23, hours: 8 }; }, async all() { return { results: [{ id: 23, hours: 8 }] }; } };
  } });
  for (const entity of ["employee", "employee-assignment", "user", "site", "position", "directory"]) {
    const event = await audit.prepareAuditEvent(new Request(`http://localhost/api/data?entity=${entity}&id=23`, { method: "DELETE" }));
    assert.ok(event); assert.equal(event.beforeData, null, entity);
  }
  for (const action of ["save-unit", "delete-unit", "assign-unit-project", "remove-unit-project", "import-units"]) {
    const event = await audit.prepareAuditEvent(new Request("http://localhost/api/equipment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, id: 23 }) }));
    assert.ok(event); assert.equal(event.beforeData, null, action);
  }
  assert.deepEqual(reads, [], "Unrelated report rows must never be fetched");
  const report = await audit.prepareAuditEvent(new Request("http://localhost/api/data?id=23", { method: "DELETE" }));
  assert.deepEqual(report.beforeData, [{ id: 23, hours: 8 }]);
  assert.match(reads.at(-1), /FROM placement_entries/);
  const equipment = await audit.prepareAuditEvent(new Request("http://localhost/api/equipment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save-entry", id: 23 }) }));
  assert.deepEqual(equipment.beforeData, { id: 23, hours: 8 });
  assert.match(reads.at(-1), /FROM equipment_entries/);
});
