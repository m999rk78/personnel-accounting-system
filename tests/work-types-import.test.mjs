import assert from "node:assert/strict";
import test from "node:test";
import { importWorkTypeDirectory } from "../app/workTypeHierarchyServer.ts";
import { workTypesExcelValues } from "../app/workTypesExcel.ts";

function databaseFixture({ duplicateUnassigned = false, duplicatePair = false } = {}) {
  let data = {
    parents: [{ id: 1, siteId: 1, name: "Вспомогательные", active: 1 }, { id: 2, siteId: 1, name: "Архивный вид", active: 0 }, { id: 3, siteId: 2, name: "Чужой вид", active: 1 }],
    children: [
      { id: 10, siteId: 1, name: "Старый подвид", mainWorkTypeId: null, active: 1 },
      { id: 11, siteId: 1, name: "Историческая связь", mainWorkTypeId: 2, active: 1 },
      { id: 12, siteId: 1, name: "Подготовка", mainWorkTypeId: 1, active: 1 },
      { id: 13, siteId: 2, name: "Чужой подвид", mainWorkTypeId: null, active: 1 },
      { id: 14, siteId: 1, name: "Архивный подвид", mainWorkTypeId: null, active: 0 },
      ...(duplicateUnassigned ? [{ id: 15, siteId: 1, name: " Старый   подвид ", mainWorkTypeId: null, active: 1 }] : []),
      ...(duplicatePair ? [{ id: 16, siteId: 1, name: " ПОДГОТОВКА ", mainWorkTypeId: 1, active: 1 }] : []),
    ],
  };
  const original = structuredClone(data);
  const result = (results = [], changes = 0, lastRowId = null) => ({ results, success: true, meta: { changes, last_row_id: lastRowId } });
  return {
    original, snapshot: () => structuredClone(data),
    async transaction(operation) {
      const pending = structuredClone(data);
      const execute = (sql, values) => {
        if (sql.includes("pg_advisory_xact_lock")) return result();
        if (sql.startsWith("SELECT id FROM sites")) return result(values[0] === 1 ? [{ id: 1 }] : []);
        if (sql.startsWith("SELECT id, name FROM main_work_types")) return result(pending.parents.filter(row => row.siteId === values[0] && row.active).map(row => ({ id: row.id, name: row.name })));
        if (sql.startsWith("SELECT id, name, main_work_type_id")) return result(pending.children.filter(row => row.siteId === values[0] && row.active).map(row => ({ id: row.id, name: row.name, mainWorkTypeId: row.mainWorkTypeId })));
        if (sql.startsWith("INSERT INTO main_work_types")) {
          const id = 100 + pending.parents.length;
          pending.parents.push({ id, siteId: values[0], name: values[1], active: 1 }); return result([], 1, id);
        }
        if (sql.startsWith("INSERT INTO subwork_types")) {
          const id = 200 + pending.children.length;
          pending.children.push({ id, siteId: values[0], name: values[1], mainWorkTypeId: values[2], active: 1 }); return result([], 1, id);
        }
        if (sql.startsWith("UPDATE subwork_types")) {
          const child = pending.children.find(row => row.id === values[1] && row.siteId === values[2] && row.active && row.mainWorkTypeId === null);
          if (!child) return result([], 0);
          child.mainWorkTypeId = values[0]; return result([], 1);
        }
        throw new Error(`Unexpected fixture SQL: ${sql}`);
      };
      const transaction = { prepare(sql) {
        const statement = values => ({ bind: (...next) => statement(next), all: async () => execute(sql, values), first: async () => execute(sql, values).results[0] ?? null, run: async () => execute(sql, values) });
        return statement([]);
      } };
      const output = await operation(transaction);
      data = pending;
      return output;
    },
  };
}

test("work-types export imports back unchanged with nullable and archived-parent legacy subtypes", async () => {
  const db = databaseFixture();
  const rows = workTypesExcelValues([
    { key: "parent-1", name: "Вспомогательные" }, { key: "unassigned", name: "Без вида", unassigned: true },
  ], parent => parent.unassigned ? [{ name: "Старый подвид" }, { name: "Историческая связь" }] : [{ name: "Подготовка" }]);
  const entries = rows.map(([name, subworkName]) => ({ name, subworkName }));
  assert.equal(await importWorkTypeDirectory(db, 1, entries), 3);
  assert.deepEqual(db.snapshot(), db.original, "round-trip must not rewrite names, nullable parents or archived parent IDs");
  await importWorkTypeDirectory(db, 1, entries);
  assert.deepEqual(db.snapshot(), db.original);
});

test("blank parent never creates a new child, revives an archive or matches another project", async () => {
  for (const subworkName of ["Новый без вида", "Архивный подвид", "Чужой подвид", "Подготовка"]) {
    const db = databaseFixture();
    await assert.rejects(importWorkTypeDirectory(db, 1, [{ name: "Новый вид", subworkName: "Новый подвид" }, { name: "", subworkName }]), /заполните вид работы/);
    assert.deepEqual(db.snapshot(), db.original, "the whole workbook remains unchanged on a later invalid row");
  }
});

test("malformed work-type imports fail before they can drop or rewrite values", async () => {
  const db = databaseFixture();
  for (const rows of [undefined, [], Array.from({ length: 5001 }, () => ({ name: "Вид", subworkName: "" }))]) {
    await assert.rejects(importWorkTypeDirectory(db, 1, rows), /от 1 до 5000/);
  }
  await assert.rejects(importWorkTypeDirectory(db, 1, [{ name: "Вид", subworkName: 123 }]), /должны быть текстом/);
  await assert.rejects(importWorkTypeDirectory(db, 1, [{ name: "Вид", subworkName: "а".repeat(241) }]), /до 240 символов/);
  assert.deepEqual(db.snapshot(), db.original);
});

test("ambiguous unassigned names and existing parent-child pairs are rejected without partial changes", async () => {
  const unassigned = databaseFixture({ duplicateUnassigned: true });
  await assert.rejects(importWorkTypeDirectory(unassigned, 1, [{ name: "", subworkName: "СТАРЫЙ ПОДВИД" }]), /неоднозначен/);
  assert.deepEqual(unassigned.snapshot(), unassigned.original);
  const pair = databaseFixture({ duplicatePair: true });
  await assert.rejects(importWorkTypeDirectory(pair, 1, [{ name: "Откатить этот вид", subworkName: "" }, { name: "Вспомогательные", subworkName: "Подготовка" }]), /неоднозначен/);
  assert.deepEqual(pair.snapshot(), pair.original);
});

test("work-types import still assigns a known nullable child, creates paired children and remains idempotent", async () => {
  const db = databaseFixture();
  const entries = [{ name: "Вспомогательные", subworkName: " старый   подвид " }, { name: "Новый вид", subworkName: "Новый подвид" }, { name: "Пустой вид", subworkName: "" }];
  await importWorkTypeDirectory(db, 1, entries);
  const once = db.snapshot();
  assert.equal(once.children.find(row => row.id === 10).mainWorkTypeId, 1);
  assert.equal(once.children.find(row => row.id === 10).name, "Старый подвид");
  assert.equal(once.children.find(row => row.id === 11).mainWorkTypeId, 2);
  const parent = once.parents.find(row => row.name === "Новый вид");
  assert.equal(once.children.find(row => row.name === "Новый подвид").mainWorkTypeId, parent.id);
  await importWorkTypeDirectory(db, 1, entries);
  assert.deepEqual(db.snapshot(), once);
});
