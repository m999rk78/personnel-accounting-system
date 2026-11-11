import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const employeeIds = [1, 2, 3, 4];

/** Actual route and order store with a serialized, in-memory SQL boundary. */
function database() {
  const saved = new Map();
  let transactionTail = Promise.resolve();
  const db = {
    saved,
    prepare(sql) {
      let values = [];
      const execute = () => {
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS table_row_orders")) return null;
        if (sql.includes("SELECT e.id FROM employees e WHERE e.id IN")) return employeeIds.map(id => ({ id }));
        if (sql.startsWith("SELECT row_ids AS ids FROM table_row_orders")) return saved.has(values[0]) ? { ids: [...saved.get(values[0])] } : null;
        if (sql.startsWith("INSERT INTO table_row_orders (id)")) { if (!saved.has(values[0])) saved.set(values[0], []); return null; }
        if (sql.startsWith("UPDATE table_row_orders SET row_ids")) { saved.set(values[1], JSON.parse(values[0])); return null; }
        throw new Error(`Unexpected SQL: ${sql}`);
      };
      const statement = {
        bind(...next) { values = next; return statement; },
        async first() { return execute(); },
        async all() { return { results: execute() }; },
        async run() { execute(); return { success: true }; },
      };
      return statement;
    },
    async transaction(callback) {
      let release;
      const previous = transactionTail;
      transactionTail = new Promise(resolve => { release = resolve; });
      await previous;
      try { return await callback(db); } finally { release(); }
    },
  };
  return db;
}

const context = {
  user: { id: 1, role: "superadmin", assignedSiteId: null, permissions: rolePermissionTemplate("superadmin") },
  db: database(),
};
globalThis.__tableRowOrderPersistenceTest = context;
const route = await import(await compileModuleGraph(new URL("../app/api/table-order/route.ts", import.meta.url), {
  "../../../db/client": dataUrl("export function getDatabase(){return globalThis.__tableRowOrderPersistenceTest.db;}"),
  "../../auth": dataUrl("export async function getAuthUser(){return globalThis.__tableRowOrderPersistenceTest.user;} export function assertSameOrigin(request){if(request.headers.get('origin')!==new URL(request.url).origin)throw new Error('Foreign origin');}"),
  "../../auditLog": dataUrl("export async function withAuditTrail(request,handler){return handler(request);}"),
  "../../equipmentReportStore": dataUrl("export async function ensureEquipmentReportSchema(){throw new Error('Personnel order must not initialize equipment');}"),
  "../../personnelImportOrderServer": dataUrl("export async function readPersonnelImportOrder(){return {importIds:[],hasImportOrder:false};}"),
}));
after(() => { delete globalThis.__tableRowOrderPersistenceTest; });

const request = (method, body, scope = "project-personnel", siteId = 7) => new Request(`http://localhost:3000/api/table-order?scope=${scope}&siteId=${siteId}`, {
  method,
  headers: { origin: "http://localhost:3000", "Content-Type": "application/json" },
  ...(body ? { body: JSON.stringify({ scope, siteId, ...body }) } : {}),
});
const post = body => route.POST(request("POST", body));
const read = async (siteId = 7) => {
  const response = await route.GET(request("GET", undefined, "project-personnel", siteId));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};

test("concurrent initial timesheet moves seed from only the first stale displayed baseline", async () => {
  context.db = database();
  const first = post({ movingIds: [4], placement: "before", targetId: 3, displayedIds: [2, 1, 3, 4], displayedIdsOnlyIfUnsaved: true });
  const second = post({ movingIds: [1], placement: "after", targetId: 4, displayedIds: [3, 2, 1, 4], displayedIdsOnlyIfUnsaved: true });
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
  assert.deepEqual((await firstResponse.json()).ids, [2, 1, 4, 3]);
  assert.deepEqual((await secondResponse.json()).ids, [2, 4, 1, 3], "The second move applies to the locked saved order, not its stale full baseline");

  const restored = await read();
  assert.deepEqual(restored, { ids: [2, 4, 1, 3], canWrite: true, hasSavedOrder: true, importIds: [], hasImportOrder: false });
  assert.deepEqual(await read(8), { ids: employeeIds, canWrite: true, hasSavedOrder: false, importIds: [], hasImportOrder: false });
});

test("conditional displayed baselines are accepted only for project personnel", async () => {
  context.db = database();
  for (const [scope, body] of [
    ["employees", { movingIds: [1], placement: "start", displayedIds: employeeIds, displayedIdsOnlyIfUnsaved: true }],
    ["project-personnel", { movingIds: [1], placement: "start", displayedIdsOnlyIfUnsaved: true }],
    ["project-personnel", { movingIds: [1], placement: "start", displayedIds: employeeIds, displayedIdsOnlyIfUnsaved: false }],
  ]) {
    const response = await route.POST(request("POST", body, scope));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Условный видимый порядок|видимый порядок/);
  }
});

test("an explicit catalog sort may still replace the displayed baseline after an order exists", async () => {
  context.db = database();
  let response = await post({ movingIds: [4], placement: "before", targetId: 3 });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).ids, [1, 2, 4, 3]);

  response = await post({ movingIds: [3], placement: "before", targetId: 1, displayedIds: [4, 3, 2, 1] });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).ids, [4, 2, 3, 1]);
  assert.deepEqual((await read()).ids, [4, 2, 3, 1]);
});
