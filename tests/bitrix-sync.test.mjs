import test from "node:test";
import assert from "node:assert/strict";

import { BITRIX24_READ_ONLY_METHODS, classifyBitrixStage, compareBitrixEmployees, isBitrixEmployeeInImportScope, normalizeBitrixText, resolveBitrixFieldValues } from "../app/bitrix24Sync.ts";

test("Bitrix24 integration exposes only read methods", () => {
  assert.deepEqual(BITRIX24_READ_ONLY_METHODS, ["crm.item.fields", "crm.item.list", "crm.status.list"]);
  assert.equal(BITRIX24_READ_ONLY_METHODS.some((method) => /(?:add|update|delete)/i.test(method)), false);
});

test("normalizeBitrixText makes Russian labels comparable", () => {
  assert.equal(normalizeBitrixText("  НА   ОБЪЁКТЕ  "), "на объекте");
});

test("classifyBitrixStage recognizes employee availability stages", () => {
  assert.equal(classifyBitrixStage("", "На объекте"), "on_site");
  assert.equal(classifyBitrixStage("", "Перемещения"), "transfer");
  assert.equal(classifyBitrixStage("", "Межвахта"), "intershift");
  assert.equal(classifyBitrixStage("", "Ежегодный отпуск"), "vacation");
  assert.equal(classifyBitrixStage("", "На больничном"), "sick_leave");
  assert.equal(classifyBitrixStage("", "Уволен"), "dismissed");
  assert.equal(classifyBitrixStage("", "Проверка документов"), "unknown");
});

test("configured stage mapping takes priority and accepts an ID", () => {
  assert.equal(classifyBitrixStage("DT182_1:NEW", "На объекте", { "dt182_1:new": "intershift" }), "intershift");
});

test("empty Bitrix enum value zero is not treated as a project", () => {
  const values = new Map([["205", "НЗНП"]]);
  assert.deepEqual(resolveBitrixFieldValues(0, values), []);
  assert.deepEqual(resolveBitrixFieldValues("205", values), ["НЗНП"]);
});

test("Bitrix import scope includes only configured stages and limits on-site employees by project", () => {
  const scope = {
    stageKeys: ["Объекты и офисы", "МО/О", "Перемещения"],
    projectKeys: ["НЗНП", "Усть-Луга ГПЗ"],
  };
  const employee = (stageName, availabilityStatus, projectKeys = []) => ({
    bitrix24Id: "1", fullName: "Тест", employmentType: "ОПР", department: "УСР", position: "Монтажник",
    stageId: "", stageName, availabilityStatus, projectKeys, sourceUpdatedAt: null,
  });
  assert.equal(isBitrixEmployeeInImportScope(employee("Объекты и офисы", "on_site", ["НЗНП"]), scope), true);
  assert.equal(isBitrixEmployeeInImportScope(employee("Объекты и офисы", "on_site", ["Центр. офис"]), scope), false);
  assert.equal(isBitrixEmployeeInImportScope(employee("МО/О", "intershift"), scope), true);
  assert.equal(isBitrixEmployeeInImportScope(employee("Перемещения", "transfer"), scope), true);
  assert.equal(isBitrixEmployeeInImportScope(employee("Кандидаты", "unknown"), scope), false);
  assert.equal(isBitrixEmployeeInImportScope(employee("Увольнение", "dismissed"), scope), false);
});

test("Bitrix check reports differences without treating manual employees as missing", () => {
  const source = [{
    bitrix24Id: "101", fullName: "Иванов Иван", employmentType: "ОПР", department: "УСР", position: "Монтажник",
    stageId: "ON_SITE", stageName: "На объекте", availabilityStatus: "on_site", projectKeys: ["Усть-Луга"], sourceUpdatedAt: null,
  }];
  const local = [{ bitrix24Id: "101", fullName: "Иванов  Иван", employmentType: "ОПР", department: "УСР", position: "Монтажник", bitrix24Stage: "На объекте" }];
  assert.deepEqual(compareBitrixEmployees(source, local), { compared: 1, matched: 1, differences: [] });

  const changed = compareBitrixEmployees(source, [{ ...local[0], position: "Сварщик" }, { ...local[0], bitrix24Id: "999", fullName: "Старая карточка" }]);
  assert.equal(changed.matched, 0);
  assert.deepEqual(changed.differences.map((difference) => difference.kind), ["changed", "missing_in_bitrix"]);
  assert.match(changed.differences[0].details, /должность/);
});
