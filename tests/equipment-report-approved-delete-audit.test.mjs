import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { presentAuditEvent } from "../app/auditEventPresentation.ts";

const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = asModule(`
  export const events = [], reads = [];
  export const before = [
    {entry:{id:501,site_id:7,equipment_id:12,equipment_name_snapshot:'Кран А123',work_date:'2026-11-05',hours:4,revision:2},
     sourceRow:{id:101,report_id:17,approved_entry_id:501,equipment_id:12,hours:4},
     report:{id:17,site_id:7,status:'approved',revision:3}},
    {entry:{id:504,site_id:7,equipment_id:14,equipment_name_snapshot:'Самосвал Б456',work_date:'2026-10-31',hours:6,revision:4},
     sourceRow:null,report:null}
  ];
  export const getAuthUser = async () => ({id:8,fullName:'Инженер',role:'engineer'});
  export const getDatabase = () => ({prepare(sql) {
    let values=[];
    const statement={bind(...args){values=args;return statement;},
      async first(){return sql.includes('SELECT name FROM sites')?{name:'Учебный проект'}:null;},
      async all(){reads.push({sql,values});return {results:sql.includes('FROM equipment_entries entry')?structuredClone(before):[]};},
      async run(){if(sql.includes('INSERT INTO audit_events'))events.push(values);return {results:[],meta:{changes:1}};}
    };
    return statement;
  },async batch(){return [];}});
`);
let code = ts.transpileModule(await readFile(new URL("../app/auditLog.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
code = code.replaceAll('"../db/client"', JSON.stringify(boundaryUrl)).replaceAll('"./auth"', JSON.stringify(boundaryUrl));
const { withAuditTrail } = await import(asModule(code));
const boundary = await import(boundaryUrl);
const payload = { action: "delete-approved-rows", siteId: 7, rows: [
  { entryId: 501, revision: 2, reportId: 17, reportRevision: 3 },
  { entryId: 504, revision: 4 },
] };
const request = (body = payload) => new Request("http://localhost/api/equipment-report", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("approved equipment deletion records published/source snapshots before removal and the successful IDs", async () => {
  const expected = structuredClone(boundary.before), result = { deletedEntryIds: [501, 504] };
  try {
    await withAuditTrail(request(), async () => {
      boundary.before.length = 0;
      return Response.json(result);
    });
  } finally {
    boundary.before.push(...expected);
  }
  const event = boundary.events.at(-1), after = JSON.parse(event[11]);
  assert.deepEqual(event.slice(3,9), ["reports", "equipment_report.delete-approved-rows", "equipment_entry", "", 7, "Учебный проект"]);
  assert.equal(event[9], "Удалил подтверждённые строки отчёта техники: 2");
  assert.deepEqual(JSON.parse(event[10]), expected);
  assert.deepEqual(after.requested, payload);
  assert.deepEqual(after.result, result);
  assert.deepEqual(after.context.references, [
    { kind: "equipment", id: 12, label: "Кран А123", siteId: 7, workDate: "2026-11-05" },
    { kind: "equipment", id: 14, label: "Самосвал Б456", siteId: 7, workDate: "2026-10-31" },
  ]);
  const read = boundary.reads.find(({sql}) => sql.includes("FROM equipment_entries entry"));
  assert.deepEqual(read.values, [[501,504]]);
  assert.match(read.sql, /LEFT JOIN equipment_report_rows/);
  assert.match(read.sql, /LEFT JOIN equipment_reports/);
});

test("denied, conflicted and failed equipment deletions do not produce successful audit events", async () => {
  const count = boundary.events.length;
  for (const status of [400, 403, 409, 500]) {
    await withAuditTrail(request(), async () => Response.json({ error: "Не удалено" }, { status }));
  }
  assert.equal(boundary.events.length, count);
});

test("single equipment deletion retains the published entry identity and ignores unrelated requested lookup IDs", async () => {
  const readsBefore = boundary.reads.length;
  await withAuditTrail(request({ ...payload, rows: [payload.rows[0]], equipmentId: 999, entries: [{ equipmentId: 999 }] }),
    async () => Response.json({ deletedEntryIds: [501] }));
  assert.equal(boundary.events.at(-1)[6], "501");
  const lookups = boundary.reads.slice(readsBefore).filter(({sql}) => sql.includes("FROM equipment_units"));
  assert.ok(lookups.length > 0);
  assert.ok(lookups.every(({values}) => !values.flat().includes(999)));
});

test("equipment deletion details show historical hours and links to the correct project and month for every row", () => {
  const view = presentAuditEvent({
    id: 1, actorUserId: 8, actorName: "Инженер", actorRole: "engineer", category: "reports",
    actionKey: "equipment_report.delete-approved-rows", entityType: "equipment_entry", entityId: "",
    siteId: 7, siteName: "Учебный проект", summary: "Удалил подтверждённые строки отчёта техники: 2",
    createdAt: "2026-11-20T08:00:00Z", beforeData: boundary.before,
    afterData: { requested: payload, result: { deletedEntryIds: [501,504], entries: [{ equipmentName: "Посторонняя техника", hours: 200 }] } },
  });
  const sections = view.sections.filter(section => section.title.startsWith("Удалённая строка"));
  assert.equal(sections.length, 2);
  assert.match(sections[0].title, /Кран А123.*05\.11\.2026/);
  assert.match(sections[1].title, /Самосвал Б456.*31\.10\.2026/);
  assert.deepEqual(sections.map(section => section.fields.find(field => field.label === "Часы").value), ["4 ч.", "6 ч."]);
  assert.doesNotMatch(view.searchText, /Посторонняя техника/);
  assert.ok(view.links.some(({target}) => target.view === "equipmentTimesheet" && target.siteId === 7 && target.equipmentId === 12 && target.month === "2026-11"));
  assert.ok(view.links.some(({target}) => target.view === "equipmentTimesheet" && target.siteId === 7 && target.equipmentId === 14 && target.month === "2026-10"));
  assert.ok(view.links.every(({target}) => target.equipmentId !== 501 && target.equipmentId !== 504));
});
