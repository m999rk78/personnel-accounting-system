import assert from "node:assert/strict";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const { mutateEquipmentReport } = await import(await compileModuleGraph(new URL("../app/equipmentReportStore.ts", import.meta.url)));
const actor = permissions => ({ id: 10, role: "foreman", assignedSiteId: 7,
  projectAccess: { mode: "selected", siteIds: [7] }, permissions: { ...rolePermissionTemplate("foreman"), ...(permissions ? { equipment_report: permissions } : {}) } });

/** A synthetic transaction which only supports an empty unpublished draft. */
function database({ failOrder = false } = {}) {
  const orders = new Map([["project-equipment:7", [2, 1]], ["import-order:project-personnel:7", [2, 1]]]);
  let header;
  const queries = [], writes = [];
  const db = {
    orders, queries, writes,
    prepare(sql) {
      let params = [];
      function execute() {
        queries.push({ sql, params });
        if (sql.includes("FROM sites WHERE")) return [{ id: params[0] }];
        if (sql.startsWith("SELECT equipment.id FROM equipment_units")) return params[0].filter(id => [1, 2, 3].includes(id)).map(id => ({ id }));
        if (sql.includes("FROM equipment_units equipment")) return [];
        if (sql.includes("pg_advisory_xact_lock")) return [];
        if (sql.startsWith("SELECT id FROM equipment_reports WHERE site_id")) return [];
        if (sql.includes("FROM equipment_reports report JOIN app_users owner")) return header ? [header] : [];
        if (sql.includes("FROM equipment_report_rows draft_row JOIN")) return [];
        if (sql.startsWith("SELECT clock_timestamp()")) return [{ changedAt: "2026-11-09T09:00:00Z" }];
        if (sql.startsWith("SELECT row_ids AS ids FROM table_row_orders")) return orders.has(params[0]) ? [{ ids: orders.get(params[0]) }] : [];
        writes.push({ sql, params });
        if (sql.startsWith("INSERT INTO equipment_reports")) {
          header = { id: 18, siteId: params[0], workDate: params[1], ownerUserId: params[2], status: "draft", revision: 1 };
          return [{ id: header.id }];
        }
        if (sql.startsWith("DELETE FROM equipment_report_rows") || sql.startsWith("UPDATE equipment_report_rows SET row_order")) return [];
        if (sql.startsWith("INSERT INTO table_row_orders")) {
          if (!orders.has(params[0])) orders.set(params[0], []);
          return [];
        }
        if (sql.startsWith("UPDATE table_row_orders")) {
          if (failOrder) throw new Error("Synthetic order failure");
          orders.set(params[1], JSON.parse(params[0])); return [];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      const statement = { bind(...values) { params = values; return statement; },
        async first() { return execute()[0] ?? null; }, async all() { return { results: execute() }; }, async run() { execute(); return { success: true }; } };
      return statement;
    },
    async readBatch(statements) { return statements.map(() => ({ results: [] })); },
    async transaction(callback) {
      const before = { header: structuredClone(header), orders: structuredClone(orders) };
      try { return await callback(db); }
      catch (error) { header = before.header; orders.clear(); before.orders.forEach((value, key) => orders.set(key, value)); throw error; }
    },
  };
  return db;
}
const payload = importEquipmentOrder => ({ action: "save", siteId: 7, workDate: "2026-11-09", rows: [], importEquipmentOrder });

test("report saving persists the equipment workbook baseline in the report transaction without replacing manual or personnel orders", async () => {
  const db = database();
  const report = await mutateEquipmentReport(db, actor(), payload([3, 1, 2]));
  assert.equal(report.id, 18);
  assert.deepEqual(db.orders.get("import-order:project-equipment:7"), [3, 1, 2]);
  assert.deepEqual(db.orders.get("project-equipment:7"), [2, 1]);
  assert.deepEqual(db.orders.get("import-order:project-personnel:7"), [2, 1]);
  const assigned = db.queries.find(({ sql }) => sql.startsWith("SELECT equipment.id FROM"));
  assert.match(assigned.sql, /equipment\.active = 1/);
  assert.match(assigned.sql, /assignment\.site_id = \? AND assignment\.active = 1/);
  assert.deepEqual(assigned.params, [[3, 1, 2], 7]);
  const failed = database({ failOrder: true });
  await assert.rejects(mutateEquipmentReport(failed, actor(), payload([3, 1])), /Synthetic order failure/);
  assert.equal(failed.orders.has("import-order:project-equipment:7"), false);
});

test("invalid, duplicate and unassigned import identities are rejected before writes and create permission remains mandatory", async () => {
  for (const order of [[0], ["1"], [1, 1], [99], Array.from({ length: 5001 }, (_, index) => index + 1)]) {
    const db = database();
    await assert.rejects(mutateEquipmentReport(db, actor(), payload(order)), error => error.code === "INVALID_IMPORT_ORDER");
    assert.deepEqual(db.writes, []);
  }
  const db = database();
  await assert.rejects(mutateEquipmentReport(db, actor({ view: true, create: false, update: false, delete: false }), payload([1])), error => error.code === "REPORT_FORBIDDEN");
  assert.deepEqual(db.writes, []);
});
