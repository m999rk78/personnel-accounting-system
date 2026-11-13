// Run explicitly against .env.local, never as part of CI against a production
// database. Every fixture and schema change is inside one rolled-back SQL tx.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { readPersonnelImportOrder } from "../app/personnelImportOrderServer.ts";

const address = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : process.env.PGHOST;
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(address), "Integration checks require a loopback PostgreSQL database.");

async function loadTypeScript(path, replacements = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(replacements)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { PostgresDatabase, PostgresStatement } = await loadTypeScript("../db/client.ts", { pg: import.meta.resolve("pg") });
const { mutatePersonnelReport, mutatePersonnelReportEntry, listPersonnelReports, validatePersonnelReportSubmissions } = await loadTypeScript("../app/personnelReportStore.ts", {
  "./personnelReportWorkflow": new URL("../app/personnelReportWorkflow.ts", import.meta.url).href,
  "./personnelImportOrderServer": new URL("../app/personnelImportOrderServer.ts", import.meta.url).href,
  "./employeeDirectoryEligibility": new URL("../app/employeeDirectoryEligibility.ts", import.meta.url).href,
});
const pool = new pg.Pool({
  ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
  ssl: false, max: 1, connectionTimeoutMillis: 5000,
});
const connection = await pool.connect();
const database = new PostgresDatabase(pool);
const executor = {
  prepare: (sql) => new PostgresStatement(database, sql, [], connection),
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.executeWith(connection));
    return results;
  },
  async readBatch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.all());
    return results;
  },
};
const scoped = {
  ...executor,
  async transaction(callback) {
    await connection.query("SAVEPOINT report_operation");
    try {
      const result = await callback(executor);
      await connection.query("RELEASE SAVEPOINT report_operation");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK TO SAVEPOINT report_operation");
      await connection.query("RELEASE SAVEPOINT report_operation");
      throw error;
    }
  },
};

try {
  await connection.query("BEGIN");
  await connection.query(await readFile(new URL("../drizzle-postgres/0019_personnel_report_approval.sql", import.meta.url), "utf8"));
  await connection.query(await readFile(new URL("../drizzle-postgres/0020_table_row_orders.sql", import.meta.url), "utf8"));
  await connection.query(await readFile(new URL("../drizzle-postgres/0021_personnel_report_row_timestamps.sql", import.meta.url), "utf8"));
  const columns = await connection.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'subwork_types' AND column_name = 'main_work_type_id'");
  if (!columns.rowCount) await connection.query(await readFile(new URL("../drizzle-postgres/0022_work_type_hierarchy.sql", import.meta.url), "utf8"));
  const marker = `approval-test-${randomUUID()}`;
  const insert = async (sql, values) => (await connection.query(sql, values)).rows[0].id;
  const siteId = await insert("INSERT INTO sites(name, code) VALUES ($1,$2) RETURNING id", [marker, marker]);
  const foremanId = await insert("INSERT INTO app_users(full_name,email,role,assigned_site_id) VALUES ($1,$2,'foreman',$3) RETURNING id", [marker, `${marker}@invalid.test`, siteId]);
  const engineerId = await insert("INSERT INTO app_users(full_name,email,role) VALUES ($1,$2,'engineer') RETURNING id", [`${marker}-engineer`, `${marker}-engineer@invalid.test`]);
  const secondForemanId = await insert("INSERT INTO app_users(full_name,email,role,assigned_site_id) VALUES ($1,$2,'foreman',$3) RETURNING id", [`${marker}-second`, `${marker}-second@invalid.test`, siteId]);
  const employeeId = await insert("INSERT INTO employees(full_name,position,employment_type) VALUES ($1,'Тестовый монтажник','ОПР') RETURNING id", [marker]);
  await connection.query("INSERT INTO employee_project_assignments(employee_id,site_id) VALUES ($1,$2)", [employeeId, siteId]);
  const refs = {};
  for (const [field, table] of Object.entries({ shiftId: "shifts", zoneId: "zones", mainWorkTypeId: "main_work_types", subworkTypeId: "subwork_types", masterId: "masters" })) {
    refs[field] = await insert(`INSERT INTO ${table}(site_id,name) VALUES ($1,$2) RETURNING id`, [siteId, marker]);
  }
  await connection.query("UPDATE subwork_types SET main_work_type_id=$1 WHERE id=$2", [refs.mainWorkTypeId, refs.subworkTypeId]);
  const actor = (id, role) => ({ id, role, fullName: marker, assignedSiteId: role === "foreman" || role === "engineer" ? siteId : null, permissions: rolePermissionTemplate(role) });
  const foreman = actor(foremanId, "foreman");
  const engineer = actor(engineerId, "engineer");
  const secondForeman = actor(secondForemanId, "foreman");
  const row = { ...refs, employeeId, hours: 6, note: "Проверка" };
  const otherWorkId = await insert("INSERT INTO main_work_types(site_id,name) VALUES ($1,$2) RETURNING id", [siteId, `${marker}-other-work`]);
  await assert.rejects(mutatePersonnelReport(scoped, foreman, { action: "save", siteId, workDate: "2026-10-25", rows: [{ ...row, mainWorkTypeId: otherWorkId }] }), /подвид не относится/);
  const approvedTotal = async () => Number((await connection.query("SELECT COALESCE(SUM(hours),0)::int AS hours FROM placement_entries WHERE employee_id=$1 AND deleted_at IS NULL", [employeeId])).rows[0].hours);
  const save = (user, date, rows) => mutatePersonnelReport(scoped, user, { action: "save", siteId, workDate: date, rows });
  const transition = (user, report, action, comment) => mutatePersonnelReport(scoped, user, { action, reportId: report.id, revision: report.revision, comment });

  // Real SQL must show the same submitted report to every permitted observer,
  // while private draft rows and state-changing actions stay separately guarded.
  await connection.query("SAVEPOINT flexible_report_rights");
  try {
    const viewerId = await insert("INSERT INTO app_users(full_name,email,role) VALUES ($1,$2,'viewer') RETURNING id", [`${marker}-viewer`, `${marker}-viewer@invalid.test`]);
    const superId = await insert("INSERT INTO app_users(full_name,email,role) VALUES ($1,$2,'superadmin') RETURNING id", [`${marker}-super`, `${marker}-super@invalid.test`]);
    const viewer = { ...actor(viewerId, "viewer"), projectAccess: { mode: "selected", siteIds: [siteId] }, canViewPendingReports: false };
    const superadmin = actor(superId, "superadmin");
    let visibleReport = await transition(foreman, await save(foreman, "2026-10-18", [row]), "submit");
    const privateReport = await save(secondForeman, "2026-10-18", [{ note: "Личный черновик другой бригады" }]);
    for (const observer of [engineer, superadmin, viewer]) {
      const result = await listPersonnelReports(scoped, observer, siteId, null, null);
      assert.ok(result.reports.some(item => item.id === visibleReport.id && item.status === "submitted"), `${observer.role}: permitted submitted report is visible`);
      assert.equal(result.reports.some(item => item.id === privateReport.id), false, `${observer.role}: another author's private draft stays hidden`);
    }
    await assert.rejects(transition(viewer, visibleReport, "approve"), error => error.code === "REPORT_FORBIDDEN");
    await assert.rejects(listPersonnelReports(scoped, { ...viewer, projectAccess: { mode: "selected", siteIds: [] } }, siteId, null, null), error => error.code === "REPORT_FORBIDDEN");
    const fullForeman = { ...foreman, permissions: rolePermissionTemplate("superadmin") };
    visibleReport = await mutatePersonnelReport(scoped, fullForeman, { action: "save", siteId, workDate: visibleReport.workDate, reportId: visibleReport.id, revision: visibleReport.revision, rows: [{ ...visibleReport.rows[0], note: "Правка по выданному разрешению" }] });
    const fullViewer = { ...viewer, permissions: rolePermissionTemplate("superadmin") };
    visibleReport = await transition(fullViewer, visibleReport, "approve");
    assert.equal(visibleReport.status, "approved");
    visibleReport = await mutatePersonnelReport(scoped, fullViewer, { action: "save", siteId, workDate: visibleReport.workDate, reportId: visibleReport.id, revision: visibleReport.revision, rows: [{ ...visibleReport.rows[0], note: "Подтверждённая правка по разрешению" }] });
    assert.equal(visibleReport.ownerUserId, foreman.id);
    assert.equal(visibleReport.rows[0].note, "Подтверждённая правка по разрешению");
    console.log("PASS: actual PostgreSQL submitted visibility for engineer/superadmin/viewer, private drafts, explicit foreman/viewer grants, readonly denial and project isolation.");
  } finally {
    await connection.query("ROLLBACK TO SAVEPOINT flexible_report_rights");
    await connection.query("RELEASE SAVEPOINT flexible_report_rights");
  }

  // Read-only preflight returns every date/employee/row issue without changing
  // drafts or accounting. Independent fixture employees keep later totals intact.
  const validationIds = [];
  for (const suffix of ["validation-first", "validation-second"]) {
    const id = await insert("INSERT INTO employees(full_name,position,employment_type) VALUES ($1,'Монтажник','ОПР') RETURNING id", [`${marker}-${suffix}`]);
    validationIds.push(id);
    await connection.query("INSERT INTO employee_project_assignments(employee_id,site_id) VALUES ($1,$2)", [id, siteId]);
  }
  for (let index = 0; index < validationIds.length; index += 1) await connection.query(`INSERT INTO placement_entries
    (site_id,work_date,employee_id,shift_id,zone_id,main_work_type_id,subwork_type_id,master_id,hours,
    position_snapshot,employee_name_snapshot,employment_type_snapshot,department_snapshot,master_name_snapshot,created_by)
    VALUES ($1,'2026-10-15',$2,$3,$4,$5,$6,$7,$8,'Монтажник',$9,'ОПР','','',$9)`,
    [siteId, validationIds[index], refs.shiftId, refs.zoneId, refs.mainWorkTypeId, refs.subworkTypeId, refs.masterId, 8 + index, marker]);
  const validationDraft = await save(foreman, "2026-10-17", [{ ...row, employeeId: validationIds[0], hours: 5 }]);
  const readOnly = {
    ...executor,
    prepare(sql) {
      assert.match(sql.trim(), /^SELECT\b/i, "preflight may only execute SELECT queries");
      assert.doesNotMatch(sql, /FOR UPDATE|pg_advisory/i, "preflight must not acquire mutation locks");
      return executor.prepare(sql);
    },
    batch() { throw new Error("Preflight must not execute mutation batches"); },
  };
  const validationRequest = { action: "validate-submissions", siteId, reports: [
    { key: "new:2026-10-15", workDate: "2026-10-15", rows: [{ ...row, employeeId: validationIds[0], hours: 4 }, { ...row, employeeId: validationIds[1], hours: 3 }] },
    { key: "new:2026-10-16", workDate: "2026-10-16", rows: [{ ...row, employeeId: validationIds[0], hours: 6 }, { ...row, employeeId: validationIds[0], hours: 5 }, { ...row, employeeId: validationIds[1], zoneId: 2147483647, masterId: null, note: "x".repeat(4001) }] },
    { key: String(validationDraft.id), workDate: validationDraft.workDate, reportId: validationDraft.id, revision: validationDraft.revision + 1, rows: validationDraft.rows },
  ] };
  const counts = async () => (await connection.query(`SELECT
    (SELECT COUNT(*)::int FROM personnel_reports WHERE site_id=$1) AS reports,
    (SELECT COUNT(*)::int FROM personnel_report_rows row JOIN personnel_reports report ON report.id=row.report_id WHERE report.site_id=$1) AS rows,
    (SELECT COALESCE(SUM(hours),0)::int FROM placement_entries WHERE site_id=$1 AND deleted_at IS NULL) AS hours`, [siteId])).rows[0];
  const beforeValidation = await counts();
  const validation = await validatePersonnelReportSubmissions(readOnly, foreman, validationRequest);
  const conflicts = validation.issues.filter(issue => issue.code === "HOURS_CONFLICT");
  assert.equal(conflicts.length, 3);
  assert.deepEqual(conflicts.filter(issue => issue.workDate === "2026-10-15").map(issue => issue.employeeId), validationIds);
  assert.deepEqual(conflicts.find(issue => issue.workDate === "2026-10-16").rowNumbers, [1, 2]);
  for (const code of ["INCOMPLETE_ROW", "INVALID_ROW_VALUE", "INVALID_REFERENCE", "STALE_REPORT"]) assert.ok(validation.issues.some(issue => issue.code === code), code);
  assert.deepEqual(await counts(), beforeValidation);
  assert.equal((await connection.query("SELECT revision,status FROM personnel_reports WHERE id=$1", [validationDraft.id])).rows[0].revision, validationDraft.revision);
  await assert.rejects(validatePersonnelReportSubmissions(readOnly, secondForeman, validationRequest), error => error.code === "REPORT_FORBIDDEN");
  await assert.rejects(validatePersonnelReportSubmissions(readOnly, { ...foreman, assignedSiteId: siteId + 99999 }, validationRequest), error => error.code === "REPORT_FORBIDDEN");
  await assert.rejects(validatePersonnelReportSubmissions(readOnly, foreman, { ...validationRequest, reports: [...validationRequest.reports, validationRequest.reports[0]] }), /ключи/);
  const ready = await validatePersonnelReportSubmissions(readOnly, foreman, { action: "validate-submissions", siteId, reports: [{ key: String(validationDraft.id), workDate: validationDraft.workDate, reportId: validationDraft.id, revision: validationDraft.revision, rows: validationDraft.rows }] });
  assert.deepEqual(ready.issues, []);

  // One workbook can span multiple dates. Every save records its full employee
  // order, even when some employees occur only on a different imported day.
  const manualKey = `project-personnel:${siteId}`;
  const importKey = `import-order:project-personnel:${siteId}`;
  const fileOrder = [validationIds[1], employeeId, validationIds[0]];
  const manualOrder = [employeeId, validationIds[0], validationIds[1]];
  await connection.query("INSERT INTO table_row_orders(id,row_ids) VALUES ($1,$2::jsonb)", [manualKey, JSON.stringify(manualOrder)]);
  let imported = await mutatePersonnelReport(scoped, foreman, { action: "save", siteId, workDate: "2026-10-13", rows: [row], importEmployeeOrder: fileOrder });
  assert.deepEqual((await readPersonnelImportOrder(executor, "project-personnel", siteId, manualOrder)).importIds, fileOrder);
  const secondDay = await mutatePersonnelReport(scoped, foreman, { action: "save", siteId, workDate: "2026-10-14", rows: [{ ...row, employeeId: validationIds[0] }], importEmployeeOrder: fileOrder });
  imported = await mutatePersonnelReport(scoped, foreman, { action: "save", siteId, workDate: imported.workDate, reportId: imported.id, revision: imported.revision, rows: imported.rows, importEmployeeOrder: fileOrder });
  assert.deepEqual((await readPersonnelImportOrder(executor, "project-personnel", siteId, manualOrder)).importIds, fileOrder);
  assert.deepEqual((await connection.query("SELECT row_ids FROM table_row_orders WHERE id=$1", [manualKey])).rows[0].row_ids, manualOrder);
  assert.equal(await approvedTotal(), 0, "saving an import order must not publish report hours");
  const untouched = await counts();
  const foreignId = await insert("INSERT INTO employees(full_name,position,employment_type) VALUES ($1,'Монтажник','ОПР') RETURNING id", [`${marker}-foreign-import-order`]);
  const inactiveId = await insert("INSERT INTO employees(full_name,position,employment_type,active) VALUES ($1,'Монтажник','ОПР',0) RETURNING id", [`${marker}-inactive-import-order`]);
  await connection.query("INSERT INTO employee_project_assignments(employee_id,site_id) VALUES ($1,$2)", [inactiveId, siteId]);
  for (const invalid of [[foreignId], [inactiveId], [employeeId, employeeId], [0], [1.5], Array.from({ length: 5001 }, (_, index) => index + 1)]) {
    await assert.rejects(mutatePersonnelReport(scoped, foreman, { action: "save", siteId, workDate: "2026-10-12", rows: [row], importEmployeeOrder: invalid }), error => error.code === "INVALID_IMPORT_ORDER");
  }
  assert.deepEqual(await counts(), untouched);
  const failingImport = { transaction: callback => scoped.transaction(tx => callback({ ...tx, prepare(sql) {
    if (sql.startsWith("UPDATE table_row_orders SET row_ids")) throw new Error("Injected import-order write failure");
    return tx.prepare(sql);
  } })) };
  await assert.rejects(mutatePersonnelReport(failingImport, foreman, { action: "save", siteId, workDate: "2026-10-12", rows: [row], importEmployeeOrder: [...fileOrder].reverse() }), /Injected import-order/);
  assert.deepEqual(await counts(), untouched, "metadata failure rolls back the report save too");
  assert.deepEqual((await connection.query("SELECT row_ids FROM table_row_orders WHERE id=$1", [importKey])).rows[0].row_ids, fileOrder);
  assert.deepEqual((await connection.query("SELECT row_ids FROM table_row_orders WHERE id=$1", [manualKey])).rows[0].row_ids, manualOrder);
  await connection.query("DELETE FROM personnel_report_rows WHERE report_id=ANY($1)", [[imported.id, secondDay.id]]);
  await connection.query("DELETE FROM personnel_reports WHERE id=ANY($1)", [[imported.id, secondDay.id]]);
  await connection.query("DELETE FROM personnel_report_rows WHERE report_id=$1", [validationDraft.id]);
  await connection.query("DELETE FROM personnel_reports WHERE id=$1", [validationDraft.id]);
  await connection.query("DELETE FROM placement_entries WHERE employee_id=ANY($1)", [validationIds]);

  // Row identity and chronology survive saving, reordering and approval.
  let chronological = await save(foreman, "2026-10-20", [{ ...row, hours: 3 }]);
  const original = chronological.rows[0];
  const saveChronological = (rows) => mutatePersonnelReport(scoped, foreman, { action: "save", siteId, workDate: chronological.workDate, reportId: chronological.id, revision: chronological.revision, rows });
  chronological = await saveChronological(chronological.rows);
  assert.equal(chronological.rows[0].id, original.id);
  assert.equal(chronological.rows[0].createdAt, original.createdAt);
  assert.equal(chronological.rows[0].updatedAt, original.updatedAt);
  await connection.query("SELECT pg_sleep(0.01)");
  chronological = await saveChronological([{ ...row, hours: 2 }, ...chronological.rows]);
  const added = chronological.rows[0];
  assert.ok(Date.parse(added.createdAt) > Date.parse(original.createdAt));
  assert.equal(chronological.rows[1].updatedAt, original.updatedAt);
  await connection.query("SELECT pg_sleep(0.01)");
  chronological = await saveChronological([chronological.rows[1], { ...chronological.rows[0], note: "Изменено" }]);
  assert.equal(chronological.rows[0].id, original.id);
  assert.equal(chronological.rows[0].updatedAt, original.updatedAt);
  assert.equal(chronological.rows[1].id, added.id);
  assert.equal(chronological.rows[1].createdAt, added.createdAt);
  assert.ok(Date.parse(chronological.rows[1].updatedAt) > Date.parse(added.updatedAt));
  await assert.rejects(saveChronological([{ ...row, id: 2147483647 }]), error => error.code === "INVALID_REPORT_ROW");
  await assert.rejects(saveChronological([chronological.rows[0], chronological.rows[0]]), error => error.code === "INVALID_REPORT_ROW");
  const beforeApproval = chronological.rows.map(item => ({ id: item.id, createdAt: item.createdAt, updatedAt: item.updatedAt }));
  chronological = await transition(foreman, chronological, "submit");
  chronological = await transition(engineer, chronological, "approve");
  const published = (await listPersonnelReports(scoped, engineer, siteId, chronological.workDate, chronological.workDate)).entries;
  for (const original of beforeApproval) {
    const entry = published.find(item => chronological.rows.find(row => row.id === original.id)?.approvedEntryId === item.id);
    assert.equal(entry.createdAt, original.createdAt);
    assert.equal(entry.updatedAt, original.updatedAt);
  }
  // Keep the existing accounting assertions below independent of this scenario.
  await connection.query("DELETE FROM personnel_report_rows WHERE report_id=$1", [chronological.id]);
  await connection.query("DELETE FROM placement_entries WHERE site_id=$1 AND work_date='2026-10-20'", [siteId]);
  await connection.query("DELETE FROM personnel_reports WHERE id=$1", [chronological.id]);

  let report = await save(foreman, "2026-10-28", [{ employeeId }]);
  assert.equal(report.status, "draft");
  assert.equal(await approvedTotal(), 0);
  await assert.rejects(transition(foreman, report, "submit"), /заполните/);
  report = await mutatePersonnelReport(scoped, foreman, { action: "save", reportId: report.id, revision: report.revision, siteId, workDate: report.workDate, rows: [row] });
  assert.equal(await approvedTotal(), 0);
  report = await transition(foreman, report, "submit");
  assert.equal(report.status, "submitted");
  assert.equal(await approvedTotal(), 0);
  assert.equal((await listPersonnelReports(scoped, engineer, siteId, null, null)).entries.length, 0);
  await assert.rejects(transition(foreman, report, "approve"), (error) => error.code === "REVIEW_FORBIDDEN");
  await assert.rejects(transition(secondForeman, report, "reopen"), (error) => error.code === "REPORT_FORBIDDEN");
  await assert.rejects(transition(engineer, { ...report, revision: report.revision - 1 }, "approve"), (error) => error.code === "STALE_REPORT");
  report = await transition(engineer, report, "reject", "Проверьте зону");
  assert.equal(report.status, "rejected");
  assert.equal(report.reviewComment, "Проверьте зону");
  report = await transition(foreman, report, "submit");
  // Reviewers edit submitted reports without publishing them or changing owner/status.
  const edit = (user, current, rows) => mutatePersonnelReport(scoped, user, { action: "save", siteId: current.siteId, workDate: current.workDate, reportId: current.id, revision: current.revision, rows });
  await assert.rejects(edit(foreman, report, report.rows), error => error.code === "REPORT_FORBIDDEN");
  const oldSubmitted = report;
  report = await edit(engineer, report, [{ ...report.rows[0], note: "Исправлено инженером" }]);
  assert.equal(report.status, "submitted");
  assert.equal(report.ownerUserId, foremanId);
  assert.equal(report.rows[0].note, "Исправлено инженером");
  assert.equal(await approvedTotal(), 0);
  await assert.rejects(transition(engineer, oldSubmitted, "approve"), error => error.code === "STALE_REPORT");
  await assert.rejects(edit(engineer, report, [{ ...report.rows[0], hours: null }]), /заполните/);
  const submitted = report;
  report = await transition(engineer, report, "approve");
  assert.equal(report.status, "approved");
  assert.equal(await approvedTotal(), 6);
  assert.ok(report.rows[0].approvedEntryId);
  assert.equal((await listPersonnelReports(scoped, engineer, siteId, null, null)).entries.length, 1);
  await assert.rejects(transition(engineer, submitted, "approve"), (error) => error.code === "STALE_REPORT");
  await assert.rejects(transition(engineer, report, "approve"), (error) => error.code === "INVALID_TRANSITION");
  assert.equal(await approvedTotal(), 6);

  // Approved corrections update the same accounting row, not a second copy.
  const firstEntryId = report.rows[0].approvedEntryId;
  const firstCreatedAt = report.rows[0].createdAt;
  const oldApproved = report;
  await assert.rejects(edit(foreman, report, report.rows), error => error.code === "REPORT_FORBIDDEN");
  await assert.rejects(edit(engineer, report, [{ ...report.rows[0], approvedEntryRevision: undefined }]), error => error.code === "STALE_REPORT");
  report = await edit(engineer, report, [{ ...report.rows[0], hours: 8, note: "Исправлены часы" }]);
  assert.equal(report.status, "approved");
  assert.equal(report.ownerUserId, foremanId);
  assert.equal(report.rows[0].approvedEntryId, firstEntryId);
  assert.equal(report.rows[0].approvedEntryRevision, 2);
  assert.equal(report.rows[0].createdAt, firstCreatedAt);
  assert.equal(await approvedTotal(), 8);
  assert.equal((await connection.query("SELECT COUNT(*)::int AS count FROM placement_entries WHERE site_id=$1 AND deleted_at IS NULL", [siteId])).rows[0].count, 1);
  await assert.rejects(edit(engineer, oldApproved, oldApproved.rows), error => error.code === "STALE_REPORT");
  // External edits through an older API also remain authoritative and invalidate stale rows.
  await connection.query("UPDATE placement_entries SET note='Другая вкладка',revision=revision+1 WHERE id=$1", [firstEntryId]);
  await assert.rejects(edit(engineer, report, report.rows), error => error.code === "STALE_REPORT");
  report = (await listPersonnelReports(scoped, engineer, siteId, null, null)).reports.find(item => item.id === report.id);
  assert.equal(report.rows[0].note, "Другая вкладка");
  report = await edit({ ...engineer, role: "superadmin" }, report, [{ ...report.rows[0], hours: 6 }]);
  assert.equal(await approvedTotal(), 6);

  // Two foremen can prepare independent drafts. Only the first approval may
  // consume the remaining daily hours; the second stays submitted on conflict.
  let other = await save(secondForeman, "2026-10-28", [{ ...row, hours: 4 }]);
  other = await transition(secondForeman, other, "submit");
  let extra = await save(foreman, "2026-10-28", [{ ...row, hours: 4 }]);
  extra = await transition(foreman, extra, "submit");
  other = await transition(engineer, other, "approve");
  assert.equal(other.status, "approved");
  assert.equal(await approvedTotal(), 10);
  await assert.rejects(transition(engineer, extra, "approve"), (error) => error.code === "HOURS_CONFLICT");
  assert.equal((await connection.query("SELECT status FROM personnel_reports WHERE id=$1", [extra.id])).rows[0].status, "submitted");
  assert.equal(await approvedTotal(), 10);

  // Corrections respect other foremen's approved hours and roll back on conflict.
  const beforeConflict = report;
  await assert.rejects(edit(engineer, report, [{ ...report.rows[0], hours: 7 }]), error => error.code === "HOURS_CONFLICT");
  assert.equal(await approvedTotal(), 10);
  report = (await listPersonnelReports(scoped, engineer, siteId, null, null)).reports.find(item => item.id === report.id);
  assert.equal(report.revision, beforeConflict.revision);
  assert.equal(report.rows[0].hours, 6);
  // Swapping an employee releases their old hours, without changing ownership.
  const replacementId = await insert("INSERT INTO employees(full_name,position,employment_type) VALUES ($1,'Монтажник','ОПР') RETURNING id", [`${marker}-replacement`]);
  await connection.query("INSERT INTO employee_project_assignments(employee_id,site_id) VALUES ($1,$2)", [replacementId, siteId]);
  report = await edit(engineer, report, [{ ...report.rows[0], employeeId: replacementId, hours: 8 }]);
  assert.equal(await approvedTotal(), 4);
  report = await edit(engineer, report, [{ ...report.rows[0], employeeId, hours: 6 }]);
  assert.equal(await approvedTotal(), 10);
  // Add/remove rows atomically; reordering never duplicates published entries.
  report = await edit(engineer, report, [report.rows[0], { ...row, employeeId: replacementId, hours: 2 }]);
  const addedApprovedId = report.rows[1].approvedEntryId;
  report = await edit(engineer, report, [report.rows[1], report.rows[0]]);
  assert.equal(report.rows[0].approvedEntryId, addedApprovedId);
  report = await edit(engineer, report, [report.rows[1]]);
  assert.equal((await connection.query("SELECT deleted_at FROM placement_entries WHERE id=$1", [addedApprovedId])).rows[0].deleted_at !== null, true);
  assert.equal(report.rows[0].approvedEntryId, firstEntryId);
  // Same-size replacement still requires create/delete permissions.
  const updateOnly = { ...engineer, permissions: { ...engineer.permissions, workers_report: { view: true, create: false, update: true, delete: false } } };
  await assert.rejects(edit(updateOnly, report, [row]), error => error.code === "REPORT_FORBIDDEN");

  // A database error part-way through publishing two rows must roll back even
  // the first INSERT and its stage-to-final link.
  let atomic = await save(foreman, "2026-10-27", [{ ...row, hours: 3 }, { ...row, hours: 3 }]);
  atomic = await transition(foreman, atomic, "submit");
  let insertedRows = 0;
  const failing = {
    transaction: (callback) => scoped.transaction((tx) => callback({
      ...tx,
      prepare(sql) {
        if (/INSERT INTO placement_entries/.test(sql) && ++insertedRows === 2) throw new Error("Injected publication failure");
        return tx.prepare(sql);
      },
    })),
  };
  await assert.rejects(mutatePersonnelReport(failing, engineer, { action: "approve", reportId: atomic.id, revision: atomic.revision }), /Injected/);
  assert.equal(await approvedTotal(), 10);
  assert.equal((await connection.query("SELECT status FROM personnel_reports WHERE id=$1", [atomic.id])).rows[0].status, "submitted");
  assert.equal((await connection.query("SELECT COUNT(*)::int AS count FROM personnel_report_rows WHERE report_id=$1 AND approved_entry_id IS NOT NULL", [atomic.id])).rows[0].count, 0);

  // The daily cap is shared by all sites, not just the current project's table.
  const secondSiteId = await insert("INSERT INTO sites(name,code) VALUES ($1,$2) RETURNING id", [`${marker}-site-2`, `${marker}-site-2`]);
  await connection.query("INSERT INTO employee_project_assignments(employee_id,site_id) VALUES ($1,$2)", [employeeId, secondSiteId]);
  const secondRefs = {};
  for (const [field, table] of Object.entries({ shiftId: "shifts", zoneId: "zones", mainWorkTypeId: "main_work_types", subworkTypeId: "subwork_types", masterId: "masters" })) {
    secondRefs[field] = await insert(`INSERT INTO ${table}(site_id,name) VALUES ($1,$2) RETURNING id`, [secondSiteId, marker]);
  }
  await connection.query("UPDATE subwork_types SET main_work_type_id=$1 WHERE id=$2", [secondRefs.mainWorkTypeId, secondRefs.subworkTypeId]);
  let crossSite = await mutatePersonnelReport(scoped, engineer, { action: "save", siteId: secondSiteId, workDate: "2026-10-26", rows: [{ ...secondRefs, employeeId, hours: 8 }] });
  crossSite = await transition(engineer, crossSite, "submit");
  crossSite = await transition(engineer, crossSite, "approve");
  assert.equal(crossSite.status, "approved");
  const blocked = await save(foreman, "2026-10-26", [{ ...row, hours: 3 }]);
  await assert.rejects(transition(foreman, blocked, "submit"), (error) => error.code === "HOURS_CONFLICT");
  const scopedHistory = await listPersonnelReports(scoped, foreman, siteId, null, null);
  assert.equal(scopedHistory.reports.some(item => ["draft", "rejected"].includes(item.status) && item.ownerUserId !== foreman.id), false, "personal drafts never leak between authors");
  assert.ok(scopedHistory.reports.some(item => item.status === "submitted"), "submitted reports remain visible according to the status grant");

  // Legacy approved entries use their own revisions and the same shared hour cap.
  const legacyId = await insert(`INSERT INTO placement_entries(site_id,work_date,employee_id,shift_id,zone_id,main_work_type_id,subwork_type_id,master_id,hours,
    position_snapshot,employee_name_snapshot,employment_type_snapshot,department_snapshot,master_name_snapshot,created_by,responsible_user_id)
    VALUES ($1,'2026-10-19',$2,$3,$4,$5,$6,$7,5,'Монтажник',$8,'ОПР','','',$8,$9) RETURNING id`,
    [siteId, employeeId, refs.shiftId, refs.zoneId, refs.mainWorkTypeId, refs.subworkTypeId, refs.masterId, marker, foremanId]);
  const legacy = { action: "save-approved-entry", entryId: legacyId, revision: 1, siteId, workDate: "2026-10-19", row: { ...row, hours: 8, note: "Старая запись исправлена" } };
  await assert.rejects(mutatePersonnelReportEntry(scoped, foreman, legacy), error => error.code === "REPORT_FORBIDDEN");
  const corrected = await mutatePersonnelReportEntry(scoped, engineer, legacy);
  assert.equal(corrected.id, legacyId);
  assert.equal(corrected.hours, 8);
  assert.equal(corrected.revision, 2);
  assert.equal(corrected.responsibleUserId, foremanId);
  await assert.rejects(mutatePersonnelReportEntry(scoped, engineer, legacy), error => error.code === "STALE_REPORT");
  await assert.rejects(mutatePersonnelReportEntry(scoped, engineer, { ...legacy, revision: 2, row: { ...row, employeeId: replacementId, hours: null } }), /заполните/);
  await assert.rejects(mutatePersonnelReportEntry(scoped, engineer, { ...legacy, entryId: firstEntryId, workDate: report.workDate }), error => error.code === "STALE_REPORT");

  console.log("PASS: reviewer submitted/approved/legacy corrections, accounting synchronization, ownership, stale revisions, shared hours, atomicity; partial drafts, submit isolation, roles/ownership, revisions, return/resubmit, atomic approval, duplicate approval, cross-site daily-hours conflicts and rollback.");
} finally {
  await connection.query("ROLLBACK");
  connection.release();
  await pool.end();
}
