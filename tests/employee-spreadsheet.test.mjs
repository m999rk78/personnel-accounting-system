import assert from "node:assert/strict";
import test from "node:test";
import { applyEmployeeSpreadsheetBatch, removeNewEmployeeDrafts } from "../app/employeeSpreadsheet.ts";
import { draftHistoryReducer } from "../app/personnelSpreadsheet.ts";
import { createEmployeeSpreadsheetHistory } from "../app/useEmployeeSpreadsheetHistory.ts";

const references = {
  employmentTypes: [{ id: 1, name: "ИТР" }, { id: 2, name: "ОПР" }],
  departments: [{ id: 3, name: "ПТО" }, { id: 4, name: "МУСК" }],
  positions: [{ id: 5, name: "Инженер" }, { id: 6, name: "Монтажник" }],
  sites: [{ id: 10, name: "Усть-Луга ГПЗ" }, { id: 20, name: "НЗНП" }],
  positionCatalog: [
    { employmentType: "ИТР", department: "ПТО", position: "Инженер" },
    { employmentType: "ОПР", department: "МУСК", position: "Монтажник" },
  ],
};
const employee = (id, fullName = `Сотрудник ${id}`) => ({ id, fullName, employmentType: "ИТР", department: "ПТО", position: "Инженер", source: "manual", siteId: 10, siteName: "Усть-Луга ГПЗ" });
const draft = (key, overrides = {}) => ({ key, fullName: "", employmentType: "", department: "", position: "", projectSiteId: "", ...overrides });
const row = (value) => ({ rowKey: `employee-${value.id}`, employee: value });
const draftRow = (value) => ({ rowKey: value.key, draft: value });
const run = (options) => {
  let sequence = 0;
  return applyEmployeeSpreadsheetBatch({ drafts: [], references, canCreate: true, canUpdate: true, newKey: () => `new-${++sequence}`, ...options });
};

test("normalizes all pasted fields, fills position dependencies and preserves unrelated drafts", () => {
  const unrelated = draft("untouched", { fullName: "Черновик" });
  const result = run({ drafts: [unrelated], rows: [{ row: row(employee(1)), values: { fullName: "  Иван Петров  ", position: "  монтажник ", siteName: " усть-луга   гпз " } }] });
  assert.equal(result.drafts[0], unrelated);
  assert.deepEqual(result.drafts[1], draft("employee-1", { id: 1, fullName: "Иван Петров", employmentType: "ОПР", department: "МУСК", position: "Монтажник", projectSiteId: "10" }));
  assert.deepEqual(result.editedIds, [1]);

  const explicit = run({ rows: [{ row: row(employee(1)), values: { position: "Монтажник", employmentType: "ИТР", department: "ПТО" } }] });
  assert.equal(explicit.drafts[0].employmentType, "ИТР");
  assert.equal(explicit.drafts[0].department, "ПТО");
});

test("invalid batch lists every bad row and field without mutating or allocating keys", () => {
  const source = Object.freeze(draft("original", { fullName: "Сохранить" }));
  const drafts = Object.freeze([source]);
  let keys = 0;
  assert.throws(() => run({ drafts, newKey: () => { keys++; return "never"; }, rows: [
    { row: draftRow(source), values: { fullName: "Не сохранять", department: "Неизвестный отдел" } },
    { values: { fullName: "Новый", employmentType: "Плохой тип", position: "Плохая должность", siteName: "Чужой проект" } },
  ] }), error => {
    assert.match(error.message, /Строка 1:.*Неизвестный отдел.*Отдел/);
    assert.match(error.message, /Строка 2:.*Плохой тип.*Тип/);
    assert.match(error.message, /Строка 2:.*Плохая должность.*Должность/);
    assert.match(error.message, /Строка 2:.*Чужой проект.*Проект/);
    return true;
  });
  assert.equal(keys, 0);
  assert.deepEqual(drafts, [draft("original", { fullName: "Сохранить" })]);
});

test("clearing cells keeps a partial editable draft, including an unassigned project", () => {
  const result = run({ rows: [{ row: row(employee(1)), values: { fullName: "", employmentType: "", department: "", position: "", siteName: "Без объекта" } }] });
  assert.deepEqual(result.drafts, [draft("employee-1", { id: 1 })]);
});

test("restricted projects reject clearing, out-of-scope edits and unknown sites atomically", () => {
  const scoped = { ...references, requiredSiteId: [10] };
  assert.throws(() => run({ references: scoped, rows: [{ row: row(employee(1)), values: { siteName: "" } }] }), /Проект.*разрешённых проектов/);
  assert.throws(() => run({ references: scoped, rows: [{ row: row({ ...employee(1), siteId: 20 }), values: { fullName: "Другой" } }] }), /разрешённых проектов/);
  assert.throws(() => run({ references: scoped, rows: [{ values: { siteName: "Несуществующий" } }] }), /Несуществующий.*Проект/);
  const added = run({ references: scoped, rows: [{ values: { fullName: "Новый" } }] });
  assert.equal(added.drafts[0].projectSiteId, "10");
  assert.throws(() => run({ references: { ...references, requiredSiteId: [10, 20] }, rows: [{ values: { fullName: "Новый" } }] }), /оставить его пустым нельзя/);
  assert.equal(run({ references: { ...references, requiredSiteId: [10, 20] }, rows: [{ values: { siteName: "20" } }] }).drafts[0].projectSiteId, "20");
});

test("each edit merges into the latest draft instead of the stale rendered row", () => {
  const stale = draft("employee-1", { id: 1, fullName: "Устаревшее имя", department: "ПТО", projectSiteId: "10" });
  const latest = { ...stale, fullName: "Последнее имя", employmentType: "ОПР", position: "Монтажник" };
  const result = run({ drafts: [latest], rows: [
    { row: draftRow(stale), values: { department: "МУСК" } },
    { row: row(employee(1)), values: { siteName: "НЗНП" } },
  ] });
  assert.deepEqual(result.drafts, [{ ...latest, department: "МУСК", projectSiteId: "20" }]);
  assert.deepEqual(result.editedIds, [1]);
  assert.equal(latest.department, "ПТО");
  assert.throws(() => run({ rows: [{ row: draftRow(stale), values: { fullName: "Удалённый черновик" } }] }), /черновик больше не существует/);
});

test("paste from a new draft reuses only new slots and never spills into saved employees", () => {
  const before = draft("before", { fullName: "До выбранной строки" });
  const start = draft("start", { fullName: "Начало" });
  const existingEdit = draft("employee-2", { id: 2, fullName: "Сохранённый сотрудник", projectSiteId: "10" });
  const later = draft("later");
  const result = run({ drafts: [before, start, existingEdit, later], rows: [
    { row: draftRow(start), values: { fullName: "Первая строка" } },
    { row: row(employee(2)), values: { fullName: "Вторая строка" } },
    { row: row(employee(3)), values: { fullName: "Третья строка" } },
  ] });
  assert.deepEqual(result.drafts.map(value => [value.key, value.fullName]), [
    ["before", "До выбранной строки"], ["start", "Первая строка"],
    ["employee-2", "Сохранённый сотрудник"], ["later", "Вторая строка"], ["new-1", "Третья строка"],
  ]);
  assert.deepEqual(result.editedIds, []);
});

test("permission checks reject mixed batches and overflow without a partial update", () => {
  const original = employee(1);
  let keys = 0;
  assert.throws(() => run({ canCreate: false, newKey: () => { keys++; return "never"; }, rows: [
    { row: row(original), values: { fullName: "Не сохранится" } },
    { values: { fullName: "Новый запрещён" } },
  ] }), /Строка 2: нет права добавлять/);
  assert.equal(keys, 0);
  assert.equal(original.fullName, "Сотрудник 1");
  assert.throws(() => run({ canUpdate: false, rows: [{ row: row(original), values: { fullName: "Запрещено" } }] }), /нет права редактировать/);
  const fresh = draft("fresh");
  assert.throws(() => run({ canCreate: false, drafts: [fresh], rows: [{ row: draftRow(fresh), values: { fullName: "Запрещено" } }] }), /нет права добавлять/);
  const allowed = run({ canUpdate: false, drafts: [fresh], rows: [
    { row: draftRow(fresh), values: { fullName: "Новый 1" } },
    { row: row(original), values: { fullName: "Новый 2" } },
  ] });
  assert.deepEqual(allowed.drafts.map(value => value.fullName), ["Новый 1", "Новый 2"]);
  assert.deepEqual(allowed.editedIds, []);
});

test("immutable snapshots retain paste order and support undo and redo including new rows", () => {
  const initial = [draft("first")];
  const initialSnapshot = structuredClone(initial);
  const pasted = run({ drafts: initial, rows: [
    { row: draftRow(initial[0]), values: { fullName: "Яков" } },
    { values: { fullName: "Антон" } },
    { values: { fullName: "Борис" } },
  ] }).drafts;
  const edited = run({ drafts: pasted, rows: [{ row: draftRow(pasted[0]), values: { fullName: "Яков изменён" } }] }).drafts;
  assert.deepEqual(initial, initialSnapshot);
  assert.deepEqual(pasted.map(value => value.fullName), ["Яков", "Антон", "Борис"]);
  let history = { past: [], present: initial, future: [] };
  history = draftHistoryReducer(history, { type: "change", update: pasted });
  history = draftHistoryReducer(history, { type: "change", update: edited });
  history = draftHistoryReducer(history, { type: "undo" });
  assert.equal(history.present[0].fullName, "Яков");
  history = draftHistoryReducer(history, { type: "undo" });
  assert.deepEqual(history.present, initialSnapshot);
  history = draftHistoryReducer(history, { type: "redo" });
  assert.deepEqual(history.present.map(value => value.fullName), ["Яков", "Антон", "Борис"]);
  history = draftHistoryReducer(history, { type: "redo" });
  assert.equal(history.present[0].fullName, "Яков изменён");
  assert.deepEqual(initial, initialSnapshot);
});

test("read-only columns do not create drafts, ambiguous options fail, and paste is bounded", () => {
  assert.deepEqual(run({ canCreate: false, canUpdate: false, rows: [{ values: { number: "1", bitrixCheckLabel: "Всё хорошо" } }] }), { drafts: [], editedIds: [] });
  assert.throws(() => run({ references: { ...references, departments: [...references.departments, { id: 99, name: " пто " }] }, rows: [{ values: { department: "ПТО" } }] }), /не найдено или неоднозначно.*Отдел/);
  assert.throws(() => run({ rows: Array.from({ length: 1001 }, () => ({ values: { fullName: "Сотрудник" } })) }), /не более 1000 строк/);
  const maximum = run({ rows: Array.from({ length: 1000 }, (_, index) => ({ values: { fullName: `Сотрудник ${index}` } })) });
  assert.equal(maximum.drafts.length, 1000);
  assert.equal(new Set(maximum.drafts.map(value => value.key)).size, 1000);
});

test("employee undo keeps rapid own updates and batched acknowledgements intact", () => {
  const history = createEmployeeSpreadsheetHistory();
  const initial = [draft("first")];
  const one = [draft("first", { fullName: "Один" })];
  const two = [draft("first", { fullName: "Два" })];
  const applied = [];
  const onReplaceDrafts = value => applied.push(value);
  history.synchronize({ drafts: initial, onReplaceDrafts });
  history.replace(one);
  history.replace(two);
  history.synchronize({ drafts: two, onReplaceDrafts });
  assert.deepEqual(history.getSnapshot(), { canUndo: true, canRedo: false });
  history.undo();
  assert.deepEqual(applied.at(-1), one);
  history.undo();
  assert.deepEqual(applied.at(-1), initial);
  history.synchronize({ drafts: one, onReplaceDrafts }); // Delayed acknowledgement of the first undo.
  history.synchronize({ drafts: initial, onReplaceDrafts });
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: true });
  history.redo();
  assert.deepEqual(applied.at(-1), one);
  history.redo();
  assert.deepEqual(applied.at(-1), two);
  assert.deepEqual(initial, [draft("first")]);
});

test("opening a second employee keeps multi-row edits undoable without adding a preparation step", () => {
  const history = createEmployeeSpreadsheetHistory();
  const first = Object.freeze(draft("employee-1", { id: 1, fullName: "Первый", projectSiteId: "10" }));
  const second = Object.freeze(draft("employee-2", { id: 2, fullName: "Второй", projectSiteId: "20" }));
  const applied = [];
  const onReplaceDrafts = value => applied.push(value);
  const acknowledge = () => history.synchronize({ drafts: applied.at(-1), onReplaceDrafts });
  history.synchronize({ drafts: [], onReplaceDrafts });
  history.prepare(first);
  assert.deepEqual(applied.at(-1), [first]);
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: false });
  acknowledge();
  const firstEdited = { ...first, fullName: "Первый изменён" };
  history.replace([firstEdited]);
  acknowledge();
  history.prepare(second);
  assert.deepEqual(applied.at(-1), [firstEdited, second]);
  acknowledge();
  const secondEdited = { ...second, department: "МУСК" };
  history.replace([firstEdited, secondEdited]);
  acknowledge();
  history.undo();
  assert.deepEqual(applied.at(-1), [firstEdited, second]);
  acknowledge();
  history.undo();
  assert.deepEqual(applied.at(-1), [first, second]);
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: true });
  acknowledge();
  history.redo();
  assert.deepEqual(applied.at(-1), [firstEdited, second]);
  acknowledge();
  history.redo();
  assert.deepEqual(applied.at(-1), [firstEdited, secondEdited]);
  assert.deepEqual(history.getSnapshot(), { canUndo: true, canRedo: false });
  assert.equal(first.fullName, "Первый");
  assert.equal(second.department, "");
});

test("preparing an employee preserves redo and cannot introduce new or duplicate drafts", () => {
  const history = createEmployeeSpreadsheetHistory();
  const first = draft("employee-1", { id: 1, fullName: "Первый" });
  const second = draft("employee-2", { id: 2, fullName: "Второй" });
  const applied = [];
  const onReplaceDrafts = value => applied.push(value);
  history.synchronize({ drafts: [first], onReplaceDrafts });
  const edited = [{ ...first, fullName: "Изменён" }];
  history.replace(edited);
  history.undo();
  history.prepare(second);
  assert.deepEqual(applied.at(-1), [first, second]);
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: true });
  history.synchronize({ drafts: [first], onReplaceDrafts }); // Earlier undo acknowledgement.
  history.synchronize({ drafts: applied.at(-1), onReplaceDrafts });
  history.redo();
  assert.deepEqual(applied.at(-1), [...edited, second]);
  const count = applied.length;
  for (const invalid of [draft("new"), draft("zero", { id: 0 }), draft("other-key", { id: 1 }), draft("employee-1", { id: 3 }), { ...second }]) history.prepare(invalid);
  assert.equal(applied.length, count);
  assert.deepEqual(history.getSnapshot(), { canUndo: true, canRedo: false });
  history.synchronize({ drafts: applied.at(-1) });
  history.prepare(draft("no-callback", { id: 4 }));
  assert.equal(applied.length, count);
});

test("external save, cancel or added rows reset history and cannot be undone", () => {
  for (const external of [[], [draft("added")], [draft("first", { id: 1, fullName: "Открыт на изменение" })]]) {
    const history = createEmployeeSpreadsheetHistory();
    const initial = [draft("first")];
    const edited = [draft("first", { fullName: "Изменён" })];
    const applied = [];
    const onReplaceDrafts = value => applied.push(value);
    history.synchronize({ drafts: initial, onReplaceDrafts });
    history.replace(edited);
    history.synchronize({ drafts: edited, onReplaceDrafts });
    history.synchronize({ drafts: external, onReplaceDrafts });
    assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: false });
    history.undo();
    history.redo();
    assert.equal(applied.length, 1);
    history.replace([draft("next")]);
    history.undo();
    assert.deepEqual(applied.at(-1), external);
  }
});

test("employee history caps undo at fifty steps, drops redo after editing and uses latest callbacks", () => {
  const history = createEmployeeSpreadsheetHistory();
  const applied = [];
  const onReplaceDrafts = value => applied.push(value);
  history.synchronize({ drafts: [draft("first", { fullName: "0" })], onReplaceDrafts });
  for (let index = 1; index <= 60; index++) {
    const current = [draft("first", { fullName: String(index) })];
    history.replace(current);
    history.synchronize({ drafts: current, onReplaceDrafts });
  }
  for (let index = 0; index < 60; index++) history.undo();
  assert.equal(applied.at(-1)[0].fullName, "10");
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: true });
  const latest = [];
  history.synchronize({ drafts: applied.at(-1), onReplaceDrafts: value => latest.push(value) });
  history.replace([draft("first", { fullName: "Новая ветка" })]);
  assert.equal(latest.length, 1);
  assert.deepEqual(history.getSnapshot(), { canUndo: true, canRedo: false });
  history.synchronize({ drafts: latest.at(-1) });
  history.replace([draft("first", { fullName: "Без обработчика" })]);
  history.undo();
  assert.equal(latest.length, 1);
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: false });
});

test("removing a selected blank row preserves both filled new employees and all their values", () => {
  const first = Object.freeze(draft("first", { fullName: "Иван Петров", employmentType: "ИТР", department: "ПТО", position: "Инженер", projectSiteId: "10" }));
  const blank = Object.freeze(draft("blank", { projectSiteId: "10" }));
  const second = Object.freeze(draft("second", { fullName: "Антон Сидоров", employmentType: "ОПР", department: "МУСК", position: "Монтажник", projectSiteId: "20" }));
  const original = Object.freeze([first, blank, second]);
  const result = removeNewEmployeeDrafts(original, ["blank"]);
  assert.deepEqual(result, { drafts: [first, second], removedKeys: ["blank"] });
  assert.equal(result.drafts[0], first);
  assert.equal(result.drafts[1], second);
  assert.deepEqual(original, [first, blank, second]);
});

test("mixed and repeated selections cannot remove drafts of saved employees or unknown keys", () => {
  const saved = draft("employee-1", { id: 1, fullName: "Изменённое имя", projectSiteId: "10" });
  const definedZeroId = draft("zero", { id: 0 });
  const definedNullId = draft("null", { id: null });
  const firstNew = draft("new-first", { fullName: "Первый новый" });
  const secondNew = draft("new-second", { fullName: "Второй новый" });
  const original = [saved, firstNew, definedZeroId, secondNew, definedNullId];
  const result = removeNewEmployeeDrafts(original, ["new-second", "employee-1", "new-first", "new-first", "missing", "zero", "null"]);
  assert.deepEqual(result.drafts, [saved, definedZeroId, definedNullId]);
  assert.deepEqual(result.removedKeys, ["new-first", "new-second"]);
  for (const selected of [[], ["missing"], ["employee-1", "zero", "null"]]) {
    const unchanged = removeNewEmployeeDrafts(original, selected);
    assert.equal(unchanged.drafts, original);
    assert.deepEqual(unchanged.removedKeys, []);
  }
});

test("removing multiple new rows is one undoable operation that restores exact values and order", () => {
  const saved = draft("employee-1", { id: 1, fullName: "Сохранённый сотрудник с правками", employmentType: "ИТР", department: "ПТО", position: "Инженер", projectSiteId: "10" });
  const filled = draft("filled", { fullName: "Новый сотрудник", employmentType: "ОПР", department: "МУСК", position: "Монтажник", projectSiteId: "20" });
  const blank = draft("blank", { projectSiteId: "10" });
  const retained = draft("retained", { fullName: "Оставить эту строку", department: "ПТО" });
  const original = [filled, saved, blank, retained];
  const before = structuredClone(original);
  const history = createEmployeeSpreadsheetHistory();
  let current = original;
  const onReplaceDrafts = value => { current = value; };
  history.synchronize({ drafts: original, onReplaceDrafts });
  const removal = removeNewEmployeeDrafts(current, ["blank", "employee-1", "filled"]);
  history.replace(removal.drafts);
  history.synchronize({ drafts: current, onReplaceDrafts });
  assert.deepEqual(current, [saved, retained]);
  assert.deepEqual(history.getSnapshot(), { canUndo: true, canRedo: false });
  history.undo();
  history.synchronize({ drafts: current, onReplaceDrafts });
  assert.deepEqual(current, before);
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: true });
  history.redo();
  assert.deepEqual(current, [saved, retained]);
  assert.deepEqual(original, before);
});
