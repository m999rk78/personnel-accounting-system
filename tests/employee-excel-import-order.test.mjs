import assert from "node:assert/strict";
import test from "node:test";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { noCustomRolesUrl, noPermissionChangesUrl } from "./fixtures/custom-role-imports.mjs";

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = moduleUrl(`export let actor; export let database;
  export function configure(user,db){actor=user;database=db;}
  export const getDatabase=()=>database; export const getAuthUser=async()=>actor;
  export function assertSameOrigin(){} export async function ensureAuthSchema(){}
  export async function createInvitation(){throw new Error('No invitations in import tests');}
  export async function sendInvitationEmail(){throw new Error('No outgoing email in import tests');}`);
const boundary = await import(boundaryUrl);
const noop = names => moduleUrl(names.map(name => `export async function ${name}(){return {};}`).join("\n"));
const file = name => new URL(`../app/${name}.ts`, import.meta.url).href;
const replacements = {
  "../../../db/client": boundaryUrl, "../../auth": boundaryUrl,
  "../../auditLog": moduleUrl("export const withAuditTrail=(request,handler)=>handler(request);"),
  "../../compressJsonResponse": moduleUrl("export async function compressJsonResponse(request,response){return response;}"),
  "../../customRolesServer": noCustomRolesUrl, "../../permissions": noPermissionChangesUrl,
  "../../projectAccessServer": noop(["loadUserProjectAccess", "saveUserProjectAccess"]),
  "../../projectMasters": noop(["ensureProjectMastersSchema", "syncProjectMasters"]),
  "../../workTypeHierarchyServer": noop(["saveSubworkDirectory"]),
  "../../bitrix24Sync": noop(["compareBitrixEmployees", "fetchBitrixEmployeeSnapshot", "normalizeBitrixText", "selectBitrixEmployeesForImport", "selectLinkedBitrixEmployeesForReview", "suggestBitrixEmployeeLinks"]),
  ...Object.fromEntries(["roles", "permissionModel", "projectScopedData", "readOptionalBatch", "settingsReadPolicy", "bitrix24Cooldown", "bitrixReviewSelection", "excelDirectoryImports", "personnelImportOrderServer"].map(name => [`../../${name}`, file(name)])),
};
// This suite exercises the actual route and its transaction with an in-memory DB.
// Schema initialization and every external service are outside this boundary.
globalThis.personnelDatabaseInitializationPromise = Promise.resolve();
const { POST } = await import(await compileModuleGraph(new URL("../app/api/data/route.ts", import.meta.url), replacements));

function memoryDatabase({ failOrderKey, failEmployeeId } = {}) {
  let state = {
    sites: [{ id: 1, code: "ONE", name: "Проект один", active: 1 }, { id: 2, code: "TWO", name: "Проект два", active: 1 }, { id: 3, code: "THREE", name: "Другой проект", active: 1 }],
    employees: [
      { id: 1, fullName: "Первый сотрудник", employmentType: "ОПР", department: "Отдел", position: "Монтажник", active: 1, source: "manual", siteId: 1, availability: "on_site", sortOrder: 40 },
      { id: 2, fullName: "Второй сотрудник", employmentType: "ОПР", department: "Отдел", position: "Сварщик", active: 1, source: "bitrix24", siteId: 2, availability: "vacation", sortOrder: 10 },
      { id: 3, fullName: "Вне файла", employmentType: "ИТР", department: "Отдел", position: "Мастер", active: 1, source: "manual", siteId: 1, availability: "on_site", sortOrder: 30 },
    ],
    assignments: [{ employeeId: 1, siteId: 1, active: 1 }, { employeeId: 2, siteId: 2, active: 1 }, { employeeId: 3, siteId: 1, active: 1 }],
    orders: new Map([["employees:0", [2, 1, 3]], ["project-personnel:1", [3, 1]], ["project-personnel:2", [2]], ["import-order:employees:0", [3, 1, 2]], ["import-order:project-personnel:1", [3, 1]], ["import-order:project-personnel:2", [2]], ["import-order:project-personnel:3", [99]]]),
  };
  const original = structuredClone(state);
  const writes = [];
  const result = (results = [], changes = results.length, lastRowId = null) => ({ results, success: true, meta: { changes, last_row_id: lastRowId } });
  function executor(pending) {
    const execute = (sql, values) => {
      if (sql.includes("pg_advisory_xact_lock")) return result();
      if (sql.startsWith("SELECT id, code, name FROM sites")) return result(pending.sites.filter(site => site.active));
      if (sql.startsWith("SELECT id, full_name AS fullName FROM employees")) return result(pending.employees.filter(employee => employee.active).map(({ id, fullName }) => ({ id, fullName })));
      if (sql.startsWith("SELECT row_ids AS ids FROM table_row_orders")) return result(pending.orders.has(values[0]) ? [{ ids: pending.orders.get(values[0]) }] : []);
      writes.push({ sql, values: structuredClone(values) });
      if (sql.startsWith("INSERT INTO employees")) {
        const id = Math.max(...pending.employees.map(employee => employee.id)) + 1;
        pending.employees.push({ id, fullName: values[0], employmentType: values[1], department: values[2], position: values[3], source: "excel", siteId: values[4], availability: values[5], sortOrder: Math.max(...pending.employees.map(employee => employee.sortOrder)) + 1, active: 1 });
        return result([], 1, id);
      }
      if (sql.startsWith("UPDATE employees SET employment_type")) {
        const employee = pending.employees.find(employee => employee.id === values[5] && employee.active);
        if (employee?.id === failEmployeeId) throw new Error("Тестовый сбой записи сотрудника");
        if (!employee) return result([], 0);
        Object.assign(employee, { employmentType: values[0], department: values[1], position: values[2], siteId: values[3] });
        if (employee.source !== "bitrix24") employee.availability = values[4];
        return result([], 1);
      }
      if (sql.startsWith("UPDATE employee_project_assignments SET active = 0")) {
        for (const assignment of pending.assignments) if (assignment.employeeId === values[0] && assignment.active && (!values[1] || !values[1].includes(assignment.siteId))) assignment.active = 0;
        return result([], 1);
      }
      if (sql.startsWith("UPDATE employee_project_assignments SET source")) return result([], 1);
      if (sql.startsWith("INSERT INTO employee_project_assignments")) {
        if (!pending.assignments.some(assignment => assignment.employeeId === values[0] && assignment.siteId === values[1] && assignment.active)) pending.assignments.push({ employeeId: values[0], siteId: values[1], active: 1 });
        return result([], 1);
      }
      if (sql.startsWith("INSERT INTO table_row_orders")) { if (!pending.orders.has(values[0])) pending.orders.set(values[0], []); return result([], 1); }
      if (sql.startsWith("UPDATE table_row_orders")) {
        if (values[1] === failOrderKey) throw new Error("Тестовый сбой записи порядка импорта");
        pending.orders.set(values[1], JSON.parse(values[0])); return result([], 1);
      }
      throw new Error(`Неожиданный SQL теста импорта: ${sql}`);
    };
    return { prepare(sql) {
      const statement = values => ({ bind: (...next) => statement(next), all: async () => execute(sql, values), first: async () => execute(sql, values).results[0] ?? null, run: async () => execute(sql, values) });
      return statement([]);
    } };
  }
  return { original, writes, snapshot: () => structuredClone(state), async transaction(callback) {
    const pending = structuredClone(state);
    const output = await callback(executor(pending));
    state = pending;
    return output;
  } };
}
const employee = (fullName, projectCode) => ({ fullName, employmentType: "ОПР", department: "Импорт", position: "Монтажник", projectCode });
const workbook = [employee("Второй сотрудник", "ONE; TWO"), employee("Новый сотрудник", "TWO"), employee("Первый сотрудник", "ONE")];
async function importWorkbook(db, employees, permissions = rolePermissionTemplate("superadmin")) {
  boundary.configure({ id: 1, fullName: "Тестовый администратор", role: "superadmin", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, permissions }, db);
  const response = await POST(new Request("http://localhost/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import-employees", employees }) }));
  return { status: response.status, payload: await response.json() };
}

test("global employee import records mixed existing/new workbook order and each explicit project's subsequence", async () => {
  const db = memoryDatabase();
  assert.deepEqual(await importWorkbook(db, workbook), { status: 201, payload: { count: 3, unassigned: 0 } });
  const current = db.snapshot();
  assert.deepEqual(current.orders.get("import-order:employees:0"), [2, 4, 1, 3]);
  assert.deepEqual(current.orders.get("import-order:project-personnel:1"), [2, 1, 3]);
  assert.deepEqual(current.orders.get("import-order:project-personnel:2"), [2, 4]);
  for (const key of ["employees:0", "project-personnel:1", "project-personnel:2", "import-order:project-personnel:3"]) assert.deepEqual(current.orders.get(key), db.original.orders.get(key), key);
  assert.deepEqual(current.employees.slice(0, 3).map(employee => employee.sortOrder), [40, 10, 30]);
  assert.equal(current.employees.find(employee => employee.id === 2).availability, "vacation");
});

test("reimport of existing workbook employees replaces only the import prefix without duplicate records", async () => {
  const db = memoryDatabase();
  await importWorkbook(db, workbook);
  assert.equal((await importWorkbook(db, [workbook[2], workbook[1], workbook[0]])).status, 201);
  const current = db.snapshot();
  assert.equal(current.employees.length, 4);
  assert.deepEqual(current.orders.get("import-order:employees:0"), [1, 4, 2, 3]);
  assert.deepEqual(current.orders.get("import-order:project-personnel:1"), [1, 2, 3]);
  assert.deepEqual(current.orders.get("import-order:project-personnel:2"), [4, 2]);
  assert.equal(current.assignments.filter(assignment => assignment.employeeId === 2 && assignment.siteId === 1 && assignment.active).length, 1);
});

test("duplicate workbook names and missing create/update grants leave employee profiles and every order unchanged", async () => {
  for (const [rows, permissions] of [
    [[workbook[0], workbook[0]], rolePermissionTemplate("superadmin")],
    [workbook, { ...rolePermissionTemplate("superadmin"), employees: { view: true, create: true, update: false, delete: false } }],
    [workbook, { ...rolePermissionTemplate("superadmin"), employees: { view: true, create: false, update: true, delete: false } }],
  ]) {
    const db = memoryDatabase();
    const outcome = await importWorkbook(db, rows, permissions);
    assert.ok([400, 403].includes(outcome.status));
    assert.deepEqual(db.snapshot(), db.original);
    assert.equal(db.writes.length, 0);
  }
});

test("late order or profile failures roll back employees, project assignments and already written import orders together", async () => {
  for (const failure of [{ failOrderKey: "import-order:project-personnel:2" }, { failEmployeeId: 1 }]) {
    const db = memoryDatabase(failure);
    const outcome = await importWorkbook(db, workbook);
    assert.equal(outcome.status, 400);
    assert.match(outcome.payload.error, /Тестовый сбой/);
    assert.ok(db.writes.length > 0, "rollback must be checked after writes were attempted");
    assert.deepEqual(db.snapshot(), db.original);
  }
});
