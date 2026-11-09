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
  code = code.replaceAll('"./roles.ts"', JSON.stringify(new URL("../app/roles.ts", import.meta.url).href)).replaceAll('"./workTypesRowOrder"', JSON.stringify(new URL("../app/workTypesRowOrder.ts", import.meta.url).href)).replaceAll('"./personnelReportRowOrder"', JSON.stringify(new URL("../app/personnelReportRowOrder.ts", import.meta.url).href)).replaceAll('"./equipmentReportRowOrder"', JSON.stringify(new URL("../app/equipmentReportRowOrder.ts", import.meta.url).href)).replaceAll('"../db/client"', JSON.stringify(databaseStub)).replaceAll('"./permissionModel"', JSON.stringify(new URL("../app/permissionModel.ts", import.meta.url).href)).replaceAll('"./tableRowOrder"', JSON.stringify(new URL("../app/tableRowOrder.ts", import.meta.url).href));
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
  assert.notEqual(rowOrderAccess(user("engineer", 1), "equipment-report-rows", 1).key, rowOrderAccess({ ...user("engineer", 1), id: 2 }, "equipment-report-rows", 1).key);
  assert.throws(() => rowOrderAccess(user("foreman", 1), "equipment-report-rows", 2), /Нет доступа/);
  assert.throws(() => rowOrderAccess(user("superadmin"), "invalid", null), /Неизвестная таблица/);
});

test("engineer row orders cannot leave the assigned project, even with global overrides", async () => {
  const { rowOrderAccess, TableOrderAccessError } = await serverModule();
  const engineer = { id: 17, role: "engineer", assignedSiteId: 1, projectAccess: { mode: "selected", siteIds: [1] }, permissions: rolePermissionTemplate("superadmin") };
  const allProjectEngineer = { ...engineer, assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] } };
  for (const scope of ["project-personnel", "project-equipment", "personnel-report-rows", "equipment-report-rows", "directory-work-types", "directory-zone", "employees", "equipment", "users", "projects"]) {
    assert.equal(rowOrderAccess(engineer, scope, 1).canRead, true);
    assert.throws(() => rowOrderAccess(engineer, scope, 2), error => error instanceof TableOrderAccessError && error.status === 403);
    assert.throws(() => rowOrderAccess({ ...engineer, projectAccess: { mode: "selected", siteIds: [] } }, scope, 1), /Нет доступа/);
    assert.equal(rowOrderAccess(allProjectEngineer, scope, 2).canRead, true);
  }
  assert.notEqual(rowOrderAccess(engineer, "employees", 1).key, rowOrderAccess(allProjectEngineer, "employees", 1).key);
});

test("scoped catalog order IDs include only active assignments from the engineer's project", async () => {
  const { canonicalRowIds } = await serverModule();
  const engineer = { id: 17, role: "engineer", assignedSiteId: 3, projectAccess: { mode: "selected", siteIds: [3] }, permissions: rolePermissionTemplate("engineer") };
  const queries = [];
  const executor = { prepare: sql => ({ bind: (...values) => ({ all: async () => { queries.push({ sql, values }); return { results: [{ id: 42 }] }; } }) }) };
  for (const scope of ["employees", "equipment", "users", "projects"]) {
    assert.deepEqual(await canonicalRowIds(scope, 3, executor, engineer), [42]);
    assert.deepEqual(queries.at(-1).values, scope === "users" ? [[3], [3]] : [[3]]);
  }
  assert.match(queries[0].sql, /employee_project_assignments[\s\S]*assignment\.site_id = ANY\(\?::integer\[\]\)[\s\S]*assignment\.active = 1/);
  assert.match(queries[1].sql, /equipment_project_assignments[\s\S]*assignment\.site_id = ANY\(\?::integer\[\]\)[\s\S]*assignment\.active = 1/);
  assert.match(queries[2].sql, /assigned_site_id = ANY\(\?::integer\[\]\)/);
  assert.match(queries[3].sql, /id = ANY\(\?::integer\[\]\)/);
  const count = queries.length;
  await assert.rejects(canonicalRowIds("employees", 4, executor, engineer), /Нет доступа/);
  assert.equal(queries.length, count);
});

test("canonical project rows are read through the same transaction connection", async () => {
  const { canonicalRowIds } = await serverModule();
  let bound;
  const executor = { prepare: () => ({ bind: (...values) => { bound = values; return { all: async () => ({ results: [{ id: 42 }] }) }; } }) };
  assert.deepEqual(await canonicalRowIds("project-personnel", 9, executor), [42]);
  assert.deepEqual(bound, [9, 9, 9]);
});

test("approved personnel report ordering retains the saved workbook row rank", async () => {
  const { canonicalRowIds } = await serverModule();
  let sql;
  const executor = { prepare: statement => { sql = statement; return { bind: () => ({ all: async () => ({ results: [] }) }) }; } };
  await canonicalRowIds("personnel-report-rows", 9, executor, { id: 7, role: "foreman", assignedSiteId: 9 });
  assert.match(sql, /COALESCE\(origin\.row_order, 0\) AS rank/);
  assert.match(sql, /records ORDER BY day DESC, created DESC, rank, id DESC/);
});

test("equipment report ordering uses record IDs, keeps published origins and isolates the foreman's records", async () => {
  const { canonicalRowIds } = await serverModule();
  let sql;
  let bound;
  const executor = { prepare: statement => { sql = statement; return { bind: (...values) => { bound = values; return { all: async () => ({ results: [{ id: "2026-10-30/report-8-10" }, { id: "2026-10-29/approved-44" }] }) }; } }; } };
  assert.deepEqual(await canonicalRowIds("equipment-report-rows", 9, executor, { id: 7, role: "foreman", assignedSiteId: 9 }), ["2026-10-30/report-8-10", "2026-10-29/approved-44"]);
  assert.deepEqual(bound, [9, 7, 9, 7]);
  assert.match(sql, /FROM equipment_report_rows row JOIN equipment_reports/);
  assert.match(sql, /origin\.approved_entry_id = entry\.id/);
  assert.match(sql, /report\.owner_user_id = \?/);
  assert.match(sql, /entry\.responsible_user_id = \?/);
  assert.deepEqual(await canonicalRowIds("equipment-report-rows", 9, executor, { id: 8, role: "engineer", assignedSiteId: 9 }), ["2026-10-30/report-8-10", "2026-10-29/approved-44"]);
  assert.deepEqual(bound, [9, 8, 9]);
  const [pendingSql, publishedSql] = sql.split("UNION ALL");
  assert.match(pendingSql, /WHERE report\.site_id = \? AND report\.status <> 'approved'/);
  assert.match(pendingSql, /AND \(report\.status = 'submitted' OR report\.owner_user_id = \?\)/);
  assert.doesNotMatch(pendingSql, /AND FALSE/, "An engineer can still order submitted reports from another author");
  assert.match(publishedSql, /WHERE entry\.site_id = \? AND entry\.deleted_at IS NULL/);
  assert.doesNotMatch(publishedSql, /report\.owner_user_id|entry\.responsible_user_id/, "Author-only drafts must not hide published entries from the project engineer");
  assert.match(publishedSql, /COALESCE\(origin\.row_order, 0\) AS rank/);
  assert.match(publishedSql, /records ORDER BY day DESC, created DESC, rank, id DESC/);
  assert.equal((sql.match(/\?/g) ?? []).length, bound.length, "Each project and author predicate has a matching bound value");
});
