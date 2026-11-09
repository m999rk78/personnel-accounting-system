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
const textOf = node => typeof node === "string" ? node : Array.isArray(node) ? node.map(textOf).join(" ") : node?.props ? textOf(node.props.children) : "";
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
  const state = [], calls = [], messages = [];
  let cursor = 0, loaded = 0;
  const options = {
    data: null, view: "employees", visibleEmployees: [], visibleSites: [], selectedEmployeeRows: [], employeeDrafts: [], employeeFullRowEditIds: [],
    mayCreateEmployees: true, mayDeleteEmployees: true, mayInspectBitrix24: true, mayUpdateEmployees: true,
    loadData: async () => { loaded++; }, requireSavedExcelRows: () => true, setEmployeePendingDeletes() {},
    setError: message => messages.push(message), setNotice: message => messages.push(message), confirm: async () => true, ...overrides,
  };
  const environment = {
    useState(initial) { const id = cursor++; if (!(id in state)) state[id] = typeof initial === "function" ? initial() : initial; return [state[id], next => { state[id] = typeof next === "function" ? next(state[id]) : next; }]; },
    useRef(initial) { const id = cursor++; state[id] ??= { current: initial }; return state[id]; },
    useMemo: callback => callback(), useEffect() {}, bitrixReviewUpdateIds, bitrixReviewUpdateBatches,
    formatBitrix24Cooldown: () => "", remainingBitrix24Cooldown: () => 0, normalize: value => value.trim().toLocaleLowerCase("ru-RU"),
    async fetch(_url, request) {
      const payload = JSON.parse(request.body); calls.push(payload);
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
  assert.deepEqual(review.selectedBitrixUpdatableEmployees.map(item => item.id), [7]);
  review.setBitrixEmployeeAction({ kind: "update", difference: blacklisted });
  await ui.render().applyBitrixEmployeeAction();
  assert.deepEqual(ui.calls, [{ action: "update-bitrix24-employee", employeeId: 7, bitrix24Id: "B7" }]);
  assert.equal(ui.loaded, 1); assert.equal(ui.render().bitrixCheckResult.status, "ok");
  assert.ok(ui.messages.some(message => typeof message === "string" && message.includes("перенесён в архив")));
});

const dialogFunction = find(dialogSource, node => ts.isFunctionDeclaration(node) && node.name?.text === "BitrixReviewDialogs").getText(dialogSource).replace(/^export\s+/, "");
const renderDialog = new Function("createElement", "Fragment", "CustomSelect", "BitrixReviewEmployeeList", compile(`${dialogLabels}; ${dialogFunction}; return BitrixReviewDialogs;`))(createElement, Fragment, () => null, () => null);
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
  const dismissal = ui.select(dismissed);
  assert.equal(dismissal.canAcknowledgeSelectedBitrixEmployee, true);
  await dismissal.acknowledgeBitrixDifference(dismissed);
  assert.equal(ui.calls.at(-1).action, "acknowledge-bitrix24-difference");
  await ui.render().acknowledgeSelectedBitrixWarnings();
  assert.deepEqual(ui.calls.at(-1), { action: "acknowledge-selected-bitrix24-differences", employeeIds: [8, 9] });
});
