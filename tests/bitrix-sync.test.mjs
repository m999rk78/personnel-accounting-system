import test from "node:test";
import assert from "node:assert/strict";

import { BITRIX24_READ_ONLY_METHODS, bitrixOfficeTransferDirection, classifyBitrixStage, compareBitrixEmployees, fetchBitrixEmployeeSnapshot, isAvailabilityStatus, isBitrixCentralOfficeEmployee, isBitrixEmployeeInImportScope, normalizeBitrixText, observeLegacyTerminalBitrixDuplicates, resolveBitrixFieldValues, selectLinkedBitrixEmployeesForReview, suggestArchivedBitrixEmployeeLinks, suggestBitrixEmployeeLinks } from "../app/bitrix24Sync.ts";

test("Bitrix24 integration exposes only read methods", () => {
  assert.deepEqual(BITRIX24_READ_ONLY_METHODS, ["crm.item.fields", "crm.item.list", "crm.status.list"]);
  assert.equal(BITRIX24_READ_ONLY_METHODS.some((method) => /(?:add|update|delete)/i.test(method)), false);
});

test("normalizeBitrixText makes Russian labels comparable", () => {
  assert.equal(normalizeBitrixText("  НА   ОБЪЁКТЕ  "), "на объекте");
});

test("only the exact Central Office subdivision is excluded, regardless of case or spacing", () => {
  for (const subdivisionKeys of [["Центр. офис"], [" ЦЕНТР .  ОФИС "], ["Филиал", "Центр.офис"]]) {
    assert.equal(isBitrixCentralOfficeEmployee({ subdivisionKeys }), true);
  }
  for (const employee of [{}, { subdivisionKeys: [] }, { subdivisionKeys: ["Центр. офис региона"] }, { department: "Центр. офис", projectKeys: ["Центр. офис"] }]) {
    assert.equal(isBitrixCentralOfficeEmployee(employee), false);
  }
});

test("classifyBitrixStage recognizes employee availability stages", () => {
  assert.equal(classifyBitrixStage("", "На объекте"), "on_site");
  assert.equal(classifyBitrixStage("", "Перемещения"), "transfer");
  assert.equal(classifyBitrixStage("", "МО/О"), "intershift");
  assert.equal(classifyBitrixStage("", "Межвахта"), "intershift");
  assert.equal(classifyBitrixStage("", "Ежегодный отпуск"), "vacation");
  assert.equal(classifyBitrixStage("", "На больничном"), "sick_leave");
  assert.equal(classifyBitrixStage("", "Уволен"), "dismissed");
  assert.equal(classifyBitrixStage("", "Увольнение"), "dismissed");
  assert.equal(classifyBitrixStage("", "Увольнения"), "dismissed");
  assert.equal(classifyBitrixStage("", "Черный список"), "blacklisted");
  assert.equal(classifyBitrixStage("", "  ЧЁРНЫЙ   СПИСОК  "), "blacklisted");
  assert.equal(classifyBitrixStage("", "Черный список / уволенные"), "blacklisted");
  assert.equal(classifyBitrixStage("", "Не в черном списке"), "unknown");
  assert.equal(isAvailabilityStatus("blacklisted"), true);
  assert.equal(classifyBitrixStage("", "Проверка документов"), "unknown");
});

test("configured stage mapping takes priority and accepts an ID", () => {
  assert.equal(classifyBitrixStage("DT182_1:NEW", "На объекте", { "dt182_1:new": "intershift" }), "intershift");
  assert.equal(classifyBitrixStage("DT182_1:BLACKLIST", "Завершённые", { "dt182_1:blacklist": "blacklisted" }), "blacklisted");
});

test("review follows linked employees into both termination stages without importing unrelated former employees", () => {
  const scope = { stageKeys: ["Объекты и офисы"], projectKeys: ["НЗНП"] };
  const item = (id, stageName, availabilityStatus, projectKeys = []) => ({
    bitrix24Id: id, fullName: `Сотрудник ${id}`, employmentType: "ОПР", department: "УСР", position: "Монтажник",
    stageId: id, stageName, availabilityStatus, projectKeys, sourceUpdatedAt: null,
  });
  const source = [
    item("101", "Объекты и офисы", "on_site", ["НЗНП"]),
    item("102", "Черный список", "blacklisted"),
    item("103", "Увольнения", "dismissed"),
    item("104", "Черный список", "blacklisted"),
    item("105", "Увольнения", "dismissed"),
    item("106", "Кандидаты", "unknown"),
    item("107", "Объекты и офисы", "on_site", ["Другой проект"]),
  ];
  assert.deepEqual(selectLinkedBitrixEmployeesForReview(source, ["102", "103", "106", "107"], scope).map(item => item.bitrix24Id), ["101", "102", "103"]);
  const terminalAllowlisted = { ...scope, stageKeys: [...scope.stageKeys, "Черный список", "Увольнения"] };
  assert.deepEqual(selectLinkedBitrixEmployeesForReview(source, ["102", "103"], terminalAllowlisted).map(item => item.bitrix24Id), ["101", "102", "103"]);
  assert.deepEqual(selectLinkedBitrixEmployeesForReview(source, [], terminalAllowlisted).map(item => item.bitrix24Id), ["101"]);
});

test("termination review is status-only, distinguishes blacklist and becomes matched after safe archival", () => {
  const old = { bitrix24Id: "101", fullName: "Историческое ФИО", employmentType: "ОПР", department: "УСР", position: "Монтажник", bitrix24Stage: "Объекты и офисы", availabilityStatus: "on_site", active: 1, projectKeys: ["НЗНП"] };
  for (const [availabilityStatus, stageName, kind] of [["blacklisted", "Черный список", "blacklisted_in_bitrix"], ["dismissed", "Увольнения", "dismissed_in_bitrix"]]) {
    // HR fields may be cleared in a terminal Bitrix stage; this must not erase the local profile or block archiving.
    const remote = { bitrix24Id: "101", fullName: "", employmentType: "", department: "", position: "", stageId: "FINAL", stageName, availabilityStatus, projectKeys: [], sourceUpdatedAt: null };
    const review = compareBitrixEmployees([remote], [old], [remote]);
    assert.deepEqual(review.differences.map(item => item.kind), [kind]);
    assert.equal(review.differences[0].employeeName, old.fullName);
    assert.match(review.differences[0].details, /уволен/i);
    assert.equal(review.matched, 0);
    assert.deepEqual(compareBitrixEmployees([remote], [{ ...old, availabilityStatus, bitrix24Stage: stageName, active: 0 }]), { compared: 1, matched: 1, differences: [] });
    assert.deepEqual(compareBitrixEmployees([remote], [{ ...old, availabilityStatus, bitrix24Stage: stageName, active: 1 }]).differences.map(item => item.kind), [kind]);
    assert.deepEqual(compareBitrixEmployees([], [old], [remote]).differences.map(item => item.kind), [kind]);
    assert.equal(compareBitrixEmployees([remote], [], [remote]).differences.some(item => item.kind === "missing_locally"), false);
  }
});

test("terminated Bitrix cards are never suggested for automatic or manual first linking", () => {
  const employee = { bitrix24Id: "101", fullName: "Иванов Иван", employmentType: "ОПР", department: "УСР", position: "Монтажник", stageId: "FINAL", stageName: "Черный список", availabilityStatus: "blacklisted", projectKeys: [], sourceUpdatedAt: null };
  const local = [{ id: 1, bitrix24Id: null, fullName: employee.fullName, employmentType: employee.employmentType, department: employee.department, position: employee.position }];
  for (const availabilityStatus of ["blacklisted", "dismissed", "deleted"]) assert.deepEqual(suggestBitrixEmployeeLinks([{ ...employee, availabilityStatus }], local), []);
});

test("review does not offer implicit rehire when an archived blacklisted identity changes stage or disappears", () => {
  const archived = { bitrix24Id: "101", fullName: "Тестовый сотрудник", employmentType: "ОПР", department: "УСР", position: "Монтажник", bitrix24Stage: "Черный список", availabilityStatus: "blacklisted", active: 0 };
  const remote = { ...archived, stageId: "ON_SITE", stageName: "Объекты и офисы", availabilityStatus: "on_site", projectKeys: ["НЗНП"], sourceUpdatedAt: null };
  assert.deepEqual(compareBitrixEmployees([remote], [archived]), { compared: 1, matched: 1, differences: [] });
  assert.deepEqual(compareBitrixEmployees([], [archived], [remote]).differences, []);
  assert.deepEqual(compareBitrixEmployees([], [archived], []).differences, []);
  assert.deepEqual(suggestBitrixEmployeeLinks([remote], [archived]), []);
});

test("the actual read-only snapshot resolves both termination stages from crm.status.list", async t => {
  const settings = {
    BITRIX24_WEBHOOK_URL: "https://bitrix-fixture.invalid/rest/1/synthetic/",
    BITRIX24_EMPLOYEE_ENTITY_TYPE_ID: "182", BITRIX24_EMPLOYEE_NAME_FIELD: "title",
    BITRIX24_EMPLOYEE_TYPE_FIELD: "ufType", BITRIX24_EMPLOYEE_DEPARTMENT_FIELD: "ufDepartment",
    BITRIX24_EMPLOYEE_POSITION_FIELD: "ufPosition", BITRIX24_EMPLOYEE_PROJECT_FIELD: "ufProject", BITRIX24_STAGE_STATUS_MAP: "{}",
  };
  const previous = new Map(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, request) => {
    assert.equal(url.origin, "https://bitrix-fixture.invalid");
    const method = url.pathname.split("/").at(-1).replace(/\.json$/, "");
    calls.push(method); assert.ok(BITRIX24_READ_ONLY_METHODS.includes(method));
    const params = JSON.parse(request.body);
    let result;
    if (method === "crm.item.fields") result = { fields: {} };
    else if (method === "crm.item.list") result = { items: [
      { id: 101, title: "Тестовый уволенный", stageId: "DT182_0:DISMISSED", categoryId: 0 },
      { id: 102, title: "Тестовый чёрный список", stageId: "DT182_0:BLACKLIST", categoryId: 0 },
    ] };
    else { assert.equal(params.filter.ENTITY_ID, "DYNAMIC_182_STAGE_0"); result = [
      { STATUS_ID: "DT182_0:DISMISSED", NAME: "Увольнения" },
      { STATUS_ID: "DT182_0:BLACKLIST", NAME: "Чёрный список" },
    ]; }
    return Response.json({ result });
  });
  const snapshot = await fetchBitrixEmployeeSnapshot();
  assert.deepEqual(snapshot.map(item => [item.bitrix24Id, item.stageName, item.availabilityStatus]), [
    ["101", "Увольнения", "dismissed"], ["102", "Чёрный список", "blacklisted"],
  ]);
  assert.deepEqual(calls, ["crm.item.fields", "crm.item.list", "crm.status.list"]);
});

for (const [subdivisionField, originalNames] of [
  ["ufCrm5_1702909988069", false], ["UF_CRM_5_1702909988069", true], ["ufFixtureSubdivision", false],
]) test(`snapshot decodes the subdivision using ${subdivisionField}, not the transfer or department field`, async t => {
  const typeField = originalNames ? "UF_CRM_TYPE" : "ufType";
  const settings = {
    BITRIX24_WEBHOOK_URL: "https://bitrix-fixture.invalid/rest/1/synthetic/",
    BITRIX24_EMPLOYEE_ENTITY_TYPE_ID: "182", BITRIX24_EMPLOYEE_NAME_FIELD: "title",
    BITRIX24_EMPLOYEE_TYPE_FIELD: typeField, BITRIX24_EMPLOYEE_DEPARTMENT_FIELD: "ufDepartment",
    BITRIX24_EMPLOYEE_POSITION_FIELD: "ufPosition", BITRIX24_EMPLOYEE_PROJECT_FIELD: "ufProject", BITRIX24_STAGE_STATUS_MAP: "{}",
  };
  const previous = new Map(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.mock.method(globalThis, "fetch", async (url, request) => {
    const method = url.pathname.split("/").at(-1).replace(/\.json$/, "");
    const params = JSON.parse(request.body);
    if (method === "crm.status.list") return Response.json({ result: [{ STATUS_ID: "ON_SITE", NAME: "Объекты и офисы" }] });
    assert.equal(params.useOriginalUfNames, originalNames ? "Y" : "N");
    if (method === "crm.item.fields") return Response.json({ result: { fields: {
      ufTransfer: { title: "Перевод подразделения", items: [{ ID: 3937, VALUE: "Другая запись" }] },
      ufDepartment: { title: "Отдел", items: [{ ID: 122, VALUE: "ОК" }] },
      [subdivisionField]: { title: "Подразделение", items: [{ ID: 3937, VALUE: "Центр. офис" }, { ID: 4000, VALUE: "Площадка" }] },
    } } });
    assert.equal(method, "crm.item.list");
    assert.ok(params.select.includes(subdivisionField));
    assert.ok(!params.select.includes("ufTransfer"));
    return Response.json({ result: { items: [
      { id: 101, title: "Офисная карточка", stageId: "ON_SITE", categoryId: 0, ufDepartment: "122", [subdivisionField]: ["3937"] },
      { id: 102, title: "Карточка площадки", stageId: "ON_SITE", categoryId: 0, ufDepartment: "122", [subdivisionField]: 4000, ufTransfer: 3937 },
    ] } });
  });
  const cards = await fetchBitrixEmployeeSnapshot();
  assert.deepEqual(cards.map(card => [card.department, card.subdivisionKeys, isBitrixCentralOfficeEmployee(card)]), [
    ["ОК", ["Центр. офис"], true], ["ОК", ["Площадка"], false],
  ]);
});

test("Central Office cards cannot be imported, compared, linked or selected for terminal observations", () => {
  const ordinary = { bitrix24Id: "102", fullName: "Иванов Иван", employmentType: "ОПР", department: "УСР", position: "Монтажник",
    stageId: "ON_SITE", stageName: "Объекты и офисы", availabilityStatus: "on_site", projectKeys: ["НЗНП"], sourceUpdatedAt: null };
  const office = { ...ordinary, bitrix24Id: "101", subdivisionKeys: ["Центр. офис"] };
  const terminal = { ...office, availabilityStatus: "blacklisted", stageName: "Чёрный список" };
  const linked = { ...office, id: 1, active: 1, bitrix24Stage: "Увольнения" };
  const archived = { ...linked, active: 0 };
  const namesake = { ...ordinary, id: 2, active: 1, bitrix24Id: null };
  const scope = { stageKeys: ["Объекты и офисы", "Чёрный список"], projectKeys: ["НЗНП"] };
  assert.equal(isBitrixEmployeeInImportScope(office, scope), false);
  assert.deepEqual(selectLinkedBitrixEmployeesForReview([terminal, ordinary], ["101"], scope), [ordinary]);
  assert.deepEqual(compareBitrixEmployees([office], [linked]), { compared: 0, matched: 0, differences: [] });
  assert.deepEqual(compareBitrixEmployees([], [linked], [terminal]), { compared: 0, matched: 0, differences: [] });
  assert.deepEqual(suggestBitrixEmployeeLinks([office], [namesake]), []);
  assert.equal(suggestBitrixEmployeeLinks([ordinary], [namesake], [ordinary, office])[0].kind, "review", "office namesakes still prevent unsafe automatic matching");
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks([office], [archived, namesake]), []);
  assert.deepEqual(observeLegacyTerminalBitrixDuplicates([terminal], [archived, namesake]), []);
});

test("office transitions distinguish field history from office-only, dismissed, and ambiguous records", () => {
  const scope = { stageKeys: ["ON_SITE"], projectKeys: ["НЗНП"] };
  const local = { active: 1, availabilityStatus: "on_site", hasProjectHistory: true };
  const office = { bitrix24Id: "101", availabilityStatus: "on_site", subdivisionKeys: ["Центр. офис"] };
  const confirmedOffice = { ...local, active: 0, availabilityStatus: "central_office" };
  const field = { ...office, stageId: "ON_SITE", stageName: "Объекты и офисы", subdivisionKeys: ["СЗУ"], projectKeys: ["НЗНП"] };
  assert.equal(bitrixOfficeTransferDirection(office, local), "to_office", "the office branch does not need stage/project import configuration");
  assert.equal(bitrixOfficeTransferDirection(office, { ...local, hasProjectHistory: false }, scope), null);
  assert.equal(bitrixOfficeTransferDirection(office, confirmedOffice, scope), null);
  assert.equal(bitrixOfficeTransferDirection({ ...office, bitrix24Id: "" }, local, scope), null);
  assert.equal(bitrixOfficeTransferDirection({ ...office, availabilityStatus: "blacklisted" }, local, scope), null);
  assert.equal(bitrixOfficeTransferDirection(office, { ...local, availabilityStatus: "dismissed" }, scope), null);
  assert.equal(bitrixOfficeTransferDirection(field, confirmedOffice, scope), "to_site");
  assert.equal(bitrixOfficeTransferDirection(field, { ...confirmedOffice, availabilityStatus: "out_of_scope" }, scope), null);
  assert.equal(bitrixOfficeTransferDirection(field, { ...confirmedOffice, availabilityStatus: "blacklisted" }, scope), null);
  assert.equal(bitrixOfficeTransferDirection({ ...field, projectKeys: ["Другой объект"] }, confirmedOffice, scope), null);
  assert.equal(bitrixOfficeTransferDirection({ ...field, stageId: "UNSUPPORTED", stageName: "Другой этап" }, confirmedOffice, scope), null);
  assert.equal(bitrixOfficeTransferDirection({ ...field, subdivisionKeys: ["3937"] }, confirmedOffice, scope), null);
  assert.equal(bitrixOfficeTransferDirection({ ...field, subdivisionKeys: [] }, confirmedOffice, scope), null);
  assert.equal(bitrixOfficeTransferDirection({ ...field, availabilityStatus: "transfer" }, confirmedOffice, scope), null);
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
  const local = [{ bitrix24Id: "101", fullName: "Иванов  Иван", employmentType: "ОПР", department: "УСР", position: "Монтажник", bitrix24Stage: "На объекте", projectKeys: ["Усть-Луга"] }];
  assert.deepEqual(compareBitrixEmployees(source, local), { compared: 1, matched: 1, differences: [] });

  const changed = compareBitrixEmployees(source, [{ ...local[0], position: "Сварщик" }, { ...local[0], bitrix24Id: "999", fullName: "Старая карточка" }]);
  assert.equal(changed.matched, 0);
  assert.deepEqual(changed.differences.map((difference) => difference.kind), ["changed", "missing_in_bitrix"]);
  assert.match(changed.differences[0].details, /Должность/);

  const changedProject = compareBitrixEmployees(source, [{ ...local[0], projectKeys: ["Другой объект"] }]);
  assert.equal(changedProject.matched, 0);
  assert.match(changedProject.differences[0].details, /Объект: «Другой объект» → «Усть-Луга»/);

  const dismissedSource = [{ ...source[0], availabilityStatus: "dismissed", stageName: "Увольнение" }];
  const dismissed = compareBitrixEmployees([], local, dismissedSource);
  assert.deepEqual(dismissed.differences.map((difference) => difference.kind), ["dismissed_in_bitrix"]);
  assert.match(dismissed.differences[0].details, /уволен/i);
});

test("suggests only unique exact employee matches for automatic Bitrix linking", () => {
  const source = [{
    bitrix24Id: "101", fullName: "Иванов  Иван", employmentType: "ОПР", department: "УСР", position: "Монтажник",
    stageId: "ON_SITE", stageName: "На объекте", availabilityStatus: "on_site", projectKeys: ["Усть-Луга"], sourceUpdatedAt: null,
  }, {
    bitrix24Id: "102", fullName: "Петров Пётр", employmentType: "ИТР", department: "ПТО", position: "Инженер",
    stageId: "ON_SITE", stageName: "На объекте", availabilityStatus: "on_site", projectKeys: ["Усть-Луга"], sourceUpdatedAt: null,
  }];
  const local = [
    { id: 1, bitrix24Id: null, fullName: "Иванов Иван", employmentType: "ОПР", department: "УСР", position: "Монтажник" },
    { id: 2, bitrix24Id: null, fullName: "Петров Петр", employmentType: "ИТР", department: "ПТО", position: "Главный инженер" },
  ];
  assert.deepEqual(suggestBitrixEmployeeLinks(source, local), [
    { bitrix24Id: "101", employeeName: "Иванов  Иван", kind: "safe", employeeIds: [1] },
    { bitrix24Id: "102", employeeName: "Петров Пётр", kind: "review", employeeIds: [2] },
  ]);
  assert.equal(suggestBitrixEmployeeLinks(source, [{ ...local[0], bitrix24Id: "101" }, local[1]]).some((item) => item.bitrix24Id === "101"), false);
});

const archiveLinkSource = Object.freeze({
  bitrix24Id: "701", fullName: "Семёнов  Пётр", employmentType: "ИТР", department: "ПТО", position: "Инженер",
  stageId: "ON_SITE", stageName: "На объекте", availabilityStatus: "on_site", projectKeys: ["Усть-Луга"], sourceUpdatedAt: null,
});
const archiveLinkTarget = Object.freeze({
  id: 42, active: 1, bitrix24Id: null, fullName: "Семенов Петр", employmentType: " ИТР ", department: "ПТО", position: "инженер", availabilityStatus: "on_site",
});
const archiveLinkOwner = Object.freeze({
  ...archiveLinkTarget, id: 17, active: 0, bitrix24Id: "701", position: "Предыдущая должность", availabilityStatus: "out_of_scope",
});

test("ordinary matching also requires unique names across local and remote records", () => {
  const suggestion = { bitrix24Id: "701", employeeName: archiveLinkSource.fullName, kind: "review", employeeIds: [42] };
  assert.deepEqual(suggestBitrixEmployeeLinks(
    [archiveLinkSource], [archiveLinkTarget], [archiveLinkSource, { ...archiveLinkSource, bitrix24Id: "702", fullName: "Семенов Петр" }],
  ), [suggestion], "remote namesakes outside the selection also prevent automatic matching");
  assert.deepEqual(suggestBitrixEmployeeLinks([archiveLinkSource], [
    archiveLinkTarget, { ...archiveLinkTarget, id: 43, bitrix24Id: "702" },
  ]), [suggestion], "already-linked local namesakes also prevent automatic matching");
  assert.deepEqual(suggestBitrixEmployeeLinks([archiveLinkSource], [
    archiveLinkTarget, { ...archiveLinkTarget, id: 43, position: "Технолог" },
  ]), [{ ...suggestion, employeeIds: [42, 43] }], "one exact match among several namesakes must still be confirmed manually");
});

test("ID-only linking compares actual availability and projects without inventing a missing stage change", () => {
  const linked = { ...archiveLinkTarget, bitrix24Id: "701", bitrix24Stage: "", projectKeys: ["Усть-Луга"] };
  assert.deepEqual(compareBitrixEmployees([archiveLinkSource], [linked]), { compared: 1, matched: 1, differences: [] });
  assert.equal(compareBitrixEmployees([archiveLinkSource], [{ ...linked, projectKeys: ["Другой объект"] }]).differences[0].details,
    "Объект: «Другой объект» → «Усть-Луга»");
  for (const bitrix24Stage of ["", "На объекте", "В отпуске"]) {
    const result = compareBitrixEmployees([archiveLinkSource], [{ ...linked, bitrix24Stage, availabilityStatus: "vacation" }]);
    assert.equal(result.matched, 0);
    assert.deepEqual(result.differences.map(difference => difference.details), ["Статус: «Отпуск» → «На объекте»"]);
  }
  assert.equal(compareBitrixEmployees([archiveLinkSource], [{ ...linked, availabilityStatus: undefined }]).differences[0].details,
    "Стадия: «—» → «На объекте»", "legacy snapshots without availability still use the stored stage");
  assert.deepEqual(compareBitrixEmployees([{ ...archiveLinkSource, availabilityStatus: "unknown" }], [linked]).differences.map(difference => difference.kind),
    ["unknown_stage"]);
});

test("archived Bitrix ID proposes the exact current card, never the historical card", () => {
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks(
    [archiveLinkSource], [archiveLinkOwner, archiveLinkTarget],
  ), [{ bitrix24Id: "701", employeeName: archiveLinkSource.fullName, kind: "safe", employeeIds: [42] }]);
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks([archiveLinkSource], [archiveLinkOwner]), []);
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks([archiveLinkSource], [archiveLinkTarget]), []);
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks([archiveLinkSource], [
    { ...archiveLinkOwner, fullName: "Другой сотрудник" }, archiveLinkTarget,
  ]), []);
});

test("archive-backed matching abstains on ambiguous IDs and never proposes terminal or office records", () => {
  for (const availabilityStatus of ["blacklisted", "dismissed", "deleted", "central_office"]) {
    assert.deepEqual(suggestArchivedBitrixEmployeeLinks(
      [{ ...archiveLinkSource, availabilityStatus }], [archiveLinkOwner, archiveLinkTarget],
    ), []);
    assert.deepEqual(suggestArchivedBitrixEmployeeLinks(
      [archiveLinkSource], [{ ...archiveLinkOwner, availabilityStatus }, archiveLinkTarget],
    ), []);
    assert.deepEqual(suggestArchivedBitrixEmployeeLinks(
      [archiveLinkSource], [archiveLinkOwner, { ...archiveLinkTarget, availabilityStatus }],
    ), []);
  }
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks(
    [archiveLinkSource], [archiveLinkOwner, archiveLinkTarget], [archiveLinkSource, { ...archiveLinkSource, fullName: "Другое ФИО" }],
  ), []);
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks(
    [archiveLinkSource], [archiveLinkOwner, archiveLinkTarget, { ...archiveLinkOwner, id: 18 }],
  ), []);
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks(
    [{ ...archiveLinkSource, fullName: " " }], [{ ...archiveLinkOwner, fullName: "" }, { ...archiveLinkTarget, fullName: "" }],
  ), []);
});

test("an office return cannot be compared, linked or used to archive a namesake through an ordinary review", () => {
  const office = { ...archiveLinkOwner, availabilityStatus: "central_office", fullName: archiveLinkSource.fullName };
  const field = { ...archiveLinkSource, subdivisionKeys: ["СЗУ"] };
  const namesake = { ...archiveLinkTarget, fullName: office.fullName, position: office.position };
  assert.deepEqual(compareBitrixEmployees([field], [office]), { compared: 0, matched: 0, differences: [] });
  assert.deepEqual(compareBitrixEmployees([], [office]), { compared: 0, matched: 0, differences: [] });
  assert.deepEqual(suggestBitrixEmployeeLinks([field], [office, namesake]), []);
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks([field], [office, namesake]), []);
  assert.deepEqual(observeLegacyTerminalBitrixDuplicates([{ ...field, availabilityStatus: "dismissed" }], [office, namesake]), []);
});

test("archive-backed candidates need manual review when identity fields or uniqueness cannot be verified", () => {
  const expected = [{ bitrix24Id: "701", employeeName: archiveLinkSource.fullName, kind: "review", employeeIds: [42] }];
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks([archiveLinkSource], [
    archiveLinkOwner, { ...archiveLinkTarget, position: "Технолог" },
  ]), expected);
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks([{ ...archiveLinkSource, department: " " }], [
    archiveLinkOwner, { ...archiveLinkTarget, department: "" },
  ]), expected, "matching blanks do not establish identity");
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks([archiveLinkSource], [
    archiveLinkOwner, archiveLinkTarget, { ...archiveLinkTarget, id: 43, bitrix24Id: "702" },
  ]), expected, "a linked active namesake also prevents automatic selection");
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks([archiveLinkSource], [
    archiveLinkOwner, archiveLinkTarget, { ...archiveLinkTarget, id: 43 },
  ]), [{ ...expected[0], employeeIds: [42, 43] }]);
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks(
    [archiveLinkSource], [archiveLinkOwner, archiveLinkTarget], [archiveLinkSource, { ...archiveLinkSource, bitrix24Id: "702" }],
  ), expected, "competing source cards prevent automatic selection even outside the current scope");
  assert.deepEqual(suggestArchivedBitrixEmployeeLinks(
    [{ ...archiveLinkSource, availabilityStatus: "unknown" }], [archiveLinkOwner, archiveLinkTarget],
  ), expected);
});
