import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkTypesIndex, filterWorkTypeParents, normalizeWorkTypeSearch, workTypeChildRows, workTypesTableRows } from "../app/workTypesDirectoryModel.ts";

const parents = [
  { id: 2, name: "Вспомогательные работы" },
  { id: 1, name: "Земляные работы" },
  { id: 3, name: "Монтаж" },
];
const children = [
  { id: 11, name: "Уборка территории", mainWorkTypeId: 2 },
  { id: 12, name: "Перевозка персонала", mainWorkTypeId: 2 },
  { id: 13, name: "Перевозка грунта", mainWorkTypeId: 1 },
  { id: 14, name: "Отсутствует вид", mainWorkTypeId: null },
  { id: 15, name: "Архивный вид", mainWorkTypeId: 99 },
  { id: 16, name: "Старые данные" },
];

test("directory index groups children in input order and treats absent parents as unassigned", () => {
  const original = structuredClone({ parents, children });
  const index = buildWorkTypesIndex(parents, children);
  assert.deepEqual(index.parents.map(parent => [parent.id, parent.childCount]), [[2, 2], [1, 1], [3, 0]]);
  assert.deepEqual(index.byParent.get(2).map(child => child.id), [11, 12]);
  assert.deepEqual(index.byParent.get(3), []);
  assert.deepEqual(index.unassigned.map(child => child.id), [14, 15, 16]);
  assert.deepEqual(index.children.map(row => row.id), children.map(child => child.id));
  assert.deepEqual(index.children[0], { id: 11, name: "Уборка территории", parentId: 2, parentName: "Вспомогательные работы", assigned: true });
  assert.deepEqual(index.children[4], { id: 15, name: "Архивный вид", parentId: null, parentName: "Не распределены", assigned: false });
  assert.deepEqual({ parents, children }, original, "building the index never mutates input catalogs");
});

test("Russian search handles case, ё, stress and whitespace without merging й with и", () => {
  assert.equal(normalizeWorkTypeSearch("  УЧЁТ  \n  Монта́жа  "), "учет монтажа");
  assert.notEqual(normalizeWorkTypeSearch("Стройка"), normalizeWorkTypeSearch("Строика"));
  const index = buildWorkTypesIndex([{ id: 1, name: "Учёт техники" }], [{ id: 2, name: "Монта́ж оборудования", mainWorkTypeId: 1 }]);
  assert.equal(filterWorkTypeParents(index, { query: " УЧЕТ " }).length, 1);
  assert.equal(filterWorkTypeParents(index, { query: "МОНТАЖ" }).length, 1);
  assert.equal(workTypeChildRows(index, "all", "учет").length, 1);
  assert.equal(workTypeChildRows(index, "all", "Монтаж").length, 1);
});

test("parent search includes child matches and combines with empty or filled status", () => {
  const index = buildWorkTypesIndex(parents, children);
  assert.deepEqual(filterWorkTypeParents(index, { query: "перевозка" }).map(parent => parent.id), [2, 1]);
  assert.deepEqual(filterWorkTypeParents(index, { query: "вспомогательные" }).map(parent => parent.id), [2]);
  assert.deepEqual(filterWorkTypeParents(index, { status: "empty" }).map(parent => parent.id), [3]);
  assert.deepEqual(filterWorkTypeParents(index, { status: "filled" }).map(parent => parent.id), [2, 1]);
  assert.deepEqual(filterWorkTypeParents(index, { status: "empty", query: "перевозка" }), []);
  assert.deepEqual(filterWorkTypeParents(index, { status: "filled", query: "монтаж" }), []);
  assert.deepEqual(filterWorkTypeParents(index, { query: "Отсутствует вид" }), []);
});

test("table scopes and search use real parent associations with no rows leaking across scopes", () => {
  const index = buildWorkTypesIndex(parents, children);
  assert.strictEqual(workTypeChildRows(index), index.children);
  assert.strictEqual(workTypeChildRows(index, 2), index.rowsByParent.get(2));
  assert.deepEqual(workTypeChildRows(index, "unassigned").map(row => row.id), [14, 15, 16]);
  assert.deepEqual(workTypeChildRows(index, "all", "перевозка").map(row => row.id), [12, 13]);
  assert.deepEqual(workTypeChildRows(index, 2, "перевозка").map(row => row.id), [12]);
  assert.deepEqual(workTypeChildRows(index, 2, "вспомогательные").map(row => row.id), [11, 12]);
  assert.deepEqual(workTypeChildRows(index, "unassigned", "архивный").map(row => row.id), [15]);
  assert.deepEqual(workTypeChildRows(index, 99), []);
  assert.deepEqual(workTypeChildRows(index, 3), []);
});

test("large catalogs keep every child exactly once, preserve counts and support narrow scopes", () => {
  const main = Array.from({ length: 500 }, (_, id) => ({ id: id + 1, name: `Вид ${id + 1}` }));
  const sub = Array.from({ length: 50_000 }, (_, id) => ({ id: id + 1, name: `Подвид ${id + 1}`, mainWorkTypeId: id % 501 + 1 }));
  const index = buildWorkTypesIndex(main, sub);
  assert.equal(index.children.length, 50_000);
  assert.equal(new Set(index.children.map(row => row.id)).size, 50_000);
  assert.equal(index.parents.reduce((count, parent) => count + parent.childCount, 0) + index.unassigned.length, 50_000);
  assert.equal(index.unassigned.length, 99);
  assert.equal(workTypeChildRows(index, 1).length, 100);
  assert.deepEqual(workTypeChildRows(index, 1, "Подвид 1").map(row => row.id), sub.filter(row => row.mainWorkTypeId === 1 && row.name.includes("Подвид 1")).map(row => row.id));
  assert.deepEqual(filterWorkTypeParents(index, { query: "Подвид 50000" }).map(row => row.id), [sub.at(-1).mainWorkTypeId]);
  assert.equal(filterWorkTypeParents(index, { status: "empty" }).length, 0);
  assert.equal(workTypeChildRows(index, "unassigned").every(row => !row.assigned && row.parentId === null), true);
});

test("empty catalogs and catalogs containing only orphans are supported", () => {
  const empty = buildWorkTypesIndex([], []);
  assert.deepEqual(filterWorkTypeParents(empty), []);
  assert.deepEqual(workTypeChildRows(empty), []);
  const orphans = buildWorkTypesIndex([], children);
  assert.equal(orphans.unassigned.length, children.length);
  assert.deepEqual(filterWorkTypeParents(orphans, { query: "перевозка" }), []);
  assert.equal(workTypeChildRows(orphans, "unassigned", "перевозка").length, 2);
});

test("flat table shows each subtype once and one row for each empty work type", () => {
  const index = buildWorkTypesIndex(parents, children);
  const rows = workTypesTableRows(index);
  assert.deepEqual(rows.map(row => row.key), ["child-11", "child-12", "child-13", "parent-3", "child-14", "child-15", "child-16"]);
  assert.deepEqual(rows[0], { key: "child-11", kind: "child", id: 11, name: "Уборка территории", parentId: 2, parentName: "Вспомогательные работы" });
  assert.deepEqual(rows[3], { key: "parent-3", kind: "parent", id: 3, name: "", parentId: 3, parentName: "Монтаж", childCount: 0 });
  assert.equal(rows.filter(row => row.kind === "parent").length, 1, "populated work types have no extra group row");
  assert.deepEqual(workTypesTableRows(buildWorkTypesIndex([], [])), []);
});

test("flat row keys distinguish subtype ids from empty work type ids and remain stable", () => {
  const index = buildWorkTypesIndex([{ id: 1, name: "Пустой вид" }, { id: 2, name: "Работы" }], [{ id: 1, name: "Подвид", mainWorkTypeId: 2 }]);
  assert.deepEqual(workTypesTableRows(index).map(row => row.key), ["parent-1", "child-1"]);
  assert.deepEqual(workTypesTableRows(index, "подвид").map(row => row.key), ["child-1"]);
  assert.deepEqual(workTypesTableRows(index, "пустой").map(row => row.key), ["parent-1"]);
});

test("flat table puts all unassigned and orphaned subtypes last without altering the index", () => {
  const index = buildWorkTypesIndex(parents, children);
  const before = structuredClone(index);
  const unassigned = workTypesTableRows(index).filter(row => row.parentId === null);
  assert.deepEqual(unassigned.map(row => [row.id, row.parentName]), [[14, "Не назначен"], [15, "Не назначен"], [16, "Не назначен"]]);
  assert.deepEqual(index, before);
  assert.equal(workTypesTableRows(buildWorkTypesIndex([], children)).length, children.length);
  assert.deepEqual(workTypesTableRows(index, "Не назначен").map(row => row.id), [14, 15, 16]);
});

test("flat table search matches both names, includes a matching parent's children and keeps catalog order", () => {
  const index = buildWorkTypesIndex(parents, children);
  assert.deepEqual(workTypesTableRows(index, "  ВСПОМОГАТЕЛЬНЫЕ  ").map(row => row.key), ["child-11", "child-12"]);
  assert.deepEqual(workTypesTableRows(index, "перевозка").map(row => row.key), ["child-12", "child-13"]);
  assert.deepEqual(workTypesTableRows(index, "монтаж").map(row => row.key), ["parent-3"]);
  assert.deepEqual(workTypesTableRows(index, "Архивный вид").map(row => row.key), ["child-15"]);
  assert.deepEqual(workTypesTableRows(index, "несуществующий запрос"), []);
  const localized = buildWorkTypesIndex([{ id: 1, name: "Учёт техники" }], [{ id: 1, name: "Монта́ж оборудования", mainWorkTypeId: 1 }]);
  assert.deepEqual(workTypesTableRows(localized, "УЧЕТ"), workTypesTableRows(localized, "монтаж"));
});

test("flat table handles 50,000 subtypes with exact counts and stable grouped ordering", () => {
  const main = Array.from({ length: 501 }, (_, id) => ({ id: id + 1, name: `Вид ${id + 1}` }));
  main.at(-1).name = "Без подвидов";
  const sub = Array.from({ length: 50_000 }, (_, id) => ({ id: id + 1, name: `Подвид ${id + 1}`, mainWorkTypeId: id % 501 === 500 ? null : id % 500 + 1 }));
  const index = buildWorkTypesIndex(main, sub);
  const rows = workTypesTableRows(index);
  assert.equal(rows.length, 50_001, "one empty work type adds one row to the subtype total");
  assert.equal(rows.filter(row => row.kind === "child").length, 50_000);
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  assert.deepEqual(rows.filter(row => row.kind === "parent").map(row => row.key), ["parent-501"]);
  assert.deepEqual(rows.slice(0, index.rowsByParent.get(1).length).map(row => row.id), index.rowsByParent.get(1).map(row => row.id));
  assert.deepEqual(rows.slice(-index.unassignedRows.length).map(row => row.id), index.unassignedRows.map(row => row.id));
  assert.deepEqual(workTypesTableRows(index, "Без подвидов").map(row => row.key), ["parent-501"]);
  assert.deepEqual(workTypesTableRows(index, "Подвид 50000").map(row => row.key), ["child-50000"]);
});
