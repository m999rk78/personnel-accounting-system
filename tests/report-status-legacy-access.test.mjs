import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as permissions from "../app/permissionModel.ts";
import * as roles from "../app/roles.ts";
import { workspaceTableAccess, workspaceViewAllowed } from "../app/workspaceAccess.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const access = await import(await compileModuleGraph(new URL("../app/server/data/access.ts", import.meta.url), {
  "./catalogs": moduleUrl("export function directoryTable(){return null;}"),
}));
const actor = () => ({ id: 17, role: "engineer", fullName: "Инженер", projectAccess: { mode: "selected", siteIds: [7] }, permissions: permissions.rolePermissionTemplate("engineer") });
function disableStatus(user, resource, status) { user.permissions[`${resource}_${status}`] = { view: false, create: false, update: false, delete: false }; }
async function functions(path, names, env) {
  const source = ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const code = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(source).replace(/^export\s+/, "")).join("\n");
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), `${js}; return {${names.join(",")}};`)(...Object.values(env));
}
function database() {
  const reads = [], writes = [];
  const prepare = sql => {
    const statement = { bind() { return statement; }, async all() { reads.push(sql); return { results: [{ id: 900, workDate: "2026-11-09", hours: 8, submitted: true, name: "Учебный проект" }] }; }, async first() { return (await statement.all()).results[0]; }, async run() { writes.push(sql); throw new Error("Unexpected write"); } };
    return statement;
  };
  return { reads, writes, prepare, async readBatch(statements) { return Promise.all(statements.map(statement => statement.all())); } };
}

test("draft editing rights cannot authorize approved placement CRUD through the legacy API", () => {
  const user = actor(); disableStatus(user, "workers_report", "approved");
  for (const action of ["view", "create", "update", "delete"]) assert.equal(access.canManagePlacement(user, 7, "2026-11-09", action), false);
  assert.equal(access.canDeleteEntity(user, null, null), false);
  assert.equal(workspaceViewAllowed(user.permissions, "placement"), true, "Own drafts remain accessible");
  assert.equal(workspaceTableAccess(user.permissions, "placement").update, true);
  user.permissions.workers_report_approved.view = true;
  user.permissions.workers_report_approved.update = true;
  assert.equal(access.canManagePlacement(user, 7, "2026-11-09", "update"), true);
  assert.equal(access.canManagePlacement(user, 8, "2026-11-09", "update"), false);
  assert.equal(access.canManagePlacement(user, 7, "2026-11-09", "delete"), false);
});

test("hiding all report statuses hides their pages and table actions while preserving timesheets", () => {
  const user = actor();
  for (const resource of ["workers_report", "equipment_report"]) for (const status of ["draft", "submitted", "approved"]) disableStatus(user, resource, status);
  for (const view of ["placement", "equipment"]) {
    assert.equal(workspaceViewAllowed(user.permissions, view), false);
    assert.equal(workspaceTableAccess(user.permissions, view).edit, false);
    assert.equal(workspaceTableAccess(user.permissions, view).select, false);
  }
  assert.equal(workspaceViewAllowed(user.permissions, "timesheet"), true);
  assert.equal(workspaceViewAllowed(user.permissions, "equipmentTimesheet"), true);
});

test("legacy personnel reads and exports cannot disclose hidden approved rows or submission progress", async () => {
  const user = actor(), db = database(); disableStatus(user, "workers_report", "approved"); disableStatus(user, "workers_report", "submitted");
  const { handleGET } = await functions("../app/server/data/readWorkspace.ts", ["handleGET"], {
    ...roles, ...permissions, getAuthUser: async () => user, ensureDatabaseInitialized: async () => {}, asPositiveInteger: value => Number(value) || null,
    todayInMoscow: () => "2026-11-09", validDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value), unauthorized: () => Response.json({}, { status: 401 }), forbidden: () => Response.json({}, { status: 403 }), env: { DB: db },
    syncProjectMasters: async () => {}, reportCatalogStatements: () => Array.from({ length: 8 }, () => db.prepare("catalog")),
    ...Object.fromEntries(["placementEntriesStatement", "filledDatesStatement", "reportSubmissionStatement", "employeeUsageStatement", "foremanProgressStatement", "reportTimesheetMarksStatement"].map(name => [name, () => db.prepare(name)])),
  });
  for (const scope of ["entries", "workspace"]) {
    const response = await handleGET(new Request(`http://localhost/api/data?siteId=7&scope=${scope}&date=2026-11-09`));
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const key of ["entries", "filledDates", "employeeUsage", "foremanProgress"]) assert.deepEqual(body[key], [], key);
    assert.equal(body.reportSubmitted, false);
  }
  const count = db.reads.length;
  assert.equal((await handleGET(new Request("http://localhost/api/data?siteId=7&scope=export-range&date=2026-11-09"))).status, 403);
  assert.deepEqual(await (await handleGET(new Request("http://localhost/api/data?siteId=7&scope=carryover&date=2026-11-09"))).json(), { sourceDate: null, entries: [] });
  assert.equal(db.reads.length, count, "Hidden export/carryover do not fetch published rows");
  assert.deepEqual(db.writes, []);
});

test("equipment daily reads hide approved rows while the separately authorized month still aggregates them", async () => {
  const user = actor(), db = database(); disableStatus(user, "equipment_report", "approved"); disableStatus(user, "equipment_report", "submitted");
  const { handleGET } = await functions("../app/api/equipment/route.ts", ["handleGET", "positiveInteger", "validDate", "validMonth", "nextMonthStart", "errorResponse", "equipmentAccessPayload"], {
    ...roles, ...permissions, getAuthUser: async () => user, getDatabase: () => db, ensureEquipmentSchema: async () => {}, resolveSite: async () => ({ siteId: 7, site: { name: "Учебный проект" } }),
    equipmentForemanProgressStatement: () => db.prepare("progress"), equipmentTimesheetUnitsStatement: () => db.prepare("month units"),
  });
  const query = "siteId=7&date=2026-11-09&month=2026-11&scope=project";
  let response = await handleGET(new Request(`http://localhost/api/equipment?${query}&section=daily&view=daily`));
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.deepEqual(body.entries, []); assert.deepEqual(body.filledDates, []); assert.deepEqual(body.foremanProgress, []); assert.equal(body.reportSubmitted, false);
  const count = db.reads.length;
  response = await handleGET(new Request("http://localhost/api/equipment?siteId=7&date=2026-11-09&month=2026-11&scope=export-range&section=daily&view=daily"));
  assert.equal(response.status, 403); assert.equal(db.reads.length, count);
  response = await handleGET(new Request(`http://localhost/api/equipment?${query}&section=month&view=timesheet`));
  assert.equal(response.status, 200); body = await response.json();
  assert.equal(body.entries[0].hours, 8, "Timesheet grant remains an independent accounting view");
  assert.deepEqual(db.writes, []);
});

test("personal report row-order APIs filter hidden statuses before reconciling saved IDs", async () => {
  const { canonicalRowIds, rowOrderAccess } = await import(await compileModuleGraph(new URL("../app/tableRowOrderServer.ts", import.meta.url), {
    "../db/client": moduleUrl("export function getDatabase(){throw new Error('Injected database required');}"),
  }));
  for (const [scope, resource] of [["personnel-report-rows", "workers_report"], ["equipment-report-rows", "equipment_report"]]) {
    const user = actor(), queries = []; disableStatus(user, resource, "approved"); disableStatus(user, resource, "submitted");
    const executor = { prepare: sql => ({ bind: (...values) => ({ async all() { queries.push({ sql, values }); return { results: [] }; } }) }) };
    assert.deepEqual(await canonicalRowIds(scope, 7, executor, user), []);
    const sql = queries[0].sql;
    assert.match(sql, /report\.status IN \('draft', 'rejected'\) AND TRUE/);
    assert.match(sql, /report\.status = 'submitted' AND FALSE/);
    assert.match(sql, /entry\.deleted_at IS NULL AND FALSE/);
    assert.equal(rowOrderAccess(user, scope, 7).canRead, true);
    assert.equal(rowOrderAccess(user, scope, 7).canWrite, true);
    disableStatus(user, resource, "draft");
    assert.equal(rowOrderAccess(user, scope, 7).canRead, false);
    assert.equal(rowOrderAccess(user, scope, 7).canWrite, false);
  }
});
