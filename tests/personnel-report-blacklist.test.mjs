import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { personnelReportEmployeeRestriction } from "../app/personnelReportWorkflow.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const boundaryUrl = moduleUrl("let database; export function configure(value){database=value;} export const env={get DB(){return database;}};");
const boundary = await import(boundaryUrl);
const placement = await import(await compileModuleGraph(new URL("../app/server/data/placement.ts", import.meta.url), {
  "./context": boundaryUrl,
  "../../../db/client": moduleUrl("export function getDatabase(){throw new Error('No real database in blacklist tests');}"),
}));
const catalogs = await import(await compileModuleGraph(new URL("../app/server/data/catalogs.ts", import.meta.url), {
  "./context": boundaryUrl,
  "../../../db/client": moduleUrl("export function getDatabase(){throw new Error('No real database in blacklist tests');}"),
}));
const store = await import(await compileModuleGraph(new URL("../app/personnelReportStore.ts", import.meta.url)));
const actor = (role = "engineer") => ({ id: 8, role, fullName: "Тестовый пользователь", assignedSiteId: 7,
  projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate(role) });
const original = { id: 101, reportId: 17, siteId: 7, workDate: "2026-11-03", employeeId: 55,
  shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1, hours: 6, note: "История",
  employeeName: "Историческое ФИО", employmentType: "ОПР", department: "Исторический отдел", positionSnapshot: "Монтажник",
  masterName: "Исторический мастер", rowOrder: 0, approvedEntryId: 500, approvedEntryRevision: 1 };
const blockedCases = [
  { availabilityStatus: "blacklisted", code: "EMPLOYEE_BLACKLISTED" },
  { availabilityStatus: "dismissed", code: "EMPLOYEE_DISMISSED" },
  { availabilityStatus: "deleted", code: "EMPLOYEE_DISMISSED" },
  { availabilityStatus: "on_site", bitrixCheckStatus: "blacklisted_in_bitrix", code: "EMPLOYEE_BLACKLISTED" },
  { availabilityStatus: "on_site", bitrixCheckStatus: "dismissed_in_bitrix", code: "EMPLOYEE_DISMISSED" },
];
const camel = value => value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const aliases = { employee_name_snapshot: "employeeName", employment_type_snapshot: "employmentType", department_snapshot: "department", position_snapshot: "positionSnapshot", master_name_snapshot: "masterName" };

/** The real reference/catalog SQL runs only in SQLite memory. Report mutations
 * use a strict synthetic boundary, so neither env files nor cloud DBs are read. */
function fixture({ availabilityStatus = "on_site", bitrixCheckStatus = null, acknowledged = false, active = true, assigned = true, employeeSiteId = 7, status = "draft", employeeId = 55, masterEmployeeId = null, onEmployeeLock } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE employees (id INTEGER PRIMARY KEY, full_name TEXT, employment_type TEXT, department TEXT, position TEXT,
    source TEXT, sort_order INTEGER, bitrix24_stage TEXT, availability_status TEXT, sync_error TEXT, active INTEGER, bitrix24_id TEXT, last_synced_at TEXT);
    CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT, active INTEGER, code TEXT);
    CREATE TABLE employee_project_assignments (employee_id INTEGER, site_id INTEGER, active INTEGER);
    CREATE TABLE bitrix24_employee_check_states (employee_id INTEGER PRIMARY KEY, status TEXT, acknowledged_at TEXT, checked_at TEXT, details TEXT, fingerprint TEXT);
    CREATE TABLE shifts (id INTEGER, site_id INTEGER, name TEXT, active INTEGER);
    CREATE TABLE zones (id INTEGER, site_id INTEGER, name TEXT, active INTEGER);
    CREATE TABLE main_work_types (id INTEGER, site_id INTEGER, name TEXT, active INTEGER);
    CREATE TABLE subwork_types (id INTEGER, site_id INTEGER, name TEXT, active INTEGER, main_work_type_id INTEGER);
    CREATE TABLE masters (id INTEGER, site_id INTEGER, name TEXT, active INTEGER, employee_id INTEGER);
    CREATE TABLE placement_entries (id INTEGER PRIMARY KEY, site_id INTEGER, work_date TEXT, employee_id INTEGER,
      master_id INTEGER, hours INTEGER, deleted_at TEXT, position_snapshot TEXT, employee_name_snapshot TEXT,
      employment_type_snapshot TEXT, department_snapshot TEXT, master_name_snapshot TEXT);
    INSERT INTO sites VALUES (7,'Тестовый проект',1,'QA7'),(8,'Другой проект',1,'QA8');
    INSERT INTO shifts VALUES (1,7,'День',1); INSERT INTO zones VALUES (1,7,'Зона',1);
    INSERT INTO main_work_types VALUES (1,7,'Монтаж',1); INSERT INTO subwork_types VALUES (1,7,'Подготовка',1,1);
    `);
  sqlite.prepare("INSERT INTO masters VALUES (1,7,'Текущий мастер',1,?)").run(masterEmployeeId);
  const insertEmployee = sqlite.prepare("INSERT INTO employees VALUES (?,?,?,?,?,'bitrix24',0,'Стадия',?,NULL,?,NULL,NULL)");
  insertEmployee.run(55, "Текущее ФИО", "ОПР", "Текущий отдел", "Монтажник", availabilityStatus, Number(active));
  insertEmployee.run(56, "Разрешённый сотрудник", "ОПР", "УСР", "Сварщик", null, 1);
  sqlite.prepare("INSERT INTO employee_project_assignments VALUES (55,?,?),(56,7,1)").run(employeeSiteId, Number(assigned));
  if (bitrixCheckStatus) sqlite.prepare("INSERT INTO bitrix24_employee_check_states VALUES (55,?,?,?,NULL,'synthetic')")
    .run(bitrixCheckStatus, acknowledged ? "2020-01-02" : null, "2020-01-01");
  sqlite.prepare("INSERT INTO placement_entries VALUES (500,7,?,55,1,6,NULL,?,?,?,?,?)")
    .run(original.workDate, original.positionSnapshot, original.employeeName, original.employmentType, original.department, original.masterName);
  let header = { id: 17, siteId: 7, workDate: original.workDate, ownerUserId: 8, ownerName: "Прораб", status, revision: 1 };
  let row = { ...original, employeeId };
  let entry = { ...original, employeeId, id: 500, revision: 1, responsibleUserId: 8 };
  const writes = [], queries = [];
  function sqlSelect(sql, values) {
    const expanded = [];
    let offset = 0;
    const text = sql.replaceAll("::integer[]", "").replace(/\?/g, () => {
      const value = values[offset++];
      if (Array.isArray(value)) { expanded.push(...value); return value.length ? value.map(() => "?").join(",") : "SELECT NULL WHERE 0"; }
      expanded.push(value); return "?";
    }).replace(/= ANY\(([^)]*)\)/g, "IN ($1)").replaceAll("::int", "").replace(/ FOR SHARE OF (employee|e)$/, "");
    assert.equal(offset, values.length, "Every SQL parameter is bound");
    return sqlite.prepare(text).all(...expanded).map(item => ({ ...item }));
  }
  function execute(sql, values) {
    queries.push({ sql, values });
    if (/^SELECT\b/.test(sql)) {
      if (/ FOR SHARE OF (employee|e)$/.test(sql)) {
        const result = sqlSelect(sql, values);
        onEmployeeLock?.(sqlite);
        return result;
      }
      if (sql.includes("FROM personnel_reports report JOIN app_users owner")) return [structuredClone(header)];
      if (sql.includes("FROM personnel_report_rows draft_row JOIN")) return [{ ...row, ...(header.status === "approved" && sql.includes("CASE WHEN report.status") ? entry : {}), id: 101, reportId: 17, approvedEntryId: 500, approvedEntryRevision: entry.revision }];
      if (sql.includes("FROM employees") || sql.includes("FROM sites") || /FROM (shifts|zones|main_work_types|subwork_types|masters)\b/.test(sql) || sql.includes("SUM(entry.hours)") || sql.includes("FROM placement_entries WHERE")) return sqlSelect(sql, values);
      if (sql.includes("pg_advisory_xact_lock") || /^SELECT entry.id FROM/.test(sql)) return [];
      if (sql.includes("SELECT clock_timestamp() AS changedAt")) return [{ changedAt: "2026-11-04T00:00:00Z" }];
      if (sql.startsWith("SELECT id FROM personnel_reports WHERE id")) return [{ id: 17 }];
      if (sql.includes("FROM personnel_reports") && sql.includes("status <> 'approved'")) return [];
      throw new Error(`Unexpected SELECT in blacklist fixture: ${sql}`);
    }
    writes.push({ sql, values });
    if (sql.startsWith("UPDATE personnel_reports SET revision")) header.revision++;
    else if (sql.startsWith("UPDATE personnel_report_rows SET row_order = ?") || sql.startsWith("UPDATE placement_entries SET employee_id")) {
      const target = sql.startsWith("UPDATE placement_entries") ? entry : row;
      const fields = [...sql.split(" SET ")[1].split(" WHERE ")[0].matchAll(/(\w+)\s*=\s*\?/g)].map(match => aliases[match[1]] ?? camel(match[1]));
      fields.forEach((field, index) => { target[field] = values[index]; });
      if (target === entry) entry.revision++;
    } else if (!sql.startsWith("DELETE FROM personnel_report_rows") && !sql.startsWith("UPDATE personnel_report_rows SET row_order = -id")) throw new Error(`Unexpected mutation in blacklist fixture: ${sql}`);
    return [{ id: 17 }];
  }
  const db = {
    writes, queries, state: () => structuredClone({ header, row, entry }), close: () => sqlite.close(),
    prepare(source) {
      const sql = source.trim(); let values = [];
      const statement = { sql, bind(...next) { values = next; return statement; },
        async first() { return execute(sql, values)[0] ?? null; }, async all() { return { results: execute(sql, values) }; },
        async run() { return { results: execute(sql, values), meta: { changes: 1 } }; } };
      return statement;
    },
    async readBatch(statements) { return Promise.all(statements.map(statement => statement.all())); },
    async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; },
    async transaction(callback) { const before = structuredClone({ header, row, entry }); try { return await callback(db); } catch (error) { ({ header, row, entry } = before); throw error; } },
  };
  return db;
}
const draftPayload = changes => ({ action: "save", siteId: 7, workDate: original.workDate, rows: [{ ...original, id: undefined }], ...changes });
const legacyPayload = changes => ({ ...original, id: undefined, ...changes });
const legacyExisting = { ...original, id: 500, positionSnapshot: original.positionSnapshot,
  employeeNameSnapshot: original.employeeName, employmentTypeSnapshot: original.employmentType,
  departmentSnapshot: original.department, masterNameSnapshot: original.masterName };

for (const sample of blockedCases) for (const acknowledged of [false, true]) test(`blocks new report/copy/import/API rows: ${JSON.stringify(sample)}, acknowledged=${acknowledged}`, async t => {
  const db = fixture({ ...sample, acknowledged }); t.after(db.close);
  boundary.configure(db);
  assert.deepEqual((await placement.reportEmployeesStatement(7).all()).results.map(employee => employee.id), [56]);
  assert.deepEqual((await catalogs.projectEmployeeCatalogStatement(7).all()).results.map(employee => employee.id), [56]);
  assert.deepEqual((await catalogs.employeeCatalogStatement(actor()).all()).results.map(employee => employee.id), [56]);
  for (const role of ["engineer", "foreman"]) {
    await assert.rejects(store.mutatePersonnelReport(db, actor(role), draftPayload()), error => error.code === sample.code && error.details.issues[0].employeeId === 55);
  }
  await assert.rejects(placement.validatePayload(db, legacyPayload()), error => error.code === sample.code);
  await assert.rejects(placement.validateBulkPayloads(db, [legacyPayload({ employeeId: 56 }), legacyPayload()]), error => error.code === sample.code && error.details.row === 2);
  assert.equal(db.writes.length, 0, "Blocked batch must not publish or mutate history");
});

for (const sample of blockedCases) test(`hides a blocked employee's linked master in current lists, retaining saved references: ${JSON.stringify(sample)}`, async t => {
  const db = fixture({ ...sample, masterEmployeeId: 55 }); t.after(db.close);
  boundary.configure(db);
  assert.deepEqual((await catalogs.projectMasterCatalogStatement(7).all()).results, []);
  const newRow = { ...legacyPayload(), employeeId: 56 };
  await assert.rejects(store.mutatePersonnelReport(db, actor(), draftPayload({ rows: [newRow] })), /Мастер/);
  await assert.rejects(placement.validatePayload(db, newRow), /не относится/);
  await assert.rejects(placement.validateBulkPayloads(db, [newRow]), /не относится/);
  assert.equal((await placement.validatePayload(db, { ...newRow, id: 500 }, 500)).masterName, original.masterName);
  assert.equal((await placement.validateBulkPayloads(db, [{ ...newRow, id: 500 }], [legacyExisting]))[0].masterName, original.masterName);
  assert.equal(db.writes.length, 0);
});

test("keeps manual masters and masters of eligible employees available", async t => {
  for (const masterEmployeeId of [null, 56]) {
    const db = fixture({ masterEmployeeId }); t.after(db.close);
    boundary.configure(db);
    assert.deepEqual((await catalogs.projectMasterCatalogStatement(7).all()).results.map(master => master.id), [1]);
  }
});

test("archived/unassigned blacklisted employees still produce a clear restriction, not an accidental eligibility bypass", async t => {
  const db = fixture({ availabilityStatus: "blacklisted", active: false, assigned: false }); t.after(db.close);
  await assert.rejects(store.mutatePersonnelReport(db, actor(), draftPayload()), error => error.code === "EMPLOYEE_BLACKLISTED");
  await assert.rejects(placement.validatePayload(db, legacyPayload()), error => error.code === "EMPLOYEE_BLACKLISTED");
  await assert.rejects(placement.validateBulkPayloads(db, [legacyPayload()]), error => error.code === "EMPLOYEE_BLACKLISTED");
  assert.equal(db.writes.length, 0);
});

test("blocked employee IDs from another project cannot expose private names or enter the report", async t => {
  const db = fixture({ availabilityStatus: "blacklisted", employeeSiteId: 8 }); t.after(db.close);
  await assert.rejects(store.mutatePersonnelReport(db, actor("foreman"), draftPayload()), error => {
    assert.equal(error.code, "INVALID_EMPLOYEE");
    assert.equal(error.details.issues[0].employeeName, undefined);
    return true;
  });
  await assert.rejects(placement.validatePayload(db, legacyPayload()), /Сотрудник отсутствует/);
  await assert.rejects(placement.validateBulkPayloads(db, [legacyPayload()]), /сотрудник недоступен/);
  assert.equal(db.writes.length, 0);
});

test("transaction validation reads employee status after the ordered employee lock has completed", async t => {
  const paths = [
    db => store.mutatePersonnelReport(db, actor(), draftPayload()),
    db => placement.validatePayload(db, legacyPayload()),
    db => placement.validateBulkPayloads(db, [legacyPayload({ employeeId: 56 }), legacyPayload(), legacyPayload({ employeeId: 56 })]),
  ];
  for (const operation of paths) {
    const db = fixture({ onEmployeeLock(sqlite) {
      // Model an archive that finishes while the row lock is being acquired.
      // The following reference SELECT must get a fresh status snapshot.
      sqlite.exec("UPDATE employees SET availability_status = 'blacklisted', active = 0 WHERE id = 55; UPDATE employee_project_assignments SET active = 0 WHERE employee_id = 55;");
    } });
    t.after(db.close);
    await assert.rejects(operation(db), error => error.code === "EMPLOYEE_BLACKLISTED");
    const lock = db.queries.findIndex(query => / FOR SHARE OF (employee|e)$/.test(query.sql));
    const status = db.queries.findIndex(query => query.sql.includes("check_state.status AS bitrixCheckStatus"));
    assert.ok(lock >= 0 && status > lock, "Acquire employee locks in a separate statement before status reads");
    assert.match(db.queries[lock].sql, /ORDER BY (employee|e)\.id FOR SHARE OF/);
    assert.equal(new Set(db.queries[lock].values[0]).size, db.queries[lock].values[0].length, "Only unique requested employees are locked");
    assert.ok(db.queries[lock].values[0].every(id => id === 55 || id === 56));
    assert.equal(db.writes.length, 0);
  }
});

for (const status of ["draft", "submitted"]) test(`previous ${status} stays intact and cannot save/submit/approve a newly blocked employee`, async t => {
  const db = fixture({ bitrixCheckStatus: "blacklisted_in_bitrix", acknowledged: true, status }); t.after(db.close);
  const before = db.state();
  await assert.rejects(store.mutatePersonnelReport(db, actor(), draftPayload({ reportId: 17, revision: 1, rows: [original] })), error => error.code === "EMPLOYEE_BLACKLISTED");
  await assert.rejects(store.mutatePersonnelReport(db, actor(), { action: status === "draft" ? "submit" : "approve", reportId: 17, revision: 1 }), error => error.code === "EMPLOYEE_BLACKLISTED");
  assert.deepEqual(db.state(), before);
  assert.equal(db.writes.length, 0);
});

test("submission preview reports blocked employee and row/date without changing the draft", async t => {
  const db = fixture({ availabilityStatus: "dismissed" }); t.after(db.close);
  const result = await store.validatePersonnelReportSubmissions(db, actor(), { action: "validate-submissions", siteId: 7,
    reports: [{ key: "new:2026-11-03", workDate: original.workDate, rows: [{ ...original, id: undefined }] }] });
  assert.ok(result.issues.length > 0);
  const issue = result.issues.find(issue => issue.code === "EMPLOYEE_DISMISSED");
  assert.equal(issue.employeeId, 55); assert.equal(issue.workDate, original.workDate); assert.deepEqual(issue.rowNumbers, [1]);
  assert.equal(db.queries.some(query => query.sql.includes("FOR SHARE")), false, "Read-only previews do not retain mutation locks");
  assert.equal(db.writes.length, 0);
});

test("approved same-employee corrections retain history even after archive, while adding/replacing is forbidden", async t => {
  const db = fixture({ availabilityStatus: "blacklisted", active: false, assigned: false, status: "approved" }); t.after(db.close);
  const result = await store.mutatePersonnelReport(db, actor(), draftPayload({ reportId: 17, revision: 1, rows: [{ ...original, hours: 8, note: "Уточнение" }] }));
  assert.equal(result.status, "approved"); assert.equal(db.state().entry.hours, 8);
  for (const field of ["employeeName", "employmentType", "department", "positionSnapshot", "masterName"]) assert.equal(db.state().entry[field], original[field]);
  const writes = db.writes.length, before = db.state();
  await assert.rejects(store.mutatePersonnelReport(db, actor(), draftPayload({ reportId: 17, revision: 2, rows: [{ ...original, approvedEntryRevision: 2 }, { ...original, id: undefined }] })), error => error.code === "EMPLOYEE_BLACKLISTED");
  assert.deepEqual(db.state(), before); assert.equal(db.writes.length, writes);
  const replacing = fixture({ availabilityStatus: "blacklisted", status: "approved", employeeId: 56 }); t.after(replacing.close);
  await assert.rejects(store.mutatePersonnelReport(replacing, actor(), draftPayload({ reportId: 17, revision: 1, rows: [original] })), error => error.code === "EMPLOYEE_BLACKLISTED");
  assert.equal(replacing.writes.length, 0);
});

test("legacy approved same-employee corrections are allowed but cannot be reused as a new identity", async t => {
  const db = fixture({ availabilityStatus: "deleted", active: false, assigned: false }); t.after(db.close);
  const single = await placement.validatePayload(db, legacyPayload({ hours: 8 }), 500);
  assert.equal(single.employeeName, original.employeeName); assert.equal(single.hours, 8);
  const bulk = await placement.validateBulkPayloads(db, [legacyPayload({ id: 500, hours: 8 })], [legacyExisting]);
  assert.equal(bulk[0].employeeName, original.employeeName);
  for (const id of [undefined, 999]) await assert.rejects(placement.validateBulkPayloads(db, [legacyPayload({ id })], [legacyExisting]), error => error.code === "EMPLOYEE_DISMISSED");
  const replacedExisting = { ...legacyExisting, employeeId: 56 };
  await assert.rejects(placement.validateBulkPayloads(db, [legacyPayload({ id: 500 })], [replacedExisting]), error => error.code === "EMPLOYEE_DISMISSED");
  assert.equal(db.writes.length, 0);
});

test("legacy null statuses and unrelated acknowledged mismatches stay selectable; ordinary inactive staff do not", async t => {
  const db = fixture({ availabilityStatus: null, bitrixCheckStatus: "mismatch", acknowledged: true }); t.after(db.close);
  boundary.configure(db);
  assert.deepEqual((await placement.reportEmployeesStatement(7).all()).results.map(employee => employee.id), [56, 55]);
  assert.equal(personnelReportEmployeeRestriction({ availabilityStatus: null, bitrixCheckStatus: "mismatch" }), null);
  assert.equal((await placement.validatePayload(db, legacyPayload({ hours: 4 }))).employeeName, "Текущее ФИО");
  const preview = await store.validatePersonnelReportSubmissions(db, actor(), { action: "validate-submissions", siteId: 7,
    reports: [{ key: "new:2026-11-03", workDate: original.workDate, rows: [{ ...original, id: undefined, hours: 4 }] }] });
  assert.deepEqual(preview.issues, []);
  const inactive = fixture({ active: false, assigned: false }); t.after(inactive.close);
  await assert.rejects(store.mutatePersonnelReport(inactive, actor(), draftPayload()), error => error.code === "INVALID_EMPLOYEE");
  await assert.rejects(placement.validatePayload(inactive, legacyPayload()), /Сотрудник отсутствует/);
  assert.equal(inactive.writes.length, 0);
});
