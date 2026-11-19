import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { serializeSpreadsheetText, parseSpreadsheetText } from "../app/spreadsheetClipboard.ts";
import { isTableSelectAllShortcut, isTableTextEntryTarget } from "../app/tableSelectAllShortcut.ts";
import { excelPreviewClipboardHeaders, excelPreviewClipboardRows } from "../app/excelPreviewClipboardRows.ts";
import { userRoleLabel } from "../app/userAccessModel.ts";
import { PERMISSION_ACTIONS, PERMISSION_ACTION_LABELS, PERMISSION_CATALOG, rolePermissionTemplate } from "../app/permissionModel.ts";

async function declaration(path, name) {
  const url = new URL(path, import.meta.url);
  const source = ts.createSourceFile(url.pathname, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  return ts.transpileModule(node.getText(source).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const hookCode = await declaration("../app/useNativeTableSelectAll.ts", "useNativeTableSelectAll");
const rowShortcutCode = await declaration("../app/tableRowSelectionShortcut.ts", "tableRowSelectionIntent");
const columnShortcutCode = await declaration("../app/tableRowSelectionShortcut.ts", "tableColumnSelectionIntent");
const rowBlockedCode = await declaration("../app/tableRowSelectionShortcut.ts", "isTableRowSelectionBlocked");
const { tableRowSelectionIntent, tableColumnSelectionIntent, isTableRowSelectionBlocked } = new Function("isTableTextEntryTarget", `${rowBlockedCode}\n${rowShortcutCode}\n${columnShortcutCode}; return { tableRowSelectionIntent, tableColumnSelectionIntent, isTableRowSelectionBlocked };`)(isTableTextEntryTarget);
const userCode = await declaration("../app/UserAccessCards.tsx", "userTableClipboardRows");
const permissionCode = await declaration("../app/PermissionMatrix.tsx", "permissionTableClipboardRows");
const userRows = new Function("userRoleLabel", `${userCode};return userTableClipboardRows;`)(userRoleLabel);
const permissionRows = new Function("PERMISSION_ACTIONS", `${permissionCode};return permissionTableClipboardRows;`)(PERMISSION_ACTIONS);
async function constant(path, name, dependencies = {}) {
  const url = new URL(path, import.meta.url);
  const source = ts.createSourceFile(url.pathname, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find(node => node.name.getText(source) === name);
  assert.ok(declaration?.initializer);
  const code = ts.transpileModule(`return (${declaration.initializer.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}
const userHeaders = await constant("../app/UserAccessCards.tsx", "USER_TABLE_CLIPBOARD_HEADERS");
const permissionHeaders = await constant("../app/PermissionMatrix.tsx", "PERMISSION_TABLE_CLIPBOARD_HEADERS", { PERMISSION_ACTIONS, PERMISSION_ACTION_LABELS });

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(kind = "div", parent = null, type = "text") { super(); this.kind = kind; this.parent = parent; this.type = type; this.checked = false; this.focusCount = 0; this.dataset = {}; this.children = []; parent?.children.push(this); }
  closest(selector) {
    const matches = selector.split(",").some(value => value.trim() === this.kind || value.trim() === "input" && this.kind === "input"
      || value.trim() === "[data-native-table-row]" && this.dataset.nativeTableRow !== undefined
      || value.trim() === "[data-native-table-column]" && this.dataset.nativeTableColumn !== undefined || value.trim() === "[role='grid']" && this.role === "grid");
    return matches ? this : this.parent?.closest(selector) ?? null;
  }
  contains(target) { for (let node = target; node; node = node.parent) if (node === this) return true; return false; }
  focus() { this.focusCount++; }
  querySelector(selector) { const index = selector.match(/data-native-table-row="(\d+)"/)?.[1]; return this.children.find(child => child.dataset.nativeTableRow === index) ?? null; }
  scrollIntoView() { this.scrolled = true; }
}
const originalElement = globalThis.Element, originalNode = globalThis.Node;
globalThis.Element = FakeElement; globalThis.Node = FakeNode;
test.after(() => { if (originalElement === undefined) delete globalThis.Element; else globalThis.Element = originalElement; if (originalNode === undefined) delete globalThis.Node; else globalThis.Node = originalNode; });

function harness(initialRows = [["Первый", "1"], ["Второй", "2"]]) {
  const slots = [], listeners = new Map(), root = new FakeElement(), toasts = [];
  root.role = "grid";
  let cursor = 0, dirty = false, pending = [], cleanup = [];
  const options = { rows: initialRows, resetKey: "first", rootRef: { current: root } };
  const document = { addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); } };
  const deps = {
    useRef(value) { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; },
    useMemo: callback => callback(), useCallback: callback => callback,
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; dirty = true; }]; },
    useEffect(callback) { pending.push(callback); }, useLayoutEffect(callback) { pending.push(callback); }, document, Node: FakeNode, Element: FakeElement,
    serializeSpreadsheetText, isTableSelectAllShortcut, isTableTextEntryTarget, tableRowSelectionIntent, tableColumnSelectionIntent, isTableRowSelectionBlocked,
    useTableCopyToast() { return { showCopyToast: message => toasts.push(message), copyToast: "copy-toast" }; },
  };
  const hook = new Function(...Object.keys(deps), `${hookCode};return useNativeTableSelectAll;`)(...Object.values(deps));
  function render() {
    let result, count = 0;
    do { cursor = 0; dirty = false; pending = []; result = hook(options); assert.ok(count++ < 4); } while (dirty);
    cleanup.forEach(callback => callback?.()); cleanup = pending.map(callback => callback());
    return result;
  }
  function event(target = new FakeElement("td", root), fields = {}) {
    const writes = [];
    const result = { target, key: "a", code: "KeyA", ctrlKey: true, metaKey: false, shiftKey: false, button: 0, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      clipboardData: { setData: (...args) => writes.push(args) }, writes, ...fields };
    result.nativeEvent = result; return result;
  }
  return { root, options, render, event, listeners, toasts };
}

function bodyCell(env, rowIndex, columnIndex, control) {
  const row = new FakeElement("tr", env.root); row.dataset.nativeTableRow = String(rowIndex);
  const cell = new FakeElement("td", row); cell.dataset.nativeTableColumn = String(columnIndex);
  return control ? new FakeElement(control, cell, "checkbox") : cell;
}

test("plain cells replace selection; Ctrl and Command add or toggle separate cells without copying gaps", () => {
  for (const modifier of [{ ctrlKey: true }, { ctrlKey: false, metaKey: true }]) {
    const env = harness([["A1", "unselected A2", "A3"], ["unselected row", "hidden", "hidden"], ["C1", "unselected C2", "C3"]]);
    env.options.headers = ["First", "Do not copy", "Last"];
    const choose = (row, column, fields = modifier) => env.render().handlers.onPointerDownCapture(env.event(bodyCell(env, row, column), fields));
    choose(2, 2, { ctrlKey: false });
    choose(0, 0);
    let view = env.render();
    assert.equal(view.className, "native-table-cell-selection");
    assert.equal(view.cellProps(0, 0)["data-native-cell-selected"], true);
    assert.equal(view.cellProps(2, 2)["data-native-cell-selected"], true);
    assert.equal(view.cellProps(0, 2)["data-native-cell-selected"], false);
    let copy = env.event(); view.handlers.onCopyCapture(copy);
    assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["A1", ""], ["", "C3"]]);
    assert.deepEqual(env.toasts, ["Скопировано: 2 × 2"]);
    choose(0, 0);
    copy = env.event(); env.render().handlers.onCopyCapture(copy);
    assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["C3"]]);
    choose(0, 2, { ctrlKey: false });
    view = env.render();
    assert.equal(view.cellProps(2, 2)["data-native-cell-selected"], false);
    copy = env.event(); view.handlers.onCopyCapture(copy);
    assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["A3"]]);
    choose(0, 2);
    assert.equal(env.render().selected, false, "toggling the last cell clears selection");
  }
});

test("grouped visible cells copy only their own fields with blanks at unselected intersections", () => {
  const env = harness([["First", "first@example.invalid", "Viewer", "Active"], ["Second", "second@example.invalid", "Engineer", "Invited"]]);
  env.options.columnGroups = [[0, 1], [2, 3]];
  env.options.headers = userHeaders;
  env.render().handlers.onPointerDownCapture(env.event(bodyCell(env, 1, 1), { ctrlKey: false }));
  env.render().handlers.onPointerDownCapture(env.event(bodyCell(env, 0, 0), { ctrlKey: false, metaKey: true }));
  const copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["First", "first@example.invalid", "", ""], ["", "", "Engineer", "Invited"]]);
  assert.deepEqual(env.toasts, ["Скопировано: 2 × 4"]);
});

test("modifier selection on data-cell controls suppresses opening or toggling while plain controls keep their action", () => {
  for (const control of ["button", "input", "label"]) {
    const env = harness([["Visible", "Да"]]);
    const target = bodyCell(env, 0, 1, control); target.checked = true;
    const pointer = env.event(target, { ctrlKey: false, metaKey: true });
    env.render().handlers.onPointerDownCapture(pointer);
    assert.equal(pointer.defaultPrevented, true, control);
    assert.equal(env.render().cellProps(0, 1)["data-native-cell-selected"], true);
    const click = env.event(target); env.render().handlers.onClickCapture(click);
    const change = env.event(target); env.render().handlers.onChangeCapture(change);
    assert.equal(click.defaultPrevented, true); assert.equal(change.defaultPrevented, true);
    assert.equal(target.checked, true);
    const plain = env.event(target, { ctrlKey: false }); env.render().handlers.onPointerDownCapture(plain);
    assert.equal(plain.defaultPrevented, false); assert.equal(env.render().selected, false);
    const nextClick = env.event(target); env.render().handlers.onClickCapture(nextClick);
    assert.equal(nextClick.defaultPrevented, false);
  }
  const env = harness();
  const action = new FakeElement("input", env.root, "checkbox");
  const pointer = env.event(action); env.render().handlers.onPointerDownCapture(pointer);
  assert.equal(pointer.defaultPrevented, false, "row-action checkboxes lack data-cell metadata");
  assert.equal(env.render().selected, false);
});

test("cell toggles retain whole-row, column and all selection values without exposing a removed cell", () => {
  for (const mode of ["row", "column", "all"]) {
    const env = harness([["A", "B"], ["C", "D"]]); env.options.headers = ["Name", "Hours"];
    const key = mode === "row" ? { key: " ", code: "Space", ctrlKey: false, shiftKey: true }
      : mode === "column" ? { key: " ", code: "Space" } : {};
    env.render().handlers.onKeyDownCapture(env.event(env.root, key));
    env.render().handlers.onPointerDownCapture(env.event(bodyCell(env, 0, 0)));
    const copy = env.event(); env.render().handlers.onCopyCapture(copy);
    assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), mode === "row" ? [["B"]] : mode === "column" ? [["C"]] : [["", "B"], ["C", "D"]]);
    env.render().handlers.onKeyDownCapture(env.event(env.root, { key: "Escape", ctrlKey: false }));
    assert.equal(env.render().selected, false);
  }
});

test("separate cells reset after filtering and do not consume modifier clicks in editors or nested grids", () => {
  const env = harness();
  env.render().handlers.onPointerDownCapture(env.event(bodyCell(env, 0, 0)));
  env.render().handlers.onPointerDownCapture(env.event(bodyCell(env, 1, 1)));
  env.options.rows = [["Filtered", "Visible"]];
  assert.equal(env.render().selected, false);
  const staleCopy = env.event(); env.render().handlers.onCopyCapture(staleCopy); assert.deepEqual(staleCopy.writes, []);
  const cell = bodyCell(env, 0, 0);
  const editor = new FakeElement("input", cell);
  const edit = env.event(editor); env.render().handlers.onPointerDownCapture(edit);
  assert.equal(edit.defaultPrevented, false); assert.equal(env.render().selected, false);
  const nested = new FakeElement("div", cell); nested.role = "grid";
  const nestedCell = new FakeElement("td", nested); nestedCell.dataset.nativeTableRow = "0"; nestedCell.dataset.nativeTableColumn = "0";
  const nestedPointer = env.event(nestedCell); env.render().handlers.onPointerDownCapture(nestedPointer);
  assert.equal(nestedPointer.defaultPrevented, false); assert.equal(env.render().selected, false);
});

test("Shift+Space selects the active body row and copies all columns without headings or checkbox changes", () => {
  const env = harness([["Один", 1], ["Два", 2], ["Три", 3]]);
  env.options.headers = ["Имя", "Часы"];
  const row = new FakeElement("tr", env.root); row.dataset.nativeTableRow = "1";
  const cell = new FakeElement("td", row), checkbox = new FakeElement("input", row, "checkbox"); checkbox.checked = true;
  env.render().handlers.onPointerDownCapture(env.event(cell, { ctrlKey: false }));
  const select = env.event(env.root, { key: " ", code: "Space", ctrlKey: false, shiftKey: true });
  env.render().handlers.onKeyDownCapture(select);
  const view = env.render();
  assert.equal(select.defaultPrevented, true); assert.equal(view.className, "native-table-row-selection");
  assert.equal(view.rowProps(1)["data-native-row-selected"], true); assert.equal(view.rowProps(0)["data-native-row-selected"], false);
  assert.equal(checkbox.checked, true);
  const copy = env.event(); view.handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Два", "2"]]);
  assert.deepEqual(env.toasts, ["Скопировано: 1 × 2"]);
});

test("whole-row keyboard ranges extend, shrink and reverse; Shift-click does not activate row controls", () => {
  const env = harness([["Один", 1], ["Два", 2], ["Три", 3], ["Четыре", 4]]);
  const domRows = env.options.rows.map((_, index) => { const row = new FakeElement("tr", env.root); row.dataset.nativeTableRow = String(index); return row; });
  const key = (key, code = key) => env.event(env.root, { key, code, ctrlKey: false, shiftKey: true });
  env.render().handlers.onKeyDownCapture(env.event(domRows[1], { key: " ", code: "Space", ctrlKey: false, shiftKey: true }));
  env.render().handlers.onKeyDownCapture(key("ArrowDown")); env.render().handlers.onKeyDownCapture(key("ArrowDown"));
  let copy = env.event(); env.render().handlers.onCopyCapture(copy); assert.equal(parseSpreadsheetText(copy.writes[0][1]).length, 3);
  env.render().handlers.onKeyDownCapture(key("ArrowUp"));
  copy = env.event(); env.render().handlers.onCopyCapture(copy); assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Два", "2"], ["Три", "3"]]);
  const input = new FakeElement("input", domRows[0], "checkbox"); input.checked = true;
  const pointer = env.event(input, { ctrlKey: false, shiftKey: true }); env.render().handlers.onPointerDownCapture(pointer);
  assert.equal(pointer.defaultPrevented, true);
  const click = env.event(input); env.render().handlers.onClickCapture(click); assert.equal(click.defaultPrevented, true); assert.equal(click.stopped, true);
  const change = env.event(input); env.render().handlers.onChangeCapture(change); assert.equal(change.stopped, true); assert.equal(input.checked, true);
  copy = env.event(); env.render().handlers.onCopyCapture(copy); assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Один", "1"], ["Два", "2"]]);
  assert.equal(domRows[0].scrolled, true);
  env.render().handlers.onKeyDownCapture(env.event(env.root, { key: "ArrowDown", code: "ArrowDown", ctrlKey: false }));
  assert.equal(env.render().selected, false);
  env.render().handlers.onKeyDownCapture(key(" ", "Space"));
  assert.equal(env.render().rowProps(1)["data-native-row-selected"], true);
});

test("native row ranges reset on filtering and respect empty data, editors and Ctrl+A", () => {
  const env = harness();
  const rowKey = target => env.event(target, { key: " ", code: "Space", ctrlKey: false, shiftKey: true });
  const editor = new FakeElement("input", env.root);
  const ignored = rowKey(editor); env.render().handlers.onKeyDownCapture(ignored); assert.equal(ignored.defaultPrevented, false);
  env.render().handlers.onKeyDownCapture(rowKey(env.root)); assert.equal(env.render().selected, true);
  env.options.rows = [["Новый", 8]]; assert.equal(env.render().selected, false);
  const stale = env.event(); env.render().handlers.onCopyCapture(stale); assert.deepEqual(stale.writes, []);
  env.render().handlers.onKeyDownCapture(rowKey(env.root));
  env.render().handlers.onKeyDownCapture(env.event()); assert.equal(env.render().className, "native-table-select-all");
  env.options.rows = []; env.options.headers = ["Заголовок"];
  const empty = rowKey(env.root); env.render().handlers.onKeyDownCapture(empty); assert.equal(empty.defaultPrevented, true); assert.equal(env.render().selected, false);
});

test("Ctrl+Space copies complete data columns with headers and preserves active row across row/column switching", () => {
  const env = harness([["Один", 1, 10], ["Два", 2, 20], ["Три", 3, 30]]);
  env.options.headers = ["Имя", "Часы", "Всего"];
  const row = new FakeElement("tr", env.root); row.dataset.nativeTableRow = "1";
  const cell = new FakeElement("td", row); cell.dataset.nativeTableColumn = "1";
  env.render().handlers.onPointerDownCapture(env.event(cell, { ctrlKey: false }));
  const columnKey = () => env.event(env.root, { key: " ", code: "Space" });
  env.render().handlers.onKeyDownCapture(columnKey());
  assert.equal(env.render().className, "native-table-column-selection");
  assert.equal(env.render().columnProps(1)["data-native-column-selected"], true);
  let copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Часы"], ["1"], ["2"], ["3"]]);
  env.render().handlers.onKeyDownCapture(env.event(env.root, { key: "ArrowRight", code: "ArrowRight", ctrlKey: false, shiftKey: true }));
  copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Часы", "Всего"], ["1", "10"], ["2", "20"], ["3", "30"]]);
  env.render().handlers.onKeyDownCapture(env.event(env.root, { key: "ArrowLeft", code: "ArrowLeft", ctrlKey: false, shiftKey: true }));
  env.render().handlers.onKeyDownCapture(env.event(env.root, { key: " ", code: "Space", ctrlKey: false, shiftKey: true }));
  copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Два", "2", "20"]], "column-to-row keeps the original active row");
  env.render().handlers.onKeyDownCapture(columnKey());
  copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Часы"], ["1"], ["2"], ["3"]], "row-to-column selects the active data column only");
});

test("native physical column groups copy their matching fields and Shift-click cannot mutate controls", () => {
  const env = harness([["А", "a@example.invalid", "Прораб", "Активен"], ["Б", "b@example.invalid", "Просмотр", "Приглашён"]]);
  env.options.headers = ["ФИО", "Email", "Роль", "Статус"]; env.options.columnGroups = [[0, 1], [2, 3]];
  const row = new FakeElement("tr", env.root); row.dataset.nativeTableRow = "1";
  const cell = new FakeElement("td", row); cell.dataset.nativeTableColumn = "1";
  env.render().handlers.onPointerDownCapture(env.event(cell, { ctrlKey: false }));
  env.render().handlers.onKeyDownCapture(env.event(env.root, { key: " ", code: "Space" }));
  let copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Роль", "Статус"], ["Прораб", "Активен"], ["Просмотр", "Приглашён"]]);
  const firstCell = new FakeElement("td", row); firstCell.dataset.nativeTableColumn = "0";
  const checkbox = new FakeElement("input", firstCell, "checkbox"); checkbox.checked = true;
  env.render().handlers.onPointerDownCapture(env.event(checkbox, { ctrlKey: false, shiftKey: true }));
  const click = env.event(checkbox); env.render().handlers.onClickCapture(click); assert.equal(click.defaultPrevented, true);
  const change = env.event(checkbox); env.render().handlers.onChangeCapture(change); assert.equal(change.stopped, true);
  assert.equal(checkbox.checked, true);
  copy = env.event(); env.render().handlers.onCopyCapture(copy); assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [env.options.headers, ...env.options.rows]);
  env.options.rows = [env.options.rows[1]]; assert.equal(env.render().selected, false, "Filter change clears the column range");
});

test("Ctrl+Space follows an explicitly focused new column instead of retaining an old range", () => {
  const env = harness([["А", 2, 3], ["Б", 4, 5]]); env.options.headers = ["Имя", "Часы", "Всего"];
  env.render().handlers.onKeyDownCapture(env.event(env.root, { key: " ", code: "Space" }));
  env.render().handlers.onKeyDownCapture(env.event(env.root, { key: "ArrowRight", code: "ArrowRight", ctrlKey: false, shiftKey: true }));
  const header = new FakeElement("th", env.root); header.dataset.nativeTableColumn = "2";
  env.render().handlers.onKeyDownCapture(env.event(header, { key: " ", code: "Space" }));
  const copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Всего"], ["3"], ["5"]]);
  assert.equal(env.render().columnProps(0)["data-native-column-selected"], false);
});

test("native Option+Space accepts Mac NBSP and leaves inputs and mixed modifiers untouched", () => {
  const env = harness([["А", 0], ["Б", 8]]); env.options.headers = ["Имя", "Часы"];
  const row = new FakeElement("tr", env.root); row.dataset.nativeTableRow = "1";
  const cell = new FakeElement("td", row); cell.dataset.nativeTableColumn = "1";
  env.render().handlers.onPointerDownCapture(env.event(cell, { ctrlKey: false }));
  const fields = { key: "\u00a0", code: "Space", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true };
  const shortcut = env.event(env.root, fields);
  env.render().handlers.onKeyDownCapture(shortcut);
  assert.equal(shortcut.defaultPrevented, true); assert.equal(shortcut.stopped, true);
  assert.equal(env.render().columnProps(1)["data-native-column-selected"], true);
  const copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Часы"], ["0"], ["8"]]);

  env.render().handlers.onKeyDownCapture(env.event(env.root, { key: "Escape", code: "Escape", ctrlKey: false }));
  for (const overrides of [{ target: new FakeElement("input", env.root) }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    const ignored = env.event(env.root, { ...fields, ...overrides });
    env.render().handlers.onKeyDownCapture(ignored);
    assert.equal(ignored.defaultPrevented, false);
    assert.equal(ignored.stopped, undefined);
    assert.equal(env.render().selected, false);
  }
});

test("empty native columns copy headers and action checkboxes or text inputs do not become data columns", () => {
  const env = harness([]); env.options.headers = ["Зона", "Часы"];
  env.render().handlers.onKeyDownCapture(env.event(env.root, { key: " ", code: "Space" }));
  const copy = env.event(); env.render().handlers.onCopyCapture(copy); assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Зона"]]);
  env.render().handlers.onKeyDownCapture(env.event(env.root, { key: "Escape", code: "Escape", ctrlKey: false }));
  const action = new FakeElement("input", env.root, "checkbox"), editor = new FakeElement("input", env.root);
  const actionKey = env.event(action, { key: " ", code: "Space" }); env.render().handlers.onKeyDownCapture(actionKey);
  assert.equal(actionKey.defaultPrevented, true); assert.equal(env.render().selected, false);
  const editKey = env.event(editor, { key: " ", code: "Space" }); env.render().handlers.onKeyDownCapture(editKey);
  assert.equal(editKey.defaultPrevented, false); assert.equal(env.render().selected, false);
  const mergedHeader = new FakeElement("th", env.root);
  const mergedKey = env.event(mergedHeader, { key: " ", code: "Space" }); env.render().handlers.onKeyDownCapture(mergedKey);
  assert.equal(mergedKey.defaultPrevented, true); assert.equal(env.render().selected, false, "Merged template decorations cannot become a data column");
});

test("native table Ctrl+A and Cmd+A select only its current data and copy a quoted TSV without changing checkboxes", () => {
  for (const key of [{ ctrlKey: true, metaKey: false, key: "ф" }, { ctrlKey: false, metaKey: true }]) {
    const env = harness([["Имя\tс табуляцией", "Две\nстроки"], ["Кавычки \"тут\"", 0]]);
    const checkbox = new FakeElement("input", env.root, "checkbox"); checkbox.checked = true;
    const select = env.event(checkbox, key);
    env.render().handlers.onKeyDownCapture(select);
    assert.equal(select.defaultPrevented, true); assert.equal(checkbox.checked, true);
    const current = env.render(); assert.equal(current.selected, true); assert.equal(current.className, "native-table-select-all");
    const copy = env.event(); current.handlers.onCopyCapture(copy);
    assert.equal(copy.defaultPrevented, true);
    assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Имя\tс табуляцией", "Две\nстроки"], ["Кавычки \"тут\"", "0"]]);
    assert.equal(current.copyToast, "copy-toast");
    assert.deepEqual(env.toasts, ["Скопировано: 2 × 2"]);
  }
});

test("native full selection includes one heading row; ordinary partial text copy is not replaced", () => {
  const env = harness([["Тестовый сотрудник", "visible@example.invalid", "Просмотр", "Активен"]]);
  env.options.headers = userHeaders;
  const partialCopy = env.event(); env.render().handlers.onCopyCapture(partialCopy);
  assert.equal(partialCopy.defaultPrevented, false); assert.deepEqual(partialCopy.writes, []); assert.deepEqual(env.toasts, []);
  env.render().handlers.onKeyDownCapture(env.event());
  const copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [userHeaders, ...env.options.rows]);
  assert.deepEqual(env.toasts, ["Скопировано: 2 × 4"]);
  assert.deepEqual(userHeaders, ["ФИО", "Email", "Роль", "Статус"]);
  env.options.headers = ["Новое название", ...userHeaders.slice(1)];
  assert.equal(env.render().selected, false);
  const staleCopy = env.event(); env.render().handlers.onCopyCapture(staleCopy); assert.deepEqual(staleCopy.writes, []);
  env.options.headers = userHeaders; assert.equal(env.render().selected, false);
});

test("a native table with headings and no data still selects and copies its headings only", () => {
  const env = harness([]); env.options.headers = permissionHeaders;
  env.render().handlers.onKeyDownCapture(env.event()); assert.equal(env.render().selected, true);
  const copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [permissionHeaders]);
  assert.deepEqual(env.toasts, ["Скопировано: 1 × 5"]);
  assert.deepEqual(permissionHeaders, ["Раздел системы", "Просмотр", "Добавление", "Редактирование", "Удаление"]);
});

test("a failed clipboard write never reports a successful copy", () => {
  const env = harness();
  env.render().handlers.onKeyDownCapture(env.event());
  const copy = env.event(undefined, { clipboardData: { setData() { throw new Error("Clipboard unavailable"); } } });
  assert.throws(() => env.render().handlers.onCopyCapture(copy), /Clipboard unavailable/);
  assert.deepEqual(env.toasts, []);
});

test("native table select-all preserves editor, search and popup native selection", () => {
  for (const kind of ["input", "textarea", "select", "[contenteditable]:not([contenteditable='false'])", "[role='searchbox']", ".table-context-menu"]) {
    const env = harness(); const target = new FakeElement(kind, env.root);
    const select = env.event(target); env.render().handlers.onKeyDownCapture(select);
    assert.equal(select.defaultPrevented, false, kind);
    assert.equal(env.render().selected, false);
    const copy = env.event(target); env.render().handlers.onCopyCapture(copy); assert.deepEqual(copy.writes, [], kind); assert.deepEqual(env.toasts, [], kind);
  }
});

test("filter, order, period and enabled changes cannot leave or resurrect an old native selection", () => {
  const env = harness(); const original = env.options.rows;
  env.render().handlers.onKeyDownCapture(env.event()); assert.equal(env.render().selected, true);
  env.options.rows = [original[1]]; assert.equal(env.render().selected, false);
  const copy = env.event(); env.render().handlers.onCopyCapture(copy); assert.deepEqual(copy.writes, []);
  env.options.rows = original; assert.equal(env.render().selected, false);
  env.render().handlers.onKeyDownCapture(env.event());
  env.options.resetKey = "other-period"; assert.equal(env.render().selected, false);
  env.options.resetKey = "first"; assert.equal(env.render().selected, false);
  env.render().handlers.onKeyDownCapture(env.event());
  env.options.enabled = false; assert.equal(env.render().selected, false);
  env.options.enabled = true; assert.equal(env.render().selected, false);
});

test("Escape, focus leaving and outside pointer clear native select-all; empty tables do not select the whole page", () => {
  const env = harness();
  env.render().handlers.onKeyDownCapture(env.event());
  env.render().handlers.onKeyDownCapture(env.event(undefined, { key: "Escape", code: "Escape", ctrlKey: false }));
  assert.equal(env.render().selected, false);
  env.render().handlers.onKeyDownCapture(env.event()); env.render();
  env.listeners.get("pointerdown")({ target: new FakeElement("main") }); assert.equal(env.render().selected, false);
  env.render().handlers.onKeyDownCapture(env.event()); env.render().handlers.onBlurCapture({ relatedTarget: new FakeElement("button") }); assert.equal(env.render().selected, false);
  env.options.rows = []; const empty = env.event(); env.render().handlers.onKeyDownCapture(empty);
  assert.equal(empty.defaultPrevented, true); assert.equal(env.render().selected, false);
  const plainCopy = env.event(); env.render().handlers.onCopyCapture(plainCopy); assert.equal(plainCopy.defaultPrevented, false);
  assert.deepEqual(env.toasts, []);
});

test("user table projection includes visible identity, email, role and status without decorative or hidden data", () => {
  assert.deepEqual(userRows([{ id: 2, fullName: "Видимый сотрудник", email: "visible@example.invalid", role: "viewer", customRoleName: "Наблюдатель", status: "active", assignedSiteId: 7 }]), [["Видимый сотрудник", "visible@example.invalid", "Наблюдатель", "Активен"]]);
});

test("permission matrix projection uses actual allowed checked state, including unsupported and constrained actions", () => {
  const definition = PERMISSION_CATALOG.find(item => item.key === "workers_report");
  const permissions = rolePermissionTemplate("superadmin"); permissions.workers_report.create = false;
  const result = permissionRows([definition], permissions, false, (_resource, action) => ({ allowed: action !== "delete" }));
  assert.deepEqual(result[0], [`${definition.title}\n${definition.description}`, "Да", "Нет", "Да", "—"]);
  assert.deepEqual(permissionRows([definition], permissions, true)[0].slice(0, 1), [definition.title]);
  assert.deepEqual(permissionRows([], permissions, true), []);
});

test("every Excel preview projection copies displayed body values and excludes template metadata", () => {
  const generic = { headers: ["ФИО", "Значение"], rows: [["Тест", ""], ["Другое", "Сложное\nзначение"]], workbook: { kind: "table" } };
  assert.deepEqual(excelPreviewClipboardRows(generic), [[1, "Тест", "—"], [2, "Другое", "Сложное\nзначение"]]);
  assert.deepEqual(excelPreviewClipboardHeaders(generic), ["№", "ФИО", "Значение"]);
  const placement = { headers: ["Дата", "ФИО"], rows: [["2026-11-09", "Тест"]], workbook: { kind: "placement" } };
  assert.deepEqual(excelPreviewClipboardRows(placement), [[new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date("2026-11-09T00:00:00Z")), "Тест"]]);
  assert.deepEqual(excelPreviewClipboardHeaders(placement), ["Дата", "ФИО"]);
  assert.deepEqual(excelPreviewClipboardRows({ ...placement, workbook: { kind: "equipment-placement" } }), excelPreviewClipboardRows(placement));
  const worker = { employmentType: "ОПР", department: "Отдел", fullName: "Тест", position: "Монтажник", positionNote: "Примечание", dailyValues: [0, "В", 8], timesheetHours: 8, reportHours: 6, masters: "Мастер" };
  const personnel = excelPreviewClipboardRows({ workbook: { kind: "personnel-timesheet", dates: ["2026-11-01"], rows: [worker, { ...worker, employmentType: "ИТР" }] } });
  const personnelHeaders = excelPreviewClipboardHeaders({ workbook: { kind: "personnel-timesheet", dates: ["2026-11-01"], rows: [worker] } });
  assert.equal(personnelHeaders.length, personnel[0].length); assert.deepEqual(personnelHeaders.slice(0, 6), ["Тип", "Отдел", "Фамилия, имя, отчество", "Должность", "Примечание к должности", "1"]); assert.deepEqual(personnelHeaders.slice(-3), ["ЧАСЫ", "РАСТ", "Мастер"]);
  assert.equal(personnel[0].length, 39); assert.deepEqual(personnel[0].slice(5, 8), [0, "В", 8]); assert.deepEqual(personnel[0].slice(-3), [8, 2, "Мастер"]); assert.equal(personnel[1].at(-2), 0);
  const equipment = excelPreviewClipboardRows({ workbook: { kind: "equipment-timesheet", dates: ["2026-11-01"], rows: [{ equipmentName: "Кран // Тест // А001", dailyValues: [0, "6 / П 2", "П 8"], dailyProductiveHours: [0, 6, 0], productiveHours: 6, downtimeHours: 2, totalHours: 8, reportHours: 5 }] } });
  const equipmentHeaders = excelPreviewClipboardHeaders({ workbook: { kind: "equipment-timesheet", dates: ["2026-11-01"], rows: [] } });
  assert.equal(equipmentHeaders.length, equipment[0].length); assert.deepEqual(equipmentHeaders.slice(0, 4), ["Тип", "Уникальное наименование единицы", "ГРЗ", "1"]); assert.deepEqual(equipmentHeaders.slice(-3), ["ЧАСЫ", "ПРОСТОЙ", "РАСТ"]);
  assert.equal(equipment[0].length, 37); assert.deepEqual(equipment[0].slice(0, 6), ["Кран", "Кран // Тест // А001", "А001", 0, "6 / П 2", "П 8"]); assert.deepEqual(equipment[0].slice(-3), [6, 2, 3]);
  assert.deepEqual(excelPreviewClipboardRows(null), []);
  assert.deepEqual(excelPreviewClipboardHeaders(null), []);
});
