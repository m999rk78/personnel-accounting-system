import assert from "node:assert/strict";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = moduleUrl(`export let database, user;
  export function configure(db,actor){database=db;user=actor;}
  export const getDatabase=()=>database; export const getAuthUser=async()=>user;
  export function assertSameOrigin(){} export async function withAuditTrail(request,handler){return handler(request);}
  export async function compressJsonResponse(request,response){return response;}
  export async function importEquipmentEntries(){throw new Error('Unexpected import');}`);
const boundary = await import(boundaryUrl);
const { POST, GET } = await import(await compileModuleGraph(new URL("../app/api/equipment/route.ts", import.meta.url), {
  "../../../db/client": boundaryUrl, "../../auth": boundaryUrl, "../../auditLog": boundaryUrl,
  "../../compressJsonResponse": boundaryUrl, "../../equipmentImportServer": boundaryUrl,
}));
process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;

const workDate = "2026-11-17";
function fixture(existing = true) {
  const user = { id: 3, fullName: "Инженер", role: "engineer", assignedSiteId: null,
    projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("engineer") };
  let revision = 1, mark = existing ? { productiveHours: 8, downtimeHours: 0, revision: "r1", note: "Сохранено" } : null;
  const writes = [], reads = [];
  let onLock;
  const db = {
    prepare(sql) {
      let values = [];
      const query = () => {
        reads.push(sql);
        if (sql.includes("pg_advisory_xact_lock")) { const hook = onLock; onLock = undefined; hook?.(); return []; }
        if (sql.includes("FROM sites WHERE id = ?")) return [{ id: 7, name: "Тест" }];
        if (sql.startsWith("SELECT eu.id FROM equipment_units")) return [{ id: 11 }];
        if (sql.startsWith("SELECT id FROM equipment_timesheet_marks")) return mark ? [{ id: 1 }] : [];
        if (sql.includes("AS revision FROM equipment_timesheet_marks")) return mark ? [{ revision: mark.revision }] : [];
        if (sql.includes("FROM equipment_timesheet_marks") && sql.includes('AS "productiveHours"')) {
          assert.ok(sql.includes("AS revision"), "The month read must deliver the revision used by subsequent edits");
          return mark ? [{ ...mark, equipmentId: 11, workDate }] : [];
        }
        return [];
      };
      return { bind(...args) { values = args; return this; },
        async first() { return query()[0] ?? null; }, async all() { return { results: query() }; },
        async run() {
          writes.push({ sql, values });
          if (sql.includes("INSERT INTO equipment_timesheet_marks")) mark = { productiveHours: values[3], downtimeHours: values[4], note: values[5], revision: `r${++revision}` };
          else if (sql.includes("DELETE FROM equipment_timesheet_marks")) mark = null;
          else assert.fail(`Unexpected write: ${sql}`);
          return { results: [], meta: { changes: 1 } };
        },
      };
    },
    async transaction(callback) { return callback(db); },
    async readBatch(statements) { return Promise.all(statements.map(statement => statement.all())); },
  };
  boundary.configure(db, user);
  return { mark: () => mark, writes, reads, concurrent(next) { mark = next && { ...next, revision: `r${++revision}` }; }, onLock(callback) { onLock = callback; } };
}
const save = (overrides = {}) => POST(new Request("http://localhost/api/equipment", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ siteId: 7, action: "save-timesheet-mark", equipmentId: 11, workDate, productiveHours: 6, downtimeHours: 2, note: "Правка", ...overrides }),
}));

test("equipment month returns mark revisions, then guarded edits return a new revision", async () => {
  const state = fixture();
  const response = await GET(new Request("http://localhost/api/equipment?siteId=7&date=2026-11-17&month=2026-11&scope=project&view=timesheet&section=month"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).marks[0].revision, "r1");
  const update = await save({ expectedRevision: "r1" });
  assert.equal(update.status, 200);
  const result = await update.json();
  assert.equal(result.mark.revision, "r2");
  assert.equal(state.mark().productiveHours, 6);
});

test("stale equipment update, delete and retry cannot overwrite another engineer's mark", async () => {
  for (const clear of [false, true]) {
    const state = fixture();
    state.onLock(() => state.concurrent({ productiveHours: 4, downtimeHours: 3, note: "Другой инженер" }));
    const newer = () => ({ productiveHours: 4, downtimeHours: 3, note: "Другой инженер", revision: "r2" });
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await save({ expectedRevision: "r1", clear })).status, 409);
      assert.deepEqual(state.mark(), newer());
      assert.equal(state.writes.length, 0);
    }
  }
});

test("guarded equipment create and undo detect concurrent create or delete", async () => {
  let state = fixture(false);
  state.onLock(() => state.concurrent({ productiveHours: 3, downtimeHours: 0, note: "Другая вкладка" }));
  assert.equal((await save({ expectedRevision: null })).status, 409);
  assert.equal(state.writes.length, 0);
  state = fixture();
  state.onLock(() => state.concurrent(null));
  assert.equal((await save({ expectedRevision: "r1" })).status, 409);
  assert.equal(state.mark(), null);
  assert.equal(state.writes.length, 0);
  assert.equal((await save({ expectedRevision: null })).status, 200);
});

test("valid guarded zero/delete and legacy callers remain supported", async () => {
  const state = fixture(false);
  const created = await save({ productiveHours: 0, downtimeHours: 0, expectedRevision: null });
  assert.equal(created.status, 200);
  const revision = (await created.json()).mark.revision;
  assert.equal(state.mark().productiveHours, 0);
  assert.equal((await save({ clear: true, expectedRevision: revision })).status, 200);
  assert.equal(state.mark(), null);
  assert.equal((await save()).status, 200);
});

test("equipment invalid calendar days and revision types fail with 400 before writes", async () => {
  const state = fixture();
  for (const workDate of ["2026-02-29", "2026-02-30", "2026-04-31", "0000-01-01", "2026-13-01"]) {
    assert.equal((await save({ workDate })).status, 400, workDate);
    assert.equal((await GET(new Request(`http://localhost/api/equipment?siteId=7&date=${workDate}&month=2026-11&scope=project&view=timesheet&section=month`))).status, 400, workDate);
  }
  assert.equal((await GET(new Request("http://localhost/api/equipment?siteId=7&date=2026-11-17&month=0000-01&scope=project&view=timesheet&section=month"))).status, 400);
  for (const expectedRevision of [42, false, {}, []]) assert.equal((await save({ expectedRevision })).status, 400);
  assert.equal(state.writes.length, 0);
  assert.equal((await save({ workDate: "2028-02-29" })).status, 200);
});
