import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { emptyPermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";
import { displayedUserProjectAccess, userProjectLabel } from "../app/userAccessModel.ts";
import { projectAccessHarness } from "./fixtures/project-access-boundary.mjs";

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const fileUrl = name => new URL(`../app/${name}.ts`, import.meta.url).href;
const boundaryUrl = dataUrl(`export let actor; export let database;
  export function configure(user, db) { actor=user; database=db; }
  export async function getAuthUser() { return actor; }
  export function getDatabase() { return database; }
  export function assertSameOrigin() {}
`);
const boundary = await import(boundaryUrl);
async function loadRoute(name) {
  let code = ts.transpileModule(await readFile(new URL(`../app/api/${name}/route.ts`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const replacements = {
    "../../../db/client": boundaryUrl,
    "../../auth": boundaryUrl,
    "../../auditLog": dataUrl("export async function ensureAuditSchema(){} export async function withAuditTrail(request,handler){return handler(request);}"),
    "../../compressJsonResponse": dataUrl("export async function compressJsonResponse(request,response){return response;}"),
    "../../equipmentImportServer": dataUrl("export async function importEquipmentEntries(){throw new Error('Read-only fixture');}"),
    ...Object.fromEntries(["roles", "permissionModel", "projectScopedData", "equipmentAvailability", "equipmentImport", "equipmentTimesheetUnits", "equipmentReportWorkflow"].map(module => [`../../${module}`, fileUrl(module)])),
  };
  for (const [specifier, target] of Object.entries(replacements)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return import(dataUrl(code));
}
process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const auditRoute = await loadRoute("audit-log");
const equipmentRoute = await loadRoute("equipment");
const actor = (permissions, overrides = {}) => ({ id: 5, fullName: "Наблюдатель", role: "viewer", assignedSiteId: null,
  projectAccess: { mode: "selected", siteIds: [7] }, canViewPendingReports: false, permissions, ...overrides });

function databaseFixture(events = []) {
  const queries = [];
  const db = {
    queries,
    prepare(sql) {
      assert.match(sql.trim(), /^SELECT\b/);
      let values = [];
      const rows = () => {
        queries.push({ sql, values });
        assert.equal((sql.match(/\?/g) ?? []).length, values.length, "Every SQL parameter must be bound");
        if (sql.includes("FROM audit_events")) {
          let index = 0;
          let result = events;
          if (sql.includes("site_id = ANY")) {
            const sites = values[index++]; result = result.filter(event => sites.includes(event.siteId));
          }
          if (sql.includes("id < ?")) {
            const before = values[index++]; result = result.filter(event => event.id < before);
          }
          if (sql.includes("NOT (category = 'reports'")) result = result.filter(event => event.category !== "reports"
            && !/^(personnel_report|equipment_report)\./.test(event.actionKey)
            && !["personnel_report", "personnel_report_draft", "equipment_report", "equipment_report_draft", "placement_entry", "equipment_entry"].includes(event.entityType)
            && !(event.entityType === "table_row_order" && ["personnel-report-rows", "equipment-report-rows"].includes(event.entityId)));
          return result.slice(0, values[index]);
        }
        if (sql.includes("SELECT id, name FROM sites WHERE id = ?")) return [{ id: values[0], name: "Проект" }];
        if (sql.includes("FROM equipment_units")) return [{ id: 12, note: "Примечание из реестра" }];
        if (sql.includes("FROM equipment_entries")) return [{ id: 81, note: "Строка отчёта", hours: 8 }];
        return [];
      };
      const statement = { bind(...bound) { values = bound; return statement; }, async all() { return { results: rows() }; }, async first() { return rows()[0] ?? null; } };
      return statement;
    },
    async readBatch(statements) { return Promise.all(statements.map(statement => statement.all())); },
  };
  return db;
}

test("audit access cannot bypass hidden pending reports, including historical and mixed snapshots", async () => {
  const permissions = rolePermissionTemplate("viewer"); permissions.audit_log.view = true;
  const events = [
    { id: 9, siteId: 7, category: "reports", actionKey: "personnel_report.save", entityType: "personnel_report_draft", afterData: { requested: { rows: [{ note: "Скрытый черновик" }] } } },
    { id: 8, siteId: 7, category: "reports", actionKey: "equipment_report.approve", entityType: "equipment_report_draft", beforeData: { status: "submitted", reviewComment: "Внутреннее обсуждение" }, afterData: { result: { report: { status: "approved" } } } },
    { id: 7, siteId: 7, category: "reports", actionKey: "personnel_report.save-approved-entry", entityType: "placement_entry", beforeData: { status: "approved" }, afterData: { requested: { reviewComment: "Старый черновик" } } },
    { id: 6, siteId: 7, category: "legacy", actionKey: "equipment_report.save", entityType: "equipment", afterData: { rows: [{ note: "Старое событие" }] } },
    { id: 5, siteId: 7, category: "directories", actionKey: "legacy.save", entityType: "personnel_report_draft", afterData: { rows: [{ note: "Смешанное старое событие" }] } },
    { id: 4, siteId: 7, category: "timesheets", actionKey: "equipment_timesheet.set", entityType: "equipment_timesheet", afterData: { hours: 8 } },
    { id: 3, siteId: 7, category: "directories", actionKey: "table.reorder", entityType: "table_row_order", entityId: "personnel-report-rows", afterData: { requested: { movingIds: ["2026-10-31/draft-скрытый-uuid"] } } },
    { id: 2, siteId: 7, category: "directories", actionKey: "directory.save", entityType: "directory" },
    { id: 1, siteId: 8, category: "directories", actionKey: "directory.save", entityType: "directory" },
  ];
  const db = databaseFixture(events); boundary.configure(actor(permissions), db);
  const response = await auditRoute.GET(new Request("http://localhost/api/audit-log?beforeId=10&limit=2"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.events.map(event => event.id), [4, 2]);
  assert.equal(payload.hasMore, true);
  assert.doesNotMatch(JSON.stringify(payload), /черновик|Внутреннее|Старое событие|Смешанное/);
  assert.deepEqual(db.queries[0].values, [[7], 10, 2]);

  for (const overrides of [{ canViewPendingReports: true }, { role: "engineer" }]) {
    boundary.configure(actor(permissions, overrides), databaseFixture(events));
    const allowed = await auditRoute.GET(new Request("http://localhost/api/audit-log"));
    assert.deepEqual((await allowed.json()).events.map(event => event.id), [9, 8, 7, 6, 5, 4, 3, 2]);
  }
});

const equipmentRequest = parameters => new Request(`http://localhost/api/equipment?siteId=7&date=2026-10-31&month=2026-10&${parameters}`);
test("equipment rejects forged combinations before any catalog or report query", async () => {
  const permissions = rolePermissionTemplate("superadmin");
  const db = databaseFixture(); boundary.configure(actor(permissions), db);
  for (const query of [
    "view=timesheet&section=daily&scope=global",
    "view=registry&section=registry&scope=export-range",
    "view=project&section=daily&scope=project",
    "view=timesheet&section=month&scope=global",
    "view=daily&section=registry&scope=global",
    "view=registry&section=daily&scope=carryover",
  ]) {
    assert.equal((await equipmentRoute.GET(equipmentRequest(query))).status, 400, query);
  }
  assert.equal(db.queries.length, 0);
});

test("equipment legitimate UI, carryover and Excel modes keep separate read permissions", async () => {
  const modes = [
    ["equipment_report", "view=daily&section=daily&scope=project"],
    ["equipment_report", "view=daily&section=daily&scope=export-range&rangeStart=2026-10-01&rangeEnd=2026-10-31"],
    ["equipment_report", "view=daily&section=daily&scope=carryover"],
    ["equipment_timesheet", "view=timesheet&section=month&scope=project"],
    ["equipment_registry", "view=registry&section=registry&scope=global"],
    ["project_equipment", "view=project&section=project&scope=assignments"],
  ];
  for (const [resource] of modes) {
    const permissions = emptyPermissionSet(); permissions[resource].view = true;
    for (const [required, query] of modes) {
      const db = databaseFixture(); boundary.configure(actor(permissions), db);
      const response = await equipmentRoute.GET(equipmentRequest(query));
      assert.equal(response.status, resource === required ? 200 : 403, `${resource}: ${query}`);
      if (resource !== required) assert.equal(db.queries.length, 0);
    }
  }
});

test("rights catalogs redact project metadata to the observer's intersection without changing stored grants", async () => {
  const h = await projectAccessHarness();
  const target = h.db.state.users.get(1); target.assignedSiteId = 8;
  await h.settings.saveUserProjectAccess(1, { projectAccess: { mode: "selected", siteIds: [7, 8] } }, 4, h.db);
  await h.settings.saveUserProjectAccess(2, { projectAccess: { mode: "selected", siteIds: [7] } }, 4, h.db);
  await h.asUser(2);
  let response = await h.route.GET(new Request("http://localhost/api/access-rights"));
  assert.equal(response.status, 200);
  let payload = await response.json();
  assert.equal(payload.canManage, false);
  assert.doesNotMatch(JSON.stringify(payload), /Южный/);
  const observed = payload.users.find(user => user.id === 1);
  assert.deepEqual(observed.projectAccess, { mode: "selected", siteIds: [7] });
  assert.equal(observed.assignedSiteId, null);
  assert.equal(observed.assignedSiteName, null);
  assert.equal(observed.projectAccessLimitedToViewer, true);
  const owner = payload.users.find(user => user.id === 4);
  assert.deepEqual(owner.projectAccess, { mode: "selected", siteIds: [7] });
  assert.deepEqual(displayedUserProjectAccess(owner), { mode: "selected", siteIds: [7] });
  assert.equal(userProjectLabel(owner.role, owner.assignedSiteId, payload.sites, owner.projectAccess, owner.projectAccessLimitedToViewer), "Северный");
  assert.deepEqual([...h.db.state.grants.get(1)], [7, 8]);

  await h.asUser(4);
  response = await h.route.GET(new Request("http://localhost/api/access-rights")); payload = await response.json();
  const complete = payload.users.find(user => user.id === 1);
  assert.deepEqual(complete.projectAccess, { mode: "selected", siteIds: [7, 8] });
  assert.equal(complete.assignedSiteId, 8);
  assert.equal(complete.assignedSiteName, "Южный");
  assert.equal(complete.projectAccessLimitedToViewer, false);
  assert.deepEqual(payload.users.find(user => user.id === 4).projectAccess, { mode: "all", siteIds: [] });
});
