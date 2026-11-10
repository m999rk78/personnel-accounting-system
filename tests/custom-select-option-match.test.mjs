import assert from "node:assert/strict";
import test from "node:test";
import { exactCustomSelectOption, matchesCustomSelectSearch } from "../app/customSelectOptionMatch.ts";

test("short labels remain searchable by hidden equipment metadata without changing exact selection", () => {
  const option = { value: "1", label: "30 т // А123АА", searchText: "Кран TADANO Учёт техники РХИ" };
  for (const query of ["30 т", "а123аа", "КРАН", "tadano", " учет   техники ", "РХИ", ""]) {
    assert.equal(matchesCustomSelectSearch(option, query), true, query);
  }
  assert.equal(matchesCustomSelectSearch(option, "Экскаватор"), false);
  assert.equal(exactCustomSelectOption([option], "TADANO"), undefined);
  assert.equal(exactCustomSelectOption([option], option.label), option);
  assert.equal(matchesCustomSelectSearch({ value: "2", label: "Другой объект" }, "объект"), true);
});

test("project names and stored IDs select the same option", () => {
  const project = Object.freeze({ value: "10", label: "Усть-Луга ГПЗ" });
  const options = Object.freeze([project, Object.freeze({ value: "20", label: "НЗНП" })]);
  assert.equal(exactCustomSelectOption(options, "  усть-луга   гпз "), project);
  assert.equal(exactCustomSelectOption(options, "10"), project);
  assert.equal(exactCustomSelectOption(options, "Усть-Луга"), undefined);
  assert.equal(exactCustomSelectOption(options, "Неизвестный проект"), undefined);
});

test("exact matching keeps Russian case, ё and whitespace normalization", () => {
  const option = { value: "engineer", label: "Ведущий инженер по учёту" };
  assert.equal(exactCustomSelectOption([option], " ВЕДУЩИЙ\tИНЖЕНЕР ПО УЧЕТУ "), option);
  assert.equal(exactCustomSelectOption([option], " ENGINEER "), option);
  assert.equal(exactCustomSelectOption([option], "инженер"), undefined);
});

test("ambiguous enabled labels and value/label collisions are rejected", () => {
  assert.equal(exactCustomSelectOption([
    { value: "10", label: "НЗНП" }, { value: "20", label: " нзнп " },
  ], "НЗНП"), undefined);
  assert.equal(exactCustomSelectOption([
    { value: "10", label: "НЗНП" }, { value: "НЗНП", label: "Другой проект" },
  ], "НЗНП"), undefined);
  const sameValueAndLabel = { value: "ИТР", label: "ИТР" };
  assert.equal(exactCustomSelectOption([sameValueAndLabel], "ИТР"), sameValueAndLabel);
});

test("disabled matches cannot be selected and do not make an enabled choice ambiguous", () => {
  const enabled = { value: "20", label: "НЗНП" };
  const options = [{ value: "10", label: "НЗНП", disabled: true }, enabled];
  assert.equal(exactCustomSelectOption(options, "НЗНП"), enabled);
  assert.equal(exactCustomSelectOption(options, "10"), undefined);
  assert.equal(exactCustomSelectOption([{ value: "", label: "Без объекта", disabled: true }], "Без объекта"), undefined);
});

test("empty query leaves the component's normal Enter handling in control", () => {
  const options = [{ value: "", label: "Не заполнено" }];
  assert.equal(exactCustomSelectOption(options, " \t "), undefined);
  assert.equal(exactCustomSelectOption([], "ИТР"), undefined);
  assert.equal(exactCustomSelectOption(options, "Не заполнено"), options[0]);
});
