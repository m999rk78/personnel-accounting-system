import assert from "node:assert/strict";
import test from "node:test";
import { mergePersonnelImportOrder, readPersonnelImportOrder, rememberPersonnelImportOrder } from "../app/personnelImportOrderServer.ts";

function fixture(initial = {}) {
  const records = new Map(Object.entries(initial));
  const writes = [];
  const locks = [];
  const db = { prepare(sql) { return { bind(...values) {
    return {
      async first() {
        assert.match(sql, /^SELECT row_ids AS ids FROM table_row_orders WHERE id = \?/);
        if (sql.endsWith("FOR UPDATE")) locks.push(values[0]);
        return records.has(values[0]) ? { ids: structuredClone(records.get(values[0])) } : null;
      },
      async run() {
        if (sql.startsWith("INSERT INTO table_row_orders")) {
          writes.push(values[0]);
          if (!records.has(values[0])) records.set(values[0], []);
        } else if (sql.startsWith("UPDATE table_row_orders")) {
          writes.push(values[1]); records.set(values[1], JSON.parse(values[0]));
        } else throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
  } }; } };
  return { db, records, writes, locks };
}

test("latest workbook order is unique and preserves unrelated previous employees as a tail", () => {
  const result = mergePersonnelImportOrder([3, 1, 3, 2], [9, 2, 7, 7]);
  assert.deepEqual(result, [3, 1, 2, 9, 7]);
  assert.deepEqual(mergePersonnelImportOrder([3, 1, 3, 2], result), result);
  assert.deepEqual(mergePersonnelImportOrder([7, 9], result), [7, 9, 3, 1, 2]);
});

test("remember locks only the separate import baseline and never overwrites manual order", async () => {
  const state = fixture({ "employees:0": [1, 2, 3], "project-personnel:7": [2, 1], "import-order:employees:0": [9, 2] });
  await rememberPersonnelImportOrder(state.db, "employees", null, [3, 1, 3]);
  await rememberPersonnelImportOrder(state.db, "project-personnel", 7, [1, 2]);
  await rememberPersonnelImportOrder(state.db, "project-personnel", 8, [2, 1]);
  assert.deepEqual(state.records.get("employees:0"), [1, 2, 3]);
  assert.deepEqual(state.records.get("project-personnel:7"), [2, 1]);
  assert.deepEqual(state.records.get("import-order:employees:0"), [3, 1, 9, 2]);
  assert.deepEqual(state.records.get("import-order:project-personnel:7"), [1, 2]);
  assert.deepEqual(state.records.get("import-order:project-personnel:8"), [2, 1]);
  assert.deepEqual(state.locks, ["import-order:employees:0", "import-order:project-personnel:7", "import-order:project-personnel:8"]);
  assert.ok(state.writes.every(key => key.startsWith("import-order:")));
});

test("reading an import order filters hidden, inactive and foreign employees before appending the canonical remainder", async () => {
  const state = fixture({ "import-order:employees:0": [999, 3, 2, 3] });
  assert.deepEqual(await readPersonnelImportOrder(state.db, "employees", 7, [1, 2, 3]), { importIds: [3, 2, 1], hasImportOrder: true });
  assert.deepEqual(await readPersonnelImportOrder(state.db, "employees", 7, [1, 2]), { importIds: [2, 1], hasImportOrder: true });
  assert.deepEqual(await readPersonnelImportOrder(state.db, "project-personnel", 7, [3, 1, 2]), { importIds: [3, 1, 2], hasImportOrder: false });
  assert.deepEqual(state.writes, [], "read must not persist a view preference");
  assert.deepEqual(state.locks, []);
});

test("invalid employee IDs and missing project identities fail before any write; an empty import is a no-op", async () => {
  const state = fixture();
  for (const id of [0, -1, 1.5, NaN, "1", 2 ** 40]) await assert.rejects(rememberPersonnelImportOrder(state.db, "employees", null, [id]), /Некорректный порядок/);
  await assert.rejects(rememberPersonnelImportOrder(state.db, "project-personnel", null, [1]), /Укажите проект/);
  await rememberPersonnelImportOrder(state.db, "employees", null, []);
  assert.deepEqual(state.writes, []);
});
