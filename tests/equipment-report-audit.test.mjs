import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Exercise the real audit wrapper with an in-memory DB/auth boundary. This
// verifies that the new endpoint actually emits events, rather than merely
// calling a wrapper that has no description for the path.
const state = { events: [], reads: [], before: null };
const mockKey = `equipmentAudit${Date.now()}`;
globalThis[mockKey] = {
  user: { id: 17, fullName: "Инженер", role: "engineer" },
  database: {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return statement; },
        async first() { state.reads.push(sql); return sql.includes("SELECT name FROM sites") ? { name: "Проект" } : state.before; },
        async run() { state.events.push({ sql, values }); return { results: [], meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch() { return []; },
  },
};
const boundary = `data:text/javascript;base64,${Buffer.from(`export const getDatabase=()=>globalThis[${JSON.stringify(mockKey)}].database; export const getAuthUser=async()=>globalThis[${JSON.stringify(mockKey)}].user;`).toString("base64")}`;
const source = await readFile(new URL("../app/auditLog.ts", import.meta.url), "utf8");
let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
code = code.replaceAll('"../db/client"', JSON.stringify(boundary)).replaceAll('"./auth"', JSON.stringify(boundary));
const { withAuditTrail } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const request = payload => new Request("http://localhost/api/equipment-report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

test("equipment workflow audit records new IDs, project binding, review state and approved corrections", async () => {
  state.before = null;
  await withAuditTrail(request({ action: "save", siteId: 3, workDate: "2026-10-29", rows: [] }), async () => Response.json({ report: { id: 81 } }));
  let event = state.events.at(-1).values;
  assert.deepEqual(event.slice(3, 10), ["reports", "equipment_report.save", "equipment_report_draft", "81", 3, "Проект", "Сохранил изменения отчёта техники за 2026-10-29"]);

  state.before = { id: 81, siteId: 3, status: "submitted", revision: 2, rows: [{ equipment_id: 9, hours: 8 }] };
  await withAuditTrail(request({ action: "approve", reportId: 81, revision: 2 }), async () => Response.json({ report: { id: 81, status: "approved" } }));
  event = state.events.at(-1).values;
  assert.equal(event[4], "equipment_report.approve");
  assert.equal(event[7], 3);
  assert.deepEqual(JSON.parse(event[10]), state.before);
  assert.ok(state.reads.some(sql => sql.includes("FROM equipment_reports report") && sql.includes("publishedRows")));

  state.before = { id: 91, siteId: 3, equipmentId: 9, hours: 8, revision: 1 };
  await withAuditTrail(request({ action: "save-approved-entry", entryId: 91, siteId: 3, workDate: "2026-10-29", row: { hours: 7 } }), async () => Response.json({ entry: { id: 91, hours: 7, revision: 2 } }));
  event = state.events.at(-1).values;
  assert.deepEqual(event.slice(4, 8), ["equipment_report.save-approved-entry", "equipment_entry", "91", 3]);
  assert.deepEqual(JSON.parse(event[10]), state.before);
  assert.ok(state.reads.some(sql => sql.includes("FROM equipment_entries WHERE id")));
});

test("equipment validation previews and failed mutations do not create audit events", async () => {
  const count = state.events.length;
  await withAuditTrail(request({ action: "validate-submissions", siteId: 3, reports: [] }), async () => Response.json({ issues: [] }));
  await withAuditTrail(request({ action: "approve", reportId: 81, revision: 1 }), async () => Response.json({ error: "stale" }, { status: 409 }));
  assert.equal(state.events.length, count);
});

test.after(() => { delete globalThis[mockKey]; });
