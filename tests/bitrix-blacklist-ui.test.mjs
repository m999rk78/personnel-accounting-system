import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement, Fragment } from "react";
import ts from "typescript";
import { employeeBitrixStatus } from "../app/bitrixEmployeeStatus.ts";
import { bitrixReviewUpdateBatches, bitrixReviewUpdateIds } from "../app/bitrixReviewSelection.ts";

const readSource = async path => ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement", jsxFragmentFactory: "Fragment" } }).outputText;
function find(source, predicate) {
  let result;
  const visit = node => { if (!result && predicate(node)) result = node; if (!result) ts.forEachChild(node, visit); };
  visit(source); assert.ok(result); return result;
}
const gridSource = await readSource("../app/EmployeeDirectoryGrid.tsx");
const callback = name => find(gridSource, node => ts.isVariableDeclaration(node) && node.name.getText(gridSource) === name).initializer.arguments[0].getText(gridSource);
const renderStatus = new Function("createElement", "employeeBitrixStatus", compile(`return (${callback("bitrixRenderer")});`))(createElement, employeeBitrixStatus);
const getValue = new Function("employeeBitrixStatus", "latest", compile(`return (${callback("valueFor")});`))(employeeBitrixStatus, { current: { draftsById: new Map(), draftsByKey: new Map() } });
const ruleNode = find(gridSource, node => ts.isJsxAttribute(node) && node.name.getText(gridSource) === "rowClassRules");
const rowRules = new Function(compile(`return (${ruleNode.initializer.expression.getText(gridSource)});`))();
const textOf = node => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(textOf).join(" ") : node?.props ? textOf(node.props.children) : "";
const employee = { id: 7, bitrix24Id: "B7", fullName: "Тестовый сотрудник", availabilityStatus: "on_site", bitrix24Stage: "На объекте", bitrixCheckStatus: null };
const blacklisted = { kind: "blacklisted_in_bitrix", localEmployeeId: 7, bitrix24Id: "B7", employeeName: employee.fullName, details: "Стадия сотрудника в Битрикс24 — Чёрный список." };

test("the actual employee grid keeps a reconciled blacklist visible, searchable and free of stale warning styling", () => {
  const unresolved = { ...employee, bitrixCheckStatus: "blacklisted_in_bitrix", bitrixCheckDetails: blacklisted.details };
  const reconciled = { ...employee, availabilityStatus: "blacklisted", bitrix24Stage: "Чёрный список" };
  for (const current of [unresolved, { ...unresolved, bitrixCheckAcknowledged: 1 }, reconciled]) {
    const label = getValue({ employee: current }, "bitrixCheckLabel");
    assert.equal(label, "Чёрный список в Битрикс24");
    const rendered = renderStatus({ data: { employee: current }, value: label });
    assert.match(textOf(rendered), /Чёрный список в Битрикс24/);
    assert.equal(rendered.props.children[0].props.className, "bitrix-grid-status blacklisted");
  }
  assert.equal(employeeBitrixStatus(unresolved).warning, true);
  assert.equal(employeeBitrixStatus(reconciled).warning, false);
  assert.equal(rowRules["bitrix-blacklisted-row"]({ data: { employee: unresolved } }), true);
  assert.equal(rowRules["bitrix-blacklisted-row"]({ data: { employee: reconciled } }), false);
  assert.equal(rowRules["bitrix-blacklisted-row"]({ data: { employee: { ...unresolved, bitrixCheckAcknowledged: 1 } } }), false);
  assert.equal(getValue({ employee: { ...reconciled, bitrix24Stage: "На объекте" } }, "bitrixCheckLabel"), "Чёрный список в Битрикс24", "a raw stage name never overrides the server's archived availability");
  assert.equal(getValue({ employee }, "bitrixCheckLabel"), "Нет предупреждений", "only a changed server availability clears the blacklist badge");
  assert.equal(employeeBitrixStatus({ ...employee, bitrix24Id: null }).label, "Не связан с Битрикс24");
  assert.equal(employeeBitrixStatus({ ...employee, bitrixCheckStatus: "mismatch", bitrixCheckAcknowledged: 1 }).warning, false);
  assert.equal(employeeBitrixStatus({ ...employee, bitrixCheckStatus: "missing_in_bitrix" }).label, "Отсутствует в Битрикс24");
});

const dialogSource = await readSource("../app/workspace/BitrixReviewDialogs.tsx");
const dialogNames = ["BITRIX_DIFFERENCE_LABELS", "BITRIX_DIFFERENCE_SUMMARY_LABELS"];
const dialogLabels = dialogSource.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => dialogNames.includes(item.name.getText(dialogSource)))).map(node => node.getText(dialogSource)).join("\n");
test("review item and summary identify a blacklist explicitly", () => {
  const labels = new Function(compile(`${dialogLabels}; return [${dialogNames.join(",")}];`))();
  labels.forEach(map => assert.equal(map.blacklisted_in_bitrix, "Чёрный список в Битрикс24"));
});

const reviewSource = await readSource("../app/workspace/useBitrixReview.ts");
const reviewHook = find(reviewSource, node => ts.isFunctionDeclaration(node) && node.name?.text === "useBitrixReview").getText(reviewSource).replace(/^export\s+/, "");
function reviewHarness(overrides = {}) {
  const { respond, ...optionOverrides } = overrides;
  const state = [], calls = [], messages = [];
  let cursor = 0, loaded = 0;
  const options = {
    data: null, view: "employees", visibleEmployees: [], visibleSites: [], selectedEmployeeRows: [], employeeDrafts: [], employeeFullRowEditIds: [],
    mayCreateEmployees: true, mayDeleteEmployees: true, mayInspectBitrix24: true, mayUpdateEmployees: true,
    loadData: async () => { loaded++; }, requireSavedExcelRows: () => true, setEmployeePendingDeletes() {},
    setError: message => messages.push(message), setNotice: message => messages.push(message), confirm: async () => true, ...optionOverrides,
  };
  const environment = {
    useState(initial) { const id = cursor++; if (!(id in state)) state[id] = typeof initial === "function" ? initial() : initial; return [state[id], next => { state[id] = typeof next === "function" ? next(state[id]) : next; }]; },
    useRef(initial) { const id = cursor++; state[id] ??= { current: initial }; return state[id]; },
    useMemo: callback => callback(), useEffect() {}, bitrixReviewUpdateIds, bitrixReviewUpdateBatches,
    formatBitrix24Cooldown: () => "", remainingBitrix24Cooldown: () => 0, normalize: value => value.trim().toLocaleLowerCase("ru-RU"),
    async fetch(_url, request) {
      const payload = JSON.parse(request.body); calls.push(payload);
      if (respond) return respond(payload);
      if (payload.action === "acknowledge-selected-bitrix24-differences") {
        return { ok: true, json: async () => ({ employeeIds: payload.employeeIds, acknowledgedCount: payload.employeeIds.length }) };
      }
      return { ok: true, json: async () => ({ status: "ok", differences: [], compared: 1, matched: 1, totalDifferences: 0, autoLinkable: 0, updatedEmployee: { id: 7, name: employee.fullName } }) };
    },
  };
  const hook = new Function(...Object.keys(environment), compile(`${reviewHook}; return useBitrixReview;`))(...Object.values(environment));
  const render = () => { cursor = 0; return hook(options); };
  const select = (difference, extra = {}) => { render().setBitrixCheckResult({ status: "mismatch", differences: [difference], totalDifferences: 1, autoLinkable: 0, ...extra }); return render(); };
  return { render, select, calls, messages, get loaded() { return loaded; } };
}

test("actual review hook offers blacklist reconciliation and never a blacklist delete, create or link action", async () => {
  const ui = reviewHarness({ selectedEmployeeRows: [
    { ...employee, bitrixCheckStatus: "blacklisted_in_bitrix" },
    { ...employee, id: 8, bitrixCheckStatus: "blacklisted_in_bitrix", bitrixCheckAcknowledged: 1 },
    { ...employee, id: 9, bitrixCheckStatus: "dismissed_in_bitrix" },
  ] });
  const review = ui.select(blacklisted);
  assert.equal(review.canUpdateSelectedBitrixEmployee, true);
  assert.equal(review.canDeleteSelectedBitrixEmployee, false);
  assert.equal(review.canCreateSelectedBitrixEmployee, false);
  assert.equal(review.canLinkSelectedBitrixEmployee, false);
  assert.deepEqual(review.bitrixReviewUpdateIdsForAll, [7]);
  assert.deepEqual(review.selectedBitrixUpdatableEmployees.map(item => item.id), [7, 9]);
  review.setBitrixEmployeeAction({ kind: "update", difference: blacklisted });
  await ui.render().applyBitrixEmployeeAction();
  assert.deepEqual(ui.calls, [{ action: "update-bitrix24-employee", employeeId: 7, bitrix24Id: "B7" }]);
  assert.equal(ui.loaded, 1); assert.equal(ui.render().bitrixCheckResult.status, "ok");
  assert.ok(ui.messages.some(message => typeof message === "string" && message.includes("перенесён в архив")));
});

const dialogFunction = find(dialogSource, node => ts.isFunctionDeclaration(node) && node.name?.text === "BitrixReviewDialogs").getText(dialogSource).replace(/^export\s+/, "");
const renderDialog = new Function("createElement", "Fragment", "CustomSelect", "BitrixReviewEmployeeList", compile(`${dialogLabels}; ${dialogFunction}; return BitrixReviewDialogs;`))(createElement, Fragment, () => null, () => null);

const officeTransfer = (direction, id = 7) => ({
  kind: "changed", officeTransfer: direction, officeTransferFingerprint: `office_transfer:${direction}:${id}`,
  localEmployeeId: id, bitrix24Id: `B${id}`, employeeName: employee.fullName,
  details: direction === "to_office" ? "Битрикс24: «Центр. офис»." : "Битрикс24: объект «Северный»."
});

test("office transfers require the separate confirmation and never use the grid update or ignore actions", async () => {
  for (const direction of ["to_office", "to_site"]) {
    const transfer = officeTransfer(direction);
    const ui = reviewHarness({ mayDeleteEmployees: false, selectedEmployeeRows: [{ ...employee, bitrixCheckStatus: "mismatch", bitrixCheckOfficeTransfer: 1 }] });
    assert.deepEqual(ui.render().selectedBitrixUpdatableEmployees, []);
    assert.deepEqual(ui.render().selectedBitrixWarningEmployees, []);
    const withoutFingerprint = ui.select({ ...transfer, officeTransferFingerprint: undefined });
    assert.equal(withoutFingerprint.canUpdateSelectedBitrixEmployee, false);
    const review = ui.select(transfer, { ignorableEmployeeIds: [7], differenceCounts: { changed: 1 } });
    assert.equal(review.canUpdateSelectedBitrixEmployee, true);
    assert.equal(review.canAcknowledgeSelectedBitrixEmployee, false);
    assert.equal(review.canDeleteSelectedBitrixEmployee, false);
    assert.equal(review.bitrixReviewIgnoreSelectedCount, 0);
    await review.acknowledgeBitrixDifference(transfer);
    assert.deepEqual(ui.calls, []);
    const render = () => textOf(renderDialog({ review: ui.render(), data: null, visibleSites: [], mayInspectBitrix24: true, mayCreateEmployees: true, mayUpdateEmployees: true, mayDeleteEmployees: false, error: "" }));
    assert.match(render(), /Подтвердить перевод/);
    assert.doesNotMatch(render(), /Отличаются данные:|Оставить как есть/);
    review.setBitrixEmployeeAction({ kind: "update", difference: { ...transfer, officeTransferFingerprint: "stale" } });
    await ui.render().applyBitrixEmployeeAction();
    assert.deepEqual(ui.calls, []);
    review.setBitrixEmployeeAction({ kind: "update", difference: transfer });
    assert.match(render(), direction === "to_office" ? /Подтвердить перевод в центральный офис\?/ : /Подтвердить перевод на объект\?/);
    assert.match(render(), /отчёты и табели останутся без изменений/);
    await ui.render().applyBitrixEmployeeAction();
    assert.deepEqual(ui.calls, [{ action: "update-bitrix24-employee", employeeId: 7, bitrix24Id: "B7", officeTransferFingerprints: { 7: transfer.officeTransferFingerprint } }]);
  }
});

test("bulk confirmation submits only the observed fingerprints of selected office transfers", async () => {
  const out = officeTransfer("to_office"), back = officeTransfer("to_site", 8), unchecked = officeTransfer("to_office", 9);
  const ordinary = { kind: "changed", localEmployeeId: 10, bitrix24Id: "B10", employeeName: "Сотрудник площадки", details: "Изменился отдел." };
  const confirmations = [];
  let accepted = false;
  const ui = reviewHarness({ confirm: async options => { confirmations.push(options); return accepted; } });
  ui.select(out, { differences: [out, back, unchecked, ordinary], totalDifferences: 4, differenceCounts: { changed: 4 } }).setBitrixReviewSelectedIds([7, 8, 10]);
  await ui.render().updateBitrixReviewSelection();
  assert.deepEqual(ui.calls, []);
  assert.match(confirmations[0].description, /центральный офис: 1/);
  assert.match(confirmations[0].description, /на объект вернутся существующие карточки: 1/i);
  assert.match(confirmations[0].description, /отчёты и табели сохранят историю/);
  accepted = true;
  await ui.render().updateBitrixReviewSelection();
  assert.deepEqual(ui.calls, [{ action: "update-selected-bitrix24-employees", employeeIds: [7, 8, 10],
    officeTransferFingerprints: { 7: out.officeTransferFingerprint, 8: back.officeTransferFingerprint } }]);
});

test("unlinked Bitrix cards can be matched manually even when other cards are eligible for automatic matching", () => {
  const ui = reviewHarness();
  const candidate = { kind: "missing_locally", bitrix24Id: "B10", employeeName: "Сотрудник с кандидатом", details: "Проверьте совпадение по ФИО.", suggestedEmployeeIds: [10] };
  const review = ui.select(candidate, { autoLinkable: 1, autoLinkOptions: [{ bitrix24Id: "B11", archivedLink: false }], compared: 12, matched: 10, differenceCounts: { missing_locally: 1 } });
  assert.equal(review.canLinkSelectedBitrixEmployee, true);
  assert.equal(review.canCreateSelectedBitrixEmployee, false);
  assert.equal(review.selectedBitrixDifferenceDetails, candidate.details);
  const content = textOf(renderDialog({ review, data: null, visibleSites: [], mayInspectBitrix24: true, mayCreateEmployees: true, mayUpdateEmployees: true, mayDeleteEmployees: true, error: "" }));
  assert.match(content, /Совпали связанные карточки\s+10/);
  assert.match(content, /Действующих связанных карточек в сверке:\s+12\s*\. Архив не учитывается в обычной сверке\./);
  assert.match(content, /Есть кандидаты для сопоставления/);
  assert.match(content, /Нерешённые расхождения\s+0/);
  assert.match(content, /Нужно сопоставить или добавить\s+1/);
  assert.match(content, /Сопоставить с существующим/);
  assert.match(content, /Сопоставить выбранных \(0\)/);
  const unmatched = ui.select({ ...candidate, suggestedEmployeeIds: [] }, { autoLinkable: 10 });
  assert.equal(unmatched.canCreateSelectedBitrixEmployee, true);
  assert.equal(unmatched.canLinkSelectedBitrixEmployee, true);
  assert.equal(reviewHarness({ mayUpdateEmployees: false }).select(candidate, { autoLinkable: 10 }).canLinkSelectedBitrixEmployee, false);
});

test("an archived link can only be transferred to a suggested active card after confirmation", async () => {
  const archive = { kind: "missing_locally", bitrix24Id: "B10", employeeName: "Карточка Битрикс24", details: "Связь находится в архиве.", archivedLink: true, suggestedEmployeeIds: [10] };
  const target = { id: 10, fullName: "Действующий сотрудник", employmentType: "ИТР", department: "УСР", position: "Мастер" };
  const unrelated = { ...target, id: 11, fullName: "Другой сотрудник" };
  const visibleEmployees = [target, unrelated];
  const extra = { activeUnlinked: 2, archiveLinkRevision: "test-revision", compared: 10 };
  const confirmations = [];
  const cancelled = reviewHarness({ visibleEmployees, confirm: async options => { confirmations.push(options); return false; } });
  const review = cancelled.select(archive, extra);
  assert.deepEqual(review.bitrixAvailableEmployeeOptions.map(item => item.value), ["", "10"]);
  assert.equal(review.canLinkSelectedBitrixEmployee, true);
  assert.equal(review.canCreateSelectedBitrixEmployee, false);
  review.openBitrixEmployeeCreate(archive);
  assert.equal(cancelled.render().bitrixEmployeeCreateDraft, null);
  const content = textOf(renderDialog({ review, data: null, visibleSites: [], mayInspectBitrix24: true, mayCreateEmployees: true, mayUpdateEmployees: true, mayDeleteEmployees: true, error: "" }));
  assert.match(content, /Действующих без связи: 2/);
  assert.match(content, /Связать с действующей карточкой/);
  assert.match(content, /Перенести связь/);
  assert.doesNotMatch(content, /Добавить сотрудника/);
  await review.linkBitrix24Employees([{ bitrix24Id: "B10", employeeId: 11 }]);
  assert.deepEqual(confirmations, []);
  await review.linkBitrix24Employees([{ bitrix24Id: "B10", employeeId: 10 }]);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].description, /Карточка Битрикс24.*архивной.*Действующий сотрудник/);
  assert.match(confirmations[0].description, /отчёты и табели останутся без изменений/);
  assert.deepEqual(cancelled.calls, []);
  assert.equal(cancelled.render().linkingBitrix24, false);
  const accepted = reviewHarness({ visibleEmployees });
  const withoutRevision = accepted.select(archive);
  assert.equal(withoutRevision.canLinkSelectedBitrixEmployee, false);
  await withoutRevision.linkBitrix24Employees([{ bitrix24Id: "B10", employeeId: 10 }]);
  assert.deepEqual(accepted.calls, []);
  await accepted.select(archive, extra).linkBitrix24Employees([{ bitrix24Id: "B10", employeeId: 10 }]);
  assert.deepEqual(accepted.calls, [{ action: "link-bitrix24-employees", links: [{ bitrix24Id: "B10", employeeId: 10 }], allowArchivedLink: true, archiveLinkRevision: "test-revision" }]);
});

test("matching sends only the checked exact matches and confirms only selected archive transfers", async () => {
  const missing = { kind: "missing_locally", bitrix24Id: "B10", employeeName: "Сотрудник без связи", details: "" };
  const extra = { autoLinkable: 3, archiveAutoLinkable: 2, archiveLinkRevision: "test-batch", autoLinkOptions: [
    { bitrix24Id: "B10", archivedLink: true }, { bitrix24Id: "B11", archivedLink: false }, { bitrix24Id: "B12", archivedLink: true },
  ] };
  const confirmations = [];
  const cancelled = reviewHarness({ confirm: async options => { confirmations.push(options); return false; } });
  await cancelled.select(missing, extra).linkBitrix24Employees();
  assert.deepEqual(confirmations, []);
  assert.deepEqual(cancelled.calls, []);
  cancelled.render().setBitrixLinkSelectedIds(["B10", "B11"]);
  await cancelled.render().linkBitrix24Employees();
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].description, /Выбрано для сопоставления: 2.*архивных карточек на действующие: 1/);
  assert.deepEqual(cancelled.calls, []);
  assert.equal(cancelled.render().bitrixLinkSelectedCount, 2);
  const accepted = reviewHarness();
  accepted.select(missing, extra).setBitrixLinkSelectedIds(["B10", "B11", "not-eligible"]);
  await accepted.render().linkBitrix24Employees();
  assert.deepEqual(accepted.calls, [{ action: "link-bitrix24-employees", autoLinkBitrixIds: ["B10", "B11"], allowArchivedLink: true, archiveLinkRevision: "test-batch" }]);
  const ordinary = reviewHarness({ confirm: async () => { throw new Error("Ordinary links must keep their existing flow"); } });
  ordinary.select(missing, extra).setBitrixLinkSelectedIds(["B11"]);
  await ordinary.render().linkBitrix24Employees();
  assert.deepEqual(ordinary.calls, [{ action: "link-bitrix24-employees", autoLinkBitrixIds: ["B11"] }]);
});

test("the matching checklist includes reviewed archive pairs and transfers only the checked choices", async () => {
  const archive = { kind: "missing_locally", bitrix24Id: "ARCH1", employeeName: "Единственный кандидат", details: "Должность отличается",
    archivedLink: true, suggestedEmployeeIds: [10] };
  const ambiguous = { ...archive, bitrix24Id: "AMBIGUOUS", employeeName: "Есть тёзки", suggestedEmployeeIds: [11, 12] };
  const ordinary = { ...archive, archivedLink: false, bitrix24Id: "EXACT", employeeName: "Точное совпадение", suggestedEmployeeIds: [13] };
  const confirmations = [];
  const ui = reviewHarness({ confirm: async options => { confirmations.push(options); return true; } });
  const review = ui.select(archive, { differences: [archive, ambiguous, ordinary], totalDifferences: 3, archiveLinkRevision: "current",
    autoLinkOptions: [{ bitrix24Id: "EXACT", archivedLink: false }], archiveTransferOptions: [{ bitrix24Id: "ARCH1", employeeId: 10 }] });
  assert.deepEqual(review.bitrixLinkEligibleIds, ["EXACT", "ARCH1"]);
  assert.deepEqual(review.bitrixLinkArchiveIds, ["ARCH1"]);
  review.setBitrixLinkSelectedIds(["ARCH1", "AMBIGUOUS"]);
  const selected = ui.render();
  const content = textOf(renderDialog({ review: selected, data: null, visibleSites: [], mayInspectBitrix24: true, mayCreateEmployees: true, mayUpdateEmployees: true, mayDeleteEmployees: true, error: "" }));
  assert.match(content, /Перенести связь \(1\)/);
  await selected.linkBitrix24Employees();
  assert.equal(confirmations[0].confirmLabel, "Перенести связь");
  assert.match(confirmations[0].description, /единственный кандидат по ФИО, но кадровые данные могут отличаться/);
  assert.deepEqual(ui.calls, [{ action: "link-bitrix24-employees", archiveTransferLinks: [{ bitrix24Id: "ARCH1", employeeId: 10 }],
    allowArchivedLink: true, archiveLinkRevision: "current" }]);
});

test("the actual blacklist dialog offers archive with explicit historical-data and non-rehire explanations", () => {
  const ui = reviewHarness();
  const review = ui.select(blacklisted);
  const render = current => renderDialog({ review: current, data: null, visibleSites: [], mayInspectBitrix24: true, mayCreateEmployees: true, mayUpdateEmployees: true, mayDeleteEmployees: true, error: "" });
  const details = textOf(render(review));
  assert.match(details, /Архивировать/);
  assert.match(details, /«Увольнения» и «Чёрный список» означают увольнение/);
  assert.match(details, /исключает повторный приём/);
  assert.doesNotMatch(details, /Удалить из системы|Добавить сотрудника|Сопоставить с существующим/);
  review.setBitrixEmployeeAction({ kind: "update", difference: blacklisted });
  const confirmation = textOf(render(ui.render()));
  assert.match(confirmation, /Архивировать сотрудника\?/);
  assert.match(confirmation, /исключён из действующих проектов/);
  assert.match(confirmation, /отчёты и табели сохранятся без изменений/);
});

test("an archived employee's return is a separate informational warning with no write actions", async () => {
  const ui = reviewHarness();
  const returned = {
    kind: "archived_returned_to_site", bitrix24Id: "B-RETURN", employeeName: "Вернувшийся сотрудник",
    details: "В Битрикс24 снова назначен объект «Площадка Север».",
  };
  const review = ui.select(returned, { status: "ok", compared: 2, matched: 2, totalDifferences: 0, differences: [], archiveReturns: [returned] });
  const content = textOf(renderDialog({ review, data: null, visibleSites: [], mayInspectBitrix24: true, mayCreateEmployees: true, mayUpdateEmployees: true, mayDeleteEmployees: true, error: "" }));
  assert.match(content, /Изменились стадии архивных карточек \(\s*1\s*\)/);
  assert.match(content, /Активных расхождений с Битрикс24 нет/);
  assert.match(content, /Площадка Север/);
  assert.match(content, /Карточки остаются в архиве и не входят в сверку действующих сотрудников/);
  assert.doesNotMatch(content, /Сопоставить|Добавить сотрудника|Обновить из Битрикс24|Удалить из системы|Оставить как есть/);
  assert.deepEqual(review.bitrixReviewUpdateIdsForAll, []);
  assert.deepEqual(review.bitrixLinkEligibleIds, []);

  // Even an old or inconsistent preview with a local ID must stay read-only.
  const withLocalId = { ...returned, localEmployeeId: 7 };
  const stale = ui.select(withLocalId, { updatableEmployeeIds: [7] });
  assert.equal(stale.canLinkSelectedBitrixEmployee, false);
  assert.equal(stale.canCreateSelectedBitrixEmployee, false);
  assert.equal(stale.canUpdateSelectedBitrixEmployee, false);
  assert.equal(stale.canDeleteSelectedBitrixEmployee, false);
  assert.equal(stale.canAcknowledgeSelectedBitrixEmployee, false);
  await stale.acknowledgeBitrixDifference(withLocalId);
  for (const kind of ["update", "delete"]) {
    ui.render().setBitrixEmployeeAction({ kind, difference: withLocalId });
    await ui.render().applyBitrixEmployeeAction();
  }
  assert.deepEqual(ui.calls, []);
  assert.equal(ui.loaded, 0);
});

test("actual review action revalidates permissions and refuses a delete even if stale UI state requests one", async () => {
  const ui = reviewHarness();
  ui.select(blacklisted).setBitrixEmployeeAction({ kind: "delete", difference: blacklisted });
  await ui.render().applyBitrixEmployeeAction();
  assert.deepEqual(ui.calls, []); assert.equal(ui.loaded, 0);
  const readOnly = reviewHarness({ mayUpdateEmployees: false });
  const review = readOnly.select(blacklisted);
  assert.equal(review.canUpdateSelectedBitrixEmployee, false);
  review.setBitrixEmployeeAction({ kind: "update", difference: blacklisted });
  await readOnly.render().applyBitrixEmployeeAction();
  assert.deepEqual(readOnly.calls, []);
  // The existing explicit missing/dismissed deletion path remains available.
  const missing = { ...blacklisted, kind: "missing_in_bitrix" };
  const allowed = ui.select(missing);
  assert.equal(allowed.canDeleteSelectedBitrixEmployee, true);
  allowed.setBitrixEmployeeAction({ kind: "delete", difference: missing });
  await ui.render().applyBitrixEmployeeAction();
  assert.equal(ui.calls[0].action, "delete-bitrix24-employee");
});

test("the selected-employees toolbar confirms archive and cancellation performs no update", async () => {
  const confirmations = [];
  const selectedEmployeeRows = [{ ...employee, bitrixCheckStatus: "blacklisted_in_bitrix" }];
  const cancelled = reviewHarness({ selectedEmployeeRows, confirm: async options => { confirmations.push(options); return false; } });
  await cancelled.render().updateSelectedEmployeesFromBitrix();
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].description, /перенесены в архив/);
  assert.match(confirmations[0].description, /История отчётов и табелей сохранится/);
  assert.deepEqual(cancelled.calls, []); assert.equal(cancelled.loaded, 0);
  assert.equal(cancelled.render().processingBitrixEmployee, false);
  const accepted = reviewHarness({ selectedEmployeeRows });
  await accepted.render().updateSelectedEmployeesFromBitrix();
  assert.deepEqual(accepted.calls, [{ action: "update-selected-bitrix24-employees", employeeIds: [7] }]);
  assert.equal(accepted.loaded, 1);
  const ordinary = reviewHarness({ selectedEmployeeRows: [{ ...employee, bitrixCheckStatus: "mismatch" }], confirm: async () => { throw new Error("Regular updates must keep their existing flow"); } });
  await ordinary.render().updateSelectedEmployeesFromBitrix();
  assert.equal(ordinary.calls.length, 1);
});

test("per-row actions respect the server's full eligible set, including exclusions after a confirmation opens", async () => {
  const ui = reviewHarness();
  const changed = { ...blacklisted, kind: "changed" };
  const initiallyAllowed = ui.select(changed);
  assert.equal(initiallyAllowed.canUpdateSelectedBitrixEmployee, true, "old responses retain the compatible changed-only fallback");
  initiallyAllowed.setBitrixEmployeeAction({ kind: "update", difference: changed });
  const excluded = ui.select(changed, { updatableEmployeeIds: [] });
  assert.equal(excluded.canUpdateSelectedBitrixEmployee, false, "an inactive changed preview row cannot override an authoritative empty eligible list");
  await excluded.applyBitrixEmployeeAction();
  assert.deepEqual(ui.calls, []); assert.equal(ui.loaded, 0);
  assert.equal(ui.select(blacklisted, { updatableEmployeeIds: [] }).canUpdateSelectedBitrixEmployee, false);
  assert.equal(ui.select(blacklisted, { updatableEmployeeIds: [7] }).canUpdateSelectedBitrixEmployee, true);
});

test("blacklist warnings cannot be acknowledged individually or from selected employees, including stale acknowledged previews", async () => {
  const ui = reviewHarness({ selectedEmployeeRows: [{ ...employee, bitrixCheckStatus: "blacklisted_in_bitrix" }] });
  const review = ui.select(blacklisted, { updatableEmployeeIds: [7] });
  assert.equal(review.canAcknowledgeSelectedBitrixEmployee, false);
  assert.deepEqual(review.selectedBitrixWarningEmployees, []);
  assert.equal(review.canUpdateSelectedBitrixEmployee, true);
  assert.doesNotMatch(textOf(renderDialog({ review, data: null, visibleSites: [], mayInspectBitrix24: true, mayCreateEmployees: true, mayUpdateEmployees: true, mayDeleteEmployees: true, error: "" })), /Оставить как есть/);
  await review.acknowledgeBitrixDifference(blacklisted);
  await ui.render().acknowledgeSelectedBitrixWarnings();
  assert.deepEqual(ui.calls, []); assert.equal(ui.loaded, 0);
  assert.equal(ui.render().bitrixCheckResult.totalDifferences, 1);
  const stale = ui.select({ ...blacklisted, acknowledged: true }, { updatableEmployeeIds: [7] });
  assert.equal(stale.canAcknowledgeSelectedBitrixEmployee, false);
  assert.equal(stale.canUpdateSelectedBitrixEmployee, true, "server eligibility still permits applying the terminal status");
  assert.equal(employeeBitrixStatus({ ...employee, bitrixCheckStatus: "blacklisted_in_bitrix", bitrixCheckAcknowledged: 1 }).label, "Чёрный список в Битрикс24");
});

test("mismatch and dismissal acknowledgement retain their flow without hiding a same-employee blacklist item", async () => {
  const ordinary = { ...blacklisted, kind: "changed" };
  const dismissed = { ...blacklisted, kind: "dismissed_in_bitrix", localEmployeeId: 8 };
  const ui = reviewHarness({ selectedEmployeeRows: [
    { ...employee, bitrixCheckStatus: "blacklisted_in_bitrix" },
    { ...employee, id: 8, bitrixCheckStatus: "dismissed_in_bitrix" },
    { ...employee, id: 9, bitrixCheckStatus: "mismatch" },
  ] });
  const review = ui.select(ordinary, { differences: [ordinary, blacklisted], totalDifferences: 2, differenceCounts: { changed: 1, blacklisted_in_bitrix: 1 } });
  assert.equal(review.canAcknowledgeSelectedBitrixEmployee, true);
  assert.deepEqual(review.selectedBitrixWarningEmployees.map(item => item.id), [8, 9]);
  await review.acknowledgeBitrixDifference(ordinary);
  const result = ui.render().bitrixCheckResult;
  assert.equal(result.status, "mismatch"); assert.equal(result.totalDifferences, 1);
  assert.equal(result.differences.find(item => item.kind === "changed").acknowledged, true);
  assert.notEqual(result.differences.find(item => item.kind === "blacklisted_in_bitrix").acknowledged, true);
  assert.equal(result.differenceCounts.blacklisted_in_bitrix, 1);
  assert.ok(ui.messages.some(message => message.includes("Расхождение скрыто, пока оно не изменится.")));
  const dismissal = ui.select(dismissed);
  assert.equal(dismissal.canAcknowledgeSelectedBitrixEmployee, true);
  await dismissal.acknowledgeBitrixDifference(dismissed);
  assert.equal(ui.calls.at(-1).action, "acknowledge-bitrix24-difference");
  await ui.render().acknowledgeSelectedBitrixWarnings();
  assert.deepEqual(ui.calls.at(-1), { action: "acknowledge-selected-bitrix24-differences", employeeIds: [8, 9] });
});

test("ignoring checked review differences sends bounded requests, preserves blacklist and only hides confirmed rows", async () => {
  const ordinary = Array.from({ length: 201 }, (_, index) => ({
    kind: "changed", localEmployeeId: index + 10, bitrix24Id: `B${index + 10}`, employeeName: `Сотрудник ${index + 10}`, details: "Объект отличается",
  }));
  const employeeIds = ordinary.map(item => item.localEmployeeId);
  const ignoredFingerprints = Object.fromEntries(employeeIds.map(id => [id, `fingerprint-${id}`]));
  const ui = reviewHarness({
    respond(payload) {
      assert.equal(payload.action, "acknowledge-selected-bitrix24-differences");
      return { ok: true, json: async () => ({ employeeIds: payload.employeeIds.filter(id => id !== 11) }) };
    },
  });
  const review = ui.select(ordinary[0], {
    differences: [...ordinary, blacklisted], totalDifferences: 202, differenceCounts: { changed: 201, blacklisted_in_bitrix: 1 },
    updatableEmployeeIds: [...employeeIds, 7], ignorableEmployeeIds: [...employeeIds, 7], warningFingerprints: ignoredFingerprints,
  });
  review.setBitrixReviewSelectedIds([...employeeIds, 7, 9999]);
  assert.equal(ui.render().bitrixReviewIgnoreSelectedCount, 201);
  assert.equal(ui.render().bitrixReviewBlacklistSelectedCount, 1);
  const content = textOf(renderDialog({ review: ui.render(), data: null, visibleSites: [], mayInspectBitrix24: true, mayCreateEmployees: true, mayUpdateEmployees: true, mayDeleteEmployees: true, error: "" }));
  assert.match(content, /Игнорировать различия \(201\)/);
  assert.match(content, /Записи чёрного списка нельзя игнорировать/);
  await ui.render().acknowledgeBitrixReviewSelection();
  assert.deepEqual(ui.calls.map(call => call.employeeIds), [employeeIds.slice(0, 200), employeeIds.slice(200)]);
  assert.deepEqual(ui.calls[1].warningFingerprints, { [employeeIds[200]]: `fingerprint-${employeeIds[200]}` });
  assert.equal(ui.loaded, 1);
  const result = ui.render().bitrixCheckResult;
  assert.equal(result.totalDifferences, 2);
  assert.deepEqual(result.differenceCounts, { changed: 1, blacklisted_in_bitrix: 1 });
  assert.deepEqual(result.differences.filter(item => !item.acknowledged).map(item => item.localEmployeeId), [11, 7]);
  assert.deepEqual(result.updatableEmployeeIds, [11, 7]);
  assert.equal(result.acknowledgedDifferences, 200);
  assert.match(ui.messages.at(-1), /Не удалось проигнорировать различия у сотрудников: 1/);
});

test("dismissal is selectable for update only with permission to archive", async () => {
  const dismissed = { ...blacklisted, kind: "dismissed_in_bitrix", localEmployeeId: 8 };
  const changed = { ...blacklisted, kind: "changed", localEmployeeId: 9 };
  const extra = { differences: [dismissed, changed], totalDifferences: 2, updatableEmployeeIds: [8, 9], dismissalEmployeeIds: [8], ignorableEmployeeIds: [8, 9] };
  const ui = reviewHarness({ mayDeleteEmployees: false });
  const review = ui.select(dismissed, extra);
  assert.deepEqual(review.bitrixReviewUpdateIdsForAll, [9]);
  assert.deepEqual(review.bitrixReviewSelectableIds, [9, 8]);
  review.setBitrixReviewSelectedIds([8]);
  assert.equal(ui.render().bitrixReviewSelectedCount, 0);
  assert.equal(ui.render().bitrixReviewIgnoreSelectedCount, 1);
  await ui.render().updateBitrixReviewSelection();
  assert.deepEqual(ui.calls, []);
  const permitted = reviewHarness();
  assert.deepEqual(permitted.select(dismissed, extra).bitrixReviewUpdateIdsForAll, [8, 9]);
});
