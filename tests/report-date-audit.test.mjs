import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = asModule(`
  export let before=null;
  export const events=[],reads=[];
  export function setBefore(value){before=value;}
  export const getAuthUser=async()=>({id:17,fullName:'Инженер',role:'engineer'});
  export const getDatabase=()=>({prepare(sql){
    let values=[];
    const statement={bind(...args){values=args;return statement;},
      async first(){reads.push(sql);return sql.includes('SELECT name FROM sites')?{name:'Проект'}:before;},
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

for (const [section, prefix, reportTable, entryTable, entryType] of [
  ["personnel", "personnel_report", "personnel_reports", "placement_entries", "placement_entry"],
  ["equipment", "equipment_report", "equipment_reports", "equipment_entries", "equipment_entry"],
]) {
  for (const action of ["change-date", "change-entry-date"]) {
    test(`${section} ${action} audit retains source/target dates, identity and project`, async () => {
      const entry = action === "change-entry-date";
      const before = { id: 81, siteId: 3, workDate: "2026-10-31", revision: 2, ...(entry ? {} : { status: "approved", rows: [{ id: 7 }], publishedRows: [{ id: 91, work_date: "2026-10-31", hours: 6 }] }) };
      boundary.setBefore(before);
      const payload = { action, ...(entry ? { entryId: 81, siteId: 3 } : { reportId: 81 }), revision: 2, workDate: "2026-11-02" };
      const request = new Request(`http://localhost/api/${section}-report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const after = { ...before, workDate: payload.workDate, revision: 3 };
      const response = await withAuditTrail(request, async () => Response.json({ [entry ? "entry" : "report"]: after }));
      assert.equal(response.status, 200);
      const event = boundary.events.at(-1);
      assert.deepEqual(event.slice(3, 9), ["reports", `${prefix}.${action}`, entry ? entryType : `${prefix}_draft`, "81", 3, "Проект"]);
      assert.match(event[9], /на 2026-11-02$/);
      assert.deepEqual(JSON.parse(event[10]), before);
      assert.deepEqual(JSON.parse(event[11]), { requested: payload, result: { [entry ? "entry" : "report"]: after } });
      assert.ok(boundary.reads.some(sql => entry ? sql.includes(`FROM ${entryTable} WHERE id`) : sql.includes(`FROM ${reportTable} report`) && sql.includes("publishedRows")));

      const count = boundary.events.length;
      await withAuditTrail(request, async () => Response.json({ error: "Конфликт часов" }, { status: 409 }));
      assert.equal(boundary.events.length, count, "a rejected move must not be recorded as successful");
    });
  }
}
