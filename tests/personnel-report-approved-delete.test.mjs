import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const source = ts.transpileModule(await readFile(new URL("../app/personnelReportStore.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replaceAll('"./personnelReportWorkflow"', JSON.stringify(new URL("../app/personnelReportWorkflow.ts", import.meta.url).href))
  .replaceAll('"./personnelImportOrderServer"', JSON.stringify(new URL("../app/personnelImportOrderServer.ts", import.meta.url).href));
const { deletePersonnelReportApprovedRows } = await import(asModule(source));
const actor = (role = "engineer") => ({ id: 8, role, fullName: "Тестовый инженер", projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate(role) });
const changedAt = "2026-11-09T08:00:00Z";

/** Execute real store decisions against synthetic records, with transaction rollback. */
function fixture({ failAt, patch = () => {} } = {}) {
  let state = {
    reports: [
      { id: 17, siteId: 7, workDate: "2026-11-05", ownerUserId: 9, status: "approved", revision: 3, reviewedByUserId: 8 },
      { id: 18, siteId: 7, workDate: "2026-11-06", ownerUserId: 10, status: "approved", revision: 5, reviewedByUserId: 8 },
      { id: 19, siteId: 12, workDate: "2026-11-05", ownerUserId: 11, status: "approved", revision: 1 },
    ],
    entries: [
      { id: 501, siteId: 7, workDate: "2026-11-05", employeeId: 55, revision: 2, hours: 4, responsibleUserId: 9 },
      { id: 502, siteId: 7, workDate: "2026-11-05", employeeId: 55, revision: 3, hours: 3, responsibleUserId: 9 },
      { id: 503, siteId: 7, workDate: "2026-11-06", employeeId: 56, revision: 1, hours: 8, responsibleUserId: 10 },
      { id: 504, siteId: 7, workDate: "2026-11-04", employeeId: 55, revision: 4, hours: 6, responsibleUserId: 9 },
      { id: 505, siteId: 12, workDate: "2026-11-05", employeeId: 57, revision: 1, hours: 8, responsibleUserId: 11 },
      { id: 506, siteId: 7, workDate: "2026-11-05", employeeId: 58, revision: 1, hours: 8, employmentType: "ИТР" },
      { id: 507, siteId: 7, workDate: "2026-11-05", employeeId: 59, revision: 2, hours: 8, deletedAt: "2026-11-08T08:00:00Z" },
    ].map(entry => ({ employmentType: "ОПР", employeeName: "Историческое имя", note: "Сохранённые данные", deletedAt: null, ...entry })),
    reportRows: [
      { id: 101, reportId: 17, approvedEntryId: 501, rowOrder: 0 },
      { id: 102, reportId: 17, approvedEntryId: 502, rowOrder: 1 },
      { id: 103, reportId: 18, approvedEntryId: 503, rowOrder: 0 },
      { id: 105, reportId: 19, approvedEntryId: 505, rowOrder: 0 },
    ],
    timesheetMarks: [{ siteId: 7, employeeId: 55, workDate: "2026-11-05", hours: 7, note: "Ручная отметка инженера" }],
    dayMarkers: ["2026-11-04", "2026-11-05", "2026-11-06"],
    savedOrder: ["2026-11-05/report-17-102", "2026-11-05/report-17-101"],
  };
  patch(state);
  const queries = [], writes = [], locks = [];
  function select(sql, values) {
    queries.push({ sql, values });
    if (sql.includes("FROM sites WHERE id = ?")) return values[0] === 7 ? [{ id: 7 }] : [];
    if (sql.includes("FROM personnel_reports WHERE id = ANY")) {
      locks.push({ kind: "reports", ids: values[0] });
      return state.reports.filter(report => values[0].includes(report.id)).sort((a, b) => a.id - b.id).map(report => structuredClone(report));
    }
    if (sql.includes("source.id AS reportRowId")) {
      locks.push({ kind: "entries", ids: values[0] });
      return state.entries.filter(entry => values[0].includes(entry.id) && !entry.deletedAt && entry.employmentType === "ОПР").sort((a, b) => a.id - b.id).map(entry => {
        const source = state.reportRows.find(row => row.approvedEntryId === entry.id);
        return { ...structuredClone(entry), reportId: source?.reportId ?? null, reportRowId: source?.id ?? null };
      });
    }
    if (sql.includes("pg_advisory_xact_lock")) { locks.push({ kind: "hours", key: values[0] }); return []; }
    throw new Error(`Unexpected SELECT: ${sql}`);
  }
  function mutate(sql, values) {
    writes.push({ sql, values });
    if (sql.startsWith("UPDATE placement_entries SET deleted_at")) {
      const selected = state.entries.filter(entry => values[1].includes(entry.id) && !entry.deletedAt);
      for (const entry of selected) Object.assign(entry, { deletedAt: changedAt, updatedAt: changedAt, updatedByUserId: values[0], revision: entry.revision + 1 });
      return selected.map(entry => ({ id: entry.id }));
    }
    if (sql.startsWith("DELETE FROM personnel_report_rows")) {
      const removed = state.reportRows.filter(row => values[0].includes(row.id) && values[1].includes(row.approvedEntryId));
      state.reportRows = state.reportRows.filter(row => !removed.includes(row));
      if (failAt === "source-count") return [];
      return removed.map(row => ({ id: row.id }));
    }
    if (sql.startsWith("UPDATE personnel_reports SET revision")) {
      if (failAt === "report-update") throw new Error("Synthetic write failure");
      const selected = state.reports.filter(report => values[1].includes(report.id));
      for (const report of selected) Object.assign(report, { revision: report.revision + 1, updatedByUserId: values[0], updatedAt: changedAt });
      return selected.map(report => ({ id: report.id }));
    }
    throw new Error(`Unexpected mutation: ${sql}`);
  }
  const db = {
    state: () => structuredClone(state), queries, writes, locks,
    prepare(sql) {
      sql = sql.trim(); let values = [];
      const execute = () => /^SELECT\b/.test(sql) ? select(sql, values) : mutate(sql, values);
      const statement = { bind(...args) { values = args; return statement; }, async first() { return execute()[0] ?? null; }, async all() { return { results: execute() }; } };
      return statement;
    },
    async transaction(callback) { const before = structuredClone(state); try { return await callback(db); } catch (error) { state = before; throw error; } },
  };
  return db;
}

const target = (entryId, changes = {}) => ({
  ...({ 501: { revision: 2, reportId: 17, reportRevision: 3 }, 502: { revision: 3, reportId: 17, reportRevision: 3 }, 503: { revision: 1, reportId: 18, reportRevision: 5 }, 504: { revision: 4 }, 505: { revision: 1, reportId: 19, reportRevision: 1 }, 506: { revision: 1 }, 507: { revision: 2 } }[entryId] ?? { revision: 1 }),
  entryId, ...changes,
});
const request = (...rows) => ({ action: "delete-approved-rows", siteId: 7, rows });
const rejectCode = (code, status) => error => error.code === code && (!status || error.status === status);

test("deleting one selected approved row preserves the same employee's other dates/rows and independent marks", async () => {
  const db = fixture(), before = db.state();
  assert.deepEqual(await deletePersonnelReportApprovedRows(db, actor(), request(target(501))), { deletedEntryIds: [501] });
  const after = db.state();
  assert.equal(after.entries.find(row => row.id === 501).deletedAt, changedAt);
  assert.equal(after.entries.find(row => row.id === 501).revision, 3);
  assert.equal(after.entries.find(row => row.id === 501).updatedByUserId, 8);
  assert.deepEqual(after.entries.filter(row => row.id !== 501), before.entries.filter(row => row.id !== 501));
  assert.deepEqual(after.reportRows, before.reportRows.filter(row => row.id !== 101));
  assert.equal(after.reports[0].revision, 4);
  assert.equal(after.reports[0].status, "approved");
  assert.deepEqual(after.reports.slice(1), before.reports.slice(1));
  for (const key of ["timesheetMarks", "dayMarkers", "savedOrder"]) assert.deepEqual(after[key], before[key]);
});

test("last row, several foremen/dates and standalone legacy entries are deleted atomically", async () => {
  const db = fixture();
  const selected = [target(504), target(503), target(502), target(501)];
  assert.deepEqual(await deletePersonnelReportApprovedRows(db, actor("superadmin"), request(...selected)), { deletedEntryIds: [501, 502, 503, 504] });
  const state = db.state();
  assert.deepEqual(state.reportRows.map(row => row.id), [105]);
  assert.deepEqual(state.reports.slice(0, 2).map(report => [report.status, report.revision]), [["approved", 4], ["approved", 6]]);
  assert.ok(state.entries.filter(entry => entry.id <= 504).every(entry => entry.deletedAt === changedAt));
  assert.deepEqual(db.locks.slice(0, 2), [{ kind: "reports", ids: [17, 18] }, { kind: "entries", ids: [501, 502, 503, 504] }]);
  assert.deepEqual(db.locks.slice(2).map(lock => lock.key), ["placement-hours:2026-11-04:55", "placement-hours:2026-11-05:55", "placement-hours:2026-11-06:56"]);
});

test("a standalone deletion does not mutate any daily report", async () => {
  const db = fixture(), before = db.state();
  await deletePersonnelReportApprovedRows(db, actor(), request(target(504)));
  assert.deepEqual(db.state().reports, before.reports);
  assert.deepEqual(db.state().reportRows, before.reportRows);
  assert.equal(db.locks[0].kind, "entries");
});

for (const [label, rows, patch] of [
  ["stale report", [target(501, { reportRevision: 2 })]],
  ["stale selected entry", [target(501, { revision: 1 }), target(503)]],
  ["stale legacy entry", [target(501), target(504, { revision: 3 })]],
  ["missing entry", [target(501), target(999)]],
  ["already deleted entry", [target(501), target(507)]],
  ["non-personnel entry", [target(501), target(506)]],
  ["omitted report identity", [{ entryId: 501, revision: 2 }]],
  ["wrong report identity", [target(501, { reportId: 18, reportRevision: 5 })]],
  ["legacy unexpectedly linked", [target(504, { reportId: 17, reportRevision: 3 })]],
  ["missing report", [target(501, { reportId: 99, reportRevision: 1 })]],
  ["report no longer approved", [target(501)], state => { state.reports[0].status = "submitted"; }],
  ["inconsistent published date", [target(501)], state => { state.entries[0].workDate = "2026-11-06"; }],
]) test(`${label} rejects the entire selected set before any mutation`, async () => {
  const db = fixture({ patch }), before = db.state();
  await assert.rejects(deletePersonnelReportApprovedRows(db, actor(), request(...rows)), rejectCode("STALE_REPORT", 409));
  assert.deepEqual(db.state(), before);
  assert.deepEqual(db.writes, []);
});

for (const role of ["foreman", "viewer"]) test(`${role} cannot delete approved rows`, async () => {
  const db = fixture();
  await assert.rejects(deletePersonnelReportApprovedRows(db, actor(role), request(target(501))), rejectCode("REPORT_FORBIDDEN", 403));
  assert.deepEqual(db.queries, []);
});

for (const role of ["foreman", "viewer"]) test(`${role} can delete approved rows when that permission is explicitly granted`, async () => {
  const db = fixture(), user = actor(role);
  if (role === "foreman") user.id = 9;
  user.permissions = rolePermissionTemplate("superadmin");
  user.permissions.workers_report.update = false;
  user.permissions.workers_report_approved.update = false;
  assert.deepEqual(await deletePersonnelReportApprovedRows(db, user, request(target(501))), { deletedEntryIds: [501] });
  assert.equal(db.state().entries.find(row => row.id === 501).deletedAt, changedAt);
});

test("a foreman with the deletion grant cannot delete another author's approved rows", async () => {
  const user = actor("foreman");
  user.permissions = rolePermissionTemplate("superadmin");
  for (const row of [target(501), target(504)]) {
    const db = fixture(), before = db.state();
    await assert.rejects(deletePersonnelReportApprovedRows(db, user, request(row)), rejectCode("REPORT_FORBIDDEN", 403));
    assert.deepEqual(db.writes, []);
    assert.deepEqual(db.state(), before);
  }
});

for (const permission of ["delete", "view"]) test(`engineer without ${permission} permission cannot delete approved rows`, async () => {
  const db = fixture(), user = actor(); user.permissions.workers_report[permission] = false;
  await assert.rejects(deletePersonnelReportApprovedRows(db, user, request(target(501))), rejectCode("REPORT_FORBIDDEN", 403));
  assert.deepEqual(db.writes, []);
});

test("a dedicated approved deletion grant does not require parent or status editing rights", async () => {
  const db = fixture(), user = actor();
  user.permissions.workers_report.update = false;
  user.permissions.workers_report_approved.update = false;
  user.permissions.workers_report_approved.delete = true;
  assert.deepEqual(await deletePersonnelReportApprovedRows(db, user, request(target(501))), { deletedEntryIds: [501] });
  assert.equal(db.state().entries.find(row => row.id === 501).deletedAt, changedAt);
});

test("project access and every selected entry's project are checked", async () => {
  for (const rows of [[target(501), target(505)], [{ entryId: 505, revision: 1 }]]) {
    const db = fixture(), before = db.state();
    await assert.rejects(deletePersonnelReportApprovedRows(db, actor(), request(...rows)), rejectCode("REPORT_FORBIDDEN", 403));
    assert.deepEqual(db.state(), before);
  }
  const db = fixture(), user = actor(); user.projectAccess.siteIds = [12];
  await assert.rejects(deletePersonnelReportApprovedRows(db, user, request(target(501))), rejectCode("REPORT_FORBIDDEN", 403));
  assert.deepEqual(db.queries, []);
});

for (const rows of [[], [target(501), target(501)], [target(501, { revision: undefined })], [target(501, { reportRevision: undefined })], [target(504, { reportRevision: 1 })], [target(-1)], [null]]) test(`invalid selected identity is rejected: ${JSON.stringify(rows)}`, async () => {
  const db = fixture();
  await assert.rejects(deletePersonnelReportApprovedRows(db, actor(), request(...rows)), rejectCode("INVALID_REPORT", 400));
  assert.deepEqual(db.queries, []);
});

test("inconsistent versions of one report are rejected instead of choosing one", async () => {
  const db = fixture();
  await assert.rejects(deletePersonnelReportApprovedRows(db, actor(), request(target(501), target(502, { reportRevision: 4 }))), rejectCode("STALE_REPORT", 409));
  assert.deepEqual(db.queries, []);
});

for (const failAt of ["source-count", "report-update"]) test(`transaction rolls back published deletions and links on ${failAt}`, async () => {
  const db = fixture({ failAt }), before = db.state();
  await assert.rejects(deletePersonnelReportApprovedRows(db, actor(), request(target(501), target(503), target(504))));
  assert.deepEqual(db.state(), before);
  assert.ok(db.writes.some(write => write.sql.startsWith("UPDATE placement_entries SET deleted_at")));
});
