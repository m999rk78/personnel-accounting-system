import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement, Fragment, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const path = new URL("../app/BitrixReviewEmployeeList.tsx", import.meta.url);
const source = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "BitrixReviewEmployeeList");
assert.ok(declaration);
const code = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement", jsxFragmentFactory: "Fragment" },
}).outputText;
const compileList = useState => new Function("createElement", "Fragment", "useRef", "useEffect", "useState", `const BITRIX_REVIEW_PAGE_SIZE = 100; ${code}; return BitrixReviewEmployeeList;`)(
  createElement, Fragment, current => ({ current }), () => {}, useState,
);
const renderList = compileList(initial => [initial, () => {}]);

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

const missing = { kind: "missing_locally", bitrix24Id: "B1", employeeName: "Новый сотрудник" };
const changed = { kind: "changed", bitrix24Id: "B7", localEmployeeId: 7, employeeName: "Нужно обновить" };
const accepted = { kind: "changed", bitrix24Id: "B8", localEmployeeId: 8, employeeName: "Уже подтверждено", acknowledged: true };
const checkboxes = tree => elements(tree, node => node.type === "input" && node.props.type === "checkbox");
const rowButtons = tree => elements(tree, node => node.type === "button");
const listProps = {
  differences: [missing], total: 1, updateIds: [], selectedIds: [], activeIndex: 0, canUpdate: true, busy: false,
  getLabel: item => item.kind, onSelect() {}, onActiveChange() {},
};

test("unlinked employees have clickable detail rows but no dead bulk selection controls", () => {
  let activeIndex = 0;
  const differences = [missing, { ...missing, bitrix24Id: "B2", employeeName: "Другой сотрудник" }];
  const render = () => renderList({ ...listProps, differences, total: 2, activeIndex, onActiveChange: index => { activeIndex = index; } });
  const tree = render();
  const html = renderToStaticMarkup(tree);
  assert.doesNotMatch(html, /type="checkbox"|Выбрать всех/);
  assert.match(html, /Сотрудники/);
  assert.match(html, /Новый сотрудник/);
  assert.match(html, /Другой сотрудник/);
  const buttons = rowButtons(tree);
  assert.deepEqual(buttons.map(button => button.props["aria-pressed"]), [true, false]);
  buttons[1].props.onClick();
  assert.deepEqual(rowButtons(render()).map(button => button.props["aria-pressed"]), [false, true]);
});

test("mixed review selects only updatable employees, including eligible IDs outside the preview", () => {
  let selectedIds = [9];
  const props = { ...listProps, differences: [missing, changed, accepted], total: 4, updateIds: [7, 9], onSelect: ids => { selectedIds = ids; } };
  const render = extra => renderList({ ...props, selectedIds, ...extra });
  const tree = render();
  assert.equal(rowButtons(tree).length, 3);
  const [header, row, ...others] = checkboxes(tree);
  assert.deepEqual(others, []);
  assert.match(header.props["aria-label"], /Выбрать всех/);
  assert.match(row.props["aria-label"], /Нужно обновить/);
  assert.ok(!header.props.disabled && !row.props.disabled);
  assert.equal(header.props.checked, false);
  assert.equal(row.props.checked, false);
  header.props.onChange({ target: { checked: true } });
  assert.deepEqual(selectedIds, [7, 9]);
  const [selectedHeader, selectedRow] = checkboxes(render());
  assert.equal(selectedHeader.props.checked, true);
  assert.equal(selectedRow.props.checked, true);
  selectedRow.props.onChange({ target: { checked: false } });
  assert.deepEqual(selectedIds, [9]);
  checkboxes(render())[1].props.onChange({ target: { checked: true } });
  assert.deepEqual(selectedIds, [9, 7]);
  checkboxes(render())[0].props.onChange({ target: { checked: false } });
  assert.deepEqual(selectedIds, []);
  assert.deepEqual(checkboxes(render({ busy: true })).map(control => control.props.disabled), [true, true]);
  assert.deepEqual(checkboxes(render({ canUpdate: false })), []);
});

test("dismissal and ignore-only warnings are both selectable, with distinct purposes", () => {
  const dismissal = { kind: "dismissed_in_bitrix", localEmployeeId: 9, bitrix24Id: "B9", employeeName: "Уволенный" };
  const ignoreOnly = { kind: "incomplete", localEmployeeId: 10, bitrix24Id: "B10", employeeName: "Неполные данные" };
  let selected = [];
  const tree = renderList({
    ...listProps, differences: [changed, dismissal, ignoreOnly], total: 3, updateIds: [7, 9, 10], applyIds: [7, 9],
    onSelect: ids => { selected = ids; },
  });
  const [header, changedRow, dismissedRow, ignoreOnlyRow] = checkboxes(tree);
  assert.equal(header.props["aria-label"], "Выбрать всех с различиями");
  assert.equal(changedRow.props["aria-label"], "Обновить из Битрикс24: Нужно обновить");
  assert.equal(dismissedRow.props["aria-label"], "Архивировать по данным Битрикс24: Уволенный");
  assert.equal(ignoreOnlyRow.props["aria-label"], "Игнорировать различие: Неполные данные");
  header.props.onChange({ target: { checked: true } });
  assert.deepEqual(selected, [7, 9, 10]);
});

test("matching mode selects only exact matches, including rows outside the visible page", () => {
  const matches = Array.from({ length: 112 }, (_, index) => ({
    kind: "missing_locally", bitrix24Id: `MATCH-${index}`, employeeName: `Точное совпадение ${index + 1}`,
  }));
  const eligibleIds = matches.map(item => item.bitrix24Id);
  const differences = [missing, changed, ...matches];
  let selectedIds = [];
  const render = (extra = {}) => renderList({
    ...listProps, differences, total: differences.length, updateIds: [7],
    onSelect() { assert.fail("Matching mode must not change the update selection"); },
    linkSelection: { eligibleIds, selectedIds, onSelect: ids => { selectedIds = ids; } },
    ...extra,
  });
  const tree = render();
  const [header, first, ...otherRows] = checkboxes(tree);
  assert.equal(header.props["aria-label"], "Выбрать всех для сопоставления с Битрикс24");
  assert.equal(first.props["aria-label"], "Сопоставить с Битрикс24: Точное совпадение 1");
  assert.equal(otherRows.length, 97);
  assert.equal(first.props.checked, false);
  first.props.onChange({ target: { checked: true } });
  assert.deepEqual(selectedIds, [eligibleIds[0]]);
  assert.equal(checkboxes(render())[0].props.checked, false);
  header.props.onChange({ target: { checked: true } });
  assert.deepEqual(selectedIds, eligibleIds, "Select all covers the complete set, not only visible rows");
  const [allChecked, firstChecked] = checkboxes(render());
  assert.equal(allChecked.props.checked, true);
  assert.equal(firstChecked.props.checked, true);
  firstChecked.props.onChange({ target: { checked: false } });
  assert.deepEqual(selectedIds, eligibleIds.slice(1));
  checkboxes(render())[0].props.onChange({ target: { checked: false } });
  assert.deepEqual(selectedIds, []);
  assert.ok(checkboxes(render({ busy: true })).every(control => control.props.disabled));
  assert.deepEqual(checkboxes(render({ canUpdate: false })), []);
});

test("matching mode selects eligible archive transfers together with exact matches, never ambiguous proposals", () => {
  const exact = { ...missing, bitrix24Id: "EXACT", employeeName: "Точное совпадение" };
  const archive = { ...missing, bitrix24Id: "ARCHIVE", employeeName: "Сотрудник с одним кандидатом" };
  const ambiguous = { ...missing, bitrix24Id: "AMBIGUOUS", employeeName: "Сотрудник с несколькими кандидатами" };
  const outsidePage = Array.from({ length: 100 }, (_, index) => ({ ...missing, bitrix24Id: `OTHER-${index}` }));
  const hiddenArchive = { ...archive, bitrix24Id: "HIDDEN-ARCHIVE" };
  const eligibleIds = [exact.bitrix24Id, archive.bitrix24Id, hiddenArchive.bitrix24Id];
  const archiveIds = [archive.bitrix24Id, hiddenArchive.bitrix24Id, ambiguous.bitrix24Id];
  const differences = [exact, archive, ambiguous, changed, ...outsidePage, hiddenArchive];
  let selectedIds = [];
  const render = () => renderList({
    ...listProps, differences, total: differences.length, updateIds: [7],
    onSelect() { assert.fail("Matching must not select employee data updates"); },
    linkSelection: { eligibleIds, selectedIds, archiveIds, onSelect: ids => { selectedIds = ids; } },
  });
  const tree = render();
  const controls = checkboxes(tree);
  assert.deepEqual(controls.map(input => input.props["aria-label"]), [
    "Выбрать всех для сопоставления с Битрикс24",
    "Сопоставить с Битрикс24: Точное совпадение",
    "Перенести связь из архива: Сотрудник с одним кандидатом",
  ]);
  const titles = elements(tree, node => node.type === "label").map(label => label.props.title);
  assert.match(titles[0], /точные совпадения.*архива.*за пределами/);
  assert.equal(titles[2], "Выбрать для переноса связи из архива");
  controls[2].props.onChange({ target: { checked: true } });
  assert.deepEqual(selectedIds, [archive.bitrix24Id]);
  controls[0].props.onChange({ target: { checked: true } });
  assert.deepEqual(selectedIds, eligibleIds, "Includes off-screen archive links and excludes ambiguous rows");
  assert.ok(checkboxes(render()).every(input => input.props.checked));
});

test("all discrepancy rows can be opened in batches of 100 without affecting full bulk selection", () => {
  let limit = 100;
  const list = compileList(() => [limit, next => { limit = next; }]);
  const differences = Array.from({ length: 113 }, (_, index) => ({ ...missing, bitrix24Id: `B${index}` }));
  const props = { ...listProps, differences, total: differences.length };
  let tree = list(props);
  assert.equal(elements(tree, node => node.props.role === "listitem").length, 100);
  const more = elements(tree, node => node.type === "button" && node.props.children[0] === "Показать ещё ")[0];
  assert.ok(more);
  more.props.onClick();
  tree = list(props);
  assert.equal(elements(tree, node => node.props.role === "listitem").length, 113);
  assert.doesNotMatch(renderToStaticMarkup(tree), /Показать ещё/);
});
