// Invoked by test-prepush-postgres.mjs only. The database must be the uniquely
// named disposable QA database; this script never accepts a business database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { buildPersonnelTimesheetRange } from "../app/timesheetExportRange.ts";
import { shiftCalendarMonth } from "../app/reportDateCalendar.ts";
import { compileModuleGraph } from "./lib/compile-module-graph.mjs";

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
const personnel = await load("../app/personnelReportStore.ts", { "./personnelImportOrderServer": new URL("../app/personnelImportOrderServer.ts", import.meta.url).href, "./personnelReportWorkflow": new URL("../app/personnelReportWorkflow.ts", import.meta.url).href, "./employeeDirectoryEligibility": new URL("../app/employeeDirectoryEligibility.ts", import.meta.url).href });
const equipment = await load("../app/equipmentReportStore.ts", {
  "./equipmentReportWorkflow": new URL("../app/equipmentReportWorkflow.ts", import.meta.url).href,
  "./equipmentExcel": new URL("../app/equipmentExcel.ts", import.meta.url).href,
  "./equipmentAvailability": new URL("../app/equipmentAvailability.ts", import.meta.url).href,
  "./personnelImportOrderServer": new URL("../app/personnelImportOrderServer.ts", import.meta.url).href,
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
    "../../personnelTimesheetReference.server": new URL("../app/personnelTimesheetReference.server.ts", import.meta.url).href,
    "../../personnelTimesheetValues": new URL("../app/personnelTimesheetValues.ts", import.meta.url).href,
    "../../personnelTimesheetRoster": new URL("../app/personnelTimesheetRoster.ts", import.meta.url).href,
    "../../projectClock": new URL("../app/projectClock.ts", import.meta.url).href,
    "../../employeeDirectoryEligibility": new URL("../app/employeeDirectoryEligibility.ts", import.meta.url).href,
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
    assert.equal(Object.hasOwn(body, "roster"), false);
    return body;
  };
  const readRange = async (startMonth, endMonth, database = db) => {
    boundary.configure(database, engineer);
    const response = await timesheet.GET(new Request(`http://localhost/api/timesheet?siteId=${siteId}&startMonth=${startMonth}&endMonth=${endMonth}`));
    assert.equal(response.status, 200, `actual timesheet range GET ${startMonth}/${endMonth}`);
    return (await response.json()).months;
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
  const move = (report, workDate, user = engineer) => personnel.mutatePersonnelReportDate(db, user, { action: "change-date", reportId: report.id, revision: report.revision, workDate });
  const legacy = (employeeId, workDate, hours, employmentType = "ОПР", fullName = marker) => insert(`INSERT INTO placement_entries(site_id,work_date,employee_id,shift_id,zone_id,main_work_type_id,subwork_type_id,master_id,hours,note,employee_name_snapshot,employment_type_snapshot,position_snapshot,master_name_snapshot,created_by,responsible_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'Старая запись',$10,$12,'Архивная должность','Архивный мастер',$10,$11) RETURNING id`, [siteId, workDate, employeeId, refs.shiftId, refs.zoneId, refs.mainWorkTypeId, refs.subworkTypeId, refs.masterId, hours, fullName, foreman.id, employmentType]);

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
  await assert.rejects(move(pending, "2032-04-02"), rejectedCode("REPORT_FORBIDDEN"));
  pending = await move(pending, "2032-04-02", foreman);
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
  await pool.query("DELETE FROM employee_project_assignments WHERE employee_id=$1", [historicEmployee]);
  await pool.query("UPDATE employees SET active=0, employment_type='ИТР', position='Изменённая должность' WHERE id=$1", [historicEmployee]);
  assert.deepEqual((await read("2033-08")).employees.find(item => item.id === historicEmployee)?.roster.periods, [], "an approved report retains its archived employee without an assignment");
  historic = await move(historic, "2033-09-01");
  const historicOldMonth = await read("2033-08"), historicNewMonth = await read("2033-09");
  assert.equal(historicOldMonth.employees.some(item => item.id === historicEmployee), false, "an inactive participant leaves the source month after their last entry moves away");
  assert.ok(historicNewMonth.employees.some(item => item.id === historicEmployee));
  assert.equal(cell(historicOldMonth, historicEmployee, "2033-08-31").report, 0);
  assert.equal(cell(historicNewMonth, historicEmployee, "2033-09-01").report, 6);
  assert.equal(cell(historicNewMonth, historicEmployee, "2033-09-01").effective, 6);
  assert.equal(historic.rows[0].employmentType, "ОПР"); assert.equal(historic.rows[0].positionSnapshot, "Монтажник");
  const historicalProfile = historicNewMonth.employees.find(item => item.id === historicEmployee);
  assert.equal(historicalProfile.employmentType, "ОПР", "The monthly row retains the report's saved employment type");
  assert.equal(historicalProfile.position, "Монтажник", "Archiving or editing the directory does not relabel a recorded month");
  assert.equal(historicalProfile.profileDate, "2033-09-01");
  assert.equal((await pool.query("SELECT employment_type FROM employees WHERE id=$1", [historicEmployee])).rows[0].employment_type, "ИТР", "Reading history never changes the current directory");
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

  const rangeEmployee = await employee("range-reader-race");
  const rangeReport = await approve(foreman, "2040-10-31", [row(rangeEmployee, 8)]);
  let releaseRange, rangeQueryDone, rangeQueryFailed, rangeTimeout;
  const continueRange = new Promise(resolve => { releaseRange = resolve; });
  const pausedRange = new Promise((resolve, reject) => { rangeQueryDone = resolve; rangeQueryFailed = reject; });
  let rangeTransactions = 0, pausedOnce = false;
  const gatedRangeDatabase = {
    prepare: db.prepare.bind(db),
    transaction: callback => {
      rangeTransactions++;
      return db.transaction(transaction => callback({
        prepare: transaction.prepare.bind(transaction),
        async readBatch(statements) {
          const first = await statements[0].all();
          if (!pausedOnce) { pausedOnce = true; rangeQueryDone(); await continueRange; }
          const results = [first];
          for (const statement of statements.slice(1)) results.push(await statement.all());
          return results;
        },
      }));
    },
  };
  const readingRange = readRange("2040-10", "2040-11", gatedRangeDatabase).catch(error => { rangeQueryFailed(error); return { qaError: error }; });
  try {
    await Promise.race([pausedRange, new Promise((_, reject) => { rangeTimeout = setTimeout(() => reject(new Error("The range GET did not reach its controlled snapshot boundary.")), 5000); })]);
    await move(rangeReport, "2040-11-01");
  } finally {
    clearTimeout(rangeTimeout);
    releaseRange();
  }
  const beforeRangeMove = await readingRange;
  if (beforeRangeMove.qaError) throw beforeRangeMove.qaError;
  const rangeHours = months => months.map(month => month.entries.filter(entry => entry.employeeId === rangeEmployee).reduce((sum, entry) => sum + entry.hours, 0));
  assert.equal(rangeTransactions, 1, "Every exported month shares one actual PostgreSQL read transaction");
  assert.deepEqual(rangeHours(beforeRangeMove), [8, 0], "A range opened before a move cannot duplicate the report in the destination month");
  const afterRangeMove = await readRange("2040-10", "2040-11");
  assert.deepEqual(rangeHours(afterRangeMove), [0, 8]);
  const rangeExport = months => buildPersonnelTimesheetRange(months.map(month => ({ ...month, employees: month.employees.filter(employee => employee.id === rangeEmployee) })), "2040-10-31", "2040-11-01");
  assert.equal(rangeExport(beforeRangeMove).totalHours, 8);
  assert.equal(rangeExport(afterRangeMove).totalHours, 8);

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

  const employeePeriods = (timesheetBody, employeeId) => timesheetBody.employees.find(item => item.id === employeeId)?.roster.periods;
  const period = (startDate, endDate) => ({ startDate, endDate });
  const writeMark = (employeeId, workDate, value, options = {}) => timesheet.POST(new Request("http://localhost/api/timesheet", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteId, employeeId, workDate, value, ...options }),
  }));

  const dismissed = await employee("period-dismissal");
  const transferred = await employee("period-transfer");
  await pool.query("UPDATE employee_project_assignments SET start_date=$1 WHERE site_id=$2 AND employee_id IN ($3,$4)", ["2036-05-12", siteId, dismissed, transferred]);
  await pool.query("INSERT INTO employee_project_assignments(employee_id,site_id,start_date) VALUES($1,$2,$3)", [transferred, otherSiteId, "2036-05-20"]);

  assert.equal(employeePeriods(await read("2036-04"), dismissed), undefined, "a future assignment does not add an earlier roster row");
  assert.equal((await writeMark(dismissed, "2036-05-24", "УВ")).status, 200);
  assert.equal((await writeMark(transferred, "2036-05-25", "ПЕ")).status, 200);
  const exitMonth = await read("2036-05");
  for (const employeeId of [dismissed, transferred]) {
    assert.deepEqual(employeePeriods(exitMonth, employeeId), [period("2036-05-12", employeeId === dismissed ? "2036-05-25" : "2036-05-26")], "a terminal mark closes the working period after its own date");
  }
  assert.equal(cell(exitMonth, dismissed, "2036-05-24").value, "УВ");
  assert.equal(cell(exitMonth, transferred, "2036-05-25").value, "ПЕ");
  assert.ok(exitMonth.employees.find(item => item.id === dismissed).roster.outsideDates.includes("2036-05-25"), "The first day after dismissal is outside the period");
  const followingMonth = await read("2036-06");
  assert.equal(employeePeriods(followingMonth, dismissed), undefined, "УВ suppresses the following month's automatic row");
  assert.equal(employeePeriods(followingMonth, transferred), undefined, "ПЕ suppresses the following month's automatic row");
  assert.deepEqual(employeePeriods(await read("2036-06", otherSiteId), transferred), [period("2036-06-01", "2036-07-01")], "an exit on one site does not suppress the other site");
  assert.equal((await writeMark(dismissed, "2036-06-10", 6)).status, 404, "writes reject an absent employee");
  assert.ok(!(await read("2036-06")).marks.some(item => item.employeeId === dismissed), "a rejected write does not create a historical row");
  assert.equal((await writeMark(dismissed, "2036-05-24", "")).status, 200);
  assert.deepEqual(employeePeriods(await read("2036-06"), dismissed), [period("2036-06-01", "2036-07-01")], "Correcting an erroneous exit restores the dated assignment without rewriting it");
  assert.equal((await writeMark(dismissed, "2036-05-24", "УВ")).status, 200);

  await legacy(dismissed, "2036-06-12", 4);
  await pool.query("INSERT INTO timesheet_marks(site_id,employee_id,work_date,code,created_by) VALUES($1,$2,$3,$4,$5)", [siteId, transferred, "2036-06-11", "В", marker]);
  const engineerOnly = await insert("INSERT INTO employees(full_name,position,employment_type) VALUES($1,'Инженер','ИТР') RETURNING id", [`${marker}-historical-engineer`]);
  await legacy(engineerOnly, "2036-06-13", 7, "ИТР");
  const historyMonth = await read("2036-06");
  assert.deepEqual(employeePeriods(historyMonth, dismissed), [], "a published ОПР entry preserves the row without reopening assignment days");
  assert.equal(cell(historyMonth, dismissed, "2036-06-12").report, 4);
  assert.deepEqual(employeePeriods(historyMonth, transferred), [], "a manual mark preserves the row without reopening assignment days");
  assert.equal(cell(historyMonth, transferred, "2036-06-11").value, "В");
  assert.deepEqual(employeePeriods(historyMonth, engineerOnly), [], "a stored ИТР placement entry retains an employee with no assignment");
  assert.ok(!historyMonth.entries.some(item => item.employeeId === engineerOnly), "non-ОПР placement entries do not count toward report hours");
  assert.deepEqual(historyMonth.employees.find(item => item.id === engineerOnly).reportDates, ["2036-06-13"], "Non-OPR membership has visible report evidence even when hours remain manual");
  assert.deepEqual(historyMonth.employees.find(item => item.id === dismissed).roster.conflictDates, ["2036-06-12"], "A later report is retained as evidence of a period conflict, without guessing a return date");
  assert.equal((await writeMark(dismissed, "2036-06-12", 5)).status, 200, "the API accepts corrections to a historical row");
  assert.equal((await writeMark(engineerOnly, "2036-06-13", 6)).status, 200, "GET and POST share historical membership regardless of employment type");

  await pool.query("UPDATE employee_project_assignments SET active=0, end_date=$1 WHERE site_id=$2 AND employee_id=$3", ["2036-05-26", siteId, dismissed]);
  await pool.query("INSERT INTO employee_project_assignments(employee_id,site_id,start_date) VALUES($1,$2,$3)", [dismissed, siteId, "2036-08-12"]);
  assert.deepEqual(employeePeriods(await read("2036-05"), dismissed), [period("2036-05-12", "2036-05-25")], "a closed assignment respects the earlier recorded exit");
  const gapMonth = await read("2036-07");
  assert.equal(employeePeriods(gapMonth, dismissed), undefined, "a later assignment and earlier history do not fill the gap");
  assert.equal(employeePeriods(gapMonth, transferred), undefined, "an ordinary manual mark does not cancel ПЕ in later months");
  assert.deepEqual(employeePeriods(await read("2036-08"), dismissed), [period("2036-08-12", "2036-09-01")], "a later assignment reopens the roster from its start date");
  assert.equal((await writeMark(dismissed, "2036-08-12", 6)).status, 200, "the API accepts writes after reassignment");

  const undated = await employee("undated-history");
  assert.equal(employeePeriods(await read("2001-01"), undated), undefined, "An active legacy assignment without a start date does not populate every old month");
  await legacy(undated, "2001-01-12", 4);
  const undatedHistory = (await read("2001-01")).employees.find(item => item.id === undated);
  assert.deepEqual(undatedHistory.roster.periods, []);
  assert.ok(undatedHistory.roster.unknownDates.includes("2001-01-11"));
  assert.deepEqual(undatedHistory.roster.outsideDates, [], "Missing assignment boundaries are not represented as documented absence");

  const former = await employee("closed-active-period");
  await pool.query("UPDATE employee_project_assignments SET start_date='2001-02-10', end_date='2001-02-20', active=0 WHERE employee_id=$1", [former]);
  assert.deepEqual(employeePeriods(await read("2001-02"), former), [period("2001-02-10", "2001-02-20")], "A former project member still in the active directory has a historical assignment even without facts");

  const archivedCard = await employee("archived-card");
  const activeCard = await employee("active-card");
  const sharedName = `${marker}-same-name`;
  await pool.query("UPDATE employees SET full_name=$1, active=0 WHERE id=$2", [sharedName, archivedCard]);
  await pool.query("UPDATE employees SET full_name=$1 WHERE id=$2", [sharedName, activeCard]);
  await pool.query("UPDATE employee_project_assignments SET start_date='2001-01-19', end_date='2001-02-02', active=0 WHERE employee_id=$1", [archivedCard]);
  await pool.query("UPDATE employee_project_assignments SET start_date='2001-02-02' WHERE employee_id=$1", [activeCard]);
  const sameNameIds = body => body.employees.filter(item => item.fullName === sharedName).map(item => item.id).sort((a, b) => a - b);
  const noArchiveFacts = await read("2001-02");
  assert.deepEqual(sameNameIds(noArchiveFacts), [activeCard], "A blank archive card does not create a second same-name row");
  assert.deepEqual(employeePeriods(noArchiveFacts, activeCard), [period("2001-02-02", "2001-03-01")]);
  assert.equal((await writeMark(archivedCard, "2001-02-01", 6)).status, 404, "An old assignment alone cannot create a mark for an absent archived row");
  assert.ok(!(await read("2001-02")).marks.some(item => item.employeeId === archivedCard));

  await legacy(archivedCard, "2001-02-01", 4, "ОПР", sharedName);
  const withArchiveFact = await read("2001-02");
  assert.deepEqual(sameNameIds(withArchiveFact), [archivedCard, activeCard], "A saved report restores its own historical card even when a different card has the same name");
  assert.deepEqual(employeePeriods(withArchiveFact, archivedCard), [period("2001-02-01", "2001-02-02")]);
  assert.equal(cell(withArchiveFact, archivedCard, "2001-02-01").report, 4);
  assert.equal((await writeMark(archivedCard, "2001-02-01", 5)).status, 200, "Existing archival facts remain eligible for correction");

  const activeNamesake = await employee("another-active-card");
  await pool.query("UPDATE employees SET full_name=$1 WHERE id=$2", [sharedName, activeNamesake]);
  await pool.query("UPDATE employee_project_assignments SET start_date='2001-03-01' WHERE employee_id=$1", [activeNamesake]);
  assert.deepEqual(sameNameIds(await read("2001-03")), [activeCard, activeNamesake], "Different active employees with the same name keep separate rows");
  assert.equal((await writeMark(dismissed, "2036-02-30", 6)).status, 400, "Calendar overflow is rejected before querying membership");

  const profileOnly = await employee("manual-profile-version");
  await pool.query("UPDATE employees SET employment_type='ИТР', position='Новая должность' WHERE id=$1", [profileOnly]);
  await pool.query(`INSERT INTO employee_profile_versions(employee_id, full_name, employment_type, department, position, valid_from, valid_to)
    VALUES ($1,$2,'ОПР','Старый отдел','Старая должность','2038-11-01T00:00:00Z','2038-11-20T00:00:00Z'),
      ($1,$2,'ИТР','Новый отдел','Новая должность','2038-11-20T00:00:00Z',NULL)`, [profileOnly, `${marker}-profile-history`]);
  assert.equal((await writeMark(profileOnly, "2038-11-03", 4)).status, 200);
  const manualProfile = (await read("2038-11")).employees.find(item => item.id === profileOnly);
  assert.equal(manualProfile.profileSource, "profile");
  assert.equal(manualProfile.employmentType, "ОПР", "A later job change does not relabel the earlier last manual work day");
  assert.equal(manualProfile.position, "Старая должность");

  const mixedEmployee = await employee("mixed-type-month");
  await legacy(mixedEmployee, "2038-10-04", 8);
  await legacy(mixedEmployee, "2038-10-05", 7, "ИТР");
  assert.equal((await writeMark(mixedEmployee, "2038-10-04", 4)).status, 200);
  assert.equal((await writeMark(mixedEmployee, "2038-10-05", 7)).status, 200);
  const mixedMonth = await read("2038-10");
  const mixedProfile = mixedMonth.employees.find(item => item.id === mixedEmployee);
  assert.equal(mixedProfile.employmentType, "ИТР");
  assert.equal(cell(mixedMonth, mixedEmployee, "2038-10-04").mismatch, true, "The final ITR snapshot cannot hide an earlier OPR correction");
  assert.equal(cell(mixedMonth, mixedEmployee, "2038-10-05").mismatch, false, "ITR manual work does not introduce an OPR discrepancy");
  const mixedExport = buildPersonnelTimesheetRange([{ ...mixedMonth, employees: [mixedProfile] }], "2038-10-04", "2038-10-05");
  assert.deepEqual(mixedExport.rows[0].dailyReportTracked, [true, false]);
  assert.equal(mixedExport.totalDifference, -4);
  const reverseMixed = await employee("mixed-type-reverse");
  await legacy(reverseMixed, "2038-12-04", 7, "ИТР");
  await legacy(reverseMixed, "2038-12-05", 8);
  assert.equal((await writeMark(reverseMixed, "2038-12-04", 7)).status, 200);
  const reverseMonth = await read("2038-12");
  const reverseProfile = reverseMonth.employees.find(item => item.id === reverseMixed);
  assert.equal(reverseProfile.employmentType, "ОПР");
  assert.deepEqual(reverseProfile.reportTrackedByDate, { "2038-12-04": false, "2038-12-05": true });
  assert.equal(cell(reverseMonth, reverseMixed, "2038-12-04").mismatch, false, "An ITR day does not become an OPR discrepancy after a later change of type");
  const reverseExport = buildPersonnelTimesheetRange([{ ...reverseMonth, employees: [reverseProfile] }], "2038-12-04", "2038-12-05");
  assert.deepEqual(reverseExport.rows[0].dailyReportTracked, [false, true]);
  assert.equal(reverseExport.totalDifference, 0);
  const legacyClosed = await employee("legacy-closed-period");
  const sameDay = await employee("same-day-period");
  await pool.query("UPDATE employee_project_assignments SET start_date=NULL, end_date='2036-05-13', active=0 WHERE employee_id=$1", [legacyClosed]);
  await pool.query("UPDATE employee_project_assignments SET start_date='2036-05-13', end_date='2036-05-13', active=0 WHERE employee_id=$1", [sameDay]);
  const boundaryMonth = await read("2036-05");
  for (const employeeId of [legacyClosed, sameDay]) {
    assert.deepEqual(employeePeriods(boundaryMonth, employeeId), [], "Unknown and same-day periods do not invent a continuous interval");
    assert.equal((await writeMark(employeeId, "2036-05-13", 6)).status, 200, "The closing day's actual work can be recorded");
    assert.equal(employeePeriods(await read("2036-06"), employeeId), undefined, "A closed legacy or same-day period does not carry into a later month");
  }

  const concurrentMarkEmployee = await employee("concurrent-mark");
  const concurrentDate = "2041-01-12";
  const competingCreates = await Promise.all([8, 6].map(value => writeMark(concurrentMarkEmployee, concurrentDate, value, { expectedRevision: null })));
  assert.deepEqual(competingCreates.map(response => response.status).sort(), [200, 409], "Only one browser can create the previously empty cell");
  const createdMark = (await read("2041-01")).marks.find(mark => mark.employeeId === concurrentMarkEmployee);
  assert.ok(createdMark.revision);
  const updatedResponse = await writeMark(concurrentMarkEmployee, concurrentDate, 9, { expectedRevision: createdMark.revision });
  assert.equal(updatedResponse.status, 200);
  const updatedMark = (await updatedResponse.json()).mark;
  assert.ok(updatedMark.revision);
  assert.notEqual(updatedMark.revision, createdMark.revision);
  assert.equal((await writeMark(concurrentMarkEmployee, concurrentDate, 4, { expectedRevision: createdMark.revision })).status, 409, "A stale browser cannot overwrite the latest hours");
  assert.equal((await writeMark(concurrentMarkEmployee, concurrentDate, "", { expectedRevision: createdMark.revision })).status, 409, "A stale browser cannot delete the latest hours");
  assert.equal((await read("2041-01")).marks.find(mark => mark.employeeId === concurrentMarkEmployee).hours, 9);
  assert.equal((await writeMark(concurrentMarkEmployee, concurrentDate, "", { expectedRevision: updatedMark.revision })).status, 200);

  const concurrentHistoryEmployee = await employee("concurrent-history-deletion");
  await pool.query("DELETE FROM employee_project_assignments WHERE employee_id=$1", [concurrentHistoryEmployee]);
  await pool.query("UPDATE employees SET active=0 WHERE id=$1", [concurrentHistoryEmployee]);
  for (const date of ["2041-02-01", "2041-02-02"]) await pool.query("INSERT INTO timesheet_marks(site_id,employee_id,work_date,hours,created_by) VALUES($1,$2,$3,6,$4)", [siteId, concurrentHistoryEmployee, date, marker]);
  const historyMarks = (await read("2041-02")).marks.filter(mark => mark.employeeId === concurrentHistoryEmployee);
  const competingDeletes = await Promise.all(historyMarks.map(mark => writeMark(concurrentHistoryEmployee, mark.workDate, "", { expectedRevision: mark.revision })));
  assert.deepEqual(competingDeletes.map(response => response.status).sort(), [200, 409], "Concurrent deletes of different days must not bypass final-row confirmation");
  const survivingHistory = await read("2041-02");
  assert.ok(survivingHistory.employees.some(employee => employee.id === concurrentHistoryEmployee));
  const lastMark = survivingHistory.marks.find(mark => mark.employeeId === concurrentHistoryEmployee);
  assert.ok(lastMark);
  assert.equal((await writeMark(concurrentHistoryEmployee, lastMark.workDate, "", { expectedRevision: lastMark.revision, allowRosterRemoval: true })).status, 200);
  assert.ok(!(await read("2041-02")).employees.some(employee => employee.id === concurrentHistoryEmployee));
  console.log("PASS: personnel roster GET and POST on PostgreSQL: dated periods, same-month and project-local УВ/ПЕ, reversible exit correction, snapshot profiles, legacy unknown dates, preserved conflicts, ОПР-only hours and explicit reassignment.");

  const deleteModule = await compileModuleGraph(new URL("../app/server/data/deleteData.ts", import.meta.url), {
    "../../../db/client": boundaryUrl,
    "../../auth": boundaryUrl,
    "./bootstrap": "data:text/javascript,export%20async%20function%20ensureDatabaseInitialized()%7B%7D",
  });
  try {
    const { handleDELETE } = await import(deleteModule.url);
    const { monthStart } = (await pool.query("SELECT to_char(date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM-DD') AS \"monthStart\"")).rows[0];
    const month = monthStart.slice(0, 7);
    const nextMonth = shiftCalendarMonth(monthStart, 1).slice(0, 7);
    const scenarios = [
      { name: "typo", value: "", hours: 0, report: 0 },
      { name: "hours", value: "6", hours: 6, report: 0 },
      { name: "report", value: "8", hours: 8, report: 8 },
      { name: "code", value: "В", hours: 0, report: 0 },
    ];

    for (const mode of ["employee", "employee-assignment"]) {
      const samples = [];
      for (const scenario of scenarios) {
        const id = await employee(`delete-${mode}-${scenario.name}`);
        await pool.query("UPDATE employee_project_assignments SET start_date=$1 WHERE employee_id=$2", [monthStart, id]);
        await pool.query("UPDATE employees SET site_id=$1 WHERE id=$2", [siteId, id]);
        if (scenario.report) await approve(mode === "employee" ? foreman : otherForeman, monthStart, [row(id, scenario.report)]);
        else if (scenario.value) assert.equal((await writeMark(id, monthStart, scenario.value)).status, 200);
        samples.push({ ...scenario, id });
      }
      const before = await read(month);
      for (const sample of samples) assert.ok(before.employees.some(item => item.id === sample.id), `${mode}/${sample.name} has a row before deletion`);

      if (mode === "employee") {
        const response = await handleDELETE(new Request("http://localhost/api/data?entity=employee", {
          method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: samples.map(sample => sample.id) }),
        }));
        assert.equal(response.status, 200, "global removal succeeds even if the employee has hours");
        assert.deepEqual(await response.json(), { ok: true, count: samples.length });
      } else {
        for (const { id } of samples) {
          const response = await handleDELETE(new Request(`http://localhost/api/data?entity=employee-assignment&siteId=${siteId}&id=${id}`, { method: "DELETE" }));
          assert.equal(response.status, 200);
        }
      }

      const after = await read(month);
      const following = await read(nextMonth);
      for (const sample of samples) {
        const expectedRow = mode === "employee-assignment" || Boolean(sample.value);
        const savedRow = after.employees.find(item => item.id === sample.id);
        assert.equal(Boolean(savedRow), expectedRow, `${mode}/${sample.name}: selected month visibility`);
        if (savedRow) assert.equal(savedRow.roster.reason, mode === "employee" ? "history" : "assignment");
        const record = cell(after, sample.id, monthStart);
        assert.deepEqual({ value: record.value, effective: record.effective, report: record.report },
          { value: sample.value, effective: sample.hours, report: sample.report }, `${mode}/${sample.name}: historical facts remain`);
        assert.ok(!following.employees.some(item => item.id === sample.id), `${mode}/${sample.name}: no automatic carryover`);
      }
      assert.deepEqual(after.entries.filter(item => samples.some(sample => sample.id === item.employeeId)),
        before.entries.filter(item => samples.some(sample => sample.id === item.employeeId)), "Deletion does not mutate saved report entries");
      assert.deepEqual(after.marks.filter(item => samples.some(sample => sample.id === item.employeeId)),
        before.marks.filter(item => samples.some(sample => sample.id === item.employeeId)), "Deletion does not mutate saved timesheet marks");
    }
    console.log("PASS: actual employee and project-assignment DELETE + timesheet GET on PostgreSQL preserve reports, manual hours and zero-hour codes, distinguish empty archive and assignment rows, and stop automatic carryover.");
  } finally {
    await deleteModule.dispose();
  }
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
    await assert.rejects(move(foreman, report, date(5)), rejectedCode("REPORT_FORBIDDEN"));
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
