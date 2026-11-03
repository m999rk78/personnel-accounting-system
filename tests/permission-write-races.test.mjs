import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = moduleUrl(`export let database, actor; export function configure(db,user){database=db;actor=user;}
  export const getDatabase=()=>database; export const getAuthUser=async()=>actor; export function assertSameOrigin(){}
  export async function withAuditTrail(request,handler){return handler(request);}
  export async function compressJsonResponse(request,response){return response;}
  export async function importEquipmentEntries(){throw new Error('Unexpected report import');}`);
const boundary = await import(boundaryUrl);
async function loadRoute(name) {
  let code = ts.transpileModule(await readFile(new URL(`../app/api/${name}/route.ts`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const path of ["../../../db/client", "../../auth", "../../auditLog", "../../compressJsonResponse", "../../equipmentImportServer"]) code = code.replaceAll(JSON.stringify(path), JSON.stringify(boundaryUrl));
  for (const name of ["roles", "permissionModel", "projectScopedData", "equipmentAvailability", "equipmentImport", "equipmentTimesheetUnits", "equipmentReportWorkflow", "personnelTimesheetReference.server"]) code = code.replaceAll(JSON.stringify(`../../${name}`), JSON.stringify(new URL(`../app/${name}.ts`, import.meta.url).href));
  return import(moduleUrl(code));
}
process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const personnel = await loadRoute("timesheet"), equipment = await loadRoute("equipment");
const request = (path, body) => new Request(`http://localhost/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const user = (resource, actions) => {
  const permissions = rolePermissionTemplate("engineer");
  for (const row of Object.values(permissions)) for (const action of ["create", "update", "delete"]) row[action] = false;
  for (const action of actions) permissions[resource][action] = true;
  return { id: 1, fullName: "Тестовый пользователь", role: "engineer", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, permissions };
};

/** Inject a concurrent committed change at the actual transaction/lock boundary. */
function fixture(actor) {
  const state = { marks: new Map(), unit: null, queries: [], writes: [], onLock: null, beforeTransaction: null };
  let sequence = 0;
  function executor(transaction) {
    return { prepare(sql) {
      sql = sql.trim(); let values = [];
      async function select() {
        state.queries.push({ sql, values, transaction });
        if (sql.includes("pg_advisory_xact_lock")) { const hook = state.onLock; state.onLock = null; hook?.(); return []; }
        if (/FROM sites WHERE id = \?/.test(sql)) return [{ id: 7, name: "Тестовый проект" }];
        if (/^SELECT e.id FROM employees e WHERE/.test(sql) || /^SELECT eu.id FROM equipment_units eu WHERE/.test(sql)) return [{ id: 11 }];
        if (/^SELECT id FROM (?:equipment_)?timesheet_marks/.test(sql)) return state.marks.has(values.join(":")) ? [{ id: 1 }] : [];
        if (/^SELECT id FROM equipment_units WHERE/.test(sql)) return state.unit ? [{ id: state.unit.id }] : [];
        if (/^SELECT site_id AS "siteId" FROM equipment_project_assignments/.test(sql)) return state.unit?.siteId ? [{ siteId: state.unit.siteId }] : [];
        throw new Error(`Unexpected SELECT: ${sql.slice(0, 100)}`);
      }
      const statement = {
        bind(...next) { values = next; return statement; },
        async first() { return (await select())[0] ?? null; },
        async all() { return { results: await select() }; },
        async run() {
          state.writes.push({ sql, values, transaction });
          if (/^INSERT INTO (?:equipment_)?timesheet_marks/.test(sql)) state.marks.set(values.slice(0, 3).join(":"), values.slice(3));
          else if (/^DELETE FROM (?:equipment_)?timesheet_marks/.test(sql)) state.marks.delete(values.join(":"));
          else if (sql.startsWith("INSERT INTO equipment_units")) state.unit = { id: 11, siteId: values[0], note: values.at(-1) };
          else if (sql.startsWith("UPDATE equipment_units")) state.unit.note = "Profile overwritten";
          else if (!sql.includes("equipment_project_assignments")) throw new Error(`Unexpected mutation: ${sql.slice(0, 100)}`);
          return { results: [], success: true, meta: { changes: 1, last_row_id: 11 } };
        },
      };
      return statement;
    } };
  }
  const db = { ...executor(null), async transaction(callback) {
    const hook = state.beforeTransaction; state.beforeTransaction = null; hook?.();
    return callback(executor(++sequence));
  } };
  boundary.configure(db, actor);
  return state;
}

for (const [title, handler, path, resource, payload] of [
  ["personnel", personnel, "timesheet", "workers_timesheet", { siteId: 7, employeeId: 11, workDate: "2026-10-30", value: 8 }],
  ["equipment", equipment, "equipment", "equipment_timesheet", { action: "save-timesheet-mark", siteId: 7, equipmentId: 11, workDate: "2026-10-30", productiveHours: 8, downtimeHours: 0 }],
]) {
  const key = "7:11:2026-10-30";
  test(`${title}: create-only user cannot overwrite a mark committed while waiting for its lock`, async () => {
    const state = fixture(user(resource, ["create"]));
    state.onLock = () => state.marks.set(key, [4, "Existing concurrent mark"]);
    const response = await handler.POST(request(path, payload));
    assert.equal(response.status, 403);
    assert.deepEqual(state.marks.get(key), [4, "Existing concurrent mark"]);
    assert.equal(state.writes.length, 0);
    const lock = state.queries.findIndex(query => query.sql.includes("pg_advisory_xact_lock"));
    const read = state.queries.findIndex(query => /^SELECT id FROM (?:equipment_)?timesheet_marks/.test(query.sql));
    assert.ok(lock >= 0 && read > lock);
    assert.equal(state.queries[lock].transaction, state.queries[read].transaction);
  });
  test(`${title}: update-only user cannot recreate a mark deleted while waiting for its lock`, async () => {
    const state = fixture(user(resource, ["update"]));
    state.marks.set(key, [4]); state.onLock = () => state.marks.delete(key);
    assert.equal((await handler.POST(request(path, payload))).status, 403);
    assert.equal(state.marks.has(key), false);
    assert.equal(state.writes.length, 0);
  });
  test(`${title}: authorized create, update and delete still use the locked current mark`, async () => {
    const state = fixture(user(resource, ["create", "update", "delete"]));
    assert.equal((await handler.POST(request(path, payload))).status, 200);
    assert.equal((await handler.POST(request(path, payload))).status, 200);
    const clear = path === "timesheet" ? { ...payload, value: "" } : { ...payload, clear: true };
    assert.equal((await handler.POST(request(path, clear))).status, 200);
    assert.equal(state.marks.size, 0);
    assert.equal(state.writes.length, 3);
    assert.ok(state.writes.every(write => write.transaction !== null));
  });
}

const unitPayload = { action: "save-unit", siteId: 7, projectSiteId: 7, organization: "Тест", equipmentType: "Кран", model: "Т-1", registrationNumber: "ТЕСТ-001", note: "Новая карточка" };
test("registry create permission cannot overwrite an identity discovered only inside the transaction", async () => {
  const actor = user("equipment_registry", ["create"]); actor.permissions.project_equipment.create = true;
  const state = fixture(actor);
  state.beforeTransaction = () => { state.unit = { id: 11, siteId: 7, note: "Конкурентная карточка" }; };
  const response = await equipment.POST(request("equipment", unitPayload));
  assert.equal(response.status, 403);
  assert.equal(state.unit.note, "Конкурентная карточка");
  assert.equal(state.writes.length, 0);
  assert.ok(state.queries.some(query => query.transaction !== null && query.sql.includes("identity_key") && query.sql.includes("FOR UPDATE")));
});

for (const existing of [false, true]) test(`registry save rechecks project transfer permission after locking ${existing ? "an explicit unit" : "a newly matched identity"}`, async () => {
  const actor = user("equipment_registry", ["create", "update"]); actor.permissions.project_equipment.create = true;
  const state = fixture(actor);
  if (existing) state.unit = { id: 11, siteId: 7, note: "Исходная карточка" };
  state.beforeTransaction = () => { state.unit = { id: 11, siteId: 8, note: "Уже переведена" }; };
  const response = await equipment.POST(request("equipment", { ...unitPayload, ...(existing ? { id: 11 } : {}) }));
  assert.equal(response.status, 403);
  assert.equal(state.unit.siteId, 8);
  assert.equal(state.writes.length, 0);
});

test("registry create-only permission still creates a genuinely new unit", async () => {
  const actor = user("equipment_registry", ["create"]); actor.permissions.project_equipment.create = true;
  const state = fixture(actor);
  assert.equal((await equipment.POST(request("equipment", unitPayload))).status, 200);
  assert.equal(state.unit.id, 11);
  assert.equal(state.unit.note, unitPayload.note);
  assert.equal(state.writes.filter(write => write.sql.startsWith("INSERT INTO equipment_units")).length, 1);
});
