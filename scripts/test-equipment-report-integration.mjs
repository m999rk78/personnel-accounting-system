// Explicit loopback-only integration test. All synthetic rows and additive DDL
// are rolled back; never invoke against a configured cloud database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

const address = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : process.env.PGHOST;
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(address), "Equipment integration checks require a loopback PostgreSQL database.");
async function loadTypeScript(path, replacements = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(replacements)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { PostgresDatabase, PostgresStatement } = await loadTypeScript("../db/client.ts", { pg: import.meta.resolve("pg") });
const { mutateEquipmentReport, mutateEquipmentReportEntry, listEquipmentReports, validateEquipmentReportSubmissions } = await loadTypeScript("../app/equipmentReportStore.ts", {
  "./equipmentReportWorkflow": new URL("../app/equipmentReportWorkflow.ts", import.meta.url).href,
  "./equipmentExcel": new URL("../app/equipmentExcel.ts", import.meta.url).href,
  "./equipmentAvailability": new URL("../app/equipmentAvailability.ts", import.meta.url).href,
});
const pool = new pg.Pool({ ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}), ssl: false, max: 1, connectionTimeoutMillis: 5000 });
const connection = await pool.connect();
const database = new PostgresDatabase(pool);
const executor = {
  prepare: sql => new PostgresStatement(database, sql, [], connection),
  async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.executeWith(connection)); return results; },
  async readBatch(statements) { const results = []; for (const statement of statements) results.push(await statement.all()); return results; },
};
const scoped = { ...executor, async transaction(callback) {
  await connection.query("SAVEPOINT equipment_operation");
  try { const result = await callback(executor); await connection.query("RELEASE SAVEPOINT equipment_operation"); return result; }
  catch (error) { await connection.query("ROLLBACK TO SAVEPOINT equipment_operation"); await connection.query("RELEASE SAVEPOINT equipment_operation"); throw error; }
} };
const code = expected => error => error.code === expected;
try {
  await connection.query("BEGIN");
  await connection.query(await readFile(new URL("../drizzle-postgres/0024_equipment_report_approval.sql", import.meta.url), "utf8"));
  const marker = `equipment-workflow-${randomUUID()}`;
  const insert = async (sql, values) => (await connection.query(sql, values)).rows[0].id;
  const siteId = await insert("INSERT INTO sites(name,code) VALUES ($1,$1) RETURNING id", [marker]);
  const otherSiteId = await insert("INSERT INTO sites(name,code) VALUES ($1,$1) RETURNING id", [`${marker}-other`]);
  const foremanId = await insert("INSERT INTO app_users(full_name,email,role,assigned_site_id) VALUES ($1,$2,'foreman',$3) RETURNING id", [marker, `${marker}@invalid.test`, siteId]);
  const otherForemanId = await insert("INSERT INTO app_users(full_name,email,role,assigned_site_id) VALUES ($1,$2,'foreman',$3) RETURNING id", [`${marker}-second`, `${marker}-second@invalid.test`, siteId]);
  const engineerId = await insert("INSERT INTO app_users(full_name,email,role) VALUES ($1,$2,'engineer') RETURNING id", [`${marker}-engineer`, `${marker}-engineer@invalid.test`]);
  const actor = (id, role) => ({ id, fullName: `${marker}-${role}`, role, assignedSiteId: role === "foreman" ? siteId : null, permissions: rolePermissionTemplate(role) });
  const foreman = actor(foremanId, "foreman"), otherForeman = actor(otherForemanId, "foreman"), engineer = actor(engineerId, "engineer");
  const equipmentId = await insert("INSERT INTO equipment_units(site_id,identity_key,organization,equipment_type,brand,model,registration_number) VALUES ($1,$2,'Организация','Экскаватор','Марка','Модель','ТЕСТ001') RETURNING id", [siteId, marker]);
  await connection.query("INSERT INTO equipment_project_assignments(equipment_id,site_id) VALUES ($1,$2),($1,$3)", [equipmentId, siteId, otherSiteId]);
  const refs = {};
  for (const [field, table] of Object.entries({ shiftId: "shifts", zoneId: "zones", mainWorkTypeId: "main_work_types", subworkTypeId: "subwork_types" })) refs[field] = await insert(`INSERT INTO ${table}(site_id,name) VALUES ($1,$2) RETURNING id`, [siteId, marker]);
  await connection.query("UPDATE subwork_types SET main_work_type_id=$1 WHERE id=$2", [refs.mainWorkTypeId, refs.subworkTypeId]);
  const row = { ...refs, equipmentId, hours: 6, note: "Проверка" };
  const total = async date => Number((await connection.query("SELECT COALESCE(SUM(hours),0)::int AS hours FROM equipment_entries WHERE equipment_id=$1 AND work_date=$2 AND deleted_at IS NULL", [equipmentId, date])).rows[0].hours);
  const save = (user, workDate, rows, report) => mutateEquipmentReport(scoped, user, { action: "save", siteId, workDate, rows, ...(report ? { reportId: report.id, revision: report.revision } : {}) });
  const transition = (user, report, action, comment) => mutateEquipmentReport(scoped, user, { action, reportId: report.id, revision: report.revision, comment });
  const read = async report => (await listEquipmentReports(executor, engineer, siteId, report.workDate, report.workDate)).reports.find(current => current.id === report.id);

  // Partial drafts never materialize in the timesheet.
  const partial = await save(foreman, "2026-10-01", [{ equipmentId, note: "Не заполнено" }]);
  assert.equal(partial.rows[0].hours, null);
  assert.equal(await total(partial.workDate), 0);
  await assert.rejects(transition(foreman, partial, "submit"), /заполните/);
  await assert.rejects(save(otherForeman, partial.workDate, partial.rows, partial), code("REPORT_FORBIDDEN"));
  await assert.rejects(listEquipmentReports(executor, { ...foreman, assignedSiteId: otherSiteId }, siteId, null, null), code("REPORT_FORBIDDEN"));

  let report = await save(foreman, "2026-10-02", [row]);
  const original = report.rows[0];
  report = await save(foreman, report.workDate, report.rows, report);
  assert.equal(report.rows[0].createdAt, original.createdAt);
  assert.equal(report.rows[0].updatedAt, original.updatedAt);
  report = await transition(foreman, report, "submit");
  assert.equal(await total(report.workDate), 0);
  await assert.rejects(save(foreman, report.workDate, report.rows, report), code("REPORT_LOCKED"));
  await assert.rejects(transition(otherForeman, report, "reopen"), code("REPORT_FORBIDDEN"));
  await assert.rejects(transition(engineer, report, "reopen"), code("REPORT_FORBIDDEN"));
  report = await save(engineer, report.workDate, [{ ...report.rows[0], hours: 7 }], report);
  assert.equal(await total(report.workDate), 0);
  await assert.rejects(transition(engineer, report, "reject", " "), /причину/);
  report = await transition(engineer, report, "reject", "Проверьте часы");
  assert.equal(report.reviewComment, "Проверьте часы");
  report = await save(foreman, report.workDate, [{ ...report.rows[0], hours: 8 }], report);
  report = await transition(foreman, report, "submit");
  await assert.rejects(transition(foreman, report, "approve"), code("REVIEW_FORBIDDEN"));
  report = await transition(engineer, report, "approve");
  assert.equal(await total(report.workDate), 8);
  const publishedId = report.rows[0].approvedEntryId;
  assert.ok(publishedId);
  await assert.rejects(transition(engineer, { ...report, revision: report.revision - 1 }, "approve"), code("STALE_REPORT"));
  const restricted = { ...engineer, permissions: rolePermissionTemplate("engineer") };
  restricted.permissions.equipment_report.create = false;
  await assert.rejects(save(restricted, report.workDate, [...report.rows, row], report), code("REPORT_FORBIDDEN"));
  report = await save(engineer, report.workDate, [{ ...report.rows[0], hours: 9, note: "Исправлено" }], report);
  assert.equal(report.status, "approved");
  assert.equal(report.rows[0].approvedEntryId, publishedId);
  assert.equal(await total(report.workDate), 9);
  const published = (await connection.query("SELECT responsible_user_id,created_at,updated_by_user_id,revision FROM equipment_entries WHERE id=$1", [publishedId])).rows[0];
  assert.equal(published.responsible_user_id, foremanId);
  assert.equal(published.updated_by_user_id, engineerId);
  assert.equal(new Date(published.created_at).toISOString(), new Date(original.createdAt).toISOString());
  const stale = structuredClone(report);
  await connection.query("UPDATE equipment_entries SET revision=revision+1 WHERE id=$1", [publishedId]);
  await assert.rejects(save(engineer, report.workDate, stale.rows, stale), code("STALE_REPORT"));
  assert.equal((await read(report)).revision, report.revision);
  report = await read(report);

  // Full-day downtime blocks submission. Mixed manual values override the
  // timesheet rather than being double-counted into the report cap.
  let unavailable = await save(foreman, "2026-10-03", [row]);
  await connection.query("INSERT INTO equipment_timesheet_marks(site_id,equipment_id,work_date,productive_hours,downtime_hours,note,created_by) VALUES ($1,$2,$3,0,5,'Ремонт',$4)", [siteId, equipmentId, unavailable.workDate, marker]);
  await assert.rejects(transition(foreman, unavailable, "submit"), code("EQUIPMENT_UNAVAILABLE"));
  await connection.query("UPDATE equipment_timesheet_marks SET productive_hours=8 WHERE site_id=$1 AND equipment_id=$2 AND work_date=$3", [siteId, equipmentId, unavailable.workDate]);
  unavailable = await transition(foreman, unavailable, "submit");
  unavailable = await transition(foreman, unavailable, "reopen");
  assert.equal(unavailable.status, "draft");

  // Approved rows from other projects also consume the same equipment-day cap.
  const legacy = async (date, hours, targetSite = siteId) => insert(`INSERT INTO equipment_entries(site_id,work_date,equipment_id,shift_id,zone_id,main_work_type_id,subwork_type_id,hours,note,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Старая запись',$9) RETURNING id`, [targetSite, date, equipmentId, refs.shiftId, refs.zoneId, refs.mainWorkTypeId, refs.subworkTypeId, hours, marker]);
  await legacy("2026-10-04", 10, otherSiteId);
  const over = await save(foreman, "2026-10-04", [{ ...row, hours: 10 }, { ...row, hours: 1 }]);
  await assert.rejects(transition(foreman, over, "submit"), code("HOURS_CONFLICT"));
  assert.equal(await total(over.workDate), 10);
  const first = await transition(foreman, await save(foreman, "2026-10-05", [{ ...row, hours: 10 }, { ...row, hours: 10 }]), "submit");
  const second = await transition(otherForeman, await save(otherForeman, "2026-10-05", [{ ...row, hours: 1 }]), "submit");
  await transition(engineer, first, "approve");
  await assert.rejects(transition(engineer, second, "approve"), code("HOURS_CONFLICT"));
  assert.equal((await read(second)).status, "submitted");
  assert.equal(await total(first.workDate), 20);

  // Preflight returns all row/date issues without acquiring write locks.
  const readOnly = { ...executor, prepare(sql) { assert.match(sql.trim(), /^SELECT\b/i); assert.doesNotMatch(sql, /FOR UPDATE|pg_advisory/i); return executor.prepare(sql); }, batch() { throw new Error("Preflight must not write"); } };
  const before = await total("2026-10-04");
  const validation = await validateEquipmentReportSubmissions(readOnly, foreman, { action: "validate-submissions", siteId, reports: [
    { key: String(over.id), reportId: over.id, revision: over.revision, workDate: over.workDate, rows: over.rows },
    { key: "new:2026-10-06", workDate: "2026-10-06", rows: [{ equipmentId }, { ...row, hours: 11, note: "x".repeat(4001) }] },
  ] });
  for (const expected of ["HOURS_CONFLICT", "INCOMPLETE_ROW", "INVALID_ROW_VALUE"]) assert.ok(validation.issues.some(issue => issue.code === expected), expected);
  assert.equal(await total("2026-10-04"), before);

  // Old approved entries stay visible, and receive safe optimistic edits.
  const oldId = await legacy("2026-10-07", 5);
  const old = (await listEquipmentReports(executor, engineer, siteId, "2026-10-07", "2026-10-07")).entries.find(entry => entry.id === oldId);
  assert.ok(old && !old.orderReportId && old.equipmentName.includes("ТЕСТ001"));
  await assert.rejects(mutateEquipmentReportEntry(scoped, foreman, { action: "save-approved-entry", entryId: oldId, revision: old.revision, siteId, workDate: old.workDate, row }), code("REPORT_FORBIDDEN"));
  const edited = await mutateEquipmentReportEntry(scoped, engineer, { action: "save-approved-entry", entryId: oldId, revision: old.revision, siteId, workDate: old.workDate, row: { ...row, hours: 6 } });
  assert.equal(edited.id, old.id);
  assert.equal(edited.hours, 6);
  await assert.rejects(mutateEquipmentReportEntry(scoped, engineer, { action: "save-approved-entry", entryId: publishedId, revision: report.rows[0].approvedEntryRevision, siteId, workDate: report.workDate, row }), code("STALE_REPORT"));

  // Unchanged historical identities remain editable after catalog retirement;
  // selecting that archived unit in a new draft is still forbidden.
  await connection.query("UPDATE equipment_units SET active=0 WHERE id=$1", [equipmentId]);
  await connection.query("UPDATE equipment_project_assignments SET active=0 WHERE equipment_id=$1", [equipmentId]);
  for (const table of ["shifts", "zones", "main_work_types", "subwork_types"]) await connection.query(`UPDATE ${table} SET active=0 WHERE id=$1`, [refs[{ shifts: "shiftId", zones: "zoneId", main_work_types: "mainWorkTypeId", subwork_types: "subworkTypeId" }[table]]]);
  report = await save(engineer, report.workDate, [{ ...report.rows[0], hours: 8, note: "Историческая правка" }], report);
  assert.equal(report.rows[0].equipmentName, original.equipmentName);
  assert.equal(await total(report.workDate), 8);
  const historical = await mutateEquipmentReportEntry(scoped, engineer, { action: "save-approved-entry", entryId: edited.id, revision: edited.revision, siteId, workDate: edited.workDate, row: { ...row, hours: 5, note: "История" } });
  assert.equal(historical.hours, 5);
  await assert.rejects(save(foreman, "2026-10-08", [row]), code("INVALID_EQUIPMENT"));
  process.stdout.write("Equipment report workflow integration passed (all changes rolled back).\n");
} finally {
  await connection.query("ROLLBACK");
  connection.release();
  await pool.end();
}
