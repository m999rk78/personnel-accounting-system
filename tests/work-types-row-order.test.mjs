import assert from "node:assert/strict";
import test from "node:test";
import { isWorkTypesOrderId, workTypesOrderId } from "../app/workTypesRowOrder.ts";
import { moveRowBlock, orderRowsByIds, reconcileRowOrder } from "../app/tableRowOrder.ts";

test("work directory move keys distinguish parents from children and reject invalid identities", () => {
  for (const id of ["parent-1", "child-1", "child-50000"]) assert.equal(isWorkTypesOrderId(id), true);
  for (const id of [1, null, "child-0", "parent--2", "parent-1.5", "child-1/path", "child-9007199254740992"]) assert.equal(isWorkTypesOrderId(id), false);
  assert.notEqual(workTypesOrderId({ key: "parent-1" }), workTypesOrderId({ key: "child-1" }));
  for (const row of [{ key: "unassigned" }, { key: "new-parent-1" }, { key: "child-1", kind: "draft" }, {}]) assert.equal(workTypesOrderId(row), undefined);
  assert.equal(workTypesOrderId({ key: "parent-1", kind: "edit" }), "parent-1");
});

test("moving selected directory rows changes only their order and preserves parent associations", () => {
  const rows = [
    { key: "child-1", parentId: 1, name: "Уборка" },
    { key: "child-2", parentId: 1, name: "Перевозка" },
    { key: "parent-2", parentId: 2, name: "" },
    { key: "child-3", parentId: null, name: "Не назначен" },
  ];
  const original = structuredClone(rows);
  const moved = moveRowBlock(rows.map(workTypesOrderId), { movingIds: ["child-3", "child-2"], placement: "start" });
  assert.deepEqual(orderRowsByIds(rows, moved, workTypesOrderId), [rows[1], rows[3], rows[0], rows[2]]);
  assert.deepEqual(rows, original);
  assert.deepEqual(reconcileRowOrder(["child-1", "child-3", "child-4"], moved), ["child-3", "child-1", "child-4"]);
});

test("a saved flat order remains intact when populated master rows become available", () => {
  const available = ["parent-1", "child-1", "child-2", "parent-2", "parent-3", "child-3"];
  const saved = ["child-2", "parent-2", "child-1", "child-3", "child-2", "child-99"];
  assert.deepEqual(reconcileRowOrder(available, saved), ["child-2", "parent-2", "child-1", "child-3", "parent-1", "parent-3"]);
});

test("master and detail grids can order their own subsets through the combined scope", () => {
  const rows = [
    { key: "parent-1" }, { key: "child-1", parentId: 1 }, { key: "child-2", parentId: 1 },
    { key: "parent-2" }, { key: "child-3", parentId: 2 }, { key: "parent-3" },
  ];
  const ids = rows.map(workTypesOrderId);
  const parentRows = rows.filter(row => row.key.startsWith("parent-"));
  const firstDetail = rows.filter(row => row.parentId === 1);
  const secondDetail = rows.filter(row => row.parentId === 2);
  const childMove = moveRowBlock(ids, { movingIds: ["child-2"], placement: "before", targetId: "child-1", displayedIds: ["child-2", "child-1"] });
  assert.deepEqual(orderRowsByIds(firstDetail, childMove, workTypesOrderId).map(workTypesOrderId), ["child-2", "child-1"]);
  assert.deepEqual(orderRowsByIds(parentRows, childMove, workTypesOrderId), parentRows);
  assert.deepEqual(orderRowsByIds(secondDetail, childMove, workTypesOrderId), secondDetail);
  const parentMove = moveRowBlock(childMove, { movingIds: ["parent-3"], placement: "before", targetId: "parent-1", displayedIds: ["parent-3", "parent-2", "parent-1"] });
  assert.deepEqual(orderRowsByIds(parentRows, parentMove, workTypesOrderId).map(workTypesOrderId), ["parent-2", "parent-3", "parent-1"]);
  assert.deepEqual(orderRowsByIds(firstDetail, parentMove, workTypesOrderId).map(workTypesOrderId), ["child-2", "child-1"]);
  assert.deepEqual(orderRowsByIds(secondDetail, parentMove, workTypesOrderId), secondDetail);
  assert.deepEqual(new Set(parentMove), new Set(ids));
});
