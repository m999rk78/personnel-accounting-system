// Invoked by test-prepush-postgres.mjs only. The database must be the uniquely
// named disposable QA database; this script never accepts a business database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { buildPersonnelTimesheetRange } from "../app/timesheetExportRange.ts";

assert.ok(process.env.DATABASE_URL, "Run through the disposable PostgreSQL QA runner.");
const address = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(address.hostname));
assert.match(address.pathname, /^\/personnel_qa_[a-f0-9]{32}$/);
async function load(path, replacements = {}) {
  let code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  for (const [specifier, target] of Object.entries(replacements)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { PostgresDatabase } = await load("../db/client.ts", { pg: import.meta.resolve("pg") });
const personnel = await load("../app/personnelReportStore.ts", { "./personnelReportWorkflow": new URL("../app/personnelReportWorkflow.ts", import.meta.url).href });
const equipment = await load("../app/equipmentReportStore.ts", {
  "./equipmentReportWorkflow": new URL("../app/equipmentReportWorkflow.ts", import.meta.url).href,
  "./equipmentExcel": new URL("../app/equipmentExcel.ts", import.meta.url).href,
  "./equipmentAvailability": new URL("../app/equipmentAvailability.ts", import.meta.url).href,
});
const pool = new pg.Pool({ connectionString: address.href, ssl: false, max: 8, connectionTimeoutMillis: 5000, options: "-c statement_timeout=20000 -c lock_timeout=15000" });
const db = new PostgresDatabase(pool);
const insert = async (sql, values) => (await pool.query(sql, values)).rows[0].id;
const rejectedCode = (...codes) => error => codes.includes(error.code);

/** Check the same GET payload and calculation functions used by the real tab and Excel export. */
async function verifyPersonnelTimesheetApi({ marker, siteId, otherSiteId, foreman, otherForeman, engineer, refs }) {
  const boundaryUrl = `data:text/javascript;base64,${Buffer.from("export let db,user; export function configure(database,actor){db=database;user=actor;} export function getDatabase(){return db;} export async function getAuthUser(){return user;} export function assertSameOrigin(){} export async function withAuditTrail(request,handler){return handler(request);}").toString("base64")}`;
  const boundary = await import(boundaryUrl);
  boundary.configure(db, engineer);
  const timesheet = await load("../app/api/timesheet/route.ts", {
    "../../../db/client": boundaryUrl, "../../auth": boundaryUrl, "../../auditLog": boundaryUrl,
    "../../roles": new URL("../app/roles.ts", import.meta.url).href,
    "../../permissionModel": new URL("../app/permissionModel.ts", import.meta.url).href,
  });
  const viewSource = await readFile(new URL("../app/TimesheetView.tsx", import.meta.url), "utf8");
  const viewFile = ts.createSourceFile("TimesheetView.tsx", viewSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const helperNames = ["effectiveHours", "markValue", "isReportTracked", "isMismatch"];
  const helperCode = viewFile.statements.filter(node => ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.text)).map(node => node.getText(viewFile)).join("\n");
  const viewJs = ts.transpileModule(`${helperCode}\nexport {${helperNames.join(",")}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const view = await import(`data:text/javascript;base64,${Buffer.from(viewJs).toString("base64")}`);
  const read = async (month, project = siteId, database = db) => {
    boundary.configure(database, engineer);
    const response = await timesheet.GET(new Request(`http://localhost/api/timesheet?siteId=${project}&month=${month}`));
    assert.equal(response.status, 200, `actual timesheet GET ${project}/${month}`);
    const body = await response.json();
    assert.equal(body.month, month); assert.equal(body.siteId, project);
    return body;
  };
  const cell = (body, employeeId, workDate) => {
    const entry = body.entries.find(item => item.employeeId === employeeId && item.workDate === workDate);
    const mark = body.marks.find(item => item.employeeId === employeeId && item.workDate === workDate);
    const employee = body.employees.find(item => item.id === employeeId);
    return { report: Number(entry?.hours ?? 0), effective: view.effectiveHours(entry, mark), value: view.markValue(mark, entry), mismatch: employee ? view.isMismatch(employee, entry, mark) : false };
  };
  const employee = async suffix => {
    const id = await insert("INSERT INTO employees(full_name,position,employment_type) VALUES($1,'Монтажник','ОПР') RETURNING id", [`${marker}-api-${suffix}`]);
    await pool.query("INSERT INTO employee_project_assignments(employee_id,site_id) VALUES($1,$2)", [id, siteId]);
    return id;
  };
  const row = (employeeId, hours, references = refs) => ({ ...references, employeeId, hours, note: "Проверка фактического табеля" });
  const save = (owner, workDate, rows, project = siteId) => personnel.mutatePersonnelReport(db, owner, { action: "save", siteId: project, workDate, rows });
  const transition = (owner, report, action) => personnel.mutatePersonnelReport(db, owner, { action, reportId: report.id, revision: report.revision });
  const approve = async (owner, workDate, rows, project = siteId) => transition(engineer, await transition(owner, await save(owner, workDate, rows, project), "submit"), "approve");
  const move = (report, workDate) => personnel.mutatePersonnelReportDate(db, engineer, { action: "change-date", reportId: report.id, revision: report.revision, workDate });
  const legacy = (employeeId, workDate, hours) => insert(`INSERT INTO placement_entries(site_id,work_date,employee_id,shift_id,zone_id,main_work_type_id,subwork_type_id,master_id,hours,note,employee_name_snapshot,employment_type_snapshot,position_snapshot,master_name_snapshot,created_by,responsible_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'Старая запись',$10,'ОПР','Архивная должность','Архивный мастер',$10,$11) RETURNING id`, [siteId, workDate, employeeId, refs.shiftId, refs.zoneId, refs.mainWorkTypeId, refs.subworkTypeId, refs.masterId, hours, marker, foreman.id]);

  const firstEmployee = await employee("move");
  let first = await approve(foreman, "2031-01-15", [row(firstEmployee, 8)]);
  let body = await read("2031-01");
  assert.deepEqual(cell(body, firstEmployee, "2031-01-15"), { report: 8, effective: 8, value: "8", mismatch: false });
  assert.equal(cell(body, firstEmployee, "2031-01-16").report, 0);
  const oldRevision = first.revision;
  first = await move(first, "2031-01-16");
  body = await read("2031-01");
  assert.deepEqual(cell(body, firstEmployee, "2031-01-15"), { report: 0, effective: 0, value: "", mismatch: false });
  assert.deepEqual(cell(body, firstEmployee, "2031-01-16"), { report: 8, effective: 8, value: "8", mismatch: false });
  const noOp = await move(first, first.workDate);
  assert.equal(noOp.revision, first.revision, "repeating the same date does not duplicate hours or revisions");
  await assert.rejects(move({ ...first, revision: oldRevision }, "2031-01-17"), rejectedCode("STALE_REPORT"));
  assert.deepEqual(await read("2031-01"), body, "stale retry leaves the actual timesheet unchanged");

  // A day can contain several approved reports. Move only the chosen report's hours.
  const shared = await approve(foreman, "2031-10-31", [row(firstEmployee, 8)]);
  await approve(otherForeman, "2031-10-31", [row(firstEmployee, 2)]);
  const destination = await approve(otherForeman, "2031-11-01", [row(firstEmployee, 2)]);
  assert.equal(cell(await read("2031-10"), firstEmployee, "2031-10-31").report, 10);
  assert.equal(cell(await read("2031-11"), firstEmployee, "2031-11-01").report, 2);
  await move(shared, "2031-11-01");
  const oldMonth = await read("2031-10"), newMonth = await read("2031-11");
  assert.equal(cell(oldMonth, firstEmployee, "2031-10-31").report, 2);
  assert.equal(cell(newMonth, firstEmployee, "2031-11-01").report, 10);
  assert.equal((await personnel.listPersonnelReports(db, engineer, siteId, "2031-11-01", "2031-11-01")).reports.find(item => item.id === destination.id).revision, destination.revision);
  const crossMonthExport = buildPersonnelTimesheetRange([oldMonth, newMonth], "2031-10-31", "2031-11-01").rows.find(item => item.fullName === newMonth.employees.find(item => item.id === firstEmployee).fullName);
  assert.deepEqual(crossMonthExport.dailyReportHours, [2, 10]);
  assert.deepEqual(crossMonthExport.dailyTimesheetHours, [2, 10]);
  assert.equal(crossMonthExport.reportHours, 12);

  const secondEmployee = await employee("other");
  let annual = await approve(foreman, "2031-12-31", [row(firstEmployee, 5), row(secondEmployee, 7)]);
  annual = await move(annual, "2032-01-01");
  assert.equal(cell(await read("2031-12"), firstEmployee, "2031-12-31").report, 0);
  const annualNewMonth = await read("2032-01");
  assert.equal(cell(annualNewMonth, firstEmployee, "2032-01-01").report, 5);
  assert.equal(cell(annualNewMonth, secondEmployee, "2032-01-01").report, 7);
  assert.equal(annual.rows.length, 2, "every employee in the daily report follows its header date");
  let leap = await approve(foreman, "2032-02-28", [row(firstEmployee, 6)]);
  leap = await move(leap, "2032-02-29");
  assert.equal(cell(await read("2032-02"), firstEmployee, "2032-02-28").report, 0);
  assert.equal(cell(await read("2032-02"), firstEmployee, "2032-02-29").report, 6);
  await move(leap, "2032-03-01");
  assert.equal(cell(await read("2032-02"), firstEmployee, "2032-02-29").report, 0);
  assert.equal(cell(await read("2032-03"), firstEmployee, "2032-03-01").report, 6);

  let pending = await save(foreman, "2032-04-01", [row(firstEmployee, 8)]);
  pending = await move(pending, "2032-04-02");
  assert.equal(cell(await read("2032-04"), firstEmployee, "2032-04-02").report, 0, "a moved draft is not published");
  pending = await transition(foreman, pending, "submit");
  pending = await move(pending, "2032-04-03");
  assert.equal(cell(await read("2032-04"), firstEmployee, "2032-04-03").report, 0, "review does not add hours early");
  await transition(engineer, pending, "approve");
  assert.equal(cell(await read("2032-04"), firstEmployee, "2032-04-03").report, 8);

  const oldId = await legacy(firstEmployee, "2032-05-10", 4);
  await legacy(firstEmployee, "2032-05-10", 2);
  await legacy(secondEmployee, "2032-05-11", 3);
  const oldEntry = (await personnel.listPersonnelReports(db, engineer, siteId, "2032-05-10", "2032-05-10")).entries.find(item => item.id === oldId);
  await personnel.mutatePersonnelReportEntryDate(db, engineer, { action: "change-entry-date", entryId: oldId, revision: oldEntry.revision, siteId, workDate: "2032-05-11" });
  const legacyMonth = await read("2032-05");
  assert.equal(cell(legacyMonth, firstEmployee, "2032-05-10").report, 2);
  assert.equal(cell(legacyMonth, firstEmployee, "2032-05-11").report, 4);
  assert.equal(cell(legacyMonth, secondEmployee, "2032-05-11").report, 3);

  const otherRefs = {};
  for (const [key, table] of Object.entries({ shiftId: "shifts", zoneId: "zones", mainWorkTypeId: "main_work_types", subworkTypeId: "subwork_types", masterId: "masters" })) otherRefs[key] = await insert(`INSERT INTO ${table}(site_id,name) VALUES($1,$2) RETURNING id`, [otherSiteId, `${marker}-foreign-api`]);
  await pool.query("UPDATE subwork_types SET main_work_type_id=$1 WHERE id=$2", [otherRefs.mainWorkTypeId, otherRefs.subworkTypeId]);
  await pool.query("INSERT INTO employee_project_assignments(employee_id,site_id) VALUES($1,$2)", [firstEmployee, otherSiteId]);
  await approve(engineer, "2032-06-02", [row(firstEmployee, 7, otherRefs)], otherSiteId);
  const capSource = await approve(foreman, "2032-06-01", [row(firstEmployee, 4)]);
  const capBefore = await read("2032-06"), otherBefore = await read("2032-06", otherSiteId);
  await assert.rejects(move(capSource, "2032-06-02"), rejectedCode("HOURS_CONFLICT"));
  assert.deepEqual(await read("2032-06"), capBefore);
  assert.deepEqual(await read("2032-06", otherSiteId), otherBefore);

  // Manual timesheet corrections are intentionally independent; neither day loses its mark.
  const manual = await approve(foreman, "2032-07-10", [row(firstEmployee, 8)]);
  for (const [workDate, value] of [["2032-07-10", "6"], ["2032-07-11", "В"]]) {
    boundary.configure(db, engineer);
    const response = await timesheet.POST(new Request("http://localhost/api/timesheet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId, employeeId: firstEmployee, workDate, value, note: "Ручная корректировка" }) }));
    assert.equal(response.status, 200, "create an ordinary manual timesheet mark through the real API");
  }
  const manualMarksBefore = (await pool.query("SELECT * FROM timesheet_marks WHERE site_id=$1 AND employee_id=$2 ORDER BY work_date", [siteId, firstEmployee])).rows;
  await move(manual, "2032-07-11");
  const manualMonth = await read("2032-07");
  assert.deepEqual(cell(manualMonth, firstEmployee, "2032-07-10"), { report: 0, effective: 6, value: "6", mismatch: true });
  assert.deepEqual(cell(manualMonth, firstEmployee, "2032-07-11"), { report: 8, effective: 0, value: "В", mismatch: true });
  assert.deepEqual((await pool.query("SELECT * FROM timesheet_marks WHERE site_id=$1 AND employee_id=$2 ORDER BY work_date", [siteId, firstEmployee])).rows, manualMarksBefore);
  const manualExport = buildPersonnelTimesheetRange([manualMonth], "2032-07-10", "2032-07-11").rows.find(item => item.fullName === manualMonth.employees.find(item => item.id === firstEmployee).fullName);
  assert.deepEqual(manualExport.dailyReportHours, [0, 8]); assert.deepEqual(manualExport.dailyTimesheetHours, [6, 0]); assert.deepEqual(manualExport.dailyValues, [6, "В"]);

  // Historical OPR snapshots stay report-driven even if the employee is now ITR or archived.
  const historicEmployee = await employee("historic");
  let historic = await approve(foreman, "2033-08-31", [row(historicEmployee, 6)]);
  await pool.query("UPDATE employee_project_assignments SET active=0 WHERE employee_id=$1", [historicEmployee]);
  await pool.query("UPDATE employees SET active=0, employment_type='ИТР', position='Изменённая должность' WHERE id=$1", [historicEmployee]);
  assert.ok((await read("2033-08")).employees.some(item => item.id === historicEmployee), "the old month retains archived historical participants");
  historic = await move(historic, "2033-09-01");
  const historicOldMonth = await read("2033-08"), historicNewMonth = await read("2033-09");
  assert.equal(historicOldMonth.employees.some(item => item.id === historicEmployee), false, "an inactive participant leaves the source month after their last entry moves away");
  assert.ok(historicNewMonth.employees.some(item => item.id === historicEmployee));
  assert.equal(cell(historicOldMonth, historicEmployee, "2033-08-31").report, 0);
  assert.equal(cell(historicNewMonth, historicEmployee, "2033-09-01").report, 6);
  assert.equal(cell(historicNewMonth, historicEmployee, "2033-09-01").effective, 6);
  assert.equal(historic.rows[0].employmentType, "ОПР"); assert.equal(historic.rows[0].positionSnapshot, "Монтажник");
  const historicExport = buildPersonnelTimesheetRange([historicOldMonth, historicNewMonth], "2033-08-31", "2033-09-01").rows.find(item => item.fullName === historicNewMonth.employees.find(item => item.id === historicEmployee).fullName);
  assert.deepEqual(historicExport.dailyReportHours, [0, 6], "Excel must retain historical OPR hours despite the employee's current ITR type");
  assert.deepEqual(historicExport.dailyTimesheetHours, [0, 6]);

  // Pause a real GET after its employee query. A date change commits while the
  // other two queries wait; all three must still use one PostgreSQL snapshot.
  const racingEmployee = await employee("reader-race");
  const racingReport = await approve(foreman, "2034-10-31", [row(racingEmployee, 8)]);
  await pool.query("UPDATE employee_project_assignments SET active=0 WHERE employee_id=$1", [racingEmployee]);
  await pool.query("UPDATE employees SET active=0 WHERE id=$1", [racingEmployee]);
  let releaseReader, employeeQueryDone, employeeQueryFailed, timeout;
  const continueReader = new Promise(resolve => { releaseReader = resolve; });
  const pausedReader = new Promise((resolve, reject) => { employeeQueryDone = resolve; employeeQueryFailed = reject; });
  const gatedDatabase = {
    prepare: db.prepare.bind(db),
    transaction: callback => db.transaction(transaction => callback({
      prepare: transaction.prepare.bind(transaction),
      async readBatch(statements) {
        const employees = await statements[0].all();
        employeeQueryDone();
        await continueReader;
        const results = [employees];
        for (const statement of statements.slice(1)) results.push(await statement.all());
        return results;
      },
    })),
  };
  const reading = read("2034-11", siteId, gatedDatabase).catch(error => { employeeQueryFailed(error); return { qaError: error }; });
  try {
    await Promise.race([pausedReader, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("The actual timesheet GET did not reach its controlled read boundary.")), 5000); })]);
    await move(racingReport, "2034-11-01");
  } finally {
    clearTimeout(timeout);
    releaseReader();
  }
  const duringMove = await reading;
  if (duringMove.qaError) throw duringMove.qaError;
  assert.equal(duringMove.employees.some(item => item.id === racingEmployee), false);
  assert.equal(cell(duringMove, racingEmployee, "2034-11-01").report, 0, "a paused GET must not combine the old employee list with newly committed report rows");
  const afterReadMove = await read("2034-11");
  assert.ok(afterReadMove.employees.some(item => item.id === racingEmployee));
  assert.equal(cell(afterReadMove, racingEmployee, "2034-11-01").report, 8);
  assert.equal((await read("2034-10")).employees.some(item => item.id === racingEmployee), false);

  // Fail after the published dates and header have already been updated. The
  // real PostgreSQL transaction must restore versions and both day totals.
  const rollbackReport = await approve(foreman, "2035-01-01", [row(firstEmployee, 5)]);
  const readRollbackState = async () => ({
    reports: (await pool.query("SELECT * FROM personnel_reports WHERE id=$1", [rollbackReport.id])).rows,
    rows: (await pool.query("SELECT * FROM personnel_report_rows WHERE report_id=$1 ORDER BY id", [rollbackReport.id])).rows,
    entries: (await pool.query("SELECT e.* FROM placement_entries e JOIN personnel_report_rows r ON r.approved_entry_id=e.id WHERE r.report_id=$1 ORDER BY e.id", [rollbackReport.id])).rows,
    timesheet: await read("2035-01"),
  });
  const rollbackBefore = await readRollbackState();
  const failureName = `qa_date_failure_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`CREATE FUNCTION ${failureName}() RETURNS trigger LANGUAGE plpgsql AS $qa$ BEGIN IF NEW.site_id=${siteId} AND NEW.work_date=DATE '2035-01-02' THEN RAISE EXCEPTION 'Synthetic date marker failure'; END IF; RETURN NEW; END; $qa$`);
  try {
    await pool.query(`CREATE TRIGGER ${failureName} BEFORE INSERT OR UPDATE ON placement_report_days FOR EACH ROW EXECUTE FUNCTION ${failureName}()`);
    try {
      await assert.rejects(move(rollbackReport, "2035-01-02"), /Synthetic date marker failure/);
      assert.deepEqual(await readRollbackState(), rollbackBefore, "mid-write database failure restores the full report, entry versions and actual timesheet");
    } finally { await pool.query(`DROP TRIGGER ${failureName} ON placement_report_days`); }
  } finally { await pool.query(`DROP FUNCTION ${failureName}()`); }
  console.log("PASS: actual personnel timesheet GET + view/export calculations: old/new day totals, partial overlaps, cross-month/year/leap moves, pending isolation, legacy rows, global project cap, unchanged manual overrides, archived OPR snapshots, Excel parity, a concurrent snapshot reader and mid-write database rollback.");
}

try {
  assert.equal((await pool.query("SELECT current_database() AS name")).rows[0].name, address.pathname.slice(1));
  const marker = `date-qa-${randomUUID()}`;
  const siteId = await insert("INSERT INTO sites(name,code) VALUES ($1,$1) RETURNING id", [marker]);
  const otherSiteId = await insert("INSERT INTO sites(name,code) VALUES ($1,$1) RETURNING id", [`${marker}-other`]);
  const foremanIds = [];
  for (const suffix of ["first", "second"]) foremanIds.push(await insert("INSERT INTO app_users(full_name,email,role,assigned_site_id) VALUES ($1,$2,'foreman',$3) RETURNING id", [`${marker}-${suffix}`, `${marker}-${suffix}@invalid.test`, siteId]));
  const engineerId = await insert("INSERT INTO app_users(full_name,email,role) VALUES ($1,$2,'engineer') RETURNING id", [`${marker}-engineer`, `${marker}-engineer@invalid.test`]);
  const actor = (id, role) => ({ id, role, fullName: marker, assignedSiteId: role === "foreman" ? siteId : null, projectAccess: role === "foreman" ? { mode: "selected", siteIds: [siteId] } : { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate(role) });
  const foreman = actor(foremanIds[0], "foreman"), otherForeman = actor(foremanIds[1], "foreman"), engineer = actor(engineerId, "engineer"), viewer = actor(engineerId, "viewer");
  const foreign = { ...engineer, projectAccess: { mode: "selected", siteIds: [otherSiteId] } };
  const refs = {};
  for (const [key, table] of Object.entries({ shiftId: "shifts", zoneId: "zones", mainWorkTypeId: "main_work_types", subworkTypeId: "subwork_types", masterId: "masters" })) refs[key] = await insert(`INSERT INTO ${table}(site_id,name) VALUES ($1,$2) RETURNING id`, [siteId, marker]);
  await pool.query("UPDATE subwork_types SET main_work_type_id=$1 WHERE id=$2", [refs.mainWorkTypeId, refs.subworkTypeId]);
  const employeeId = await insert("INSERT INTO employees(full_name,position,employment_type) VALUES ($1,'Монтажник','ОПР') RETURNING id", [marker]);
  await pool.query("INSERT INTO employee_project_assignments(employee_id,site_id) VALUES ($1,$2)", [employeeId, siteId]);
  const equipmentId = await insert("INSERT INTO equipment_units(site_id,identity_key,organization,equipment_type,brand,model,registration_number) VALUES ($1,$2,'QA','Экскаватор','QA','QA','QA001') RETURNING id", [siteId, marker]);
  await pool.query("INSERT INTO equipment_project_assignments(equipment_id,site_id) VALUES ($1,$2)", [equipmentId, siteId]);

  for (const config of [
    { kind: "personnel", resource: "workers_report", table: "personnel_reports", rowTable: "personnel_report_rows", entries: "placement_entries", days: "placement_report_days", entityColumn: "employee_id", entityId: employeeId, entityField: "employeeId", cap: 10, mutate: personnel.mutatePersonnelReport, change: personnel.mutatePersonnelReportDate, changeEntry: personnel.mutatePersonnelReportEntryDate, list: personnel.listPersonnelReports },
    { kind: "equipment", resource: "equipment_report", table: "equipment_reports", rowTable: "equipment_report_rows", entries: "equipment_entries", days: "equipment_report_days", entityColumn: "equipment_id", entityId: equipmentId, entityField: "equipmentId", cap: 20, mutate: equipment.mutateEquipmentReport, change: equipment.mutateEquipmentReport, changeEntry: equipment.changeEquipmentReportEntryDate, list: equipment.listEquipmentReports },
  ]) {
    const { table, rowTable, entries, days, entityColumn, entityId, entityField } = config;
    const row = hours => ({ ...refs, [entityField]: entityId, hours, note: "Историческая запись" });
    const rowsFor = hours => Array.from({ length: Math.ceil(hours / 10) }, (_, index) => row(Math.min(10, hours - index * 10)));
    const date = day => `2026-11-${String(day).padStart(2, "0")}`;
    const save = (user, workDate, rows) => config.mutate(db, user, { action: "save", siteId, workDate, rows });
    const transition = (user, report, action, comment) => config.mutate(db, user, { action, reportId: report.id, revision: report.revision, comment });
    const move = (user, report, workDate) => config.change(db, user, { action: "change-date", reportId: report.id, revision: report.revision, workDate });
    const get = async report => (await config.list(db, engineer, siteId, null, null)).reports.find(item => item.id === report.id);
    const approved = async (user, workDate, rows) => transition(engineer, await transition(user, await save(user, workDate, rows), "submit"), "approve");
    const total = async workDate => Number((await pool.query(`SELECT COALESCE(SUM(hours),0)::int AS hours FROM ${entries} WHERE ${entityColumn}=$1 AND work_date=$2 AND deleted_at IS NULL`, [entityId, workDate])).rows[0].hours);
    const snapshot = async report => ({
      header: (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [report.id])).rows,
      rows: (await pool.query(`SELECT * FROM ${rowTable} WHERE report_id=$1 ORDER BY id`, [report.id])).rows,
      published: (await pool.query(`SELECT e.* FROM ${entries} e JOIN ${rowTable} r ON r.approved_entry_id=e.id WHERE r.report_id=$1 ORDER BY e.id`, [report.id])).rows,
      markers: (await pool.query(`SELECT * FROM ${days} WHERE site_id=$1 ORDER BY work_date`, [siteId])).rows,
    });
    const markerExists = async workDate => (await pool.query(`SELECT 1 FROM ${days} WHERE site_id=$1 AND work_date=$2`, [siteId, workDate])).rowCount > 0;

    let partial = await save(foreman, date(1), [{ note: "Незаполненная строка" }]);
    const partialRowId = partial.rows[0].id;
    partial = await move(foreman, partial, date(2));
    assert.equal(partial.workDate, date(2)); assert.equal(partial.rows[0].id, partialRowId); assert.equal(partial.rows[0].workDate, date(2)); assert.equal(partial.rows[0].hours, null);
    assert.equal(await total(date(2)), 0);
    const partialSnapshot = await snapshot(partial);
    for (const user of [viewer, foreign, otherForeman, { ...engineer, permissions: { ...engineer.permissions, [config.resource]: { ...engineer.permissions[config.resource], update: false } } }]) await assert.rejects(move(user, partial, date(3)), rejectedCode("REPORT_FORBIDDEN"));
    for (const invalid of ["0000-01-01", "2026-02-30", "2026-13-01", "2026-1-02", "", null]) await assert.rejects(move(foreman, partial, invalid));
    await assert.rejects(move(foreman, { ...partial, revision: partial.revision - 1 }, date(3)), rejectedCode("STALE_REPORT"));
    assert.deepEqual(await snapshot(partial), partialSnapshot, "failed date changes roll back all tables and day markers");
    assert.deepEqual(await move(foreman, partial, partial.workDate), partial, "same day is a no-op");
    await save(foreman, date(3), [{ note: "Занятая дата" }]);
    await assert.rejects(move(foreman, partial, date(3)), rejectedCode("REPORT_EXISTS"));
    assert.deepEqual(await snapshot(partial), partialSnapshot);

    let report = await save(foreman, date(4), rowsFor(6));
    report = await transition(foreman, report, "submit");
    await assert.rejects(move(foreman, report, date(5)), rejectedCode("REPORT_LOCKED"));
    report = await move(engineer, report, date(5));
    assert.equal(report.status, "submitted"); assert.equal(await total(date(5)), 0);
    report = await transition(engineer, report, "approve");
    const beforeMove = await snapshot(report);
    const originalEntryIds = report.rows.map(item => item.approvedEntryId);
    const originalRows = report.rows.map(item => ({ id: item.id, createdAt: item.createdAt }));
    report = await move(engineer, report, date(6));
    assert.equal(report.status, "approved"); assert.deepEqual(report.rows.map(item => item.approvedEntryId), originalEntryIds);
    assert.deepEqual(report.rows.map(item => ({ id: item.id, createdAt: item.createdAt })), originalRows);
    assert.equal(report.ownerUserId, foreman.id); assert.equal(report.reviewedAt, beforeMove.header[0].reviewed_at);
    assert.equal(await total(date(5)), 0); assert.equal(await total(date(6)), 6);
    assert.equal(await markerExists(date(5)), false); assert.equal(await markerExists(date(6)), true);
    const afterMove = await snapshot(report);
    for (let index = 0; index < afterMove.published.length; index++) {
      const previous = beforeMove.published[index], next = afterMove.published[index];
      for (const field of ["id", "created_at", "created_by", "created_by_user_id", "responsible_user_id", "note", "hours"]) assert.equal(next[field], previous[field], `${config.kind}: date changes preserve ${field}`);
      assert.equal(next.revision, previous.revision + 1); assert.equal(next.work_date, date(6));
    }
    const blocker = await approved(otherForeman, date(7), rowsFor(config.cap - 5));
    const beforeConflict = await snapshot(report);
    await assert.rejects(move(engineer, report, date(7)), rejectedCode("HOURS_CONFLICT"));
    assert.deepEqual(await snapshot(report), beforeConflict);
    const exact = await approved(otherForeman, date(8), rowsFor(config.cap - 6));
    report = await move(engineer, report, date(8));
    assert.equal(await total(date(8)), config.cap, "exact daily cap remains permitted");
    assert.equal(await markerExists(date(6)), false);
    // Moving one report away must preserve the day used by the other foreman.
    report = await move(engineer, report, date(9));
    assert.equal(await markerExists(date(8)), true); assert.equal((await get(exact)).workDate, date(8));
    assert.equal((await get(blocker)).workDate, date(7));
    await assert.rejects(config.changeEntry(db, engineer, { action: "change-entry-date", entryId: originalEntryIds[0], revision: report.rows[0].approvedEntryRevision, siteId, workDate: date(10) }), rejectedCode("STALE_REPORT"));

    if (config.kind === "equipment") {
      await pool.query("INSERT INTO equipment_timesheet_marks(site_id,equipment_id,work_date,productive_hours,downtime_hours,note,created_by) VALUES($1,$2,$3,0,10,'Ремонт',$4)", [siteId, entityId, date(10), marker]);
      const beforeUnavailable = await snapshot(report);
      await assert.rejects(move(engineer, report, date(10)), rejectedCode("EQUIPMENT_UNAVAILABLE"));
      assert.deepEqual(await snapshot(report), beforeUnavailable);
      const repairDraft = await save(foreman, date(11), [{ equipmentId: entityId, note: "Неполная" }]);
      await assert.rejects(move(foreman, repairDraft, date(10)), rejectedCode("EQUIPMENT_UNAVAILABLE"));
    }

    // Legacy entries have no report header: move in place using their own version.
    const legacyId = config.kind === "personnel"
      ? await insert(`INSERT INTO placement_entries(site_id,work_date,employee_id,shift_id,zone_id,main_work_type_id,subwork_type_id,master_id,hours,note,employee_name_snapshot,employment_type_snapshot,position_snapshot,master_name_snapshot,created_by,responsible_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,4,'Старая запись',$9,'ОПР','Архивная должность','Архивный мастер',$9,$10) RETURNING id`, [siteId, date(12), entityId, refs.shiftId, refs.zoneId, refs.mainWorkTypeId, refs.subworkTypeId, refs.masterId, marker, foreman.id])
      : await insert(`INSERT INTO equipment_entries(site_id,work_date,equipment_id,shift_id,zone_id,main_work_type_id,subwork_type_id,hours,note,equipment_name_snapshot,organization_snapshot,equipment_type_snapshot,brand_snapshot,model_snapshot,registration_number_snapshot,created_by,responsible_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,4,'Старая запись',$8,'Архив','Архив','Архив','Архив','Архив',$8,$9) RETURNING id`, [siteId, date(12), entityId, refs.shiftId, refs.zoneId, refs.mainWorkTypeId, refs.subworkTypeId, marker, foreman.id]);
    const legacyBefore = (await pool.query(`SELECT * FROM ${entries} WHERE id=$1`, [legacyId])).rows[0];
    const legacyPayload = { action: "change-entry-date", entryId: legacyId, revision: legacyBefore.revision, siteId, workDate: date(13) };
    for (const user of [viewer, foreign, foreman]) await assert.rejects(config.changeEntry(db, user, legacyPayload), rejectedCode("REPORT_FORBIDDEN"));
    const legacy = await config.changeEntry(db, engineer, legacyPayload);
    assert.equal(legacy.id, legacyId); assert.equal(legacy.workDate, date(13)); assert.equal(legacy.revision, legacyBefore.revision + 1);
    const legacyAfter = (await pool.query(`SELECT * FROM ${entries} WHERE id=$1`, [legacyId])).rows[0];
    for (const key of Object.keys(legacyBefore).filter(key => !["work_date", "revision", "updated_at", "updated_by_user_id"].includes(key))) assert.deepEqual(legacyAfter[key], legacyBefore[key], `legacy ${config.kind} preserves ${key}`);
    await assert.rejects(config.changeEntry(db, engineer, legacyPayload), rejectedCode("STALE_REPORT"));
    await approved(otherForeman, date(14), rowsFor(config.cap - 3));
    await assert.rejects(config.changeEntry(db, engineer, { ...legacyPayload, revision: legacy.revision, workDate: date(14) }), rejectedCode("HOURS_CONFLICT"));
    assert.equal((await pool.query(`SELECT work_date FROM ${entries} WHERE id=$1`, [legacyId])).rows[0].work_date, date(13));

    // Concurrent approved moves share the target's entity/hour lock, across owners.
    const concurrencyHours = config.kind === "personnel" ? 6 : 11;
    const first = await approved(foreman, date(20), rowsFor(concurrencyHours));
    const second = await approved(otherForeman, date(21), rowsFor(concurrencyHours));
    const concurrent = await Promise.allSettled([move(engineer, first, date(22)), move(engineer, second, date(22))]);
    assert.equal(concurrent.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(item => item.status === "rejected" && item.reason.code === "HOURS_CONFLICT").length, 1);
    assert.equal(await total(date(22)), concurrencyHours, "concurrent moves cannot overbook a day");
    const pendingA = await save(foreman, date(23), [{ note: "A" }]);
    const pendingB = await save(foreman, date(24), [{ note: "B" }]);
    const duplicate = await Promise.allSettled([move(foreman, pendingA, date(25)), move(foreman, pendingB, date(25))]);
    assert.equal(duplicate.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(duplicate.filter(item => item.status === "rejected" && item.reason.code === "REPORT_EXISTS").length, 1);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE site_id=$1 AND owner_user_id=$2 AND work_date=$3 AND status<>'approved'`, [siteId, foreman.id, date(25)])).rows[0].count, 1);

    // Different owners and entities do not share hour/owner locks. Their day
    // markers must still be locked consistently during opposite date moves.
    const swapEntity = config.kind === "personnel"
      ? await insert("INSERT INTO employees(full_name,position,employment_type) VALUES ($1,'Монтажник','ОПР') RETURNING id", [`${marker}-swap`])
      : await insert("INSERT INTO equipment_units(site_id,identity_key,organization,equipment_type,brand,model,registration_number) VALUES ($1,$2,'QA','Экскаватор','QA','QA','QA002') RETURNING id", [siteId, `${marker}-swap`]);
    await pool.query(`INSERT INTO ${config.kind === "personnel" ? "employee_project_assignments(employee_id" : "equipment_project_assignments(equipment_id"},site_id) VALUES ($1,$2)`, [swapEntity, siteId]);
    let swapA = await approved(foreman, date(26), [row(2)]);
    let swapB = await approved(otherForeman, date(27), [{ ...row(2), [entityField]: swapEntity }]);
    for (let iteration = 0; iteration < 3; iteration++) {
      const outcomes = await Promise.allSettled([move(engineer, swapA, swapB.workDate), move(engineer, swapB, swapA.workDate)]);
      assert.ok(outcomes.every(item => item.status === "fulfilled"), `opposite ${config.kind} moves must not deadlock: ${outcomes.filter(item => item.status === "rejected").map(item => item.reason.code).join(",")}`);
      [swapA, swapB] = outcomes.map(item => item.value);
      assert.equal(await markerExists(date(26)), true); assert.equal(await markerExists(date(27)), true);
    }
    console.log(`PASS: ${config.kind} dates: partial/submitted/approved/legacy, permissions, stale/invalid/duplicate rollback, historical identity, day markers, daily cap ${config.cap}, concurrent moves${config.kind === "equipment" ? ", repair availability" : ""}.`);
  }
  await verifyPersonnelTimesheetApi({ marker, siteId, otherSiteId, foreman, otherForeman, engineer, refs });
} finally {
  await pool.end();
}
