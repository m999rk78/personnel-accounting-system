import assert from "node:assert/strict";
import test from "node:test";
import { createCellTextEditSession } from "../app/cellTextEditing.ts";

test("text is committed once even when Enter is followed by blur", () => {
  const session = createCellTextEditSession("Старая зона");
  assert.equal(session.commit("Новая зона 123"), "Новая зона 123");
  assert.equal(session.commit("Новая зона 123"), undefined);
});

test("Escape discards the draft even if removing focus causes blur", () => {
  const session = createCellTextEditSession("Зона");
  session.cancel();
  assert.equal(session.commit("Незавершённый ввод"), undefined);
});

test("unchanged text does not publish a row update; clearing text does", () => {
  assert.equal(createCellTextEditSession("Зона").commit("Зона"), undefined);
  assert.equal(createCellTextEditSession("Зона").commit(""), "");
});

test("separate cells and successive edits keep independent sessions", () => {
  const first = createCellTextEditSession("");
  const second = createCellTextEditSession("Проект");
  first.cancel();
  assert.equal(second.commit("Другой проект"), "Другой проект");
  assert.equal(createCellTextEditSession("Другой проект").commit("Ещё один"), "Ещё один");
});
