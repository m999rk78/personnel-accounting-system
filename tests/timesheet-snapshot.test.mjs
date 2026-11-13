import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = moduleUrl(`export let user, db;
  export function configure(nextUser,nextDb){user=nextUser;db=nextDb;}
  export const getDatabase=()=>db; export const getAuthUser=async()=>user;
  export function assertSameOrigin(){} export async function withAuditTrail(request,handler){return handler(request);}`);
const boundary = await import(boundaryUrl);
let source = ts.transpileModule(await readFile(new URL("../app/api/timesheet/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
for (const [specifier, target] of Object.entries({
  "../../../db/client": boundaryUrl, "../../auth": boundaryUrl, "../../auditLog": boundaryUrl,
  "../../roles": new URL("../app/roles.ts", import.meta.url).href,
  "../../permissionModel": new URL("../app/permissionModel.ts", import.meta.url).href,
  "../../personnelTimesheetReference.server": new URL("../app/personnelTimesheetReference.server.ts", import.meta.url).href,
  "../../personnelTimesheetValues": new URL("../app/personnelTimesheetValues.ts", import.meta.url).href,
  "../../personnelTimesheetRoster": new URL("../app/personnelTimesheetRoster.ts", import.meta.url).href,
  "../../projectClock": new URL("../app/projectClock.ts", import.meta.url).href,
  "../../employeeDirectoryEligibility": new URL("../app/employeeDirectoryEligibility.ts", import.meta.url).href,
})) source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
const { GET } = await import(moduleUrl(source));
const actor = { id: 3, fullName: "Тестовый проверяющий", role: "engineer", assignedSiteId: null,
  projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate("engineer") };
const oldDate = "2026-10-31", newDate = "2026-11-01";
const worker = { id: 11, fullName: "Исторический сотрудник", employmentType: "ОПР", department: "Тестовый отдел", position: "Монтажник" };
const employeeIdentity = employee => Object.fromEntries(Object.keys(worker).map(key => [key, employee[key]]));

/** Model the commit boundary of another connection; the actual GET must opt into
 * a single read-only snapshot instead of querying this live state in parallel. */
function fixture({ failMarks = false } = {}) {
  let state = { workDate: oldDate, hours: 8, marks: [] };
  let afterRoster;
  const observations = [];
  let transactionCount = 0;
  const reply = rows => ({ results: structuredClone(rows), success: true, meta: { changes: 0 } });
  const statement = (sql, context) => {
    let values = [];
    const execute = () => {
      observations.push({ sql, values: [...values], transaction: context?.id ?? null });
      if (sql.startsWith("SELECT id, name FROM sites")) return reply([{ id: 7, name: "Тестовый проект" }]);
      assert.ok(context, "All month data must come from the same transaction");
      if (sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY") {
        assert.equal(context.reads, 0, "Isolation must be configured before reading the month");
        context.repeatableReadOnly = true;
        return reply([]);
      }
      assert.equal(context.repeatableReadOnly, true, "Never return a mixture of before/after transfer data");
      context.snapshot ??= structuredClone(state);
      context.reads++;
      const snapshot = context.snapshot;
      const inRange = (date, from, to) => date >= from && date < to;
      if (sql.startsWith("WITH assignment_roster AS")) {
        const [startDate, endDate] = values.slice(3, 5);
        const hasHistory = inRange(snapshot.workDate, startDate, endDate) || snapshot.marks.some(mark => inRange(mark.workDate, startDate, endDate));
        const rows = hasHistory ? [{ ...worker, assignments: [],
          reportDates: inRange(snapshot.workDate, startDate, endDate) ? [snapshot.workDate] : [],
          markDates: snapshot.marks.filter(mark => inRange(mark.workDate, startDate, endDate)).map(mark => mark.workDate),
          exits: snapshot.marks.filter(mark => ["УВ", "ПЕ"].includes(mark.code)), profileDate: null }] : [];
        const hook = afterRoster; afterRoster = undefined; hook?.();
        return reply(rows);
      }
      if (sql.startsWith("SELECT pe.employee_id AS employeeId")) return reply(inRange(snapshot.workDate, values[1], values[2])
        ? [{ employeeId: worker.id, workDate: snapshot.workDate, hours: snapshot.hours, reportTracked: true, masters: "Тестовый мастер", zones: "А" }] : []);
      if (sql.startsWith("SELECT employee_id AS employeeId")) {
        if (failMarks) throw new Error("Injected read failure");
        return reply(snapshot.marks.filter(mark => inRange(mark.workDate, values[1], values[2])));
      }
      throw new Error(`Unexpected month query: ${sql}`);
    };
    const prepared = { bind(...next) { values = next; return prepared; },
      async first() { return execute().results[0] ?? null; }, async all() { return execute(); }, async run() { return execute(); } };
    return prepared;
  };
  const db = {
    prepare(sql) { return statement(sql); },
    async readBatch() { throw new Error("Independent parallel reads can mix committed dates"); },
    async transaction(callback) {
      const context = { id: ++transactionCount, reads: 0, snapshot: null, repeatableReadOnly: false };
      const tx = { prepare(sql) { return statement(sql, context); },
        async readBatch(statements) { const result = []; for (const prepared of statements) result.push(await prepared.all()); return result; } };
      return callback(tx);
    },
  };
  boundary.configure(actor, db);
  return { observations, db, get transactionCount() { return transactionCount; },
    afterRoster(hook) { afterRoster = hook; },
    commitTransfer() { state = { ...state, workDate: newDate }; },
    setMark(mark) { state = { ...state, marks: [mark] }; } };
}
const request = month => new Request(`http://localhost/api/timesheet?siteId=7&month=${month}`);
const rangeRequest = (startMonth, endMonth) => new Request(`http://localhost/api/timesheet?siteId=7&startMonth=${startMonth}&endMonth=${endMonth}`);

test("a multi-month export uses one snapshot while an approved report moves across its month boundary", async () => {
  const h = fixture();
  h.afterRoster(() => h.commitTransfer());
  const response = await GET(rangeRequest("2026-10", "2026-11"));
  assert.equal(response.status, 200);
  const before = (await response.json()).months;
  assert.deepEqual(before.map(month => month.month), ["2026-10", "2026-11"]);
  assert.deepEqual(before.map(month => month.entries.reduce((sum, entry) => sum + entry.hours, 0)), [8, 0]);
  assert.equal(h.transactionCount, 1, "A range cannot combine separate monthly transactions");
  assert.equal(h.observations.filter(item => item.sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").length, 1);
  const after = (await (await GET(rangeRequest("2026-10", "2026-11"))).json()).months;
  assert.deepEqual(after.map(month => month.entries.reduce((sum, entry) => sum + entry.hours, 0)), [0, 8]);
  assert.equal(h.transactionCount, 2);
});

test("range GET validates both bounds and supports the 13 months touched by a 366-day export", async () => {
  const h = fixture();
  for (const query of [
    "startMonth=2026-11", "endMonth=2026-11", "startMonth=2026-12&endMonth=2026-11",
    "startMonth=2026-01&endMonth=2027-02", "startMonth=0000-01&endMonth=2026-11",
    "startMonth=2026-01&endMonth=9999-12", "startMonth=2026-01&endMonth=2026-02&month=2026-01",
  ]) assert.equal((await GET(new Request(`http://localhost/api/timesheet?siteId=7&${query}`))).status, 400, query);
  assert.equal(h.transactionCount, 0, "Invalid ranges cannot open a database snapshot");
  const response = await GET(rangeRequest("2026-01", "2027-01"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).months.length, 13);
  assert.equal(h.transactionCount, 1);
});

test("a cross-month transfer committing during GET cannot return hours without the historical employee", async () => {
  const h = fixture();
  h.afterRoster(() => h.commitTransfer());
  const before = await GET(request("2026-11"));
  assert.equal(before.status, 200);
  const beforeData = await before.json();
  assert.deepEqual(beforeData.employees, []); assert.deepEqual(beforeData.entries, []);
  const after = await GET(request("2026-11"));
  assert.equal(after.status, 200);
  const afterData = await after.json();
  assert.deepEqual(afterData.employees.map(employeeIdentity), [worker]);
  assert.deepEqual(afterData.employees[0].reportDates, [newDate]);
  assert.deepEqual(afterData.employees[0].roster.periods, []);
  assert.deepEqual(afterData.employees[0].roster.outsideDates, [], "Missing assignment dates are unknown, not evidence of absence");
  assert.equal(afterData.entries[0].reportTracked, true);
  assert.ok(h.observations.some(item => item.sql.includes("TRUE AS reportTracked") && item.sql.includes("UPPER(TRIM(pe.employment_type_snapshot)) = 'ОПР'")));
  assert.deepEqual(afterData.entries.map(({ employeeId, workDate, hours }) => ({ employeeId, workDate, hours })), [{ employeeId: 11, workDate: newDate, hours: 8 }]);
  assert.equal(h.transactionCount, 2);
});

test("the old month's roster and approved hours remain coherent while the move commits", async () => {
  const h = fixture();
  h.afterRoster(() => h.commitTransfer());
  const data = await (await GET(request("2026-10"))).json();
  assert.deepEqual(data.employees.map(employeeIdentity), [worker]); assert.equal(data.entries[0].workDate, oldDate); assert.equal(data.entries[0].hours, 8);
  const next = await (await GET(request("2026-10"))).json();
  assert.deepEqual(next.employees, []); assert.deepEqual(next.entries, []);
  for (const id of [1, 2]) {
    const queries = h.observations.filter(item => item.transaction === id);
    assert.equal(queries[0].sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.equal(queries.length, 4);
  }
});

test("manual marks are read from the same snapshot without modifying planned hours", async () => {
  const h = fixture();
  const mark = { employeeId: 11, workDate: oldDate, hours: 6, code: null, note: "Плановая ручная отметка", updatedBy: "Тестовый инженер" };
  h.setMark(mark); h.afterRoster(() => { h.commitTransfer(); h.setMark({ ...mark, hours: 4 }); });
  const data = await (await GET(request("2026-10"))).json();
  assert.equal(data.entries[0].hours, 8); assert.deepEqual(data.marks, [mark]);
  assert.ok(h.observations.every(item => /^(?:SELECT\b|WITH assignment_roster AS\b)/.test(item.sql) || item.sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  const { sql: rosterSql } = h.observations.find(item => item.sql.startsWith("WITH assignment_roster AS"));
  assert.match(rosterSql, /array_agg\(created_at ORDER BY work_date DESC\).*AS last_recorded_at/);
  assert.match(rosterSql, /snapshot\.work_date IS NULL AND \(m\.last_recorded_at AT TIME ZONE 'Europe\/Moscow'\)::date = m\.last_date::date\s+THEN m\.last_recorded_at/);
});

test("project and permission denials happen before a month snapshot is opened", async () => {
  const h = fixture();
  boundary.configure({ ...actor, projectAccess: { mode: "selected", siteIds: [] } }, h.db);
  assert.equal((await GET(request("2026-11"))).status, 403);
  boundary.configure({ ...actor, permissions: { ...actor.permissions, workers_timesheet: { ...actor.permissions.workers_timesheet, view: false } } }, h.db);
  assert.equal((await GET(request("2026-11"))).status, 403);
  assert.equal(h.transactionCount, 0);
});

test("a failed month read returns an error rather than publishing a partial snapshot", async () => {
  fixture({ failMarks: true });
  const previous = console.error;
  let response;
  try { console.error = () => undefined; response = await GET(request("2026-10")); }
  finally { console.error = previous; }
  assert.equal(response.status, 500);
  const data = await response.json();
  assert.equal(data.error, "Injected read failure"); assert.equal(data.entries, undefined); assert.equal(data.employees, undefined);
});
