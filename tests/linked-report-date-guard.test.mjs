import assert from "node:assert/strict";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { projectAccessHarness } from "./fixtures/project-access-boundary.mjs";

process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const initialDate = "2026-10-31", targetDate = "2026-11-01";
const actor = (role = "engineer") => ({ id: 20, role, fullName: "Тестовый проверяющий", assignedSiteId: 7,
  projectAccess: { mode: "selected", siteIds: [7, 8] }, permissions: rolePermissionTemplate(role) });
const original = id => ({ id, siteId: 7, workDate: initialDate, employeeId: id === 500 ? 55 : 56,
  shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1, hours: 6, note: "Первоначально",
  responsibleUserId: 9, revision: 2, positionSnapshot: "Монтажник", employeeNameSnapshot: `Тестовый сотрудник ${id}`,
  employmentTypeSnapshot: "ОПР", departmentSnapshot: "Учебный участок", masterNameSnapshot: "Тестовый мастер" });
const payload = (id = 500, changes = {}) => ({ id, revision: 2, siteId: 7, workDate: initialDate, employeeId: id === 500 ? 55 : 56,
  shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1, hours: 6, note: "Первоначально", ...changes });
const camel = value => value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

/** Execute the real PATCH handler against synthetic entries with a transactional
 * SQL boundary. Unknown statements fail instead of accidentally accepting a path. */
async function fixture(user = actor()) {
  const h = await projectAccessHarness();
  let entries = new Map([[500, original(500)], [501, original(501)]]);
  const linkedIds = new Set([500]);
  const queries = [], writes = [];
  let transaction = 0, sequence = 0, locked = new Set();
  const output = (rows, changes = 0) => ({ results: structuredClone(rows), success: true, meta: { changes, last_row_id: null } });
  const select = (sql, values) => {
    if (sql.startsWith("SELECT id, site_id AS siteId, work_date AS workDate")) {
      assert.ok(transaction); assert.match(sql, /FOR UPDATE/);
      const rows = values[0].flatMap(id => entries.has(id) ? [entries.get(id)] : []);
      for (const row of rows) locked.add(row.id);
      return output(rows);
    }
    if (sql.startsWith("SELECT approved_entry_id AS entryId")) {
      assert.ok(transaction); assert.ok(values[0].every(id => locked.has(id)), "Published rows must be locked before their report links are inspected");
      return output(values[0].filter(id => linkedIds.has(id)).map(entryId => ({ entryId })));
    }
    if (sql.includes("pg_advisory_xact_lock")) { assert.ok(transaction); return output([]); }
    if (sql === "SELECT e.id FROM employees e WHERE e.id = ANY(?) ORDER BY e.id FOR SHARE OF e") { assert.ok(transaction); return output(values[0].map(id => ({ id }))); }
    if (sql.startsWith("SELECT employee_id AS employeeId, site_id AS siteId")) return output(entries.has(values[0]) ? [entries.get(values[0])] : []);
    if (/SELECT id(?:, main_work_type_id AS mainWorkTypeId)? FROM (?:shifts|zones|main_work_types|subwork_types|masters)/.test(sql)) return output([{ id: 1, mainWorkTypeId: 1 }]);
    if (sql.startsWith("SELECT id, name, CASE WHEN masters.active = 1")) return output([{ id: 1, name: "Тестовый мастер", active: 1 }]);
    if (sql.startsWith("SELECT name FROM masters")) return output([{ name: "Тестовый мастер" }]);
    if (sql.includes("FROM employees e") && sql.includes("employee_project_assignments")) return output([...entries.values()].map(entry => ({ id: entry.employeeId,
      position: entry.positionSnapshot, fullName: entry.employeeNameSnapshot, employmentType: "ОПР", department: entry.departmentSnapshot })));
    if (sql.startsWith("SELECT COALESCE(SUM(hours), 0) AS used")) return output([{ used: [...entries.values()].filter(entry => entry.employeeId === values[0] && entry.workDate === values[1] && entry.id !== values[2]).reduce((sum, entry) => sum + entry.hours, 0) }]);
    if (sql.startsWith("SELECT employee_id AS employeeId, SUM(hours) AS used")) {
      const totals = new Map();
      for (const entry of entries.values()) if (entry.workDate === values[0]) totals.set(entry.employeeId, (totals.get(entry.employeeId) ?? 0) + entry.hours);
      return output([...totals].map(([employeeId, used]) => ({ employeeId, used })));
    }
    throw new Error(`Unexpected guard-test SELECT: ${sql.slice(0, 150)}`);
  };
  const execute = (sql, values) => {
    assert.equal((sql.match(/\?/g) ?? []).length, values.length, `Bind mismatch: ${sql}`);
    queries.push({ sql, values: structuredClone(values), transaction });
    if (/^SELECT\b/.test(sql)) return select(sql, values);
    assert.ok(transaction, "Writes must remain inside a transaction");
    assert.ok(sql.startsWith("UPDATE placement_entries SET"), `Unexpected guard-test mutation: ${sql}`);
    const id = values.at(-1), entry = entries.get(id);
    assert.ok(entry && locked.has(id), "Never write an unlocked/missing published entry");
    writes.push({ sql, values: structuredClone(values), transaction });
    const columns = [...sql.split(" SET ")[1].split(" WHERE ")[0].matchAll(/(\w+)\s*=\s*\?/g)].map(match => camel(match[1]));
    columns.forEach((column, index) => { entry[column] = values[index]; });
    entry.revision++;
    return output([{ id, revision: entry.revision }], 1);
  };
  const db = {
    prepare(source) {
      const sql = source.trim(); let values = [];
      const statement = { bind(...next) { values = next; return statement; },
        async all() { return execute(sql, values); }, async first() { return execute(sql, values).results[0] ?? null; }, async run() { return execute(sql, values); } };
      return statement;
    },
    async batch(statements) { const result = []; for (const statement of statements) result.push(await statement.run()); return result; },
    async readBatch(statements) { const result = []; for (const statement of statements) result.push(await statement.all()); return result; },
    async transaction(callback) {
      const before = structuredClone(entries); transaction = ++sequence; locked = new Set();
      try { return await callback(db); } catch (error) { entries = before; throw error; } finally { transaction = 0; locked = new Set(); }
    },
  };
  h.boundary.configure(user, db);
  const route = await h.loadDataRoute();
  return { queries, writes, snapshot: () => structuredClone([...entries.values()]),
    async patch(body) { return route.PATCH(new Request("http://localhost/api/data", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); } };
}

for (const mode of ["single", "bulk"]) for (const [field, value] of [["workDate", targetDate], ["siteId", 8]]) {
  test(`${mode} legacy PATCH cannot change a linked report's ${field}`, async () => {
    const h = await fixture(), before = h.snapshot();
    const row = payload(500, { [field]: value });
    const response = await h.patch(mode === "bulk" ? { entries: [row] } : row);
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.code, "REPORT_IDENTITY_LOCKED"); assert.deepEqual(result.entryIds, [500]);
    assert.deepEqual(h.snapshot(), before); assert.equal(h.writes.length, 0);
    assert.equal(h.queries.filter(query => query.sql.includes("pg_advisory_xact_lock")).length, 0, "Identity rejection must precede hour locks and writes");
  });
}

test("a mixed legacy/linked batch rolls back as a whole without moving its first legacy row", async () => {
  const h = await fixture(), before = h.snapshot();
  const response = await h.patch({ entries: [payload(501, { workDate: targetDate }), payload(500, { workDate: targetDate })] });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "REPORT_IDENTITY_LOCKED");
  assert.deepEqual(h.snapshot(), before); assert.equal(h.writes.length, 0);
});

for (const mode of ["single", "bulk"]) test(`${mode} linked entry corrections retain their date, project and identity`, async () => {
  const h = await fixture();
  const row = payload(500, { hours: 7, note: "Уточнение без переноса" });
  const response = await h.patch(mode === "bulk" ? { entries: [row] } : row);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const entry = h.snapshot().find(entry => entry.id === 500);
  assert.equal(entry.hours, 7); assert.equal(entry.note, row.note); assert.equal(entry.revision, 3);
  assert.equal(entry.workDate, initialDate); assert.equal(entry.siteId, 7); assert.equal(entry.responsibleUserId, 9);
  assert.equal(entry.employeeNameSnapshot, original(500).employeeNameSnapshot); assert.equal(entry.positionSnapshot, original(500).positionSnapshot);
  assert.equal(h.writes.length, 1);
  assert.equal(h.queries.some(query => query.sql.includes("FROM personnel_report_rows")), false, "Unchanged identities need no link lookup");
});

for (const mode of ["single", "bulk"]) test(`${mode} standalone legacy entry may still move to another date`, async () => {
  const h = await fixture();
  const row = payload(501, { workDate: targetDate });
  const response = await h.patch(mode === "bulk" ? { entries: [row] } : row);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const entry = h.snapshot().find(entry => entry.id === 501);
  assert.equal(entry.workDate, targetDate); assert.equal(entry.hours, 6); assert.equal(entry.revision, 3); assert.equal(entry.responsibleUserId, 9);
  assert.equal(h.snapshot().find(entry => entry.id === 500).workDate, initialDate);
  assert.ok(h.queries.some(query => query.sql.includes("FROM personnel_report_rows") && query.values[0].includes(501)));
});

test("omitting an optimistic revision cannot bypass the linked identity guard", async () => {
  const h = await fixture(), row = payload(500, { workDate: targetDate }); delete row.revision;
  const response = await h.patch(row);
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "REPORT_IDENTITY_LOCKED"); assert.equal(h.writes.length, 0);
});

test("stale revisions are rejected before inspecting links or moving hours", async () => {
  const h = await fixture();
  const response = await h.patch(payload(500, { revision: 1, workDate: targetDate }));
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "STALE_ENTRY");
  assert.equal(h.queries.some(query => query.sql.includes("FROM personnel_report_rows")), false); assert.equal(h.writes.length, 0);
});

for (const [role, status, code] of [["viewer", 403, undefined], ["foreman", 403, undefined]]) {
  test(`${role} cannot use the legacy PATCH endpoint to move approved report rows`, async () => {
    const h = await fixture(actor(role));
    const response = await h.patch(payload(500, { workDate: targetDate }));
    assert.equal(response.status, status); assert.equal((await response.json()).code, code);
    assert.equal(h.queries.length, 0); assert.equal(h.writes.length, 0);
  });
}

test("project scope and update permissions are enforced before the date guard", async () => {
  const scoped = await fixture({ ...actor(), projectAccess: { mode: "selected", siteIds: [8] } });
  assert.equal((await scoped.patch(payload(500, { workDate: targetDate }))).status, 403); assert.equal(scoped.queries.length, 0);
  const user = actor(); user.permissions.workers_report.update = false;
  const readOnly = await fixture(user);
  assert.equal((await readOnly.patch(payload(500, { workDate: targetDate }))).status, 403); assert.equal(readOnly.queries.length, 0);
});
