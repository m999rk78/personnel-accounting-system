import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

const fileUrl = name => new URL(`../app/${name}.ts`, import.meta.url).href;
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function load(path, replacements) {
  let source = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(replacements)) source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return import(dataUrl(source));
}

const actor = (role = "viewer", pending = false) => ({ id: 8, role, assignedSiteId: null,
  projectAccess: { mode: "selected", siteIds: [7, 11] }, canViewPendingReports: pending,
  permissions: rolePermissionTemplate(role) });
function readonlyDatabase(domain, siteId) {
  const queries = [];
  const headers = ["draft", "submitted", "approved", "rejected"].map((status, index) => ({ id: 10 + index, siteId, workDate: "2026-10-30", ownerUserId: 9,
    status, revision: 1, reviewComment: `Internal ${status}`, ownerName: "Прораб" }));
  const rows = headers.map(header => ({ id: header.id + 100, reportId: header.id, hours: 8, note: `Row ${header.status}` }));
  const entries = [{ id: 100, siteId, workDate: "2026-10-30", hours: 8, equipmentName: "Кран", note: "Опубликованная строка" }];
  const db = { queries,
    prepare(sql) {
      assert.match(sql.trim(), /^SELECT\b/i);
      let values = [];
      return { bind(...parameters) { values = parameters; return this; },
        async first() { queries.push({sql, values}); return {id:values[0]}; },
        async all() {
          queries.push({sql, values});
          if (sql.includes("JOIN app_users owner")) return { results: sql.includes("report.status = 'approved'") ? headers.filter(header=>header.status==="approved") : headers };
          if (sql.includes(`FROM ${domain}_report_rows draft_row`)) return { results: rows.filter(row=>values[0].includes(row.reportId)) };
          if (sql.includes("FROM equipment_timesheet_marks")) return {results:[{equipmentId:1,workDate:"2026-10-30",productiveHours:0,downtimeHours:8,note:"Причина простоя"}]};
          return {results:entries};
        },
      };
    },
    async readBatch(statements) { return Promise.all(statements.map(statement=>statement.all())); },
    async transaction() { throw new Error("Viewer reached a mutation transaction"); },
    async batch() { throw new Error("Viewer reached a write batch"); },
  };
  return db;
}

for (const domain of ["personnel", "equipment"]) {
  const title = domain[0].toUpperCase()+domain.slice(1);
  const store = await load(`../app/${domain}ReportStore.ts`, {
    [`./${domain}ReportWorkflow`]: fileUrl(`${domain}ReportWorkflow`),
    "./equipmentExcel": fileUrl("equipmentExcel"), "./equipmentAvailability": fileUrl("equipmentAvailability"),
    "./personnelImportOrderServer": fileUrl("personnelImportOrderServer"),
  });
  test(`${domain}: viewers receive approved data only and pending reports require an explicit grant`, async () => {
    const db = readonlyDatabase(domain, 7);
    const result = await store[`list${title}Reports`](db, actor(), 7, null, null);
    assert.deepEqual(result.reports.map(report=>report.status), ["approved"]);
    assert.equal(result.reports[0].reviewComment, "");
    assert.deepEqual(result.reports[0].rows.map(row=>row.note), ["Row approved"]);
    assert.equal(result.entries[0].note, "Опубликованная строка");
    assert.equal(result.canReview, false);
    assert.deepEqual(db.queries.find(query=>query.sql.includes(`FROM ${domain}_report_rows draft_row`)).values, [[12]]);
    const enabled = await store[`list${title}Reports`](readonlyDatabase(domain, 11), actor("viewer", true), 11, null, null);
    assert.deepEqual(enabled.reports.map(report=>report.status), ["draft", "submitted", "approved", "rejected"]);
    assert.equal(enabled.canReview, false);
    if (domain === "equipment") {
      const restricted = actor(); restricted.permissions.equipment_timesheet.view = false;
      assert.deepEqual((await store.listEquipmentReports(readonlyDatabase(domain,7), restricted,7,null,null)).availabilityMarks, []);
    }
  });

  test(`${domain}: viewer writes are forbidden before any database operation even with forged full permissions`, async () => {
    const user = { ...actor("viewer", true), permissions:rolePermissionTemplate("superadmin") };
    const db = readonlyDatabase(domain, 7);
    const denied = error => error.status===403 && error.code==="REPORT_FORBIDDEN";
    for (const action of ["save", "submit", "approve", "reject", "reopen"]) {
      await assert.rejects(store[`mutate${title}Report`](db,user,{action,siteId:7,workDate:"2026-10-30",rows:[],reportId:10,revision:1,comment:"Причина"}),denied);
    }
    await assert.rejects(store[`validate${title}ReportSubmissions`](db,user,{action:"validate-submissions",siteId:7,reports:[]}),denied);
    await assert.rejects(store[`mutate${title}ReportEntry`](db,user,{action:"save-approved-entry",siteId:7,workDate:"2026-10-30",entryId:100,revision:1,row:{}}),denied);
    assert.equal(db.queries.length,0);
  });

  test(`${domain}: selected project grants allow several projects and revocation takes effect immediately`, async () => {
    const user = actor("engineer");
    for (const siteId of [7,11]) assert.equal((await store[`list${title}Reports`](readonlyDatabase(domain,siteId),user,siteId,null,null)).canReview,true);
    const db = readonlyDatabase(domain,11);
    await assert.rejects(store[`list${title}Reports`](db,{...user,projectAccess:{mode:"selected",siteIds:[7]}},11,null,null),error=>error.status===403);
    assert.equal(db.queries.length,0);
    const all = {...user,assignedSiteId:null,projectAccess:{mode:"all",siteIds:[]}};
    assert.equal((await store[`list${title}Reports`](readonlyDatabase(domain,17),all,17,null,null)).canReview,true);
  });
}

test("viewer row-order reads hide pending records and all order writes stay disabled", async () => {
  const databaseUrl=dataUrl("export function getDatabase(){throw new Error('Use injected database');}");
  const server=await load("../app/tableRowOrderServer.ts", {
    "../db/client":databaseUrl,"./roles.ts":fileUrl("roles"),"./permissionModel":fileUrl("permissionModel"),
    "./tableRowOrder":fileUrl("tableRowOrder"),"./personnelReportRowOrder":fileUrl("personnelReportRowOrder"),
    "./equipmentReportRowOrder":fileUrl("equipmentReportRowOrder"),"./workTypesRowOrder":fileUrl("workTypesRowOrder"),
  });
  const user={...actor(),permissions:rolePermissionTemplate("superadmin")};
  for (const scope of ["personnel-report-rows","equipment-report-rows"]) {
    assert.equal(server.rowOrderAccess(user,scope,7).canRead,true);
    assert.equal(server.rowOrderAccess(user,scope,7).canWrite,false);
    const queries=[];
    const executor={prepare(sql){return {bind(...values){return {async all(){queries.push({sql,values});return {results:[{id:"2026-10-30/approved-100"}]};}};}};}};
    assert.deepEqual(await server.canonicalRowIds(scope,7,executor,user),["2026-10-30/approved-100"]);
    assert.match(queries[0].sql,/report\.status <> 'approved' AND FALSE/);
    await server.canonicalRowIds(scope,7,executor,{...user,canViewPendingReports:true});
    assert.doesNotMatch(queries[1].sql,/AND FALSE/);
  }
});
