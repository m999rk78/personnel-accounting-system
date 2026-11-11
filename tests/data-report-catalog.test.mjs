import assert from "node:assert/strict";
import test from "node:test";
import { emptyPermissionSet, normalizePermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = moduleUrl(`export let actor; export let database;
  export const syncs=[];
  export function configure(user,db){actor=user;database=db;syncs.length=0;}
  export const getAuthUser=async()=>actor; export const getDatabase=()=>database;
  export const env={get DB(){return database;}};
  export async function syncProjectMasters(db,siteId){if(db!==database)throw new Error('Unexpected database');syncs.push(siteId);}`);
const boundary = await import(boundaryUrl);
const { handleGET } = await import(await compileModuleGraph(new URL("../app/server/data/readWorkspace.ts", import.meta.url), {
  "../../auth": boundaryUrl,
  "../../../db/client": boundaryUrl,
  "./context": boundaryUrl,
  "../../projectMasters": boundaryUrl,
  "./bootstrap": moduleUrl("export async function ensureDatabaseInitialized(){}"),
}));

function actor(role = "engineer") {
  return { id: 17, role, assignedSiteId: 7, projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate(role) };
}

function fixture(user = actor()) {
  const prepared = [], executed = [], batches = [];
  const sites = [{ id: 7, name: "Доступный проект" }, { id: 8, name: "Другой проект" }];
  const employee = { id: 101, fullName: "Учебный сотрудник", employmentType: "ОПР", siteId: 7 };
  const database = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...parameters) { values = parameters; return this; },
        describe() { return { sql, values: structuredClone(values) }; },
        async all() {
          executed.push(statement.describe());
          let results = [];
          if (sql === "SELECT id, name, code, timezone FROM sites WHERE active = 1 ORDER BY id") results = sites;
          else if (sql.includes("FROM employees e") && sql.includes("epa.site_id = ?")) results = [employee];
          else if (/SELECT id, name.* FROM (shifts|zones|main_work_types|subwork_types|masters) WHERE/.test(sql)) results = [{ id: 1, name: "Учебное значение" }];
          return { results, success: true, meta: { changes: results.length, last_row_id: null } };
        },
      };
      prepared.push(statement);
      return statement;
    },
    async readBatch(statements) {
      batches.push(statements.map(statement => statement.describe()));
      return Promise.all(statements.map(statement => statement.all()));
    },
  };
  boundary.configure(user, database);
  return { prepared, executed, batches, employee };
}

const request = (scope = "report-catalog", siteId = 7) => new Request(`http://localhost/api/data?scope=${scope}&siteId=${siteId}&date=2026-11-05`);

test("report catalog loads only eight reference datasets and excludes foreign projects", async () => {
  const state = fixture();
  const response = await handleGET(request());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ["sites", "reportEmployees", "placementEmployees", "shifts", "zones", "mainWorkTypes", "subworkTypes", "masters"].sort());
  assert.deepEqual(result.sites.map(site => site.id), [7]);
  assert.deepEqual(result.reportEmployees, [state.employee]);
  assert.deepEqual(result.placementEmployees, [state.employee]);
  assert.deepEqual(boundary.syncs, [7]);
  assert.equal(state.executed.length, 8);
  assert.equal(state.batches.length, 1);
  assert.equal(state.batches[0].length, 8);
  assert.ok(state.executed.every(({ sql }) => !/placement_entries|placement_report_contributions|timesheet_marks|app_users/.test(sql)), "Reference loading must not fetch report rows, submissions, marks or users");
  assert.ok(state.executed.slice(1).every(({ values }) => values.includes(7)), "Every project catalog is scoped to the authorized project");
});

test("legacy workspace shares catalog queries and retains all its report fields", async () => {
  const state = fixture();
  const catalog = await (await handleGET(request())).json();
  const response = await handleGET(request("workspace"));
  assert.equal(response.status, 200);
  const legacy = await response.json();
  assert.equal(state.batches[1].length, 14);
  assert.deepEqual(state.batches[1].slice(0, 8), state.batches[0]);
  for (const field of Object.keys(catalog)) assert.deepEqual(legacy[field], catalog[field]);
  assert.deepEqual(legacy.employees, catalog.reportEmployees);
  assert.deepEqual(legacy.projectEmployees, catalog.placementEmployees);
  for (const field of ["entries", "filledDates", "employeeUsage", "foremanProgress", "timesheetMarks", "users"]) assert.deepEqual(legacy[field], []);
  assert.equal(legacy.reportSubmitted, false);
});

test("report catalog rejects anonymous, unauthorized and foreign-project readers before querying", async () => {
  const denied = actor(); denied.permissions.workers_report.view = false;
  for (const [user, siteId, expected] of [[null, 7, 401], [denied, 7, 403], [actor(), 8, 403]]) {
    const state = fixture(user);
    assert.equal((await handleGET(request("report-catalog", siteId))).status, expected);
    assert.equal(state.prepared.length, 0);
    assert.equal(state.executed.length, 0);
    assert.deepEqual(boundary.syncs, []);
  }
});

test("viewers can load authorized report references without synchronizing or writing masters", async () => {
  const state = fixture(actor("viewer"));
  const response = await handleGET(request());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sites.map(site => site.id), [7]);
  assert.equal(state.executed.length, 8);
  assert.deepEqual(boundary.syncs, []);
});

test("statistics-only navigation exposes authorized projects without reports or directory access", async () => {
  const user = actor("viewer");
  user.permissions = normalizePermissionSet({ ...emptyPermissionSet(), workers_statistics: { view: true }, equipment_statistics: { view: true } });
  const state = fixture(user);
  const response = await handleGET(request("navigation"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sites: [{ id: 7, name: "Доступный проект" }] });
  assert.equal(state.executed.length, 1);
  assert.equal(state.batches.length, 0);
  for (const scope of ["report-catalog", "workspace", "entries", "carryover", "export-range", "settings"]) {
    assert.equal((await handleGET(request(scope))).status, 403, scope);
  }
  assert.equal(state.executed.length, 1, "A statistics grant must not query reports or their reference datasets");
  assert.deepEqual(boundary.syncs, []);
});
