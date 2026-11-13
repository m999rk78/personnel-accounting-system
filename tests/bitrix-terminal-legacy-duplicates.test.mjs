import assert from "node:assert/strict";
import test from "node:test";
import { observeLegacyTerminalBitrixDuplicates } from "../app/bitrix24Sync.ts";

const archived = {
  id: 10, bitrix24Id: "100", active: 0, availabilityStatus: "out_of_scope",
  fullName: "Фёдоров Иван Сергеевич", employmentType: "ОПР", department: "Цех 1", position: "Сварщик",
};
const active = {
  ...archived, id: 11, bitrix24Id: null, active: 1, availabilityStatus: "on_site",
  fullName: "  Федоров  Иван Сергеевич ", department: "цех  1",
};
const remote = {
  ...archived, employmentType: "", department: "", position: "", projectKeys: [],
  stageId: "FINAL", stageName: "Увольнение", sourceUpdatedAt: null, availabilityStatus: "dismissed",
};

test("recognizes a unique terminal legacy clone without depending on source HR fields", () => {
  for (const [availabilityStatus, status] of [["dismissed", "dismissed_in_bitrix"], ["blacklisted", "blacklisted_in_bitrix"]]) {
    const cards = [{ ...remote, availabilityStatus }];
    const locals = [{ ...archived }, { ...active }];
    const originals = structuredClone([cards, locals]);
    const [observation, ...rest] = observeLegacyTerminalBitrixDuplicates(cards, locals);
    assert.equal(rest.length, 0);
    assert.deepEqual(observation, {
      employeeId: active.id, archivedId: archived.id, bitrix24Id: remote.bitrix24Id, availabilityStatus, status,
      details: availabilityStatus === "blacklisted"
        ? "Сотрудник в чёрном списке Битрикс24. Связь хранится на архивной карточке с теми же ФИО, типом, отделом и должностью."
        : "Сотрудник уволен в Битрикс24. Связь хранится на архивной карточке с теми же ФИО, типом, отделом и должностью.",
    });
    assert.deepEqual([cards, locals], originals);
  }
});

test("does not infer termination from a similar name, mismatching HR profile or nonterminal source", () => {
  for (const [source, locals] of [
    [[{ ...remote, fullName: "Федоров Игорь Сергеевич" }], [archived, active]],
    [[remote], [archived, { ...active, position: "Электрик" }]],
    [[remote], [{ ...archived, department: "" }, { ...active, department: "" }]],
    [[remote], [archived, { ...active, bitrix24Id: "200" }]],
    [[remote], [archived, { ...active, availabilityStatus: "blacklisted" }]],
    [[remote], [{ ...archived, availabilityStatus: "deleted" }, active]],
    [[remote], [active]],
    [[remote], [archived]],
    [[{ ...remote, availabilityStatus: "on_site" }], [archived, active]],
    [[{ ...remote, availabilityStatus: "deleted" }], [archived, active]],
  ]) assert.deepEqual(observeLegacyTerminalBitrixDuplicates(source, locals), []);
});

test("rejects ambiguous owners, active namesakes, and duplicate source IDs or names", () => {
  for (const [source, locals] of [
    [[remote], [archived, active, { ...archived, id: 12 }]],
    [[remote], [archived, active, { ...active, id: 12, bitrix24Id: "200", position: "Электрик" }]],
    [[remote, { ...remote, fullName: "Другой сотрудник" }], [archived, active]],
    [[remote, { ...remote, bitrix24Id: "200", availabilityStatus: "on_site" }], [archived, active]],
  ]) assert.deepEqual(observeLegacyTerminalBitrixDuplicates(source, locals), []);
});
