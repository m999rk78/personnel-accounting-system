import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = asModule(`
  export const events=[], reads=[];
  export const before=[
    {entry:{id:501,site_id:7,work_date:'2026-11-05',hours:4,revision:2},sourceRow:{id:101,report_id:17,approved_entry_id:501},report:{id:17,status:'approved',revision:3}},
    {entry:{id:504,site_id:7,work_date:'2026-11-04',hours:6,revision:4},sourceRow:null,report:null}
  ];
  export const getAuthUser=async()=>({id:8,fullName:'Инженер',role:'engineer'});
  export const getDatabase=()=>({prepare(sql){
    let values=[];
    const statement={bind(...args){values=args;return statement;},
      async first(){return sql.includes('SELECT name FROM sites')?{name:'Учебный проект'}:null;},
      async all(){reads.push({sql,values});return {results:before};},
      async run(){if(sql.includes('INSERT INTO audit_events'))events.push(values);return {results:[],meta:{changes:1}};}};
    return statement;
  },async batch(){return [];}});
`);
let code = ts.transpileModule(await readFile(new URL("../app/auditLog.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
code = code.replaceAll('"../db/client"', JSON.stringify(boundaryUrl)).replaceAll('"./auth"', JSON.stringify(boundaryUrl));
const { withAuditTrail } = await import(asModule(code));
const boundary = await import(boundaryUrl);
const payload = { action: "delete-approved-rows", siteId: 7, rows: [{ entryId: 501, revision: 2, reportId: 17, reportRevision: 3 }, { entryId: 504, revision: 4 }] };
const request = () => new Request("http://localhost/api/personnel-report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

test("approved row deletion audit records selected published/source records, revisions and successful IDs", async () => {
  const result = { deletedEntryIds: [501, 504] };
  await withAuditTrail(request(), async () => Response.json(result));
  const event = boundary.events.at(-1);
  assert.deepEqual(event.slice(3, 9), ["reports", "personnel_report.delete-approved-rows", "placement_entry", "", 7, "Учебный проект"]);
  assert.equal(event[9], "Удалил подтверждённые строки отчёта персонала: 2");
  assert.deepEqual(JSON.parse(event[10]), boundary.before);
  assert.deepEqual(JSON.parse(event[11]), { requested: payload, result });
  const read = boundary.reads.at(-1);
  assert.deepEqual(read.values, [[501, 504]]);
  assert.match(read.sql, /LEFT JOIN personnel_report_rows/);
  assert.match(read.sql, /LEFT JOIN personnel_reports/);
});

test("denied or conflicted deletions never appear as successful audit events", async () => {
  const count = boundary.events.length;
  for (const status of [403, 409, 500]) await withAuditTrail(request(), async () => Response.json({ error: "Не удалено" }, { status }));
  assert.equal(boundary.events.length, count);
});

test("single-row deletion audit retains the exact published entry ID", async () => {
  const single = { ...payload, rows: [payload.rows[0]] };
  const req = new Request("http://localhost/api/personnel-report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(single) });
  await withAuditTrail(req, async () => Response.json({ deletedEntryIds: [501] }));
  assert.equal(boundary.events.at(-1)[6], "501");
});
