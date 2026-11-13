import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const source = ts.transpileModule(await readFile(new URL("../app/personnelReportStore.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replaceAll('"./personnelReportWorkflow"', JSON.stringify(new URL("../app/personnelReportWorkflow.ts", import.meta.url).href))
  .replaceAll('"./personnelImportOrderServer"', JSON.stringify(new URL("../app/personnelImportOrderServer.ts", import.meta.url).href))
  .replaceAll('"./employeeDirectoryEligibility"', JSON.stringify(new URL("../app/employeeDirectoryEligibility.ts", import.meta.url).href));
const store = await import(dataUrl(source));
const order = await import(await compileModuleGraph(new URL("../app/tableRowOrderServer.ts", import.meta.url), {
  "../db/client": dataUrl("export function getDatabase() { throw new Error('Use the isolated test database'); }"),
}));

const actor = (role, id = 8, canViewPendingReports = true) => {
  const permissions = rolePermissionTemplate(role);
  if (role === "viewer" && canViewPendingReports) for (const resource of ["workers_report_draft", "equipment_report_draft"]) permissions[resource].view = true;
  return { id, role, fullName: `Пользователь ${id}`, assignedSiteId: 7, projectAccess: { mode: "selected", siteIds: [7] }, canViewPendingReports, permissions };
};
const headers = [7, 8, 9].flatMap(ownerUserId => ["draft", "rejected", "submitted", "approved"].map((status, index) => ({
  id: ownerUserId * 10 + index, siteId: 7, workDate: "2026-11-05", ownerUserId, ownerName: `Прораб ${ownerUserId}`, status, revision: 1,
})));
const rows = headers.map(header => ({ id: header.id * 10, reportId: header.id, siteId: 7, workDate: header.workDate,
  employeeId: header.ownerUserId * 100, employeeName: `Бригада ${header.ownerUserId}`, hours: 8, note: header.status,
  approvedEntryId: header.status === "approved" ? header.id * 100 : null }));
const entries = headers.filter(header => header.status === "approved").map(header => ({ id: header.id * 100, siteId: 7,
  workDate: header.workDate, responsibleUserId: header.ownerUserId, employeeId: header.ownerUserId * 100, hours: 8 }));

/** All content is synthetic. Unexpected reads and every write fail the test. */
function database() {
  const queries = [];
  const db = { queries,
    prepare(sql) {
      sql = sql.trim(); let values = [];
      const execute = () => {
        queries.push({ sql, values });
        assert.match(sql, /^SELECT\b/);
        if (sql.includes("FROM sites WHERE")) return [{ id: 7 }];
        if (sql.startsWith("SELECT id FROM personnel_reports WHERE id")) return [{ id: values[0] }];
        if (sql.includes("FROM personnel_reports report JOIN app_users owner")) {
          if (sql.includes("WHERE report.id = ANY")) return headers.filter(header => values[0].includes(header.id));
          if (sql.includes("WHERE report.id = ?")) return headers.filter(header => values[0] === header.id);
          // Return every synthetic header to verify the store's final visibility
          // guard too. Tests separately assert that real SQL narrows the query.
          return headers;
        }
        if (sql.includes("FROM personnel_report_rows draft_row JOIN")) return rows.filter(row => values[0].includes(row.reportId));
        if (sql.includes("FROM placement_entries entry") && sql.includes("FOR UPDATE OF entry")) return [];
        if (sql.includes("FROM placement_entries entry")) return entries.filter(entry => !sql.includes("entry.responsible_user_id = ?") || entry.responsibleUserId === values.at(-1));
        throw new Error(`Unexpected query: ${sql}`);
      };
      const statement = { bind(...next) { values = next; return statement; },
        async first() { return execute()[0] ?? null; }, async all() { return { results: execute() }; },
        async run() { throw new Error("A private draft reached a write"); } };
      return statement;
    },
    async transaction(callback) { return callback(db); },
    async batch() { throw new Error("A private draft reached a write batch"); },
  };
  return db;
}

for (const role of ["engineer", "superadmin", "viewer"]) test(`${role}: own drafts stay private while submitted and approved reports stay available`, async () => {
  const db = database();
  const user = actor(role);
  const result = await store.listPersonnelReports(db, user, 7, "2026-11-01", "2026-11-30");
  assert.deepEqual(result.reports.map(report => report.id), headers.filter(header => header.ownerUserId === user.id || ["submitted", "approved"].includes(header.status)).map(header => header.id));
  assert.equal(result.reports.flatMap(report => report.rows).some(row => row.employeeId !== 800 && ["draft", "rejected"].includes(row.note)), false);
  assert.deepEqual(result.entries.map(entry => entry.responsibleUserId), [7, 8, 9]);
  const headerQuery = db.queries.find(query => query.sql.includes("JOIN app_users owner"));
  assert.match(headerQuery.sql, /report\.status IN \('approved', 'submitted'\) OR report\.owner_user_id = \?/);
  assert.deepEqual(headerQuery.values, [7, "2026-11-01", "2026-11-30", user.id, ["draft", "rejected", "submitted", "approved"]]);
  const entryQuery = db.queries.find(query => query.sql.includes("FROM placement_entries entry"));
  assert.deepEqual(entryQuery.values, [7, "2026-11-01", "2026-11-30"]);
  const rowQuery = db.queries.find(query => query.sql.includes("FROM personnel_report_rows draft_row JOIN"));
  assert.deepEqual(rowQuery.values, [result.reports.map(report => report.id)]);
});

test("foremen see only their own personnel reports and published records in every status", async () => {
  for (const id of [7, 8, 9]) {
    const db = database();
    const result = await store.listPersonnelReports(db, actor("foreman", id), 7, "2026-11-01", "2026-11-30");
    const own = headers.filter(report => report.ownerUserId === id);
    assert.deepEqual(result.reports.map(report => report.id), own.map(report => report.id));
    assert.ok(result.reports.every(report => report.rows.every(row => row.employeeId === id * 100)));
    assert.deepEqual(result.entries.map(entry => entry.responsibleUserId), [id]);
    const headerQuery = db.queries.find(query => query.sql.includes("JOIN app_users owner"));
    assert.match(headerQuery.sql, /AND report\.owner_user_id = \?/);
    assert.deepEqual(headerQuery.values, [7, "2026-11-01", "2026-11-30", id, ["draft", "rejected", "submitted", "approved"]]);
    const entryQuery = db.queries.find(query => query.sql.includes("FROM placement_entries entry"));
    assert.match(entryQuery.sql, /AND entry\.responsible_user_id = \?/);
    assert.deepEqual(entryQuery.values, [7, "2026-11-01", "2026-11-30", id]);
  }
});

test("a foreman with only approved view still sees just their own approved report", async () => {
  const user = actor("foreman");
  for (const resource of ["workers_report_draft", "workers_report_submitted", "equipment_report_draft", "equipment_report_submitted"]) user.permissions[resource].view = false;
  const result = await store.listPersonnelReports(database(), user, 7, null, null);
  assert.deepEqual(result.reports.map(report => report.id), [83]);
  assert.deepEqual(result.entries.map(entry => entry.responsibleUserId), [user.id]);
});

test("a foreman cannot edit or review foreign submitted or approved reports with an expanded status grant", async () => {
  const user = actor("foreman");
  user.permissions = rolePermissionTemplate("superadmin");
  const denied = error => error.status === 403 && error.code === "REPORT_FORBIDDEN";
  for (const status of ["submitted", "approved"]) {
    const header = headers.find(report => report.ownerUserId === 9 && report.status === status);
    const base = { siteId: 7, reportId: header.id, workDate: header.workDate, revision: header.revision };
    await assert.rejects(store.mutatePersonnelReport(database(), user, { ...base, action: "save", rows: [] }), denied);
    await assert.rejects(store.mutatePersonnelReportDate(database(), user, { ...base, action: "change-date", workDate: "2026-11-06" }), denied);
    if (status === "submitted") await assert.rejects(store.mutatePersonnelReport(database(), user, { ...base, action: "approve" }), denied);
  }
});

test("viewer without pending permission receives no drafts, even their own", async () => {
  const result = await store.listPersonnelReports(database(), actor("viewer", 8, false), 7, null, null);
  assert.deepEqual(result.reports.map(report => report.status), ["submitted", "approved", "submitted", "approved", "submitted", "approved"]);
});

test("foreign drafts cannot be saved, submitted, moved or prevalidated even by engineers and superadmins", async () => {
  for (const role of ["foreman", "engineer", "superadmin"]) for (const status of ["draft", "rejected"]) {
    const user = actor(role);
    const header = headers.find(header => header.ownerUserId === 9 && header.status === status);
    const denied = error => error.status === 403 && error.code === "REPORT_FORBIDDEN";
    const base = { siteId: 7, reportId: header.id, revision: 1, workDate: header.workDate };
    await assert.rejects(store.mutatePersonnelReport(database(), user, { ...base, action: "save", rows: [] }), denied);
    await assert.rejects(store.mutatePersonnelReport(database(), user, { ...base, action: "submit" }), denied);
    await assert.rejects(store.mutatePersonnelReportDate(database(), user, { ...base, action: "change-date", workDate: "2026-11-06" }), denied);
    const db = database();
    await assert.rejects(store.validatePersonnelReportSubmissions(db, user, { action: "validate-submissions", siteId: 7,
      reports: [{ ...base, key: "foreign-draft", rows: [] }] }), denied);
    assert.equal(db.queries.some(query => query.sql.includes("FROM personnel_report_rows")), false, "prevalidation must deny before reading private draft rows");
  }
});

test("both report row-order APIs keep drafts private and scope every foreman row to its owner", async () => {
  for (const user of [actor("engineer"), actor("superadmin"), actor("viewer"), actor("foreman")]) {
    for (const scope of ["personnel-report-rows", "equipment-report-rows"]) {
      const queries = [];
      const db = { prepare(sql) { return { bind(...values) { return { async all() { queries.push({ sql, values }); return { results: [] }; } }; } }; } };
      await order.canonicalRowIds(scope, 7, db, user);
      const { sql, values } = queries[0];
      const [pending, approved] = sql.split("UNION ALL");
      if (user.role === "foreman") {
        assert.match(pending, /AND report\.owner_user_id = \?/);
        assert.doesNotMatch(pending, /OR report\.owner_user_id/);
        assert.match(approved, /AND entry\.responsible_user_id = \?/);
        assert.deepEqual(values, [7, user.id, 7, user.id]);
      } else {
        assert.match(pending, /AND \(report\.status = 'submitted' OR report\.owner_user_id = \?\)/);
        assert.doesNotMatch(approved, /entry\.responsible_user_id/);
        assert.deepEqual(values, [7, user.id, 7]);
      }
    }
  }
});
