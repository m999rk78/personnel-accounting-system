import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

async function moduleSource(path, replacements) {
  let source = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(replacements)) source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

function database(seed, queries) {
  const executor = {
    prepare(sql) {
      assert.match(sql.trim(), /^SELECT\b/);
      const statement = {
        values: [], bind(...values) { this.values = values; return this; },
        async first() { queries.push({ sql, values: this.values }); return sql.includes("FROM sites") ? { id: this.values[0] } : sql.includes("JOIN app_users owner") ? seed[0] : { id: this.values[0] }; },
        async all() { queries.push({ sql, values: this.values }); return { results: sql.includes("JOIN app_users owner") ? seed : [] }; },
      };
      return statement;
    },
    async batch() { throw new Error("Unauthorised report request attempted a write"); },
    async readBatch(statements) { return Promise.all(statements.map(statement => statement.all())); },
    async transaction(callback) { return callback(executor); },
  };
  return executor;
}

for (const domain of ["personnel", "equipment"]) {
  const title = domain[0].toUpperCase() + domain.slice(1);
  const storePromise = compileModuleGraph(`app/${domain}ReportStore.ts`).then(url => import(url));
  const engineer = { id: 10, role: "engineer", assignedSiteId: 1, projectAccess: { mode: "selected", siteIds: [1] }, permissions: rolePermissionTemplate("superadmin") };
  const header = siteId => ({ id: 12, siteId, workDate: "2026-10-30", ownerUserId: 30, ownerName: "Другой прораб", revision: 2, status: "submitted", rows: [] });
  const forbidden = error => error.status === 403 && error.code === "REPORT_FORBIDDEN";

  test(`${domain} reads, preflight, save and legacy corrections reject foreign projects before database access`, async () => {
    const store = await storePromise;
    const queries = [];
    const db = database([], queries);
    const attempts = user => [
      () => store[`list${title}Reports`](db, user, 2, null, null),
      () => store[`validate${title}ReportSubmissions`](db, user, { action: "validate-submissions", siteId: 2, reports: [{ key: "new:2026-10-30", workDate: "2026-10-30", rows: [] }] }),
      () => store[`mutate${title}Report`](db, user, { action: "save", siteId: 2, workDate: "2026-10-30", rows: [] }),
      () => store[`mutate${title}ReportEntry`](db, user, { action: "save-approved-entry", entryId: 8, revision: 1, siteId: 2, workDate: "2026-10-30", row: {} }),
    ];
    for (const actor of [engineer, { ...engineer, projectAccess: { mode: "selected", siteIds: [] } }]) for (const attempt of attempts(actor)) await assert.rejects(attempt(), forbidden);
    assert.equal(queries.length, 0);
  });

  test(`${domain} transitions verify the stored report project before any mutation`, async () => {
    const store = await storePromise;
    for (const action of ["submit", "approve", "reject", "reopen"]) {
      const queries = [];
      const db = database([header(2)], queries);
      await assert.rejects(store[`mutate${title}Report`](db, engineer, { action, reportId: 12, revision: 2, comment: "Причина" }), forbidden);
      assert.ok(queries.length > 0);
      assert.ok(queries.every(query => /^SELECT\b/.test(query.sql.trim())));
    }
  });

  test(`${domain} engineers see other foremen in their project and all-project engineers can read any project`, async () => {
    const store = await storePromise;
    for (const [actor, siteId] of [[engineer, 1], [{ ...engineer, assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] } }, 2]]) {
      const queries = [];
      const db = database([header(siteId), { ...header(siteId), id: 13, ownerUserId: 31 }], queries);
      const result = await store[`list${title}Reports`](db, actor, siteId, null, null);
      assert.deepEqual(result.reports.map(report => report.ownerUserId), [30, 31]);
      assert.equal(result.canReview, true);
      const reportQuery = queries.find(query => query.sql.includes("JOIN app_users owner"));
      assert.deepEqual(reportQuery.values, [siteId, actor.id, ["draft", "rejected", "submitted", "approved"]]);
      assert.match(reportQuery.sql, /report\.status IN \('approved', 'submitted'\) OR report\.owner_user_id = \?/);
    }
  });

  test(`${domain} private drafts and returned reports remain visible only to their author`, async () => {
    const store = await storePromise;
    const seed = [
      { ...header(1), id: 21, status: "draft" },
      { ...header(1), id: 22, status: "rejected" },
      { ...header(1), id: 23, status: "submitted" },
      { ...header(1), id: 24, status: "approved" },
      { ...header(1), id: 25, status: "draft", ownerUserId: engineer.id },
      { ...header(1), id: 26, status: "rejected", ownerUserId: engineer.id },
    ];
    const queries = [];
    // Return every header to exercise the defensive visibility filter, not just SQL.
    const result = await store[`list${title}Reports`](database(seed, queries), engineer, 1, null, null);
    assert.deepEqual(result.reports.map(report => report.id), [23, 24, 25, 26]);
    const reportQuery = queries.find(query => query.sql.includes("JOIN app_users owner"));
    assert.deepEqual(reportQuery.values, [1, engineer.id, ["draft", "rejected", "submitted", "approved"]]);
    assert.match(reportQuery.sql, /report\.status IN \('approved', 'submitted'\) OR report\.owner_user_id = \?/);
    assert.ok(queries.every(query => /^SELECT\b/.test(query.sql.trim())));
  });
}

test("work type mutations enforce the engineer's project before invoking directory helpers", async () => {
  const authUrl = `data:text/javascript,${encodeURIComponent("export let actor; export function setActor(value){actor=value;} export async function getAuthUser(){return actor;} export function assertSameOrigin(){}")}`;
  const auth = await import(authUrl);
  const helpersUrl = `data:text/javascript,${encodeURIComponent("export let calls=0; export async function saveWorkTypesDirectory(){calls++;return {saved:1};} export async function archiveWorkTypesDirectory(){calls++;return {archived:1};} export async function assignWorkTypeChildren(){calls++;return 1;} export async function importWorkTypeDirectory(){calls++;return 1;}")}`;
  const helpers = await import(helpersUrl);
  const routeUrl = await moduleSource("../app/api/work-types/route.ts", {
    "../../../db/client": `data:text/javascript,${encodeURIComponent("export function getDatabase(){return {};}")}`,
    "../../auth": authUrl,
    "../../permissionModel": new URL("../app/permissionModel.ts", import.meta.url).href,
    "../../roles": new URL("../app/roles.ts", import.meta.url).href,
    "../../auditLog": `data:text/javascript,${encodeURIComponent("export async function withAuditTrail(request,handler){return handler(request);}")}`,
    "../../workTypeHierarchyServer": helpersUrl,
    "../../workTypesEditingServer": helpersUrl,
  });
  const { POST } = await import(routeUrl);
  const request = body => new Request("http://localhost/api/work-types", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  auth.setActor({ id: 10, role: "engineer", assignedSiteId: 1, projectAccess: { mode: "selected", siteIds: [1] }, permissions: rolePermissionTemplate("superadmin") });
  for (const action of ["save", "archive", "assign", undefined]) assert.equal((await POST(request({ siteId: 2, action, parents: [], children: [], ids: [1], mainWorkTypeId: 1, entries: [] }))).status, 403);
  assert.equal(helpers.calls, 0);
  assert.equal((await POST(request({ siteId: 1, action: "save", parents: [], children: [] }))).status, 200);
  auth.setActor({ id: 11, role: "engineer", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("engineer") });
  assert.equal((await POST(request({ siteId: 2, action: "save", parents: [], children: [] }))).status, 200);
  assert.equal(helpers.calls, 2);
  auth.setActor({ id: 12, role: "viewer", assignedSiteId: null, projectAccess: { mode: "selected", siteIds: [1, 2] }, permissions: rolePermissionTemplate("superadmin") });
  for (const action of ["save", "archive", "assign", undefined]) assert.equal((await POST(request({ siteId: 1, action, parents: [], children: [], ids: [1], mainWorkTypeId: 1, entries: [] }))).status, 200);
  assert.equal(helpers.calls, 6, "Explicit grants authorize directory actions irrespective of role name");
  auth.setActor({ id: 12, role: "viewer", assignedSiteId: null, projectAccess: { mode: "selected", siteIds: [1, 2] }, permissions: rolePermissionTemplate("viewer") });
  assert.equal((await POST(request({ siteId: 1, action: "save", parents: [], children: [] }))).status, 403);
  assert.equal(helpers.calls, 6, "Read-only defaults never invoke mutating helpers");
});

test("table-order read, move and draft-remap endpoints deny foreign project access before database work", async () => {
  const actor = { id: 10, role: "engineer", assignedSiteId: 1, projectAccess: { mode: "selected", siteIds: [1] }, permissions: rolePermissionTemplate("superadmin") };
  const authUrl = `data:text/javascript,${encodeURIComponent(`export async function getAuthUser(){return ${JSON.stringify(actor)};} export function assertSameOrigin(){}`)}`;
  const databaseUrl = `data:text/javascript,${encodeURIComponent("export function getDatabase(){throw new Error('Unauthorised request touched the database');}")}`;
  const serverUrl = await moduleSource("../app/tableRowOrderServer.ts", {
    "../db/client": databaseUrl,
    "./permissionModel": new URL("../app/permissionModel.ts", import.meta.url).href,
    "./roles.ts": new URL("../app/roles.ts", import.meta.url).href,
    "./tableRowOrder": new URL("../app/tableRowOrder.ts", import.meta.url).href,
    "./personnelReportRowOrder": new URL("../app/personnelReportRowOrder.ts", import.meta.url).href,
    "./equipmentReportRowOrder": new URL("../app/equipmentReportRowOrder.ts", import.meta.url).href,
    "./workTypesRowOrder": new URL("../app/workTypesRowOrder.ts", import.meta.url).href,
  });
  const routeUrl = await moduleSource("../app/api/table-order/route.ts", {
    "../../../db/client": databaseUrl,
    "../../auth": authUrl,
    "../../permissionModel": new URL("../app/permissionModel.ts", import.meta.url).href,
    "../../roles": new URL("../app/roles.ts", import.meta.url).href,
    "../../auditLog": `data:text/javascript,${encodeURIComponent("export async function withAuditTrail(request,handler){return handler(request);}")}`,
    "../../tableRowOrderServer": serverUrl,
    "../../personnelImportOrderServer": new URL("../app/personnelImportOrderServer.ts", import.meta.url).href,
    "../../tableRowOrder": new URL("../app/tableRowOrder.ts", import.meta.url).href,
    "../../personnelReportRowOrder": new URL("../app/personnelReportRowOrder.ts", import.meta.url).href,
    "../../equipmentReportRowOrder": new URL("../app/equipmentReportRowOrder.ts", import.meta.url).href,
    "../../workTypesRowOrder": new URL("../app/workTypesRowOrder.ts", import.meta.url).href,
    "../../equipmentReportStore": `data:text/javascript,${encodeURIComponent("export async function ensureEquipmentReportSchema(){throw new Error('Unauthorised request touched equipment schema');}")}`,
  });
  const { GET, POST } = await import(routeUrl);
  for (const scope of ["personnel-report-rows", "equipment-report-rows", "directory-work-types", "project-personnel", "project-equipment", "employees", "equipment", "users", "projects"]) {
    assert.equal((await GET(new Request(`http://localhost/api/table-order?scope=${scope}&siteId=2`))).status, 403);
    for (const action of [undefined, "remap"]) {
      const response = await POST(new Request("http://localhost/api/table-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, siteId: 2, action, movingIds: [1], placement: "start", aliases: {} }) }));
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /Нет доступа к проекту/);
    }
  }
});
