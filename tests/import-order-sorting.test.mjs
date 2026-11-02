import assert from "node:assert/strict";
import test from "node:test";
import { createImportOrderRank, IMPORT_ORDER_COLUMN, importOrderColumnState, importOrderScopes, shouldApplyImportOrder } from "../app/importOrderSorting.ts";
import { orderRowsByIds } from "../app/tableRowOrder.ts";

test("Excel order overrides a different manual order without changing either stored list or row content", () => {
  const rows = [{ id: 1, name: "Абаев", hours: 3 }, { id: 2, name: "Зотов", hours: 8 }, { id: 3, name: "Петров", hours: 5 }, { id: 4, name: "Другой", hours: 6 }];
  const imported = Object.freeze([2, 1, 3, 4]);
  const manual = Object.freeze([3, 4, 1, 2]);
  const manuallyOrdered = orderRowsByIds(rows, manual, row => row.id);
  const rank = createImportOrderRank(rows, imported, row => row.id);
  const visible = [...manuallyOrdered].sort((left, right) => rank(left) - rank(right));
  assert.deepEqual(visible.map(row => row.name), ["Зотов", "Абаев", "Петров", "Другой"]);
  assert.deepEqual(orderRowsByIds(visible, manual, row => row.id).map(row => row.id), [3, 4, 1, 2]);
  assert.deepEqual(rows.map(row => row.id), [1, 2, 3, 4]);
  assert.equal(visible[0], rows[1]);
  assert.deepEqual(manual, [3, 4, 1, 2]);
  assert.deepEqual(imported, [2, 1, 3, 4]);
});

test("new or unlisted rows use canonical source order after imported identities, not manual order", () => {
  const rows = [{ id: 1 }, { key: "new-a" }, { id: 2 }, { key: "new-b" }, { id: 3 }];
  const rank = createImportOrderRank(rows, [2, 2, 1], row => row.id);
  assert.deepEqual([...rows].reverse().sort((left, right) => rank(left) - rank(right)), [rows[2], rows[0], rows[1], rows[3], rows[4]]);
  const noImport = createImportOrderRank(rows, [], row => row.id);
  assert.deepEqual([...rows].reverse().sort((left, right) => noImport(left) - noImport(right)), rows);
});

test("multiple rows belonging to the same employee keep their own stable order", () => {
  const rows = [{ id: 2, hours: 3 }, { id: 1, hours: 8 }, { id: 2, hours: 5 }];
  const rank = createImportOrderRank(rows, [2, 1], row => row.id);
  assert.deepEqual([...rows].sort((left, right) => rank(left) - rank(right)), [rows[0], rows[2], rows[1]]);
});

test("explicit import activation clears competing column sorts but does not mutate manual IDs", () => {
  const state = importOrderColumnState();
  assert.deepEqual(state, { state: [{ colId: IMPORT_ORDER_COLUMN, sort: "asc", sortIndex: 0 }], defaultState: { sort: null, sortIndex: null } });
  assert.notEqual(importOrderColumnState(), state);
  assert.equal(importOrderScopes.has("employees"), true);
  assert.equal(importOrderScopes.has("project-personnel"), true);
  for (const scope of ["equipment", "users", "personnel-report-rows", "directory-zone"]) assert.equal(importOrderScopes.has(scope), false);
});

test("ordinary refreshes preserve manual/selected sorting; only the first unconfigured view defaults to import", () => {
  const initial = { activated: false, firstLoad: true, defaultImport: true, sorted: false };
  assert.equal(shouldApplyImportOrder(initial), true);
  assert.equal(shouldApplyImportOrder({ ...initial, firstLoad: false }), false);
  assert.equal(shouldApplyImportOrder({ ...initial, defaultImport: false }), false);
  assert.equal(shouldApplyImportOrder({ ...initial, sorted: true }), false);
  assert.equal(shouldApplyImportOrder({ activated: true, firstLoad: false, defaultImport: false, sorted: true }), true);
});
