import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

const source = ts.transpileModule(await readFile(new URL("../app/personnelReportStore.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replaceAll('"./personnelReportWorkflow"', JSON.stringify(new URL("../app/personnelReportWorkflow.ts", import.meta.url).href))
  .replaceAll('"./personnelImportOrderServer"', JSON.stringify(new URL("../app/personnelImportOrderServer.ts", import.meta.url).href));
const { mutatePersonnelReportDate, mutatePersonnelReportEntryDate } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const actor = (role = "engineer", id = 8) => ({ id, role, fullName: "Проверка", projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate(role) });
const original = {
  id: 101, reportId: 17, siteId: 7, workDate: "2026-10-30", employeeId: 55,
  shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1,
  hours: 6, note: "Историческая запись", rowOrder: 0, employeeName: "Исходное ФИО",
  employmentType: "ОПР", department: "Исходный отдел", positionSnapshot: "Исходная должность",
  masterName: "Исходный мастер", approvedEntryId: 500, approvedEntryRevision: 1,
  createdAt: "2026-10-30T05:00:00Z", updatedAt: "2026-10-30T05:00:00Z",
};

/** Real store logic over a transactional SQL boundary with synthetic records only. */
function fixture({ status = "approved", legacy = false, incomplete = false, duplicate = false, extra = [], deleted = false, wrongEntryDate = false, failMarker = false } = {}) {
  let header = { id: 17, siteId: 7, workDate: original.workDate, ownerUserId: 9, ownerName: "Прораб", status, revision: 1, reviewedAt: "2026-10-30T09:00:00Z", reviewedByUserId: 8, reviewComment: "Проверено" };
  let raw = [{ ...structuredClone(original), ...(status === "approved" ? {} : { approvedEntryId: null }), ...(incomplete ? { employeeId: null, hours: null } : {}) }];
  let entries = [...(status === "approved" || legacy ? [{ ...structuredClone(original), id: 500, revision: 1, responsibleUserId: 9, workDate: wrongEntryDate ? "2026-10-29" : original.workDate, deletedAt: deleted ? "2026-10-31T00:00:00Z" : null, reportRowId: legacy ? null : 101 }] : []), ...structuredClone(extra)];
  let days = new Set([original.workDate]);
  const writes = [], queries = [], locks = [];
  function rows(published) {
    return raw.flatMap(row => {
      const entry = entries.find(entry => entry.id === row.approvedEntryId);
      if (published && status === "approved" && (!entry || entry.deletedAt)) return [];
      return [{ ...row, ...(published && status === "approved" ? entry : {}), id: row.id, reportId: header.id, workDate: header.workDate, approvedEntryId: row.approvedEntryId, approvedEntryRevision: entry?.revision }];
    });
  }
  function select(sql, values) {
    queries.push({ sql, values });
    if (sql.includes("pg_advisory_xact_lock")) { locks.push(values[0]); return []; }
    if (sql.includes("FROM sites WHERE id = ?")) return values[0] === 7 ? [{ id: 7 }] : [];
    if (sql.startsWith("SELECT id FROM personnel_reports WHERE id")) return legacy ? [] : [{ id: 17 }];
    if (sql.includes("FROM personnel_reports report JOIN app_users owner")) return legacy ? [] : [structuredClone(header)];
    if (sql.includes("source.id AS reportRowId")) return entries.filter(entry => entry.reportRowId != null).map(entry => structuredClone(entry));
    if (sql.includes("FROM personnel_report_rows draft_row JOIN")) return rows(sql.includes("CASE WHEN report.status"));
    if (sql.includes("owner_user_id = ?") && sql.includes("id <> ?")) return duplicate ? [{ id: 18 }] : [];
    if (sql.includes("SUM(entry.hours)")) {
      const totals = new Map();
      for (const entry of entries) if (!entry.deletedAt && entry.workDate === values[0] && values[1].includes(entry.employeeId) && !values[2].includes(entry.id)) totals.set(entry.employeeId, (totals.get(entry.employeeId) ?? 0) + entry.hours);
      return [...totals].map(([employeeId, hours]) => ({ employeeId, hours }));
    }
    if (sql.includes("FROM placement_entries entry") && sql.includes("FOR UPDATE OF entry")) return entries.filter(entry => entry.id === values[0] && !entry.deletedAt).map(entry => ({ ...structuredClone(entry), reportId: entry.reportRowId == null ? null : header.id }));
    if (sql.includes("FROM placement_entries entry")) return entries.filter(entry => entry.siteId === values[0] && !entry.deletedAt && (!values[1] || entry.workDate >= values[1]) && (!values[2] || entry.workDate <= values[2])).map(entry => structuredClone(entry));
    throw new Error(`Unexpected SELECT: ${sql.slice(0, 100)}`);
  }
  function mutate(sql, values) {
    writes.push({ sql, values });
    if (sql.startsWith("UPDATE placement_entries SET work_date")) {
      const selected = entries.filter(entry => (Array.isArray(values[2]) ? values[2].includes(entry.id) : entry.id === values[2]) && !entry.deletedAt);
      for (const entry of selected) { entry.workDate = values[0]; entry.updatedByUserId = values[1]; entry.updatedAt = "2026-11-01T08:00:00Z"; entry.revision++; }
      return selected.map(entry => ({ id: entry.id }));
    }
    if (sql.startsWith("UPDATE personnel_reports SET work_date")) { header.workDate = values[0]; header.revision++; header.updatedByUserId = values[1]; return [{ id: header.id }]; }
    if (sql.startsWith("UPDATE personnel_report_rows SET updated_at")) { raw = raw.map(row => ({ ...row, updatedAt: "2026-11-01T08:00:00Z" })); return raw.map(row => ({ id: row.id })); }
    if (sql.startsWith("INSERT INTO placement_report_days")) { if (failMarker) throw new Error("Synthetic marker failure"); days.add(values[1]); return [{ siteId: values[0] }]; }
    if (sql.startsWith("DELETE FROM placement_report_days")) {
      if (!entries.some(entry => entry.siteId === values[0] && entry.workDate === values[1] && !entry.deletedAt) && (legacy || header.workDate !== values[1] || header.status !== "approved")) days.delete(values[1]);
      return [];
    }
    throw new Error(`Unexpected mutation: ${sql.slice(0, 100)}`);
  }
  const state = () => structuredClone({ header, raw, entries, days: [...days].sort() });
  const db = {
    writes, queries, locks, state,
    prepare(sql) {
      sql = sql.trim(); let values = [];
      const execute = () => /^SELECT\b/.test(sql) ? select(sql, values) : mutate(sql, values);
      const statement = { bind(...next) { values = next; return statement; }, async first() { return execute()[0] ?? null; }, async all() { return { results: execute() }; }, async run() { const results = execute(); return { results, meta: { changes: results.length } }; } };
      return statement;
    },
    async transaction(callback) { const before = state(); try { return await callback(db); } catch (error) { ({ header, raw, entries } = before); days = new Set(before.days); throw error; } },
  };
  return db;
}
const move = (db, changes = {}, user = actor()) => mutatePersonnelReportDate(db, user, { action: "change-date", reportId: 17, revision: 1, workDate: "2026-11-01", ...changes });
const moveEntry = (db, changes = {}, user = actor()) => mutatePersonnelReportEntryDate(db, user, { action: "change-entry-date", entryId: 500, siteId: 7, revision: 1, workDate: "2026-11-01", ...changes });

test("approved daily report transfer preserves snapshots, identities, review and ownership", async () => {
  const db = fixture(), before = db.state();
  const result = await move(db);
  const after = db.state();
  assert.equal(result.workDate, "2026-11-01"); assert.equal(result.revision, 2);
  assert.equal(after.entries[0].workDate, "2026-11-01"); assert.equal(after.entries[0].revision, 2);
  for (const key of ["id", "employeeName", "positionSnapshot", "department", "masterName", "employeeId", "hours", "note", "createdAt", "responsibleUserId"]) assert.equal(after.entries[0][key], before.entries[0][key], key);
  for (const key of ["id", "ownerUserId", "status", "reviewedAt", "reviewedByUserId", "reviewComment"]) assert.equal(after.header[key], before.header[key], key);
  assert.deepEqual(after.days, ["2026-11-01"]);
  assert.deepEqual(db.locks.filter(key => key.startsWith("placement-hours:")), ["placement-hours:2026-10-30:55", "placement-hours:2026-11-01:55"]);
});

test("incomplete own draft can change its date without publishing or requiring complete references", async () => {
  const db = fixture({ status: "draft", incomplete: true });
  const result = await move(db, {}, actor("foreman", 9));
  assert.equal(result.workDate, "2026-11-01"); assert.equal(result.rows[0].employeeId, null);
  assert.equal(db.state().entries.length, 0);
  assert.ok(!db.writes.some(write => /placement_entries|placement_report_days/.test(write.sql)));
});

test("a duplicate destination draft is rejected before any mutation", async () => {
  const db = fixture({ status: "draft", duplicate: true }), before = db.state();
  await assert.rejects(move(db, {}, actor("foreman", 9)), error => error.code === "REPORT_EXISTS" && error.status === 409);
  assert.deepEqual(db.state(), before); assert.equal(db.writes.length, 0);
});

test("destination hours include another project's published entries and overflow rolls back", async () => {
  const db = fixture({ extra: [{ id: 600, siteId: 8, employeeId: 55, hours: 5, workDate: "2026-11-01", deletedAt: null }] }), before = db.state();
  await assert.rejects(move(db), error => error.code === "HOURS_CONFLICT" && error.details.usedHours === 5);
  assert.deepEqual(db.state(), before); assert.equal(db.writes.length, 0);
});

test("stale report version, deleted publication and divergent entry date cannot be transferred", async () => {
  for (const [options, changes] of [[{}, { revision: 2 }], [{ deleted: true }, {}], [{ wrongEntryDate: true }, {}]]) {
    const db = fixture(options), before = db.state();
    await assert.rejects(move(db, changes), error => error.code === "STALE_REPORT");
    assert.deepEqual(db.state(), before); assert.equal(db.writes.length, 0);
  }
});

test("viewer writes fail before SQL and foreman ownership/status boundaries remain enforced", async () => {
  const never = { transaction() { throw new Error("Unexpected SQL"); } };
  await assert.rejects(move(never, {}, actor("viewer")), error => error.status === 403);
  await assert.rejects(moveEntry(never, {}, actor("viewer")), error => error.status === 403);
  await assert.rejects(move(fixture({ status: "draft" }), {}, actor("foreman", 10)), error => error.status === 403);
  for (const status of ["submitted", "approved"]) await assert.rejects(move(fixture({ status }), {}, actor("foreman", 9)), error => error.code === "REPORT_FORBIDDEN");
  await assert.rejects(move(fixture(), {}, { ...actor(), projectAccess: { mode: "none", siteIds: [] } }), error => error.status === 403);
});

test("strict calendar values reject year zero, normalized dates, timestamps and invalid identifiers", async () => {
  for (const workDate of ["0000-01-01", "2026-02-30", "2026-13-01", "2026-11-01T00:00:00Z", "01.11.2026", "", null]) {
    await assert.rejects(move(fixture(), { workDate }), error => error.status === 400);
    await assert.rejects(moveEntry(fixture({ legacy: true }), { workDate }), error => error.status === 400);
  }
  for (const reportId of [0, -1, 1.5, "17", 2147483648]) await assert.rejects(move(fixture(), { reportId }), error => error.status === 400);
});

test("unchanged date is an optimistic no-op without revising the report", async () => {
  const db = fixture(), before = db.state();
  await move(db, { workDate: original.workDate });
  assert.deepEqual(db.state(), before); assert.equal(db.writes.length, 0);
});

test("source day marker is retained when another live entry remains", async () => {
  const db = fixture({ extra: [{ id: 600, siteId: 7, employeeId: 56, hours: 5, workDate: original.workDate, deletedAt: null }] });
  await move(db);
  assert.deepEqual(db.state().days, [original.workDate, "2026-11-01"]);
});

test("failure after accounting and header writes rolls back the entire report transfer", async () => {
  const db = fixture({ failMarker: true }), before = db.state();
  await assert.rejects(move(db), /Synthetic marker failure/);
  assert.ok(db.writes.some(write => write.sql.startsWith("UPDATE placement_entries")));
  assert.ok(db.writes.some(write => write.sql.startsWith("UPDATE personnel_reports")));
  assert.deepEqual(db.state(), before);
});

test("legacy approved entry date correction preserves all business values and moves accounting day", async () => {
  const db = fixture({ legacy: true }), before = db.state().entries[0];
  const result = await moveEntry(db);
  assert.equal(result.id, 500); assert.equal(result.workDate, "2026-11-01"); assert.equal(result.revision, 2);
  for (const key of ["employeeName", "positionSnapshot", "hours", "note", "responsibleUserId", "createdAt"]) assert.equal(result[key], before[key], key);
  assert.deepEqual(db.state().days, ["2026-11-01"]);
  assert.equal(db.writes.filter(write => write.sql.startsWith("UPDATE placement_entries")).length, 1);
});

test("legacy correction rejects linked rows, stale versions, foreign projects and destination overflow", async () => {
  for (const [options, changes, code] of [[{}, {}, "STALE_REPORT"], [{ legacy: true }, { revision: 2 }, "STALE_REPORT"], [{ legacy: true }, { siteId: 8 }, "REPORT_FORBIDDEN"], [{ legacy: true, extra: [{ id: 600, siteId: 8, employeeId: 55, hours: 5, workDate: "2026-11-01", deletedAt: null }] }, {}, "HOURS_CONFLICT"]]) {
    const db = fixture(options), before = db.state();
    await assert.rejects(moveEntry(db, changes), error => error.code === code);
    assert.deepEqual(db.state(), before); assert.equal(db.writes.length, 0);
  }
});

test("legacy accounting date is rolled back when the publication marker update fails", async () => {
  const db = fixture({ legacy: true, failMarker: true }), before = db.state();
  await assert.rejects(moveEntry(db), /Synthetic marker failure/);
  assert.deepEqual(db.state(), before);
});
