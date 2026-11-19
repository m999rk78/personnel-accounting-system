import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { applyCatalogBatch, removeCatalogDrafts } from "../app/catalogSpreadsheetModel.ts";
import { createCatalogDraftHistory } from "../app/useCatalogDraftHistory.ts";
import { exactCustomSelectOption } from "../app/customSelectOptionMatch.ts";

const record = (id, name = `Зона ${id}`) => ({ id, name });
const draft = (key, overrides = {}) => ({ key, name: "", note: "", entity: "zone", ...overrides });
const savedRow = value => ({ rowKey: `directory-${value.id}`, kind: "entry", record: value });
const draftRow = value => ({ rowKey: value.key, kind: value.id === undefined ? "draft" : "entry", draft: value });
const patchDraft = (current, values) => {
  const next = { ...current };
  if (values.name !== undefined) {
    if (values.name.startsWith("!")) throw new Error(`Неизвестное значение «${values.name}».`);
    next.name = values.name.trim();
  }
  if (values.note !== undefined) next.note = values.note;
  return next;
};
function run(options) {
  let sequence = 0;
  return applyCatalogBatch({ rows: [], drafts: [], canCreate: true, canUpdate: true,
    newDraft: key => draft(key), toDraft: value => draft(`directory-${value.id}`, value),
    patchDraft, editableFields: () => ["name", "note"], newKey: () => `new-${++sequence}`, ...options });
}

test("catalog validation lists errors from all rows and publishes nothing on failure", () => {
  const original = Object.freeze([Object.freeze(draft("original", { name: "Сохранить", customFlag: "original" }))]);
  let published = 0, finalValidations = 0;
  const publishBatch = rows => {
    const next = run({ drafts: original, rows, validateDrafts: () => finalValidations++ });
    published++;
    return next;
  };
  assert.throws(() => publishBatch([
    { row: draftRow(original[0]), values: { name: "Изменить только при успехе" } },
    { values: { name: "!Неверная зона" } },
    { values: { name: "!Другая ошибка" } },
  ]), error => {
    assert.match(error.message, /Строка 2:.*!Неверная зона/);
    assert.match(error.message, /Строка 3:.*!Другая ошибка/);
    return true;
  });
  assert.equal(published, 0);
  assert.equal(finalValidations, 0);
  assert.deepEqual(original, [draft("original", { name: "Сохранить", customFlag: "original" })]);
});

test("paste beginning in a new row reuses only new slots and never overwrites saved records", () => {
  const before = draft("before", { name: "Оставить" });
  const start = draft("start");
  const edited = draft("directory-1", { id: 1, name: "Существующая правка", note: "Не менять" });
  const later = draft("later", { name: "Заменить новую строку" });
  const next = run({ drafts: [before, start, edited, later], rows: [
    { row: draftRow(start), values: { name: "Первая" } },
    { row: savedRow(record(1)), values: { name: "Вторая" } },
    { row: savedRow(record(2)), values: { name: "Третья" } },
  ] });
  assert.deepEqual(next.map(value => [value.key, value.name]), [
    ["before", "Оставить"], ["start", "Первая"], ["directory-1", "Существующая правка"], ["later", "Вторая"], ["new-1", "Третья"],
  ]);
  assert.equal(next[2], edited);
  assert.ok(next.every(value => value.entity === "zone"));
});

test("catalog edits merge with the latest draft and retain domain metadata", () => {
  const stale = draft("directory-4", { id: 4, name: "Старое имя", employeeId: "50", entity: "master" });
  const current = { ...stale, name: "Новое имя", note: "Последнее примечание" };
  const next = run({ drafts: [current], rows: [
    { row: draftRow(stale), values: { note: "Примечание из вставки" } },
    { row: savedRow(record(4)), values: { name: "Итоговое имя" } },
  ] });
  assert.deepEqual(next, [{ ...current, name: "Итоговое имя", note: "Примечание из вставки" }]);
  assert.equal(current.name, "Новое имя");
  assert.throws(() => run({ rows: [{ row: draftRow(stale), values: { name: "Удалённый черновик" } }] }), /черновик больше не существует/);
});

test("unknown and read-only fields are ignored without patching or creating rows", () => {
  const original = [draft("untouched", { name: "Не менять" })];
  let patches = 0, validations = 0;
  const next = run({ drafts: original, canCreate: false, canUpdate: false,
    patchDraft: () => { patches++; throw new Error("Не должен вызываться"); }, validateDrafts: () => validations++, rows: [
      { row: draftRow(original[0]), values: { number: "1", employmentType: "ИТР" } },
      { values: { unknown: "Лишний столбец" } },
    ] });
  assert.equal(next, original);
  assert.equal(patches, 0);
  assert.equal(validations, 0);
  const mixed = run({ drafts: original, rows: [{ row: draftRow(original[0]), values: { name: "Изменить", id: "999", entity: "other" } }] });
  assert.deepEqual(mixed, [{ ...original[0], name: "Изменить" }]);
});

test("create and update permissions apply to the complete batch and draft identity", () => {
  const existing = draft("directory-1", { id: 1, name: "Существующая" });
  assert.throws(() => run({ canCreate: false, rows: [
    { row: savedRow(record(1)), values: { name: "Разрешённая правка" } },
    { values: { name: "Запрещённое добавление" } },
  ] }), /Строка 2: нет права добавлять/);
  assert.throws(() => run({ canUpdate: false, rows: [{ row: savedRow(record(1)), values: { name: "Запрещено" } }] }), /нет права редактировать/);
  assert.throws(() => run({ canUpdate: false, drafts: [existing], rows: [{ row: draftRow(existing), values: { name: "Обход через черновик" } }] }), /нет права редактировать/);
  const updated = run({ canCreate: false, drafts: [existing], rows: [{ row: draftRow(existing), values: { name: "Разрешена правка существующего" } }] });
  assert.equal(updated[0].name, "Разрешена правка существующего");
  assert.equal(existing.name, "Существующая");
  const newRow = draft("fresh");
  const added = run({ canUpdate: false, drafts: [newRow], rows: [
    { row: draftRow(newRow), values: { name: "Новая 1" } },
    { row: savedRow(record(1)), values: { name: "Новая 2" } },
  ] });
  assert.deepEqual(added.map(value => value.name), ["Новая 1", "Новая 2"]);
  assert.ok(added.every(value => value.id === undefined));
});

test("patches cannot change saved IDs or draft keys", () => {
  const source = draft("directory-1", { id: 1, name: "Не менять", entity: "master", employeeId: "2" });
  for (const change of [{ id: 999 }, { id: undefined }, { key: "different" }]) {
    assert.throws(() => run({ drafts: [source], rows: [{ row: draftRow(source), values: { name: "Нельзя" } }], patchDraft: value => ({ ...value, ...change }) }), /не может менять идентификатор/);
  }
  assert.deepEqual(source, draft("directory-1", { id: 1, name: "Не менять", entity: "master", employeeId: "2" }));
});

test("final validation sees the complete batch and can reject duplicates atomically", () => {
  const first = draft("first", { name: "А" }), second = draft("second", { name: "Б" });
  const validateDrafts = (drafts, changedKeys) => {
    assert.deepEqual(changedKeys, ["first", "second"]);
    const names = drafts.map(value => value.name);
    if (new Set(names).size !== names.length) throw new Error("Сотрудник выбран в нескольких строках.");
  };
  const swapped = run({ drafts: [first, second], validateDrafts, rows: [
    { row: draftRow(first), values: { name: "Б" } }, { row: draftRow(second), values: { name: "А" } },
  ] });
  assert.deepEqual(swapped.map(value => value.name), ["Б", "А"]);
  assert.throws(() => run({ drafts: [first, second], validateDrafts, rows: [
    { row: draftRow(first), values: { name: "Дубликат" } }, { row: draftRow(second), values: { name: "Дубликат" } },
  ] }), /Сотрудник выбран в нескольких строках/);
  assert.deepEqual([first.name, second.name], ["А", "Б"]);
});

test("project employee navigation uses a resettable ID filter and keeps all assignments for validation", async () => {
  const url = new URL("../app/ReferenceDirectoryGrids.tsx", import.meta.url);
  const ast = ts.createSourceFile(url.pathname, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = new Set(["findEmployee", "validateDistinct", "replaceCompatible", "ProjectEmployeeAgGrid"]);
  const declarations = ast.statements.flatMap(node => {
    if (ts.isFunctionDeclaration(node) && functions.has(node.name?.text)) return [node.getText(ast).replace(/^export\s+/, "")];
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.filter(declaration => declaration.name.getText(ast) === "normalize").map(declaration => `const ${declaration.getText(ast)};`);
    return [];
  });
  assert.equal(declarations.length, functions.size + 1);
  const code = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const render = new Function("React", "useMemo", "CatalogSpreadsheetGrid", "exactCustomSelectOption", `${code}; return ProjectEmployeeAgGrid;`)(
    { createElement: (_component, props) => props }, callback => callback(), () => {}, exactCustomSelectOption,
  );
  const employees = [1, 2, 3].map(id => ({ id, fullName: `Сотрудник ${id}` }));
  const blank = { key: "new-employee", employeeId: "", employeeQuery: "" };
  const onClearEmployeeFocus = () => {};
  const props = { rows: employees.slice(0, 2), allEmployees: employees, drafts: [blank], pendingDeletes: [], focusedEmployeeId: 1, onClearEmployeeFocus, loading: false };
  const grid = render(props);
  assert.equal(grid.rows, props.rows, "The ordinary filter receives the complete project roster");
  assert.deepEqual(grid.navigationFilter, { columnId: "fullName", value: "1", ready: true, onCleared: onClearEmployeeFocus });
  assert.equal(grid.columns[0].getFilterValue(employees[0]), "1");
  assert.equal(grid.columns[0].formatFilterValue("1"), "Сотрудник 1");
  assert.equal(grid.columns[0].formatFilterValue("99"), "Сотрудник №99");
  assert.equal(grid.columns[0].formatFilterValue(null), "(Пустые)");
  assert.deepEqual(grid.columns[0].options(blank, [blank]), [{ value: "3", label: "Сотрудник 3" }]);
  const duplicate = grid.patchDraft(blank, { fullName: "Сотрудник 2" });
  assert.throws(() => grid.validateDrafts([duplicate], [blank.key]), /уже есть в таблице/);
  const available = grid.patchDraft(blank, { fullName: "Сотрудник 3" });
  assert.doesNotThrow(() => grid.validateDrafts([available], [blank.key]));
  assert.deepEqual(blank, { key: "new-employee", employeeId: "", employeeQuery: "" });
  const unfiltered = render({ ...props, focusedEmployeeId: null });
  assert.equal(unfiltered.rows, props.rows, "Removing the navigation marker keeps every record available");
  assert.equal(unfiltered.navigationFilter, undefined);
  assert.equal(render({ ...props, loading: true }).navigationFilter.ready, false);
  const sameNames = employees.map(employee => ({ ...employee, fullName: "Иванов Иван Иванович" }));
  const identity = render({ ...props, rows: sameNames.slice(0, 2), allEmployees: sameNames }).columns[0];
  assert.equal(identity.getFilterValue(sameNames[0]), "1");
  assert.equal(identity.getFilterValue(sameNames[1]), "2");
  assert.equal(identity.formatFilterValue("1"), "Иванов Иван Иванович (№1)");
  assert.equal(identity.formatFilterValue("2"), "Иванов Иван Иванович (№2)");
  const legacy = render({ ...props, rows: employees.slice(0, 1), existingEmployees: employees.slice(0, 2) });
  assert.deepEqual(legacy.columns[0].options(blank, [blank]), [{ value: "3", label: "Сотрудник 3" }]);
  assert.throws(() => legacy.validateDrafts([duplicate], [blank.key]), /уже есть в таблице/);
});

test("adding unsaved catalog rows from a footer is undoable without reviving saved or cancelled drafts", () => {
  const history = createCatalogDraftHistory();
  let current = [];
  const replace = rows => { current = rows; };
  const sync = rows => { current = rows; history.synchronize(rows, replace); };
  sync([]);
  const first = draft("added", { name: "Новая зона" });
  sync([first]);
  assert.equal(history.getSnapshot().canUndo, true);
  history.undo();
  assert.deepEqual(current, []);
  history.synchronize(current, replace);
  history.redo();
  assert.deepEqual(current, [first]);
  history.synchronize(current, replace);
  history.replace([{ ...first, name: "Правка" }]);
  history.synchronize(current, replace);
  sync([...current, draft("second")]);
  history.undo();
  assert.deepEqual(current, [{ ...first, name: "Правка" }]);
  history.undo();
  assert.deepEqual(current, [first]);
  history.synchronize(current, replace);
  sync([]); // Explicit save/cancel boundary, not an undo.
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: false });
  history.undo();
  assert.deepEqual(current, []);
});

test("catalog paste limit allows one thousand rows and rejects larger batches", () => {
  assert.throws(() => run({ rows: Array.from({ length: 1001 }, () => ({ values: { name: "Зона" } })) }), /не более 1000 строк/);
  const result = run({ rows: Array.from({ length: 1000 }, (_, index) => ({ values: { name: `Зона ${index}` } })) });
  assert.equal(result.length, 1000);
  assert.equal(new Set(result.map(value => value.key)).size, 1000);
});

test("removal keeps every unselected row and every saved record with exact metadata", () => {
  const filled = Object.freeze(draft("filled", { name: "Заполненный", entity: "master", employeeId: "8" }));
  const blank = Object.freeze(draft("blank"));
  const saved = Object.freeze(draft("saved", { id: 1, name: "Сохранённый", entity: "master", employeeId: "9" }));
  const zero = Object.freeze(draft("zero", { id: 0 }));
  const nullId = Object.freeze(draft("null", { id: null }));
  const original = Object.freeze([filled, blank, saved, zero, nullId]);
  const next = removeCatalogDrafts(original, ["blank", "saved", "zero", "null", "missing", "blank"]);
  assert.deepEqual(next, [filled, saved, zero, nullId]);
  assert.equal(next[0], filled);
  assert.equal(next[1], saved);
  assert.deepEqual(original, [filled, blank, saved, zero, nullId]);
});

test("catalog history preserves multi-row edits, preparation and domain fields across undo/redo", () => {
  const first = draft("directory-1", { id: 1, name: "Первый", entity: "master", employeeId: "11" });
  const second = draft("directory-2", { id: 2, name: "Второй", entity: "master", employeeId: "22" });
  const history = createCatalogDraftHistory();
  let current = [first];
  const replace = value => { current = value; };
  history.synchronize(current, replace);
  history.replace([{ ...first, name: "Первый изменён" }]);
  history.prepare(second);
  history.synchronize(current, replace);
  history.replace(current.map(value => value.id === 2 ? { ...value, name: "Второй изменён" } : value));
  history.synchronize(current, replace);
  history.undo();
  assert.deepEqual(current, [{ ...first, name: "Первый изменён" }, second]);
  history.undo();
  assert.deepEqual(current, [first, second]);
  history.redo();
  history.redo();
  assert.deepEqual(current, [{ ...first, name: "Первый изменён" }, { ...second, name: "Второй изменён" }]);
  assert.equal(current[0].employeeId, "11");
  assert.equal(current[1].entity, "master");
  assert.deepEqual(first, draft("directory-1", { id: 1, name: "Первый", entity: "master", employeeId: "11" }));
});

test("new-row removal is one history step and reset after saving cannot resurrect rows", () => {
  const filled = draft("filled", { name: "Заполненный", entity: "master", employeeId: "5" });
  const blank = draft("blank", { entity: "master", employeeId: "" });
  const saved = draft("directory-2", { id: 2, name: "С правками", entity: "master", employeeId: "6" });
  const original = [filled, saved, blank];
  const history = createCatalogDraftHistory();
  let current = original, calls = 0;
  const replace = value => { calls++; current = value; };
  history.synchronize(current, replace);
  history.replace(removeCatalogDrafts(current, ["filled", "blank", "directory-2"]));
  history.synchronize(current, replace);
  assert.deepEqual(current, [saved]);
  history.undo();
  history.synchronize(current, replace);
  assert.deepEqual(current, original);
  history.redo();
  history.synchronize(current, replace);
  assert.deepEqual(current, [saved]);
  history.synchronize([], replace); // Successful save/cancel clears the draft buffer.
  const before = calls;
  history.undo(); history.redo();
  assert.equal(calls, before);
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: false });
});

test("rapid history actions survive delayed own acknowledgements and cap undo at fifty", () => {
  const history = createCatalogDraftHistory();
  const initial = [draft("one", { name: "0" })], first = [draft("one", { name: "1" })], second = [draft("one", { name: "2" })];
  let current = initial;
  const replace = value => { current = value; };
  history.synchronize(initial, replace);
  history.replace(first); history.replace(second);
  history.synchronize(first, replace); history.synchronize(second, replace);
  history.undo(); history.undo();
  assert.deepEqual(current, initial);
  history.redo(); history.redo();
  assert.deepEqual(current, second);
  history.synchronize(current, replace);
  for (let index = 3; index <= 62; index++) { history.replace([draft("one", { name: String(index) })]); history.synchronize(current, replace); }
  for (let index = 0; index < 60; index++) history.undo();
  assert.equal(current[0].name, "12");
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: true });
});

test("a rejected replacement callback cannot advance or corrupt catalog undo history", () => {
  const history = createCatalogDraftHistory();
  const initial = [draft("one", { name: "До изменения" })];
  let current = initial;
  const accept = value => { current = value; };
  const reject = () => { throw new Error("Операция не поддерживается потребителем"); };
  history.synchronize(initial, reject);
  assert.throws(() => history.replace([draft("one", { name: "Отклонённое изменение" })]), /не поддерживается/);
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: false });
  history.synchronize(initial, accept);
  history.replace([draft("one", { name: "Подтверждённое изменение" })]);
  history.synchronize(current, reject);
  assert.throws(() => history.undo(), /не поддерживается/);
  assert.deepEqual(history.getSnapshot(), { canUndo: true, canRedo: false });
  history.synchronize(current, accept);
  history.undo();
  assert.deepEqual(current, initial);
  history.synchronize(current, reject);
  assert.throws(() => history.redo(), /не поддерживается/);
  assert.deepEqual(history.getSnapshot(), { canUndo: false, canRedo: true });
  history.synchronize(current, accept);
  history.redo();
  assert.equal(current[0].name, "Подтверждённое изменение");
});
