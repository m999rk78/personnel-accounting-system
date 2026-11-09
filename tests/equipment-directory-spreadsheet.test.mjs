import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogBatch, removeCatalogDrafts } from "../app/catalogSpreadsheetModel.ts";
import { createCatalogDraftHistory } from "../app/useCatalogDraftHistory.ts";
import { equipmentExcelName } from "../app/equipmentExcel.ts";
import { emptyEquipmentRegistryDraft, equipmentAssignmentOptions, equipmentDirectoryTextFields, equipmentRegistryDraft, patchEquipmentAssignmentDraft, patchEquipmentRegistryDraft, validateEquipmentAssignmentDrafts, validateEquipmentRegistryDrafts } from "../app/equipmentDirectorySpreadsheet.ts";

const sites = [{ id: 10, name: "Усть-Луга ГПЗ" }, { id: 20, name: "НЗНП" }];
const unit = (id, overrides = {}) => ({ id, organization: "Подрядчик", equipmentType: "Экскаватор", brand: "CAT", model: "320", registrationNumber: `А00${id}`, note: "", assignedSiteId: 10, assignedSiteName: sites[0].name, ...overrides });
const draft = (key, overrides = {}) => ({ ...emptyEquipmentRegistryDraft(key), ...overrides });
const row = record => ({ rowKey: `unit-${record.id}`, kind: "entry", record });
const runRegistry = (options) => {
  let key = 0;
  const references = options.references ?? { sites };
  const records = options.records ?? [];
  return applyCatalogBatch({ drafts: [], canCreate: true, canUpdate: true, newDraft: key => emptyEquipmentRegistryDraft(key, "10"), toDraft: equipmentRegistryDraft,
    patchDraft: (draft, values) => patchEquipmentRegistryDraft(draft, values, references), editableFields: () => [...equipmentDirectoryTextFields, "siteName"],
    validateDrafts: (drafts, changed) => validateEquipmentRegistryDrafts(drafts, records, references, changed), newKey: () => `new-${++key}`, ...options });
};

test("registry range edits retain original IDs and latest drafts while normalizing project labels and IDs", () => {
  const original = unit(1);
  const first = equipmentRegistryDraft(original);
  const latest = { ...first, model: "320 Новый" };
  const second = unit(2);
  const next = runRegistry({ drafts: [latest], records: [original, second], rows: [
    { row: { ...row(original), draft: first }, values: { organization: "  Новый подрядчик  ", siteName: " нзнп " } },
    { row: row(second), values: { siteName: "10", note: "  Рабочая техника  " } },
  ] });
  assert.equal(next[0].id, 1);
  assert.equal(next[0].model, "320 Новый");
  assert.equal(next[0].organization, "Новый подрядчик");
  assert.equal(next[0].projectSiteId, "20");
  assert.equal(next[1].id, 2);
  assert.equal(next[1].projectSiteId, "10");
  assert.equal(next[1].note, "Рабочая техника");
  assert.equal(latest.projectSiteId, "10");
  assert.equal(original.organization, "Подрядчик");
});

test("registry paste grows only new draft slots and an invalid batch leaves all originals untouched", () => {
  const first = Object.freeze(draft("first", { model: "Первый" }));
  const original = unit(1);
  const existing = Object.freeze(equipmentRegistryDraft(original));
  const initial = Object.freeze([first, existing]);
  const rows = [
    { row: { rowKey: "new-first", kind: "draft", draft: first }, values: { model: "Модель 1" } },
    { row: row(original), values: { model: "Модель 2" } },
  ];
  const next = runRegistry({ drafts: initial, records: [original], rows });
  assert.deepEqual(next.map(value => [value.key, value.model]), [["first", "Модель 1"], [existing.key, "320"], ["new-1", "Модель 2"]]);
  assert.throws(() => runRegistry({ drafts: initial, rows: [
    { row: { rowKey: "new-first", kind: "draft", draft: first }, values: { model: "Не сохранится", siteName: "Чужой проект" } },
    { values: { model: "Также не сохранится", siteName: "Неизвестный" } },
  ] }), error => /Строка 1:.*Чужой проект/.test(error.message) && /Строка 2:.*Неизвестный/.test(error.message));
  assert.equal(first.model, "Первый");
  assert.equal(initial.length, 2);
});

test("registry references reject ambiguous projects, out-of-scope changes and silent text truncation", () => {
  const current = equipmentRegistryDraft(unit(1));
  const restricted = { sites, requiredSiteId: [10] };
  assert.throws(() => patchEquipmentRegistryDraft(current, { siteName: "20" }, restricted), /доступных проектов/);
  assert.throws(() => patchEquipmentRegistryDraft(current, { siteName: "Не назначена" }, restricted), /доступных проектов/);
  assert.throws(() => patchEquipmentRegistryDraft(current, { siteName: "НЗНП" }, { sites: [...sites, { id: 30, name: "нзнп" }] }), /неоднозначно/);
  assert.equal(patchEquipmentRegistryDraft(current, { siteName: "Без проекта" }, { sites }).projectSiteId, "");
  assert.equal(patchEquipmentRegistryDraft(current, { model: "" }, restricted).model, "");
  assert.throws(() => patchEquipmentRegistryDraft(current, { note: "я".repeat(301) }, { sites }), /300 символов/);
});

test("explicit registry save lists every incomplete or duplicate row before making a request", () => {
  const saved = unit(1);
  const original = equipmentRegistryDraft(saved);
  assert.doesNotThrow(() => validateEquipmentRegistryDrafts([original], [saved], { sites }, undefined, true));
  const duplicate = { ...original, key: "new-duplicate", id: undefined, registrationNumber: " а 0 0 1 " };
  assert.throws(() => validateEquipmentRegistryDrafts([draft("empty"), duplicate, draft("bad-project", { projectSiteId: "999" })], [saved], { sites }, undefined, true), error => {
    assert.match(error.message, /Строка 1:.*организацию/);
    assert.match(error.message, /Строка 2:.*уже есть/);
    assert.match(error.message, /Строка 3:.*существующий проект/);
    return true;
  });
  assert.throws(() => validateEquipmentRegistryDrafts([original], [saved], { sites, requiredSiteId: [20] }, undefined, true), /доступных проектов/);
});

test("project equipment accepts exact IDs or full reference names and rejects missing and duplicate assignments atomically", () => {
  const units = [unit(1), unit(2), unit(3)];
  const initial = [{ key: "first", equipmentId: "" }, { key: "second", equipmentId: "" }];
  const run = rows => applyCatalogBatch({ drafts: initial, rows, canCreate: true, canUpdate: false, newDraft: key => ({ key, equipmentId: "" }), toDraft: value => ({ key: `saved-${value.id}`, id: value.id, equipmentId: String(value.id) }), patchDraft: (draft, values) => patchEquipmentAssignmentDraft(draft, values, units), editableFields: record => record ? [] : ["equipmentType"], validateDrafts: (drafts, changed) => validateEquipmentAssignmentDrafts(drafts, units, [units[0]], changed), newKey: () => "overflow" });
  const paste = values => values.map((value, index) => ({ row: { rowKey: initial[index].key, kind: "draft", draft: initial[index] }, values: { equipmentType: value } }));
  assert.deepEqual(run(paste(["2", equipmentExcelName(units[2])])).map(value => value.equipmentId), ["2", "3"]);
  assert.throws(() => run(paste(["2", "2"])), error => /Строка 1:/.test(error.message) && /Строка 2:/.test(error.message));
  assert.throws(() => run(paste(["1", "999"])), /999.*не найдено/);
  assert.deepEqual(initial.map(value => value.equipmentId), ["", ""]);
  assert.equal(patchEquipmentAssignmentDraft({ key: "row", equipmentId: "2" }, { equipmentType: "" }, units).equipmentId, "");
  assert.throws(() => validateEquipmentAssignmentDrafts(initial, units, [], undefined, true), error => /Строка 1:/.test(error.message) && /Строка 2:/.test(error.message));
  assert.deepEqual(run([{ row: row(units[0]), values: { model: "Запрещённая правка" } }]), initial);
});

test("project choice lists exclude assigned and sibling rows while retaining the current row choice", () => {
  const units = [unit(1), unit(2), unit(3)];
  const current = { key: "current", equipmentId: "2" }, other = { key: "other", equipmentId: "3" };
  assert.deepEqual(equipmentAssignmentOptions(units, [units[0]], current, [current, other]).map(option => option.value), ["2"]);
  assert.throws(() => patchEquipmentAssignmentDraft(current, { equipmentType: equipmentExcelName(units[1]) }, [units[1], { ...units[1], id: 4 }]), /неоднозначно/);
});

test("removing selected equipment draft rows keeps saved edits and is undoable", () => {
  const added = draft("new"), saved = equipmentRegistryDraft(unit(1));
  const initial = [added, saved], applied = [];
  const history = createCatalogDraftHistory();
  const replace = value => applied.push(value);
  history.synchronize(initial, replace);
  history.replace(removeCatalogDrafts(initial, [added.key, saved.key]));
  assert.deepEqual(applied.at(-1), [saved]);
  history.synchronize(applied.at(-1), replace);
  history.undo();
  assert.deepEqual(applied.at(-1), initial);
  history.redo();
  assert.deepEqual(applied.at(-1), [saved]);
});
