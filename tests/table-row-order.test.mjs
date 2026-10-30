import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { gridRowEntityId, moveRowBlock, orderRowsByIds, reconcileRowOrder, rowMoveIsBlocked, saveManualRowMove, tableOrderScope } from "../app/tableRowOrder.ts";
import { rolePermissionTemplate } from "../app/permissionModel.ts";

test("a report can switch from its hidden default sort to manual order while filters and open editors still block moving", () => {
  const report = { editing: false, loading: false, filtered: false, sorted: true, switchSort: true, hasDraftRows: false };
  assert.equal(rowMoveIsBlocked(report), false);
  assert.equal(rowMoveIsBlocked({ ...report, editing: true }), true);
  assert.equal(rowMoveIsBlocked({ ...report, filtered: true }), true);
  assert.equal(rowMoveIsBlocked({ ...report, loading: true }), true);
  assert.equal(rowMoveIsBlocked({ ...report, switchSort: false }), true);
});

test("manual sorting is activated only after the row move has actually been saved", async () => {
  const operation = { movingIds: [2], placement: "before", targetId: 1 };
  const steps = [];
  assert.equal(await saveManualRowMove(operation, async (move) => { assert.equal(move, operation); steps.push("save"); return true; }, () => steps.push("manual")), true);
  assert.deepEqual(steps, ["save", "manual"]);
  assert.equal(await saveManualRowMove(operation, async () => false, () => steps.push("unexpected")), false);
  assert.deepEqual(steps, ["save", "manual"]);
});

test("moves one or several rows while keeping their relative order and all other rows", () => {
  assert.deepEqual(moveRowBlock([1, 2, 3, 4, 5], { movingIds: [5, 3], placement: "start" }), [3, 5, 1, 2, 4]);
  assert.deepEqual(moveRowBlock([1, 2, 3, 4, 5], { movingIds: [2, 3], placement: "end" }), [1, 4, 5, 2, 3]);
  assert.deepEqual(moveRowBlock([1, 2, 3, 4, 5], { movingIds: [2, 4], placement: "before", targetId: 5 }), [1, 3, 2, 4, 5]);
  assert.deepEqual(moveRowBlock([1, 2, 3, 4, 5], { movingIds: [4, 5], placement: "after", targetId: 1 }), [1, 4, 5, 2, 3]);
});

test("dragging from an automatic sort places the row exactly at the visible target", () => {
  assert.deepEqual(moveRowBlock([1, 2, 3], { movingIds: [3], placement: "before", targetId: 2, displayedIds: [2, 1, 3] }), [3, 2, 1]);
  assert.deepEqual(moveRowBlock([99, 1, 88, 2, 3, 77], { movingIds: [3], placement: "before", targetId: 2, displayedIds: [2, 1, 3] }), [99, 3, 2, 88, 1, 77]);
});

test("moving into the selected block is harmless, including selection of the whole table", () => {
  assert.deepEqual(moveRowBlock([1, 2, 3], { movingIds: [1, 2], placement: "after", targetId: 2 }), [1, 2, 3]);
  assert.deepEqual(moveRowBlock([1, 2], { movingIds: [2, 1], placement: "end" }), [1, 2]);
  assert.throws(() => moveRowBlock([1, 2], { movingIds: [2], placement: "before", targetId: 7 }), /больше не существует/);
});

test("new and removed rows never make a stored order lose or duplicate actual records", () => {
  assert.deepEqual(reconcileRowOrder([1, 2, 3, 4], [3, 9, 2, 3]), [3, 2, 1, 4]);
  assert.deepEqual(reconcileRowOrder([], [1]), []);
});

test("report rows retain their content and relative order within one employee", () => {
  const rows = [{ id: 1, hours: 4 }, { id: 2, hours: 8 }, { id: 1, hours: 3 }, { id: 3, hours: 9 }];
  assert.deepEqual(orderRowsByIds(rows, [2, 1], (row) => row.id), [rows[1], rows[0], rows[2], rows[3]]);
  assert.deepEqual(rows.map((row) => row.hours), [4, 8, 3, 9]);
});

test("reports, project directories and timesheets share only their own resource order", () => {
  assert.equal(tableOrderScope("placement", "all"), "personnel-report-rows");
  for (const view of ["timesheet", "projectEmployees"]) assert.equal(tableOrderScope(view, "all"), "project-personnel");
  assert.equal(tableOrderScope("equipment", "all"), "equipment-report-rows");
  for (const view of ["equipmentTimesheet", "projectEquipment"]) assert.equal(tableOrderScope(view, "all"), "project-equipment");
  assert.equal(tableOrderScope("employees", "all"), "employees");
  assert.equal(tableOrderScope("equipmentRegistry", "all"), "equipment");
  assert.equal(tableOrderScope("directories", "zone"), "directory-zone");
  assert.equal(tableOrderScope("directories", "mainWorkType"), "directory-work-types");
  assert.equal(tableOrderScope("directories", "subworkType"), "directory-work-types");
  assert.equal(tableOrderScope("auditLog", "all"), null);
});

test("technical IDs match actual employees and equipment instead of report entry IDs", () => {
  assert.equal(gridRowEntityId({ kind: "entry", entry: { id: 999, employeeId: 12 } }), 12);
  assert.equal(gridRowEntityId({ kind: "entry", entry: { id: 999, equipmentId: 13 } }), 13);
  for (const property of ["employee", "unit", "item", "record", "site", "user"]) assert.equal(gridRowEntityId({ kind: "entry", [property]: { id: 7 } }), 7);
  assert.equal(gridRowEntityId({ kind: "draft", employee: { id: 12 } }), undefined);
});

async function serverModule() {
  let code = ts.transpileModule(await readFile(new URL("../app/tableRowOrderServer.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const databaseStub = `data:text/javascript,${encodeURIComponent("export function getDatabase(){ throw new Error('Use the injected executor'); }")}`;
  code = code.replaceAll('"./workTypesRowOrder"', JSON.stringify(new URL("../app/workTypesRowOrder.ts", import.meta.url).href)).replaceAll('"./personnelReportRowOrder"', JSON.stringify(new URL("../app/personnelReportRowOrder.ts", import.meta.url).href)).replaceAll('"./equipmentReportRowOrder"', JSON.stringify(new URL("../app/equipmentReportRowOrder.ts", import.meta.url).href)).replaceAll('"../db/client"', JSON.stringify(databaseStub)).replaceAll('"./permissionModel"', JSON.stringify(new URL("../app/permissionModel.ts", import.meta.url).href)).replaceAll('"./tableRowOrder"', JSON.stringify(new URL("../app/tableRowOrder.ts", import.meta.url).href));
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

test("server permissions isolate projects and respect read-only references", async () => {
  const { rowOrderAccess } = await serverModule();
  const user = (role, assignedSiteId = null) => ({ id: 1, role, assignedSiteId, permissions: rolePermissionTemplate(role) });
  assert.equal(rowOrderAccess(user("engineer"), "positions", null).canWrite, false);
  assert.equal(rowOrderAccess(user("superadmin"), "positions", null).canWrite, true);
  assert.equal(rowOrderAccess(user("foreman", 1), "project-personnel", 1).canWrite, true);
  assert.equal(rowOrderAccess(user("foreman", 1), "employees", null).canRead, false);
  assert.throws(() => rowOrderAccess(user("foreman", 1), "project-personnel", 2), /Нет доступа/);
  assert.notEqual(rowOrderAccess(user("engineer"), "project-equipment", 1).key, rowOrderAccess(user("engineer"), "project-equipment", 2).key);
  assert.equal(rowOrderAccess(user("foreman", 1), "equipment-report-rows", 1).canWrite, true);
  assert.notEqual(rowOrderAccess(user("engineer"), "equipment-report-rows", 1).key, rowOrderAccess({ ...user("engineer"), id: 2 }, "equipment-report-rows", 1).key);
  assert.throws(() => rowOrderAccess(user("foreman", 1), "equipment-report-rows", 2), /Нет доступа/);
  assert.throws(() => rowOrderAccess(user("superadmin"), "invalid", null), /Неизвестная таблица/);
});

test("canonical project rows are read through the same transaction connection", async () => {
  const { canonicalRowIds } = await serverModule();
  let bound;
  const executor = { prepare: () => ({ bind: (...values) => { bound = values; return { all: async () => ({ results: [{ id: 42 }] }) }; } }) };
  assert.deepEqual(await canonicalRowIds("project-personnel", 9, executor), [42]);
  assert.deepEqual(bound, [9, 9, 9]);
});

test("equipment report ordering uses record IDs, keeps published origins and isolates the foreman's records", async () => {
  const { canonicalRowIds } = await serverModule();
  let sql;
  let bound;
  const executor = { prepare: statement => { sql = statement; return { bind: (...values) => { bound = values; return { all: async () => ({ results: [{ id: "2026-10-30/report-8-10" }, { id: "2026-10-29/approved-44" }] }) }; } }; } };
  assert.deepEqual(await canonicalRowIds("equipment-report-rows", 9, executor, { id: 7, role: "foreman" }), ["2026-10-30/report-8-10", "2026-10-29/approved-44"]);
  assert.deepEqual(bound, [9, 7, 9, 7]);
  assert.match(sql, /FROM equipment_report_rows row JOIN equipment_reports/);
  assert.match(sql, /origin\.approved_entry_id = entry\.id/);
  assert.match(sql, /report\.owner_user_id = \?/);
  assert.match(sql, /entry\.responsible_user_id = \?/);
  await canonicalRowIds("equipment-report-rows", 9, executor, { id: 8, role: "engineer" });
  assert.deepEqual(bound, [9, 9]);
  assert.doesNotMatch(sql, /owner_user_id = \?|responsible_user_id = \?/);
});
