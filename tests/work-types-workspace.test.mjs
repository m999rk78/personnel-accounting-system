import assert from "node:assert/strict";
import test from "node:test";
import { removeNewWorkTypeDrafts, workTypeDraft, workTypeNameKey, workTypesArchiveSelection, workTypesDraftErrors, workTypesSavePayload, workTypesWorkspace } from "../app/workTypesWorkspace.ts";
import { draftHistoryReducer } from "../app/personnelSpreadsheet.ts";

const parents = [
  { id: 2, name: "Вспомогательные работы" },
  { id: 1, name: "Земляные работы" },
  { id: 3, name: "Пустой вид" },
];
const children = [
  { id: 11, name: "Уборка", mainWorkTypeId: 2 },
  { id: 12, name: "Перевозка", mainWorkTypeId: 2 },
  { id: 13, name: "Перевозка", mainWorkTypeId: 1 },
  { id: 14, name: "Без назначения", mainWorkTypeId: null },
  { id: 15, name: "Отсутствующий вид", mainWorkTypeId: 99 },
  { id: 16, name: "Старый подвид" },
];
const parentDraft = (key, name, extra = {}) => ({ key, directoryKind: "parent", name, ...extra });
const childDraft = (key, name, parentKey, extra = {}) => ({ key, directoryKind: "child", name, parentKey, ...extra });
const catalog = () => workTypesWorkspace(parents, children, {});
const wire = value => JSON.parse(JSON.stringify(value));

test("every work type is a master row and every subtype occurs in one detail grid", () => {
  const before = structuredClone({ parents, children });
  const { masters, details } = catalog();
  assert.deepEqual(masters.map(row => [row.key, row.childCount]), [["parent-2", 2], ["parent-1", 1], ["parent-3", 0], ["unassigned", 3]]);
  assert.equal(masters.every(row => row.directoryKind === "parent"), true);
  assert.deepEqual(details.get("parent-2").map(row => row.key), ["child-11", "child-12"]);
  assert.deepEqual(details.get("parent-1").map(row => row.key), ["child-13"]);
  assert.deepEqual(details.get("parent-3"), [], "empty work types remain expandable masters with an empty detail collection");
  assert.deepEqual(details.get("unassigned").map(row => row.key), ["child-14", "child-15", "child-16"]);
  assert.deepEqual(masters[0].searchText, "Вспомогательные работы\nУборка\nПеревозка");
  const allChildren = [...details.values()].flat();
  assert.equal(allChildren.length, children.length);
  assert.equal(new Set(allChildren.map(row => row.key)).size, children.length);
  assert.deepEqual({ parents, children }, before, "building the workspace never mutates source catalogs");
});

test("empty and orphan-only catalogs create exactly the masters their details need", () => {
  assert.deepEqual(workTypesWorkspace([], [], {}), { masters: [], details: new Map() });
  const assigned = workTypesWorkspace(parents, children.slice(0, 3), {});
  assert.equal(assigned.masters.some(row => row.unassigned), false);
  assert.equal(assigned.details.has("unassigned"), false);
  const orphans = workTypesWorkspace([], children, {});
  assert.equal(orphans.masters.length, 1);
  assert.equal(orphans.masters[0].key, "unassigned");
  assert.equal(orphans.masters[0].unassigned, true);
  assert.equal(orphans.masters[0].childCount, children.length);
  assert.deepEqual(orphans.details.get("unassigned").map(row => row.id), children.map(row => row.id));
});

test("archiving the unassigned group in an orphan-only catalog selects all children without a fake parent", () => {
  const orphanChildren = [
    { id: 101, name: "Нет назначения", mainWorkTypeId: null },
    { id: 102, name: "Неопределённое назначение", mainWorkTypeId: undefined },
    { id: 103, name: "Пропавший вид", mainWorkTypeId: 999 },
    { id: 104, name: "Поле отсутствует" },
  ];
  const source = workTypesWorkspace([], orphanChildren, {});
  const selected = [source.masters[0]];
  const before = structuredClone({ selected, orphanChildren });
  const archive = workTypesArchiveSelection(selected, [], orphanChildren);
  assert.deepEqual(archive.parents, []);
  assert.deepEqual(new Set(archive.children), new Set(orphanChildren.map(row => row.id)));
  assert.equal(archive.children.length, orphanChildren.length);
  assert.equal(archive.parentCount, 0, "the synthetic group never becomes a parent record to archive");
  assert.equal(archive.childCount, orphanChildren.length);
  assert.deepEqual({ selected, orphanChildren }, before, "selection expansion leaves rows and source catalogs unchanged");
});

test("mixed archive selection deduplicates groups, explicit children and parent cascades", () => {
  const source = catalog();
  const parent = source.masters.find(row => row.id === 2);
  const group = source.masters.find(row => row.unassigned);
  const allChildren = [...source.details.values()].flat();
  const selected = [parent, group, allChildren.find(row => row.id === 11), allChildren.find(row => row.id === 14), allChildren.find(row => row.id === 13), parent, group, allChildren.find(row => row.id === 13)];
  const before = structuredClone({ selected, parents, children });
  const archive = workTypesArchiveSelection(selected, parents, children);
  assert.deepEqual(archive.parents, [2]);
  assert.deepEqual(new Set(archive.children), new Set([11, 13, 14, 15, 16]));
  assert.equal(archive.children.length, 5, "explicit child and group overlaps are present only once");
  assert.equal(archive.parentCount, 1);
  assert.equal(archive.childCount, 6, "the cascade-only child is counted and each overlapping child is counted once");
  assert.deepEqual({ selected, parents, children }, before);
});

test("archiving one unassigned child never expands to its siblings", () => {
  const orphans = catalog().details.get("unassigned");
  for (const row of orphans) {
    assert.deepEqual(workTypesArchiveSelection([row, row], parents, children), { parents: [], children: [row.id], parentCount: 0, childCount: 1 });
  }
});

test("empty archive selections and an empty synthetic group are no-ops", () => {
  const empty = { parents: [], children: [], parentCount: 0, childCount: 0 };
  assert.deepEqual(workTypesArchiveSelection([], parents, children), empty);
  assert.deepEqual(workTypesArchiveSelection([], [], []), empty);
  const group = { key: "unassigned", directoryKind: "parent", kind: "entry", name: "Без вида работы", unassigned: true };
  assert.deepEqual(workTypesArchiveSelection([group], parents, children.slice(0, 3)), empty);
  assert.deepEqual(workTypesArchiveSelection([group], [], []), empty);
});

test("inline edits and drafts update detail membership, counts and searchable names together", () => {
  const source = catalog();
  const edits = {
    "parent-2": { ...workTypeDraft(source.masters[0]), name: "Обновлённый вид" },
    "child-11": { ...workTypeDraft(source.details.get("parent-2")[0]), name: "Новая уборка", parentKey: "parent-1" },
    "new-parent-one": parentDraft("new-parent-one", "Новый вид"),
    "new-child-one": childDraft("new-child-one", "Новый подвид", "new-parent-one"),
    "new-child-empty": childDraft("new-child-empty", "", "parent-3"),
  };
  const before = structuredClone(edits);
  const workspace = workTypesWorkspace(parents, children, edits);
  assert.deepEqual(workspace.masters.map(row => [row.key, row.kind, row.childCount]), [["new-parent-one", "draft", 1], ["parent-2", "edit", 1], ["parent-1", "entry", 2], ["parent-3", "entry", 1], ["unassigned", "entry", 3]]);
  assert.deepEqual(workspace.details.get("parent-2").map(row => row.key), ["child-12"]);
  assert.deepEqual(workspace.details.get("parent-1").map(row => [row.key, row.kind]), [["child-11", "edit"], ["child-13", "entry"]]);
  assert.deepEqual(workspace.details.get("new-parent-one").map(row => row.key), ["new-child-one"]);
  assert.match(workspace.masters.find(row => row.key === "parent-1").searchText, /Новая уборка/);
  assert.doesNotMatch(workspace.masters.find(row => row.key === "parent-2").searchText, /Уборка|Новая уборка/);
  assert.equal(workspace.masters.find(row => row.key === "parent-2").searchText.startsWith("Обновлённый вид\n"), true);
  assert.deepEqual(edits, before, "derived counts and search text never leak into editable drafts");
  assert.deepEqual(workTypesWorkspace(parents, children, {}), source, "clearing drafts restores the source workspace");
});

test("multiple new parents and children stay above saved rows, newest first in their own scope", () => {
  const edits = {
    "new-parent-first": parentDraft("new-parent-first", "Первый"),
    "new-child-first": childDraft("new-child-first", "Первый подвид", "parent-2"),
    "new-parent-second": parentDraft("new-parent-second", "Второй"),
    "new-child-other": childDraft("new-child-other", "Другой подвид", "parent-1"),
    "new-child-second": childDraft("new-child-second", "Второй подвид", "parent-2"),
  };
  const before = structuredClone({ parents, children, edits });
  const workspace = workTypesWorkspace(parents, children, edits);
  assert.deepEqual(workspace.masters.map(row => row.key), ["new-parent-second", "new-parent-first", "parent-2", "parent-1", "parent-3", "unassigned"]);
  assert.deepEqual(workspace.details.get("parent-2").map(row => row.key), ["new-child-second", "new-child-first", "child-11", "child-12"]);
  assert.deepEqual(workspace.details.get("parent-1").map(row => row.key), ["new-child-other", "child-13"]);
  assert.deepEqual({ parents, children, edits }, before);
});

test("removing an accidental blank row preserves the completed new rows and existing edits", () => {
  const edits = {
    "new-parent-filled": parentDraft("new-parent-filled", "Готовый вид"),
    "new-child-filled": childDraft("new-child-filled", "Готовый подвид", "new-parent-filled"),
    "parent-2": parentDraft("parent-2", "Исправленный вид", { id: 2, originalName: parents[0].name }),
    "new-child-blank": childDraft("new-child-blank", "", "parent-2"),
  };
  const before = structuredClone(edits);
  const result = removeNewWorkTypeDrafts(edits, ["new-child-blank", "parent-2", "unassigned", "missing"]);
  assert.deepEqual(result.removedKeys, ["new-child-blank"]);
  assert.deepEqual(Object.keys(result.edits), ["new-parent-filled", "new-child-filled", "parent-2"]);
  for (const key of Object.keys(result.edits)) assert.strictEqual(result.edits[key], edits[key]);
  assert.deepEqual(edits, before);
});

test("removing a new parent cascades only to its unsaved children and is one undoable change", () => {
  const edits = {
    "new-parent-one": parentDraft("new-parent-one", "Новый вид"),
    "new-child-one": childDraft("new-child-one", "Его подвид", "new-parent-one"),
    "new-child-two": childDraft("new-child-two", "Ещё подвид", "new-parent-one"),
    "new-child-other": childDraft("new-child-other", "Другой", "parent-2"),
    "child-11": childDraft("child-11", "Исправленная уборка", "parent-1", { id: 11, originalName: "Уборка", originalParentId: 2 }),
  };
  const before = structuredClone(edits);
  const removed = removeNewWorkTypeDrafts(edits, ["new-parent-one", "new-parent-one", "child-11"]);
  assert.deepEqual(removed.removedKeys, ["new-parent-one", "new-child-one", "new-child-two"]);
  assert.deepEqual(Object.keys(removed.edits), ["new-child-other", "child-11"]);
  let history = { present: edits, past: [], future: [] };
  history = draftHistoryReducer(history, { type: "change", update: removed.edits });
  assert.equal(history.past.length, 1);
  history = draftHistoryReducer(history, { type: "undo" });
  assert.deepEqual(history.present, before);
  history = draftHistoryReducer(history, { type: "redo" });
  assert.deepEqual(history.present, removed.edits);
  assert.deepEqual(edits, before);
});

test("a new parent referenced by a saved child cannot be removed or partially mutate the batch", () => {
  const edits = {
    "new-parent-one": parentDraft("new-parent-one", "Новый вид"),
    "new-child-blank": childDraft("new-child-blank", "", "parent-2"),
    "child-11": childDraft("child-11", "Сохранённый подвид, новое имя", "new-parent-one", { id: 11, originalName: "Уборка", originalParentId: 2 }),
  };
  const before = structuredClone(edits);
  assert.throws(() => removeNewWorkTypeDrafts(edits, ["new-parent-one", "new-child-blank", "child-11"]), /Новый вид.*сохранённые подвиды/);
  assert.deepEqual(edits, before);
  assert.deepEqual(workTypesDraftErrors(parents, children, edits)["child-11"], undefined);
});

test("draft removal ignores saved ids, missing keys and synthetic groups without changing references", () => {
  const edits = {
    "parent-1": parentDraft("parent-1", "Сохранённый", { id: 1 }),
    "child-zero": childDraft("child-zero", "Защитить нулевой id", "parent-1", { id: 0 }),
    "child-null": childDraft("child-null", "Защитить null id", "parent-1", { id: null }),
  };
  for (const keys of [[], ["parent-1", "child-zero", "child-null", "missing", "unassigned"]]) {
    const result = removeNewWorkTypeDrafts(edits, keys);
    assert.strictEqual(result.edits, edits);
    assert.deepEqual(result.removedKeys, []);
  }
});

test("draft snapshots keep exact original names and parent ids when refreshed catalogs change", () => {
  const source = workTypesWorkspace([{ id: 1, name: "  Исходный вид  " }], [{ id: 1, name: "  Исходный подвид  ", mainWorkTypeId: 1 }], {});
  const parent = workTypeDraft(source.masters[0]);
  const child = workTypeDraft(source.details.get("parent-1")[0]);
  assert.equal("kind" in parent, false);
  assert.equal("childCount" in parent, false);
  assert.equal("searchText" in parent, false);
  assert.equal(parent.originalName, "  Исходный вид  ");
  assert.equal(child.originalName, "  Исходный подвид  ");
  assert.equal(child.originalParentId, 1);
  const edits = { [parent.key]: { ...parent, name: "Новое имя" }, [child.key]: { ...child, name: "Новый подвид", parentKey: "parent-2" } };
  const refreshed = workTypesWorkspace([{ id: 1, name: "Изменили на сервере" }, { id: 2, name: "Второй вид" }], [{ id: 1, name: "Изменили подвид", mainWorkTypeId: 2 }], edits);
  assert.equal(refreshed.masters[0].originalName, "  Исходный вид  ");
  assert.equal(refreshed.details.get("parent-2")[0].originalName, "  Исходный подвид  ");
  assert.equal(refreshed.details.get("parent-2")[0].originalParentId, 1, "server refresh must not replace the stale-edit comparison snapshot");
});

test("orphan display keeps the stored parent snapshot and normalizes absent parent ids to null", () => {
  const unassigned = catalog().details.get("unassigned");
  assert.deepEqual(unassigned.map(row => [row.id, row.parentKey, row.originalParentId]), [[14, "unassigned", null], [15, "unassigned", 99], [16, "unassigned", null]]);
  const edits = Object.fromEntries(unassigned.map(row => [row.key, { ...workTypeDraft(row), name: `${row.name} исправлен` }]));
  assert.deepEqual(workTypesDraftErrors(parents, children, edits), {}, "an existing unassigned child can have its name corrected without selecting a parent");
  assert.deepEqual(workTypesSavePayload(edits).children.map(row => [row.id, row.parentId, row.originalParentId]), [[14, null, null], [15, null, 99], [16, null, null]], "the visible unassigned destination and stored stale-check snapshot remain distinct");
});

test("save payload resolves saved parent ids and new parent keys while preserving original fields", () => {
  const source = catalog();
  const edits = {
    "new-parent-one": parentDraft("new-parent-one", "  Новый вид  "),
    "new-child-one": childDraft("new-child-one", " Новый подвид ", "new-parent-one"),
    "parent-2": { ...workTypeDraft(source.masters[0]), name: " Исправленный вид " },
    "child-11": { ...workTypeDraft(source.details.get("parent-2")[0]), name: " Исправленный подвид ", parentKey: "parent-1" },
  };
  const before = structuredClone(edits);
  assert.deepEqual(workTypesDraftErrors(parents, children, edits), {});
  assert.deepEqual(wire(workTypesSavePayload(edits)), {
    parents: [{ clientKey: "new-parent-one", name: "Новый вид" }, { id: 2, clientKey: "parent-2", name: "Исправленный вид", originalName: "Вспомогательные работы" }],
    children: [{ clientKey: "new-child-one", name: "Новый подвид", parentId: null, parentKey: "new-parent-one" }, { id: 11, clientKey: "child-11", name: "Исправленный подвид", parentId: 1, originalName: "Уборка", originalParentId: 2 }],
  });
  assert.deepEqual(edits, before, "payload trimming leaves the editable cell text intact");
  assert.deepEqual(workTypesSavePayload({}), { parents: [], children: [] });
});

test("required names and the 240-character limit apply to edited cells", () => {
  const edits = {
    "new-parent-empty": parentDraft("new-parent-empty", " \n\t "),
    "new-parent-long": parentDraft("new-parent-long", "я".repeat(241)),
    "new-parent-limit": parentDraft("new-parent-limit", ` ${"а".repeat(240)} `),
    "new-child-empty": childDraft("new-child-empty", " \t ", "parent-1"),
    "new-child-long": childDraft("new-child-long", "б".repeat(241), "parent-2"),
    "new-child-limit": childDraft("new-child-limit", ` ${"в".repeat(240)} `, "parent-2"),
  };
  const errors = workTypesDraftErrors(parents, children, edits);
  assert.deepEqual(Object.keys(errors).sort(), ["new-child-empty", "new-child-long", "new-parent-empty", "new-parent-long"]);
  for (const error of Object.values(errors)) assert.match(error.name, /1 до 240/);
  assert.deepEqual(workTypesDraftErrors([{ id: 1, name: "" }], [{ id: 1, name: "", mainWorkTypeId: 1 }], {}), {}, "pre-existing values are checked when edited");
});

test("Russian name duplicates are checked across master rows and within each detail collection", () => {
  assert.equal(workTypeNameKey("  УЧЁТ  \n ТЕХНИКИ  "), "учет техники");
  assert.notEqual(workTypeNameKey("Стройка"), workTypeNameKey("Строика"));
  const edits = {
    "new-parent-duplicate": parentDraft("new-parent-duplicate", " ВСПОМОГАТЕЛЬНЫЕ   РАБОТЫ "),
    "new-parent-a": parentDraft("new-parent-a", "Учёт техники"),
    "new-parent-b": parentDraft("new-parent-b", " УЧЕТ   ТЕХНИКИ "),
    "new-child-duplicate": childDraft("new-child-duplicate", " УБОРКА ", "parent-2"),
    "new-child-other-parent": childDraft("new-child-other-parent", "Уборка", "parent-1"),
    "new-child-a": childDraft("new-child-a", "Учёт", "parent-3"),
    "new-child-b": childDraft("new-child-b", "УЧЕТ", "parent-3"),
  };
  const errors = workTypesDraftErrors(parents, children, edits);
  assert.deepEqual(Object.keys(errors).sort(), ["new-child-a", "new-child-b", "new-child-duplicate", "new-parent-a", "new-parent-b", "new-parent-duplicate"]);
  for (const key of ["new-parent-a", "new-parent-b", "new-parent-duplicate"]) assert.match(errors[key].name, /Вид работы/);
  for (const key of ["new-child-a", "new-child-b", "new-child-duplicate"]) assert.match(errors[key].name, /подвид/);
  assert.equal(errors["child-11"], undefined, "an existing duplicate target is never marked as an editable draft");
  assert.deepEqual(workTypesDraftErrors(parents, children, {
    "parent-1": parentDraft("parent-1", parents[0].name, { id: 1 }),
    "parent-2": parentDraft("parent-2", parents[1].name, { id: 2 }),
  }), {}, "swapping two names is valid in the final catalog");
});

test("new subtypes require a real or drafted master and dangling references stay visibly invalid", () => {
  const edits = {
    "new-parent-one": parentDraft("new-parent-one", "Новый вид"),
    "new-child-existing": childDraft("new-child-existing", "Новый А", "parent-1"),
    "new-child-draft": childDraft("new-child-draft", "Новый Б", "new-parent-one"),
    "new-child-missing": childDraft("new-child-missing", "Новый В", "parent-404"),
    "new-child-no-choice": childDraft("new-child-no-choice", "Новый Г", undefined),
    "new-child-unassigned": childDraft("new-child-unassigned", "Новый Д", "unassigned"),
    "child-14": childDraft("child-14", "Существующий без вида", "unassigned", { id: 14, originalParentId: null }),
    "child-11": childDraft("child-11", "Существующий с пропавшим выбором", "new-parent-deleted", { id: 11, originalParentId: 2 }),
  };
  const errors = workTypesDraftErrors(parents, children, edits);
  assert.deepEqual(Object.keys(errors).sort(), ["child-11", "new-child-missing", "new-child-no-choice", "new-child-unassigned"]);
  for (const error of Object.values(errors)) assert.match(error.parentKey, /Выберите вид/);
  const workspace = workTypesWorkspace(parents, children, edits);
  assert.equal(workspace.details.get("unassigned").some(row => row.key === "new-child-missing"), true, "invalid drafts remain accessible for correction");
  assert.equal(workspace.details.get("unassigned").some(row => row.key === "child-11"), true);
});
