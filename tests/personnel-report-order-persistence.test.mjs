import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const actor = (id = 10, siteId = 7) => ({ id, role: "foreman", assignedSiteId: siteId, projectAccess: { mode: "selected", siteIds: [7, 8] }, permissions: rolePermissionTemplate("foreman") });
const first = "2026-11-06/report-1-11", second = "2026-11-06/report-1-12", third = "2026-11-06/report-1-13";
const draft = "2026-11-06/d0471ab9-d379-46f2-af6e-51ed0be6cfbf", persisted = "2026-11-06/report-1-14";

/** Actual route/store; only the SQL and auth boundaries are synthetic. */
function database() {
  const saved = new Map();
  const records = [first, second, third].map(id => ({ id, siteId: 7, ownerUserId: 10 }));
  records.push({ id: "2026-11-06/report-2-21", siteId: 7, ownerUserId: 11 }, { id: "2026-11-06/report-3-31", siteId: 8, ownerUserId: 10 });
  const db = { saved, records,
    prepare(sql) {
      let values = [];
      const execute = () => {
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS table_row_orders")) return null;
        if (sql.includes("FROM personnel_report_rows row JOIN personnel_reports")) {
          assert.match(sql, /AND report\.owner_user_id = \?/);
          return records.filter(row => row.siteId === values[0] && row.ownerUserId === values[1]).map(row => ({ id: row.id }));
        }
        if (sql.startsWith("SELECT row_ids AS ids FROM table_row_orders")) return saved.has(values[0]) ? { ids: [...saved.get(values[0])] } : null;
        if (sql.startsWith("SELECT id FROM table_row_orders")) return saved.has(values[0]) ? { id: values[0] } : null;
        if (sql.startsWith("INSERT INTO table_row_orders (id)")) { if (!saved.has(values[0])) saved.set(values[0], []); return null; }
        if (sql.startsWith("UPDATE table_row_orders SET row_ids")) { saved.set(values[1], JSON.parse(values[0])); return null; }
        throw new Error(`Unexpected SQL: ${sql}`);
      };
      const statement = { bind(...next) { values = next; return statement; }, async first() { return execute(); }, async all() { return { results: execute() }; }, async run() { execute(); return { success: true }; } };
      return statement;
    },
    async transaction(callback) { return callback(db); },
  };
  return db;
}

const context = { user: actor(), db: database() };
globalThis.__personnelRowOrderPersistenceTest = context;
const route = await import(await compileModuleGraph(new URL("../app/api/table-order/route.ts", import.meta.url), {
  "../../../db/client": dataUrl("export function getDatabase(){return globalThis.__personnelRowOrderPersistenceTest.db;}"),
  "../../auth": dataUrl("export async function getAuthUser(){return globalThis.__personnelRowOrderPersistenceTest.user;} export function assertSameOrigin(request){if(request.headers.get('origin')!==new URL(request.url).origin)throw new Error('Foreign origin');}"),
  "../../auditLog": dataUrl("export async function withAuditTrail(request,handler){return handler(request);}"),
  "../../equipmentReportStore": dataUrl("export async function ensureEquipmentReportSchema(){throw new Error('Personnel order must not initialize equipment');}"),
}));
after(() => { delete globalThis.__personnelRowOrderPersistenceTest; });
const request = (method, body, siteId = 7) => new Request(`http://localhost:3000/api/table-order?scope=personnel-report-rows&siteId=${siteId}`, {
  method, headers: { origin: "http://localhost:3000", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify({ scope: "personnel-report-rows", siteId, ...body }) } : {}),
});
const read = async (siteId = 7) => {
  const response = await route.GET(request("GET", undefined, siteId)); assert.equal(response.status, 200); return response.json();
};
const move = async body => {
  const response = await route.POST(request("POST", body)); assert.equal(response.status, 200, await response.clone().text()); return response.json();
};

test("manual report order survives a fresh GET, including unsaved UUID rows, without changing other users or projects", async () => {
  context.user = actor(); context.db = database();
  assert.deepEqual((await read()).ids, [first, second, third]);
  await move({ movingIds: [third], placement: "start" });
  await move({ movingIds: [draft], placement: "before", targetId: second, displayedIds: [third, first, second, draft] });
  const restored = await read();
  assert.equal(restored.hasSavedOrder, true);
  assert.deepEqual(restored.ids, [third, first, draft, second]);
  assert.deepEqual(context.db.records.slice(0, 3).map(row => row.id), [first, second, third], "Manual display preferences must not rewrite report records");
  context.user = actor(11);
  const anotherForeman = await read();
  assert.equal(anotherForeman.hasSavedOrder, false);
  assert.deepEqual(anotherForeman.ids, ["2026-11-06/report-2-21"]);
  context.user = actor();
  const anotherProject = await read(8);
  assert.equal(anotherProject.hasSavedOrder, false);
  assert.deepEqual(anotherProject.ids, ["2026-11-06/report-3-31"]);
  assert.deepEqual((await read()).ids, restored.ids);
});

test("saving a reordered local row retains its exact position when UUID becomes a record ID", async () => {
  context.user = actor(); context.db = database();
  await move({ movingIds: [draft], placement: "before", targetId: second, displayedIds: [first, second, third, draft] });
  context.db.records.push({ id: persisted, siteId: 7, ownerUserId: 10 });
  await move({ action: "remap", aliases: { [draft]: persisted } });
  const afterSave = await read();
  assert.deepEqual(afterSave.ids, [first, persisted, second, third]);
  assert.equal(afterSave.ids.includes(draft), false);
});
