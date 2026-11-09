import assert from "node:assert/strict";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

// Load the real dependency graph, including shared import-order helpers, rather
// than keeping a hand-written list of the store's current relative imports.
const { mutateEquipmentReport, changeEquipmentReportEntryDate } = await import(await compileModuleGraph(new URL("../app/equipmentReportStore.ts", import.meta.url)));
const engineer = { id: 8, role: "engineer", fullName: "Инженер", projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate("engineer") };
const foreman = { id: 9, role: "foreman", fullName: "Прораб", projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate("foreman") };
const oldDate = "2026-10-30", newDate = "2026-11-02";
const originalRow = {
  id: 101, reportId: 17, siteId: 7, workDate: oldDate, equipmentId: 55, shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1,
  hours: 8, note: "Историческая запись", rowOrder: 0, equipmentName: "Экскаватор на дату отчёта", organization: "Прежняя организация",
  equipmentType: "Экскаватор", brand: "Бренд", model: "Модель", registrationNumber: "ТЕСТ01", approvedEntryId: 500, approvedEntryRevision: 2,
  createdAt: "2026-10-30T05:00:00Z", updatedAt: "2026-10-30T05:00:00Z",
};

/** Run the real store, modeling transaction rollback at the SQL boundary. */
function fixture({ status = "approved", legacy = false, duplicate = false, unavailable = false, usedHours = 0, deleted = false, linkedDate = oldDate, failAfterPublishedUpdate = false, partial = false } = {}) {
  let header = { id: 17, siteId: 7, workDate: oldDate, ownerUserId: 9, ownerName: "Прораб", status, revision: 3, reviewComment: "Проверено", reviewedByUserId: 8 };
  let row = { ...structuredClone(originalRow), ...(partial ? { equipmentId: null, hours: null } : {}), approvedEntryId: status === "approved" ? 500 : null };
  let entry = { ...structuredClone(originalRow), id: 500, revision: 2, responsibleUserId: 9, workDate: linkedDate };
  let marker = oldDate;
  const sqlLog = [], writes = [];
  function select(sql, values) {
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("FROM sites WHERE")) return [{ id: 7 }];
    if (sql.startsWith("SELECT id FROM equipment_reports WHERE id")) return [{ id: 17 }];
    if (sql.startsWith("SELECT id FROM equipment_reports WHERE site_id")) return duplicate ? [{ id: 18 }] : [];
    if (sql.includes("FROM equipment_reports report JOIN app_users owner")) return legacy ? [] : [structuredClone(header)];
    if (sql.includes("FROM equipment_report_rows draft_row JOIN")) {
      const published = sql.includes("CASE WHEN report.status");
      if (published && deleted && status === "approved") return [];
      return [{ ...structuredClone(row), ...(published && status === "approved" ? entry : {}), id: 101, reportId: 17, workDate: header.workDate, approvedEntryId: row.approvedEntryId, approvedEntryRevision: entry.revision }];
    }
    if (sql.includes("JOIN equipment_report_rows source ON source.approved_entry_id") && sql.includes("WHERE source.report_id")) {
      return status === "approved" ? [{ id: 500, siteId: 7, workDate: entry.workDate, deletedAt: deleted ? "2026-11-01" : null }] : [];
    }
    if (sql.includes("SUM(hours)::int")) return usedHours ? [{ equipmentId: 55, hours: usedHours }] : [];
    if (sql.includes("FROM equipment_timesheet_marks")) return unavailable && values[1] === newDate ? [{ equipmentId: 55, downtimeHours: 10, productiveHours: 0, note: "Ремонт" }] : [];
    if (sql.includes("FROM equipment_entries entry") && sql.includes("FOR UPDATE")) return [{ ...structuredClone(entry), reportId: legacy ? null : 17 }];
    if (sql.includes("FROM equipment_entries entry")) return entry.workDate === values[1] ? [structuredClone(entry)] : [];
    throw new Error(`Unexpected SELECT: ${sql}`);
  }
  function mutate(sql, values) {
    writes.push({ sql, values });
    if (sql.startsWith("UPDATE equipment_entries SET work_date")) { entry.workDate = values[0]; entry.revision++; entry.updatedByUserId = values[1]; entry.updatedAt = "2026-11-02T08:00:00Z"; }
    else if (sql.startsWith("UPDATE equipment_reports SET work_date")) { if (failAfterPublishedUpdate) throw new Error("Synthetic failure after entry update"); header.workDate = values[0]; header.revision++; }
    else if (sql.startsWith("UPDATE equipment_report_rows SET updated_at")) row.updatedAt = "2026-11-02T08:00:00Z";
    else if (sql.startsWith("INSERT INTO equipment_report_days")) marker = values[1];
    else if (!sql.startsWith("DELETE FROM equipment_report_days")) throw new Error(`Unexpected mutation: ${sql}`);
    return [{ id: 17 }];
  }
  const db = {
    sqlLog, writes, state: () => structuredClone({ header, row, entry, marker }),
    prepare(sql) {
      sql = sql.trim(); let values = [];
      const execute = () => { sqlLog.push({ sql, values }); return /^SELECT\b/.test(sql) ? select(sql, values) : mutate(sql, values); };
      const statement = { bind(...next) { values = next; return statement; }, async first() { return execute()[0] ?? null; }, async all() { return { results: execute() }; }, async run() { return { results: execute(), meta: { changes: 1 } }; } };
      return statement;
    },
    async readBatch(statements) { return Promise.all(statements.map(statement => statement.all())); },
    async batch(statements) { const result = []; for (const statement of statements) result.push(await statement.run()); return result; },
    async transaction(callback) { const before = structuredClone({ header, row, entry, marker }); try { return await callback(db); } catch (error) { ({ header, row, entry, marker } = before); throw error; } },
  };
  return db;
}
const move = (db, user = engineer, changes = {}) => mutateEquipmentReport(db, user, { action: "change-date", reportId: 17, revision: 3, workDate: newDate, ...changes });
const moveEntry = (db, user = engineer, changes = {}) => changeEquipmentReportEntryDate(db, user, { action: "change-entry-date", entryId: 500, siteId: 7, revision: 2, workDate: newDate, ...changes });
const code = expected => error => error.code === expected;

test("moving an approved equipment report changes dates and revisions in place, preserving historical identity", async () => {
  const db = fixture();
  const result = await move(db);
  assert.equal(result.workDate, newDate);
  assert.equal(result.status, "approved");
  assert.equal(result.revision, 4);
  assert.equal(result.reviewComment, "Проверено");
  const { entry } = db.state();
  assert.equal(entry.workDate, newDate);
  assert.equal(entry.id, 500);
  assert.equal(entry.revision, 3);
  assert.equal(entry.responsibleUserId, 9);
  for (const field of ["equipmentId", "equipmentName", "organization", "equipmentType", "brand", "model", "registrationNumber", "createdAt", "hours", "note"]) assert.equal(entry[field], originalRow[field], field);
  assert.equal(db.state().marker, newDate);
  const keys = db.sqlLog.filter(item => item.sql.includes("pg_advisory_xact_lock")).map(item => item.values[0]);
  assert.deepEqual(keys.filter(key => key.startsWith("equipment-hours:")), [`equipment-hours:${oldDate}:55`, `equipment-hours:${newDate}:55`]);
  assert.deepEqual(keys.filter(key => key.startsWith("equipment-published-day:")), [`equipment-published-day:7:${oldDate}`, `equipment-published-day:7:${newDate}`]);
  const firstHours = db.sqlLog.findIndex(item => item.values[0] === `equipment-hours:${oldDate}:55`);
  const publishedLock = db.sqlLog.findIndex(item => item.sql.includes("FOR UPDATE OF entry"));
  assert.ok(publishedLock < firstHours);
  assert.match(db.writes.find(item => item.sql.startsWith("DELETE FROM equipment_report_days")).sql, /NOT EXISTS.*equipment_entries/s);
  assert.match(db.writes.find(item => item.sql.startsWith("DELETE FROM equipment_report_days")).sql, /NOT EXISTS.*equipment_reports/s);
});

test("a foreman can move an incomplete own draft without requiring missing fields", async () => {
  const db = fixture({ status: "draft", partial: true });
  const result = await move(db, foreman);
  assert.equal(result.workDate, newDate);
  assert.equal(result.rows[0].equipmentId, null);
  assert.equal(result.rows[0].hours, null);
  assert.equal(db.writes.some(item => item.sql.startsWith("UPDATE equipment_entries")), false);
});

for (const status of ["submitted", "approved"]) test(`foreman cannot move ${status} equipment report`, async () => {
  const db = fixture({ status }), before = db.state();
  await assert.rejects(move(db, foreman), code("REPORT_FORBIDDEN"));
  assert.deepEqual(db.state(), before);
});

for (const [options, expected] of [[{ duplicate: true, status: "draft" }, "REPORT_EXISTS"], [{ unavailable: true }, "EQUIPMENT_UNAVAILABLE"], [{ unavailable: true, status: "draft" }, "EQUIPMENT_UNAVAILABLE"], [{ usedHours: 13 }, "HOURS_CONFLICT"], [{ deleted: true }, "STALE_REPORT"], [{ linkedDate: "2026-10-29" }, "STALE_REPORT"]]) test(`equipment move rejects ${JSON.stringify(options)} atomically`, async () => {
  const db = fixture(options), before = db.state();
  // A draft belongs to its author; reach the date/hour validation as that
  // author rather than being rejected by the earlier ownership guard.
  await assert.rejects(move(db, options.status === "draft" ? foreman : engineer), code(expected));
  assert.deepEqual(db.state(), before);
  assert.equal(db.writes.length, 0);
});

test("review rights do not let an engineer move another user's private draft", async () => {
  const db = fixture({ status: "draft" }), before = db.state();
  await assert.rejects(move(db, engineer), code("REPORT_FORBIDDEN"));
  assert.deepEqual(db.state(), before);
  assert.equal(db.writes.length, 0);
});

test("equipment date no-op checks permissions and revision without changing timestamps", async () => {
  const db = fixture(), before = db.state();
  await move(db, engineer, { workDate: oldDate });
  assert.deepEqual(db.state(), before);
  assert.equal(db.writes.length, 0);
  await assert.rejects(move(db, engineer, { workDate: oldDate, revision: 2 }), code("STALE_REPORT"));
});

test("equipment date writes roll back both report and published entries on failure", async () => {
  const db = fixture({ failAfterPublishedUpdate: true }), before = db.state();
  await assert.rejects(move(db), /Synthetic failure/);
  assert.deepEqual(db.state(), before);
});

test("date changes require update rights, project scope, ownership, and a valid calendar day", async () => {
  const noUpdate = { ...engineer, permissions: rolePermissionTemplate("engineer") }; noUpdate.permissions.equipment_report.update = false;
  for (const user of [noUpdate, { ...engineer, projectAccess: { mode: "selected", siteIds: [8] } }, { ...foreman, id: 10 }]) {
    const db = fixture({ status: "draft" });
    await assert.rejects(move(db, user), code("REPORT_FORBIDDEN"));
    assert.equal(db.writes.length, 0);
  }
  for (const workDate of ["2026-02-30", "0000-01-01", "2026-13-01", "2.11.2026", null]) {
    const db = fixture();
    await assert.rejects(move(db, engineer, { workDate }));
    assert.equal(db.sqlLog.length, 0);
  }
  const viewer = { ...engineer, role: "viewer", permissions: rolePermissionTemplate("viewer") };
  const db = fixture();
  await assert.rejects(move(db, viewer), code("REPORT_FORBIDDEN"));
  await assert.rejects(moveEntry(db, viewer), code("REPORT_FORBIDDEN"));
  assert.equal(db.sqlLog.length, 0);
});

test("legacy approved equipment entries move with their own revision and retain snapshots", async () => {
  const db = fixture({ legacy: true });
  const result = await moveEntry(db);
  assert.equal(result.id, 500);
  assert.equal(result.workDate, newDate);
  assert.equal(result.revision, 3);
  assert.equal(result.equipmentName, originalRow.equipmentName);
  assert.equal(result.responsibleUserId, 9);
  assert.equal(db.writes.some(item => item.sql.startsWith("UPDATE equipment_reports")), false);
});

for (const [options, expected] of [[{ legacy: true, unavailable: true }, "EQUIPMENT_UNAVAILABLE"], [{ legacy: true, usedHours: 13 }, "HOURS_CONFLICT"], [{ legacy: false }, "STALE_REPORT"]]) test(`legacy equipment move rejects ${JSON.stringify(options)} without data loss`, async () => {
  const db = fixture(options), before = db.state();
  await assert.rejects(moveEntry(db), code(expected));
  assert.deepEqual(db.state(), before);
  assert.equal(db.writes.length, 0);
});
