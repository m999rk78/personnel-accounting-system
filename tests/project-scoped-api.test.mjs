import assert from "node:assert/strict";
import test from "node:test";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { scopedDataActionAllowed, projectEntitiesAllowed } from "../app/projectScopedData.ts";
import { noCustomRolesUrl, noPermissionChangesUrl } from "./fixtures/custom-role-imports.mjs";

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = moduleUrl(`export let actor; export let database;
  export function configure(user, db){actor=user;database=db;}
  export const getDatabase=()=>database;
  export const getAuthUser=async()=>actor;
  export function assertSameOrigin(){}
  export async function ensureAuthSchema(){}
  export async function createInvitation(){return 'https://test.invalid/invitation';}
  export async function sendInvitationEmail(){return {sent:false};}
`);
const boundary = await import(boundaryUrl);
const noop = names => moduleUrl(names.map(name => `export function ${name}(){return Promise.resolve({});}`).join("\n"));
const audit = moduleUrl("export async function withAuditTrail(request,handler){return handler(request);}");
const compression = moduleUrl("export async function compressJsonResponse(request,response){return response;}");
const fileUrl = name => new URL(`../app/${name}.ts`, import.meta.url).href;
const replacements = {
  "../../customRolesServer": noCustomRolesUrl,
  "../../permissions": noPermissionChangesUrl,
  "../../projectAccessServer": moduleUrl("export let saves=[]; export const projectAccessByUser=new Map(); export async function loadUserProjectAccess(user){return {projectAccess:projectAccessByUser.get(user.id)??user.projectAccess??{mode:user.role==='engineer'||user.role==='superadmin'?'all':'selected',siteIds:user.assignedSiteId?[user.assignedSiteId]:[]},canViewPendingReports:user.role!=='viewer'};} export async function saveUserProjectAccess(userId,settings,actorId){saves.push({userId,settings,actorId});if(settings.projectAccess?.siteIds?.includes(99))throw new Error('Unknown project');return settings;}"),
  "../../../db/client": boundaryUrl, "../../auth": boundaryUrl, "../../auditLog": audit,
  "../../compressJsonResponse": compression, "../../roles": fileUrl("roles"), "../../permissionModel": fileUrl("permissionModel"),
  "../../projectScopedData": fileUrl("projectScopedData"), "../../readOptionalBatch": fileUrl("readOptionalBatch"),
  "../../settingsReadPolicy": fileUrl("settingsReadPolicy"), "../../bitrix24Cooldown": fileUrl("bitrix24Cooldown"),
  "../../bitrixReviewSelection": fileUrl("bitrixReviewSelection"),
  "../../projectMasters": noop(["ensureProjectMastersSchema", "syncProjectMasters"]),
  "../../workTypeHierarchyServer": noop(["saveSubworkDirectory"]),
  "../../excelDirectoryImports": noop(["importProjectDirectoryExcel", "importProjectEmployeesExcel", "normalizeExcelDirectoryName", "prepareEmployeeExcelImport"]),
  "../../personnelImportOrderServer": fileUrl("personnelImportOrderServer"),
  "../../personnelTimesheetReference.server": fileUrl("personnelTimesheetReference.server"),
  "../../bitrix24Sync": noop(["compareBitrixEmployees", "fetchBitrixEmployeeSnapshot", "normalizeBitrixText", "selectBitrixEmployeesForImport", "selectLinkedBitrixEmployeesForReview", "suggestBitrixEmployeeLinks", "suggestArchivedBitrixEmployeeLinks", "observeLegacyTerminalBitrixDuplicates", "isBitrixCentralOfficeEmployee", "bitrixOfficeTransferDirection"]),
  "../../equipmentAvailability": fileUrl("equipmentAvailability"),
  "../../equipmentImportServer": noop(["importEquipmentEntries"]),
  "../../equipmentImport": fileUrl("equipmentImport"),
  "../../equipmentTimesheetUnits": fileUrl("equipmentTimesheetUnits"),
  "../../equipmentReportWorkflow": fileUrl("equipmentReportWorkflow"),
};
async function loadRoute(path) {
  return import(await compileModuleGraph(new URL(path, import.meta.url), replacements));
}
process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const dataRoute = await loadRoute("../app/api/data/route.ts");
const equipmentRoute = await loadRoute("../app/api/equipment/route.ts");
const timesheetRoute = await loadRoute("../app/api/timesheet/route.ts");
const actor = (role, site = 1) => ({ id: 17, fullName: "Учебный пользователь", role, assignedSiteId: site, projectAccess: role === "engineer" || role === "foreman" ? { mode: "selected", siteIds: site ? [site] : [] } : { mode: "all", siteIds: [] },
  // Even maximally permissive custom settings may not cross project boundaries.
  permissions: rolePermissionTemplate("superadmin") });
const sites = [{ id: 1, name: "Свой проект", code: "ONE" }, { id: 2, name: "Чужой проект", code: "TWO" }];
function fakeDatabase(userRows) {
  const calls = [];
  const writes = [];
  const rows = (sql, values) => {
    calls.push({ sql, values });
    if (/SELECT entity.id FROM/.test(sql)) return (values[0] ?? []).filter(id => id === 10).map(id => ({ id }));
    if (/FROM employees e\s+LEFT JOIN employee_project_assignments/.test(sql)) return values.length ? [{ id: 10, siteId: 1, fullName: "Своя техника/сотрудник", projectCodes: "ONE" }] : [{ id: 10 }, { id: 80, siteId: 2 }];
    if (/FROM app_users(?: target)? WHERE active = 1/.test(sql)) return userRows ?? (values.length ? [{ id: 11, role: "foreman", assignedSiteId: 1 }] : [{ id: 11, role: "foreman", assignedSiteId: 1 }, { id: 81, role: "foreman", assignedSiteId: 2 }]);
    if (/FROM equipment_units eu WHERE eu.active = 1/.test(sql)) return values.length ? [{ id: 10, assignedSiteId: 1 }] : [{ id: 10 }, { id: 80, assignedSiteId: 2 }];
    if (/SELECT role, password_hash/.test(sql)) return [{ role: "foreman", passwordHash: "already-activated" }];
    if (/SELECT id FROM app_users WHERE email/.test(sql)) return [];
    if (/SELECT id FROM equipment_units WHERE id = \?/.test(sql)) return [{ id: values[0] }];
    if (/SELECT id FROM employees WHERE id = \?/.test(sql)) return [{ id: values[0] }];
    if (sql.startsWith("WITH assignment_roster AS") && sql.includes("AND employee_id = ?")) return [{
      id: values[2], assignments: [{ startDate: "2000-01-01", endDate: null, active: true }], reportDates: [], markDates: [], exits: [], profileDate: null,
    }];
    if (/SELECT eu.id FROM equipment_units eu WHERE eu.id = \?/.test(sql)) return [{ id: values[0] }];
    if (/FROM sites WHERE id = \?/.test(sql)) return sites.filter(site => site.id === values[0]);
    if (/SELECT id, name(?:, code, timezone)? FROM sites WHERE active = 1/.test(sql)) return sites;
    if (/FROM personnel_options|FROM position_catalog/.test(sql)) return [{ id: 1 }];
    if (/SELECT id FROM employees WHERE full_name/.test(sql)) return [];
    return [];
  };
  const database = {
    calls, writes,
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...bound) { values = bound; return statement; },
        async all() { return { results: rows(sql, values), success: true, meta: { changes: 0, last_row_id: null } }; },
        async first() { return rows(sql, values)[0] ?? null; },
        async run() { writes.push({ sql, values }); return { results: [], success: true, meta: { changes: 1, last_row_id: 500 } }; },
      };
      return statement;
    },
    async readBatch(statements) { return Promise.all(statements.map(statement => statement.all())); },
    async batch(statements) { return Promise.all(statements.map(statement => statement.all())); },
    async transaction(callback) { return callback(database); },
  };
  return database;
}
const request = (path, method = "GET", body) => new Request(`http://localhost${path}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
function configure(user = actor("engineer")) { const database = fakeDatabase(); boundary.configure(user, database); return database; }

test("scoped engineers cannot reach foreign reports, timesheets or equipment by changing the URL", async () => {
  const database = configure();
  for (const [route, path] of [[dataRoute, "/api/data?scope=workspace&siteId=2&date=2026-10-30"], [timesheetRoute, "/api/timesheet?siteId=2&month=2026-10"], [equipmentRoute, "/api/equipment?siteId=2&date=2026-10-30&month=2026-10&scope=global&section=registry&view=registry"]]) {
    assert.equal((await route.GET(request(path))).status, 403);
  }
  assert.equal(database.calls.length, 0);
  assert.equal(database.writes.length, 0);
  configure(actor("engineer", null));
  assert.deepEqual((await (await dataRoute.GET(request("/api/data?scope=navigation"))).json()).sites, []);
});

test("engineer navigation and catalogs expose only assigned project data; an unrestricted engineer retains all projects", async () => {
  configure();
  let response = await dataRoute.GET(request("/api/data?scope=navigation"));
  assert.deepEqual((await response.json()).sites.map(site => site.id), [1]);
  response = await dataRoute.GET(request("/api/data?scope=settings&section=employees&siteId=1"));
  const employees = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(employees.employees.map(row => row.id), [10]);
  assert.deepEqual(employees.sites.map(row => row.id), [1]);
  assert.equal(employees.syncStatus, null);
  response = await dataRoute.GET(request("/api/data?scope=settings&section=users&siteId=1"));
  assert.deepEqual((await response.json()).users.map(row => row.id), [11]);
  response = await equipmentRoute.GET(request("/api/equipment?siteId=1&date=2026-10-30&month=2026-10&scope=global&section=registry&view=registry"));
  const equipment = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(equipment.units.map(row => row.id), [10]);
  assert.deepEqual(equipment.sites.map(row => row.id), [1]);
  configure({ ...actor("engineer", null), projectAccess: { mode: "all", siteIds: [] } });
  response = await dataRoute.GET(request("/api/data?scope=navigation&siteId=2"));
  assert.deepEqual((await response.json()).sites.map(site => site.id), [1, 2]);
  assert.equal((await timesheetRoute.GET(request("/api/timesheet?siteId=2&month=2026-10"))).status, 200);
});

test("settings and legacy user catalogs expose only the viewer's intersecting grants", async t => {
  const users = [
    { id: 11, role: "foreman", assignedSiteId: 2, projectAccess: { mode: "selected", siteIds: [1, 2] } },
    { id: 12, role: "superadmin", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] } },
  ];
  const bridge = await import(replacements["../../projectAccessServer"]);
  for (const user of users) bridge.projectAccessByUser.set(user.id, user.projectAccess);
  t.after(() => bridge.projectAccessByUser.clear());
  for (const path of ["/api/data?scope=settings&section=users&siteId=1", "/api/data?siteId=1&date=2026-10-30"]) {
    boundary.configure(actor("engineer"), fakeDatabase(users));
    let response = await dataRoute.GET(request(path));
    assert.equal(response.status, 200);
    let payload = await response.json();
    assert.deepEqual(payload.users.map(user => user.projectAccess), [
      { mode: "selected", siteIds: [1] }, { mode: "selected", siteIds: [1] },
    ]);
    assert.equal(payload.users[0].assignedSiteId, null);
    assert.equal(payload.users.every(user => user.projectAccessLimitedToViewer), true);
    assert.deepEqual(users[0].projectAccess.siteIds, [1, 2]);
    boundary.configure({ ...actor("engineer"), projectAccess: { mode: "all", siteIds: [] } }, fakeDatabase(users));
    response = await dataRoute.GET(request(path)); payload = await response.json();
    assert.deepEqual(payload.users[0].projectAccess, { mode: "selected", siteIds: [1, 2] });
    assert.equal(payload.users[0].assignedSiteId, 2);
    assert.equal(payload.users[0].projectAccessLimitedToViewer, false);
    assert.deepEqual(payload.users[1].projectAccess, { mode: "all", siteIds: [] });
  }
});

test("foremen retain legacy assignment validation and engineers use explicit access instead of a fixed project", async () => {
  const database = configure(actor("superadmin", null));
  const user = { fullName: "Учебный инженер", email: "engineer@invalid.test", role: "foreman" };
  assert.equal((await dataRoute.POST(request("/api/data", "POST", { action: "create-user", ...user }))).status, 400);
  assert.equal((await dataRoute.POST(request("/api/data", "POST", { action: "create-user", ...user, assignedSiteId: 99 }))).status, 400);
  assert.equal(database.writes.length, 0);
  assert.equal((await dataRoute.POST(request("/api/data", "POST", { action: "create-user", ...user, role: "engineer" }))).status, 201);
  assert.deepEqual(database.writes.at(-1).values.slice(2), ["engineer", null, null]);
  assert.equal((await dataRoute.PATCH(request("/api/data", "PATCH", { action: "update-user", userId: 123, ...user, role: "engineer", assignedSiteId: null }))).status, 200);
  assert.deepEqual(database.writes.at(-1).values.slice(2), ["engineer", null, null, 123]);
  assert.equal((await dataRoute.POST(request("/api/data", "POST", { action: "create-user", ...user, role: "admin" }))).status, 400);
});

test("explicit global grants do not bypass project asset boundaries or whole-registry import scope", async () => {
  const database = configure();
  for (const payload of [
    { action: "sync-bitrix24" },
    { action: "import-employees", employees: [] }, { action: "reorder-employees", employeeIds: [10] },
    { action: "update-employee", employeeId: 80, projectSiteId: 1 },
    { action: "assign-employee-project", employeeId: 80, siteId: 1 },
    { action: "create-directory", entity: "zone", name: "Чужая зона", siteId: 2 },
    { action: "update-site", siteId: 2, name: "Чужой проект" },
  ]) {
    const response = await dataRoute[payload.action.startsWith("update") || payload.action === "assign-site" ? "PATCH" : "POST"](request("/api/data", "POST", payload));
    assert.equal(response.status, 403, JSON.stringify(payload));
  }
  for (const payload of [{ action: "delete-unit", id: 80 }, { action: "assign-unit-project", equipmentId: 80 }, { action: "import-units", units: [{}] }]) {
    assert.equal((await equipmentRoute.POST(request("/api/equipment", "POST", { siteId: 1, ...payload }))).status, 403);
  }
  assert.equal((await dataRoute.DELETE(request("/api/data?entity=employee&id=80", "DELETE"))).status, 403);
  assert.equal((await dataRoute.DELETE(request("/api/data?entity=employee-assignment&id=10&siteId=2", "DELETE"))).status, 403);
  assert.equal(database.writes.length, 0);
});

test("scoped engineer can create an employee in the assigned project and entity guards remain all-or-nothing", async () => {
  const database = configure();
  const response = await dataRoute.POST(request("/api/data", "POST", { action: "create-employee", fullName: "Свой новый сотрудник", employmentType: "ОПР", department: "УСР", position: "Монтажник", projectSiteId: 1 }));
  assert.equal(response.status, 201);
  assert.equal(database.writes[0].values[4], 1);
  assert.deepEqual(database.writes[1].values, [500, 1]);
  assert.equal(await projectEntitiesAllowed(database, actor("engineer"), "employee", [10, 80]), false);
  assert.equal(await projectEntitiesAllowed(database, { ...actor("engineer", null), projectAccess: { mode: "all", siteIds: [] } }, "equipment", [80]), true);
  assert.equal(scopedDataActionAllowed(actor("engineer"), { action: "create-employee", projectSiteId: 2 }), false);
});

test("project selection supports several projects and an explicit empty selection revokes access", async () => {
  const engineer = { ...actor("engineer", null), projectAccess: { mode: "selected", siteIds: [1, 2] } };
  configure(engineer);
  const navigation = await dataRoute.GET(request("/api/data?scope=navigation"));
  assert.deepEqual((await navigation.json()).sites.map(site => site.id), [1, 2]);
  assert.equal((await timesheetRoute.GET(request("/api/timesheet?siteId=2&month=2026-10"))).status, 200);
  assert.equal((await equipmentRoute.GET(request("/api/equipment?siteId=2&date=2026-10-30&month=2026-10&scope=global&section=registry&view=registry"))).status, 200);
  configure({ ...engineer, projectAccess: { mode: "selected", siteIds: [] } });
  assert.deepEqual((await (await dataRoute.GET(request("/api/data?scope=navigation"))).json()).sites, []);
  assert.equal((await timesheetRoute.GET(request("/api/timesheet?siteId=1&month=2026-10"))).status, 403);
});

test("default viewer permissions remain read-only until the matching actions are explicitly granted", async () => {
  const database = configure({ ...actor("viewer", null), permissions: rolePermissionTemplate("viewer"), projectAccess: { mode: "selected", siteIds: [1, 2] } });
  for (const [method, body] of [["POST", { action: "create-employee", projectSiteId: 1 }], ["PATCH", { action: "update-employee", employeeId: 10, projectSiteId: 1 }], ["DELETE", { ids: [10] }]]) {
    assert.equal((await dataRoute[method](request("/api/data?entity=employee", method, body))).status, 403);
  }
  for (const action of ["save-unit", "assign-unit-project", "save-timesheet-mark", "clear-timesheet-mark", "delete-unit", "import-units"]) {
    assert.equal((await equipmentRoute.POST(request("/api/equipment", "POST", { action, siteId: 1, equipmentId: 10 }))).status, 403);
  }
  assert.equal((await timesheetRoute.POST(request("/api/timesheet", "POST", { siteId: 1, employeeId: 10, workDate: "2026-10-30", value: 8 }))).status, 403);
  assert.equal(database.calls.length, 0);
  assert.equal(database.writes.length, 0);
  const equipment = await (await equipmentRoute.GET(request("/api/equipment?siteId=1&date=2026-10-30&month=2026-10&scope=project&section=daily&view=daily"))).json();
  for (const [key, value] of Object.entries(equipment)) if (/^can(Create|Update|Delete|Edit|Manage)/.test(key)) assert.equal(value, false, key);
  assert.deepEqual(equipment.foremanProgress, []);
  const timesheet = await (await timesheetRoute.GET(request("/api/timesheet?siteId=1&month=2026-10"))).json();
  assert.equal(timesheet.canEdit, false);
  assert.equal(timesheet.canCreate, false);
  assert.equal(timesheet.canUpdate, false);
  assert.equal(timesheet.canDelete, false);
});

for (const role of ["foreman", "viewer"]) test(`${role} can use granted global settings and both timesheets without changing role name`, async () => {
  const user = { ...actor(role, 1), projectAccess: { mode: "selected", siteIds: [1] } };
  const db = configure(user);
  let response = await dataRoute.POST(request("/api/data", "POST", { action: "create-user", role: "engineer", fullName: "Новый сотрудник", email: `${role}@invalid.test` }));
  assert.equal(response.status, 201, await response.text());
  assert.ok(db.writes.some(write => write.sql.includes("INSERT INTO app_users")));
  response = await dataRoute.PATCH(request("/api/data", "PATCH", { action: "update-site", siteId: 1, name: "Новый проект" }));
  assert.equal(response.status, 200, await response.text());
  response = await timesheetRoute.POST(request("/api/timesheet", "POST", { siteId: 1, employeeId: 10, workDate: "2026-10-30", value: 8 }));
  assert.equal(response.status, 200, await response.text());
  assert.ok(db.writes.some(write => write.sql.includes("INSERT INTO timesheet_marks")));
  response = await equipmentRoute.POST(request("/api/equipment", "POST", { action: "save-timesheet-mark", siteId: 1, equipmentId: 10, workDate: "2026-10-30", productiveHours: 8, downtimeHours: 0 }));
  assert.equal(response.status, 200, await response.text());
  assert.ok(db.writes.some(write => write.sql.includes("INSERT INTO equipment_timesheet_marks")));
  assert.equal((await timesheetRoute.POST(request("/api/timesheet", "POST", { siteId: 2, employeeId: 10, workDate: "2026-10-30", value: 8 }))).status, 403, "An explicit grant never expands project scope");
});

test("resource-level denies still reject global manager actions before database mutation", async () => {
  const user = actor("engineer"); user.permissions = rolePermissionTemplate("engineer");
  const db = configure(user);
  for (const [method, body] of [["POST", { action: "create-user" }], ["PATCH", { action: "update-user" }], ["PATCH", { action: "create-position" }]]) {
    assert.equal((await dataRoute[method](request("/api/data", method, body))).status, 403);
  }
  assert.equal(db.writes.length, 0);
});

test("viewer project access is saved with the user and changing into viewer defaults to no grants", async () => {
  const database = configure(actor("superadmin", null));
  const bridge = await import(replacements["../../projectAccessServer"]);
  bridge.saves.length = 0;
  const settings = { projectAccess: { mode: "selected", siteIds: [1, 2] }, canViewPendingReports: true };
  assert.equal((await dataRoute.POST(request("/api/data", "POST", { action: "create-user", role: "viewer", fullName: "Наблюдатель", email: "viewer@invalid.test", ...settings }))).status, 201);
  assert.deepEqual(bridge.saves.at(-1), { userId: 500, settings, actorId: 17 });
  assert.equal(database.writes.at(-1).values[2], "viewer");
  assert.equal((await dataRoute.PATCH(request("/api/data", "PATCH", { action: "update-user", userId: 123, role: "viewer", fullName: "Наблюдатель", email: "viewer@invalid.test" }))).status, 200);
  assert.deepEqual(bridge.saves.at(-1).settings, { projectAccess: { mode: "selected", siteIds: [] }, canViewPendingReports: false });
});

test("an engineer without explicit grants has the original all-project working role", async () => {
  const engineer = { ...actor("engineer", null) };
  delete engineer.projectAccess;
  configure(engineer);
  assert.deepEqual((await (await dataRoute.GET(request("/api/data?scope=navigation&siteId=2"))).json()).sites.map(site => site.id), [1, 2]);
  assert.equal((await timesheetRoute.GET(request("/api/timesheet?siteId=2&month=2026-10"))).status, 200);
});
