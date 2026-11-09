import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { allSpreadsheetCells, findSpreadsheetDataRowIndex, isStructuralSpreadsheetRow, nativeSpreadsheetSelectionKey, nativeSpreadsheetSelectionValues, spreadsheetDataColumns, spreadsheetDataRowRanges, spreadsheetHeaderValues, spreadsheetPointRowIndex, spreadsheetRangeHasStructuralRows } from "../app/gridSpreadsheetRows.ts";
import { isTableSelectAllShortcut, isTableTextEntryTarget } from "../app/tableSelectAllShortcut.ts";
import { parseSpreadsheetText, serializeSpreadsheetText, stripSpreadsheetHeaderRow } from "../app/spreadsheetClipboard.ts";

const readSource = async path => ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const gridSource = await readSource("../app/GridFilters.tsx");
const workTypesSource = await readSource("../app/WorkTypesTable.tsx");
function find(file, predicate) {
  let result;
  const visit = node => { if (!result && predicate(node)) result = node; if (!result) ts.forEachChild(node, visit); };
  visit(file); assert.ok(result); return result;
}
function declaration(file, name) {
  const node = find(file, node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(file) === name);
  return ts.isVariableDeclaration(node) ? node.initializer.getText(file) : node.getText(file);
}
function bind(expression, environment) {
  const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment));
}
const column = id => ({ getColId: () => id });
function fixture(rows = [{ id: "one", data: { name: "Первый" } }, { id: "two", data: { name: "Второй" } }], ids = ["ag-Grid-SelectionColumn", "name", "hours", "actions"]) {
  const columns = ids.map(column);
  return {
    rows, columns, getAllDisplayedColumns: () => columns, getDisplayedRowCount: () => rows.length,
    getCellRanges: () => [], getFocusedCell: () => null, setGridOption() {},
    getDisplayNameForColumn: (column, location) => { assert.equal(location, "header"); return ({ name: "Наименование", hours: "Часы" })[column.getColId()] ?? column.getColId(); },
    getDisplayedRowAtIndex: index => rows[index], getRowNode: id => { const index = rows.findIndex(row => row.id === id); return index >= 0 ? { ...rows[index], rowIndex: index } : undefined; },
    isDestroyed: () => false, getCellValue: ({ rowNode, colKey, useFormatter }) => {
      assert.equal(useFormatter, true, "copy must preserve the table's date, label and number formatters");
      return rowNode.data[colKey.getColId()];
    },
  };
}
const shortcut = changes => ({ ctrlKey: true, metaKey: false, key: "a", code: "KeyA", ...changes });

test("select-all accepts Ctrl, Cmd, uppercase and physical Russian-layout KeyA, but rejects other shortcuts", () => {
  assert.equal(isTableSelectAllShortcut(shortcut()), true);
  assert.equal(isTableSelectAllShortcut(shortcut({ ctrlKey: false, metaKey: true })), true);
  assert.equal(isTableSelectAllShortcut(shortcut({ key: "A", code: "" })), true);
  assert.equal(isTableSelectAllShortcut(shortcut({ key: "ф" })), true);
  for (const patch of [{ altKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }, { ctrlKey: false }, { key: "c", code: "KeyC" }]) assert.equal(isTableSelectAllShortcut(shortcut(patch)), false);
});

class ElementFixture {
  constructor({ tag = "div", type, popup = false, editor = false, parent } = {}) { Object.assign(this, { tag, type, popup, editor, parent }); }
  closest(selector) {
    if (selector === "input") return this.tag === "input" ? this : this.parent?.closest(selector) ?? null;
    return this.tag === "textarea" || this.tag === "select" || this.popup || this.editor ? this : this.parent?.closest(selector) ?? null;
  }
}
test("native text fields and popup searches own select-all while checkboxes and dialog tables remain selectable", t => {
  const previous = globalThis.Element; globalThis.Element = ElementFixture;
  t.after(() => { if (previous === undefined) delete globalThis.Element; else globalThis.Element = previous; });
  for (const target of [new ElementFixture({ tag: "input", type: "text" }), new ElementFixture({ tag: "input", type: "search" }), new ElementFixture({ tag: "textarea" }), new ElementFixture({ tag: "select" }), new ElementFixture({ editor: true }), new ElementFixture({ popup: true })]) {
    assert.equal(isTableSelectAllShortcut(shortcut({ target })), false);
    assert.equal(isTableTextEntryTarget(target), true);
  }
  for (const target of [new ElementFixture(), new ElementFixture({ tag: "input", type: "checkbox" }), new ElementFixture({ tag: "input", type: "radio" })]) assert.equal(isTableSelectAllShortcut(shortcut({ target })), true);
});

test("select-all uses filtered/displayed model order, includes virtual rows and excludes controls and structural rows", () => {
  const grid = fixture([
    { id: "header", group: true, data: { name: "Структурная дата" } },
    { id: "second", data: { name: "Вторая по сортировке" } },
    { id: "details", detail: true, data: { name: "Не копировать detail" } },
    { id: "first", data: { name: "Первая по сортировке" } },
    { id: "footer", footer: true, data: { name: "Структурный итог" } },
  ]);
  const columns = spreadsheetDataColumns(grid);
  assert.deepEqual(columns.map(value => value.getColId()), ["name", "hours"]);
  assert.deepEqual(allSpreadsheetCells(grid, columns), { start: { rowIndex: 1, rowId: "second", columnId: "name" }, end: { rowIndex: 3, rowId: "first", columnId: "hours" } });
  assert.deepEqual(spreadsheetDataRowRanges(grid), [{ rowStartIndex: 1, rowEndIndex: 1 }, { rowStartIndex: 3, rowEndIndex: 3 }]);
  assert.equal(findSpreadsheetDataRowIndex(grid, 0, 1), 1);
  const huge = fixture(Array.from({ length: 50_000 }, (_, index) => ({ id: String(index), data: { name: index } })));
  assert.equal(allSpreadsheetCells(huge, spreadsheetDataColumns(huge)).end.rowIndex, 49_999, "select-all is independent of mounted DOM rows");
  assert.equal(allSpreadsheetCells(fixture([]), columns), null);
  assert.equal(allSpreadsheetCells(grid, []), null);
});

function localizedHarness({ batch = false, rows, ids } = {}) {
  const api = fixture(rows, ids), selectionRef = { current: null }, lastSelectionRef = { current: null }, dragging = { current: true }, selectionIncludesHeaders = { current: false };
  let selected = null, status = "", focused = 0;
  const environment = { api, selectionRef, lastSelectionRef, dragging, selectionIncludesHeaders, setIncludeSelectedHeaders() {}, isTableSelectAllShortcut, allSpreadsheetCells, spreadsheetDataColumns,
    spreadsheetColumns: grid => spreadsheetDataColumns(grid),
    body: { current: { focus() { focused++; } } },
    onSpreadsheetBatch: batch ? () => { throw new Error("select-all must never write rows"); } : undefined,
    setSelection: value => { selected = value; }, setContextMenu() {}, setSpreadsheetStatus: value => { status = value; },
    isInteractiveTarget: () => false,
  };
  const keydown = bind(declaration(gridSource, "handleSpreadsheetKeyDown"), environment);
  return { api, selectionRef, lastSelectionRef, selectionIncludesHeaders, keydown, get selected() { return selected; }, get status() { return status; }, get focused() { return focused; } };
}
function keyEvent(changes) { const event = { nativeEvent: shortcut(changes), defaultPrevented: false, preventDefault() { this.defaultPrevented = true; this.nativeEvent.defaultPrevented = true; } }; return event; }

test("actual LocalizedGrid handler selects all for editable and read-only catalogs without changing checkbox rows", () => {
  for (const batch of [false, true]) {
    const ui = localizedHarness({ batch });
    const event = keyEvent(); ui.keydown(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(ui.selected.end.rowIndex, 1);
    assert.deepEqual(ui.selectionRef.current, ui.lastSelectionRef.current);
    assert.equal(ui.focused, 1, "move focus off checkbox controls so the following copy event belongs to the range");
    assert.match(ui.status, /Выделены все данные/);
    assert.equal(ui.api.rows.some(row => row.selected), false, "cell ranges never opt employees into bulk edit/delete actions");
  }
  const empty = localizedHarness({ rows: [] }); empty.keydown(keyEvent());
  assert.equal(empty.selected, null); assert.match(empty.status, /Выделены заголовки/);
});

test("actual copy range excludes group/detail rows, honors displayed columns and preserves exact formatted TSV values", () => {
  const api = fixture([
    { id: "group", group: true, data: { name: "Заголовок", hours: 0 } },
    { id: "one", data: { name: "Первый\tсотрудник", hours: "02.11.2026" } },
    { id: "detail", detail: true, data: { name: "Дублированная карточка", hours: 99 } },
    { id: "two", data: { name: "Второй\nсотрудник", hours: "7,5" } },
  ], ["name", "hours", "actions"]);
  const selectionRef = { current: allSpreadsheetCells(api, spreadsheetDataColumns(api)) };
  const spreadsheetBounds = bind(declaration(gridSource, "spreadsheetBounds"), { spreadsheetColumns: spreadsheetDataColumns, spreadsheetPointRowIndex });
  const callback = find(gridSource, node => ts.isVariableDeclaration(node) && node.name.getText(gridSource) === "selectedText").initializer.arguments[0].getText(gridSource);
  const selectedText = bind(callback, { api, selectionRef, spreadsheetBounds, serializeSpreadsheetText, isStructuralSpreadsheetRow, selectionIncludesHeaders: { current: false }, lastHeaderClipboard: { current: null }, spreadsheetHeaderValues, spreadsheetColumns: spreadsheetDataColumns });
  assert.deepEqual(parseSpreadsheetText(selectedText()), [["Первый\tсотрудник", "02.11.2026"], ["Второй\nсотрудник", "7,5"]]);
});

test("actual WorkTypes native-grid select-all respects nested ownership and selects only data ranges", t => {
  const previous = globalThis.Element; globalThis.Element = ElementFixture;
  t.after(() => { if (previous === undefined) delete globalThis.Element; else globalThis.Element = previous; });
  const attr = find(workTypesSource, node => ts.isJsxAttribute(node) && node.name.getText(workTypesSource) === "onKeyDownCapture");
  const api = fixture([{ id: "first", data: {} }, { id: "detail", data: {}, detail: true }, { id: "second", data: {} }]);
  const calls = [];
  Object.assign(api, { isModuleRegistered: () => true, clearCellSelection: () => calls.push("clear"), addCellRange: value => calls.push(value), setFocusedCell: (...value) => calls.push(value) });
  const handler = bind(attr.initializer.expression.getText(workTypesSource), { api, spreadsheetDataColumns, spreadsheetDataRowRanges, isTableSelectAllShortcut, Element: ElementFixture, selectionIncludesHeaders: { current: null }, nativeSpreadsheetSelectionKey, paintSelectedHeaders() {} });
  const shell = new ElementFixture(); shell.closest = selector => selector === ".work-types-master-grid,.work-types-detail-grid" ? shell : ElementFixture.prototype.closest.call(shell, selector);
  const event = { ...keyEvent(), target: shell, currentTarget: shell, stopPropagation() { this.stopped = true; } };
  handler(event);
  assert.equal(event.stopped, true); assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls.slice(1, 3).map(call => [call.rowStartIndex, call.rowEndIndex]), [[0, 0], [2, 2]]);
  assert.deepEqual(calls[1].columns.map(column => column.getColId()), ["name", "hours"]);
  calls.length = 0;
  handler({ ...keyEvent(), target: shell, currentTarget: new ElementFixture(), stopPropagation() { throw new Error("master must not consume a nested detail shortcut"); } });
  assert.deepEqual(calls, []);
});

test("native range copy merges selected cells in displayed order and preserves formatted values without structural duplicates", () => {
  const api = fixture([
    { id: "first", data: { name: "Перевозка\tперсонала", hours: "2,5" } },
    { id: "detail", detail: true, data: { name: "Не копировать повторно", hours: 99 } },
    { id: "second", data: { name: "Уборка\nтерритории", hours: "8" } },
    { id: "footer", footer: true, data: { name: "Итого", hours: 10 } },
  ]);
  api.getCellRanges = () => [{ startRow: { rowIndex: 3 }, endRow: { rowIndex: 0 }, columns: api.columns }];
  api.getFocusedCell = () => null;
  const matrix = nativeSpreadsheetSelectionValues(api);
  assert.deepEqual(matrix, [["Перевозка\tперсонала", "2,5"], ["Уборка\nтерритории", "8"]]);
  assert.deepEqual(parseSpreadsheetText(serializeSpreadsheetText(matrix)), matrix);
  api.getCellRanges = () => [
    { startRow: { rowIndex: 2 }, endRow: { rowIndex: 2 }, columns: [api.columns[2]] },
    { startRow: { rowIndex: 0 }, endRow: { rowIndex: 0 }, columns: [api.columns[1]] },
  ];
  assert.deepEqual(nativeSpreadsheetSelectionValues(api), [["Перевозка\tперсонала", ""], ["", "8"]]);
  api.getCellRanges = () => [];
  api.getFocusedCell = () => ({ rowIndex: 2, column: api.columns[1] });
  assert.deepEqual(nativeSpreadsheetSelectionValues(api), [["Уборка\nтерритории"]]);
  api.getFocusedCell = () => ({ rowIndex: 0, column: api.columns[0] });
  assert.equal(nativeSpreadsheetSelectionValues(api), null, "checkbox controls are not clipboard values");
});

test("actual WorkTypes copy shortcut preserves the browser copy event instead of depending on navigator.clipboard", t => {
  const previous = globalThis.Element; globalThis.Element = ElementFixture;
  t.after(() => { if (previous === undefined) delete globalThis.Element; else globalThis.Element = previous; });
  const attr = find(workTypesSource, node => ts.isJsxAttribute(node) && node.name.getText(workTypesSource) === "onKeyDownCapture");
  const handler = bind(attr.initializer.expression.getText(workTypesSource), { isTableSelectAllShortcut, isTableTextEntryTarget, Element: ElementFixture });
  const shell = new ElementFixture(); shell.closest = selector => selector === ".work-types-master-grid,.work-types-detail-grid" ? shell : ElementFixture.prototype.closest.call(shell, selector);
  for (const modifier of [{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }]) {
    const event = { ...keyEvent(), ...modifier, key: "c", code: "KeyC", target: shell, currentTarget: shell, stopPropagation() { this.stopped = true; } };
    event.nativeEvent = { ...event.nativeEvent, ...modifier, key: "c", code: "KeyC", target: shell };
    handler(event);
    assert.equal(event.stopped, true, "the native AG key listener must not cancel copy");
    assert.equal(event.defaultPrevented, false, "the browser must dispatch its real copy event");
  }
});

test("actual WorkTypes copy event writes selected model data to clipboardData and leaves editors and nested ownership alone", t => {
  const previous = globalThis.Element; globalThis.Element = ElementFixture;
  t.after(() => { if (previous === undefined) delete globalThis.Element; else globalThis.Element = previous; });
  const attr = find(workTypesSource, node => ts.isJsxAttribute(node) && node.name.getText(workTypesSource) === "onCopyCapture");
  const api = fixture(Array.from({ length: 404 }, (_, index) => ({ id: String(index), data: { name: `Вид ${index + 1}`, hours: index } })));
  api.isModuleRegistered = () => true;
  api.getCellRanges = () => [{ startRow: { rowIndex: 0 }, endRow: { rowIndex: 403 }, columns: api.columns }];
  api.getFocusedCell = () => null;
  const handler = bind(attr.initializer.expression.getText(workTypesSource), { api, isTableTextEntryTarget, nativeSpreadsheetSelectionValues, serializeSpreadsheetText, Element: ElementFixture, selectionIncludesHeaders: { current: null }, lastHeaderClipboard: { current: null } });
  const shell = new ElementFixture(); shell.closest = selector => selector === ".work-types-master-grid,.work-types-detail-grid" ? shell : ElementFixture.prototype.closest.call(shell, selector);
  const copy = (target = shell, currentTarget = shell) => ({ target, currentTarget, defaultPrevented: false,
    clipboardData: { values: {}, setData(type, value) { this.values[type] = value; } },
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
  });
  const event = copy(); handler(event);
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  const matrix = parseSpreadsheetText(event.clipboardData.values["text/plain"]);
  assert.equal(matrix.length, 404, "copy includes virtual rows beyond the mounted viewport");
  assert.deepEqual(matrix[403], ["Вид 404", "403"]);
  for (const skipped of [copy(new ElementFixture({ tag: "textarea" })), copy(new ElementFixture({ popup: true })), copy(shell, new ElementFixture())]) {
    handler(skipped);
    assert.equal(skipped.defaultPrevented, false);
    assert.deepEqual(skipped.clipboardData.values, {});
  }
});

test("explicit LocalizedGrid select-all copies headers while an identical manual body range remains data-only", () => {
  const ui = localizedHarness(); ui.keydown(keyEvent());
  const spreadsheetBounds = bind(declaration(gridSource, "spreadsheetBounds"), { spreadsheetColumns: spreadsheetDataColumns, spreadsheetPointRowIndex });
  const callback = find(gridSource, node => ts.isVariableDeclaration(node) && node.name.getText(gridSource) === "selectedText").initializer.arguments[0].getText(gridSource);
  const selectedText = bind(callback, { api: ui.api, selectionRef: ui.selectionRef, selectionIncludesHeaders: ui.selectionIncludesHeaders, lastHeaderClipboard: { current: null }, spreadsheetBounds, spreadsheetColumns: spreadsheetDataColumns, spreadsheetHeaderValues, serializeSpreadsheetText, isStructuralSpreadsheetRow });
  assert.deepEqual(parseSpreadsheetText(selectedText()), [["Наименование", "Часы"], ["Первый", ""], ["Второй", ""]]);
  ui.selectionIncludesHeaders.current = false;
  assert.deepEqual(parseSpreadsheetText(selectedText()), [["Первый", ""], ["Второй", ""]], "same body bounds do not imply header inclusion");
  const empty = localizedHarness({ rows: [] }); empty.keydown(keyEvent());
  const emptyText = bind(callback, { api: empty.api, selectionRef: empty.selectionRef, selectionIncludesHeaders: empty.selectionIncludesHeaders, lastHeaderClipboard: { current: null }, spreadsheetBounds, spreadsheetColumns: spreadsheetDataColumns, spreadsheetHeaderValues, serializeSpreadsheetText, isStructuralSpreadsheetRow });
  assert.deepEqual(parseSpreadsheetText(emptyText()), [["Наименование", "Часы"]]);
  assert.equal(empty.selectionRef.current, null, "header-only selection never creates a fake editable body point");
});

test("actual LocalizedGrid paste strips an exact full copied header and never creates a row for header-only empty selection", () => {
  const ui = localizedHarness(); ui.keydown(keyEvent());
  const batches = [];
  const spreadsheetBounds = bind(declaration(gridSource, "spreadsheetBounds"), { spreadsheetColumns: spreadsheetDataColumns, spreadsheetPointRowIndex });
  const callback = find(gridSource, node => ts.isVariableDeclaration(node) && node.name.getText(gridSource) === "pasteText").initializer.arguments[0].getText(gridSource);
  const environment = { api: ui.api, selectionRef: ui.selectionRef, selectionIncludesHeaders: ui.selectionIncludesHeaders, lastHeaderClipboard: { current: null }, serializeSpreadsheetText, onSpreadsheetPaste: undefined, onSpreadsheetBatch: batch => { batches.push(batch); return true; },
    spreadsheetBounds, spreadsheetColumns: spreadsheetDataColumns, spreadsheetHeaderValues, parseSpreadsheetText, stripSpreadsheetHeaderRow,
    spreadsheetRangeHasStructuralRows, setSpreadsheetStatus() {}, body: { current: { focus() {} } },
  };
  const paste = bind(callback, environment);
  assert.equal(paste("Наименование\tЧасы\nПервый\t8\nВторой\t6"), true);
  assert.deepEqual(batches[0].rows.map(row => row.values), [{ name: "Первый", hours: "8" }, { name: "Второй", hours: "6" }]);
  assert.equal(batches[0].rows.length, 2, "no heading is passed to the mutation handler");
  const empty = localizedHarness({ rows: [] }); empty.keydown(keyEvent());
  const emptyPaste = bind(callback, { ...environment, api: empty.api, selectionRef: empty.selectionRef });
  assert.equal(emptyPaste("Наименование\tЧасы"), false);
  assert.equal(batches.length, 1);
});

test("native full selection includes one flat visible header row, including empty tables, and exact paste matching preserves ordinary inputs", () => {
  const api = fixture(); api.getCellRanges = () => [{ startRow: { rowIndex: 0 }, endRow: { rowIndex: 1 }, columns: api.columns }];
  assert.deepEqual(nativeSpreadsheetSelectionValues(api, { includeHeaders: true })[0], ["Наименование", "Часы"]);
  assert.equal(nativeSpreadsheetSelectionValues(api).length, 2);
  const empty = fixture([]);
  assert.deepEqual(nativeSpreadsheetSelectionValues(empty, { includeHeaders: true }), [["Наименование", "Часы"]]);
  assert.equal(nativeSpreadsheetSelectionValues(empty), null);
  const attrs = find(workTypesSource, node => ts.isJsxAttribute(node) && node.name.getText(workTypesSource) === "processDataFromClipboard");
  const marker = { current: "explicit-all" };
  const paste = bind(attrs.initializer.expression.getText(workTypesSource), { selectionIncludesHeaders: marker, lastHeaderClipboard: { current: null }, serializeSpreadsheetText, stripSpreadsheetHeaderRow, spreadsheetHeaderValues, spreadsheetDataColumns });
  assert.equal(paste({ api: empty, data: [["Наименование", "Часы"]] }), null);
  marker.current = null;
  assert.deepEqual(paste({ api: empty, data: [["Наименование", "Часы"]] }), [["Наименование", "Часы"]]);
  marker.current = "explicit-all";
  assert.deepEqual(paste({ api, data: [["Наименование", "Часы"], ["Работа", "6"]] }), [["Работа", "6"]]);
  assert.deepEqual(stripSpreadsheetHeaderRow([["Наименование"], ["Работа"]], ["Наименование", "Часы"]), [["Наименование"], ["Работа"]]);
});

test("WorkTypes header paint touches only its own data headers and manual range changes clear the explicit marker", () => {
  const api = fixture(), marker = { current: "all" }, toggles = [];
  const root = { querySelectorAll: () => headers }, nested = {};
  const headers = [
    { closest: () => root, getAttribute: () => "name", classList: { toggle: (...value) => toggles.push(["own", ...value]) } },
    { closest: () => root, getAttribute: () => "ag-Grid-SelectionColumn", classList: { toggle: (...value) => toggles.push(["checkbox", ...value]) } },
    { closest: () => nested, getAttribute: () => "name", classList: { toggle: () => { throw new Error("parent selection must not paint nested detail headers"); } } },
  ];
  const callback = find(workTypesSource, node => ts.isVariableDeclaration(node) && node.name.getText(workTypesSource) === "paintSelectedHeaders").initializer.arguments[0].getText(workTypesSource);
  const paint = bind(callback, { gridElement: { current: root }, selectionIncludesHeaders: marker, spreadsheetDataColumns, requestAnimationFrame: fn => fn() });
  paint(api);
  assert.deepEqual(toggles, [["own", "ag-excel-header-selected", true], ["checkbox", "ag-excel-header-selected", false]]);
  const attrs = find(workTypesSource, node => ts.isJsxAttribute(node) && node.name.getText(workTypesSource) === "onCellSelectionChanged");
  let cleared = 0;
  const changed = bind(attrs.initializer.expression.getText(workTypesSource), { selectionIncludesHeaders: marker, nativeSpreadsheetSelectionKey,
    clearSelectedHeaders() { marker.current = null; cleared++; }, paintSelectedHeaders() {},
  });
  changed({ api }); assert.equal(cleared, 1);
  marker.current = nativeSpreadsheetSelectionKey(api); changed({ api }); assert.equal(cleared, 1, "queued native select-all notifications do not clear a current explicit marker");
});

test("shared paste preserves body rows equal to a header and strips only a marked or exact own header-copy payload", () => {
  const api = fixture([{ id: "one", data: { name: "Подвид работы" } }, { id: "two", data: { name: "Монтаж" } }], ["name"]);
  api.getDisplayNameForColumn = () => "Подвид работы";
  const selectionRef = { current: allSpreadsheetCells(api, spreadsheetDataColumns(api)) }, selectionIncludesHeaders = { current: false }, lastHeaderClipboard = { current: null };
  const spreadsheetBounds = bind(declaration(gridSource, "spreadsheetBounds"), { spreadsheetColumns: spreadsheetDataColumns, spreadsheetPointRowIndex });
  const selectedCallback = find(gridSource, node => ts.isVariableDeclaration(node) && node.name.getText(gridSource) === "selectedText").initializer.arguments[0].getText(gridSource);
  const selectedText = bind(selectedCallback, { api, selectionRef, selectionIncludesHeaders, lastHeaderClipboard, spreadsheetBounds, spreadsheetColumns: spreadsheetDataColumns, spreadsheetHeaderValues, serializeSpreadsheetText, isStructuralSpreadsheetRow });
  const batches = [];
  const pasteCallback = find(gridSource, node => ts.isVariableDeclaration(node) && node.name.getText(gridSource) === "pasteText").initializer.arguments[0].getText(gridSource);
  const paste = bind(pasteCallback, { api, selectionRef, selectionIncludesHeaders, lastHeaderClipboard, spreadsheetBounds,
    onSpreadsheetPaste: undefined, onSpreadsheetBatch: batch => { batches.push(batch); return true; },
    spreadsheetColumns: spreadsheetDataColumns, spreadsheetHeaderValues, parseSpreadsheetText, serializeSpreadsheetText, stripSpreadsheetHeaderRow,
    spreadsheetRangeHasStructuralRows, setSpreadsheetStatus() {}, body: { current: { focus() {} } },
  });
  const bodyCopy = selectedText();
  assert.equal(bodyCopy, "Подвид работы\nМонтаж");
  paste(bodyCopy);
  assert.deepEqual(batches.at(-1).rows.map(row => row.values.name), ["Подвид работы", "Монтаж"]);
  selectionIncludesHeaders.current = true;
  const headerCopy = selectedText();
  assert.equal(headerCopy, "Подвид работы\nПодвид работы\nМонтаж");
  selectionIncludesHeaders.current = false; // Clicking a different paste target must not lose known own header metadata.
  paste(headerCopy);
  assert.deepEqual(batches.at(-1).rows.map(row => row.values.name), ["Подвид работы", "Монтаж"]);
  selectedText();
  assert.equal(lastHeaderClipboard.current, null, "a subsequent ordinary body copy clears the header token");
  paste(bodyCopy);
  assert.deepEqual(batches.at(-1).rows.map(row => row.values.name), ["Подвид работы", "Монтаж"]);
});

test("actual WorkTypes copy/paste retains legitimate header-valued rows and recognizes only its own marked header payload", t => {
  const previous = globalThis.Element; globalThis.Element = ElementFixture;
  t.after(() => { if (previous === undefined) delete globalThis.Element; else globalThis.Element = previous; });
  const api = fixture([{ id: "one", data: { name: "Подвид работы" } }, { id: "two", data: { name: "Монтаж" } }], ["name"]);
  api.getDisplayNameForColumn = () => "Подвид работы"; api.isModuleRegistered = () => true;
  api.getCellRanges = () => [{ startRow: { rowIndex: 0 }, endRow: { rowIndex: 1 }, columns: api.columns }];
  const selectionIncludesHeaders = { current: null }, lastHeaderClipboard = { current: "old-header-copy" };
  const environment = { api, selectionIncludesHeaders, lastHeaderClipboard, isTableTextEntryTarget, nativeSpreadsheetSelectionValues, serializeSpreadsheetText, Element: ElementFixture, stripSpreadsheetHeaderRow, spreadsheetHeaderValues, spreadsheetDataColumns };
  const copyAttr = find(workTypesSource, node => ts.isJsxAttribute(node) && node.name.getText(workTypesSource) === "onCopyCapture");
  const pasteAttr = find(workTypesSource, node => ts.isJsxAttribute(node) && node.name.getText(workTypesSource) === "processDataFromClipboard");
  const copy = bind(copyAttr.initializer.expression.getText(workTypesSource), environment), paste = bind(pasteAttr.initializer.expression.getText(workTypesSource), environment);
  const shell = new ElementFixture(); shell.closest = selector => selector === ".work-types-master-grid,.work-types-detail-grid" ? shell : ElementFixture.prototype.closest.call(shell, selector);
  let text;
  const event = () => ({ target: shell, currentTarget: shell, clipboardData: { setData(_type, value) { text = value; } }, preventDefault() {}, stopPropagation() {} });
  copy(event()); assert.equal(lastHeaderClipboard.current, null);
  assert.deepEqual(paste({ api, data: parseSpreadsheetText(text) }), [["Подвид работы"], ["Монтаж"]]);
  selectionIncludesHeaders.current = "explicit-all";
  copy(event()); assert.equal(text, "Подвид работы\nПодвид работы\nМонтаж");
  selectionIncludesHeaders.current = null;
  assert.deepEqual(paste({ api, data: parseSpreadsheetText(text) }), [["Подвид работы"], ["Монтаж"]]);
  copy(event()); assert.equal(lastHeaderClipboard.current, null);
  assert.deepEqual(paste({ api, data: [["Подвид работы"], ["Другие работы"]] }), [["Подвид работы"], ["Другие работы"]]);
});

test("an outside click clears an explicit header-only selection even without a body cell", () => {
  const selectionIncludesHeaders = { current: true };
  let cleared = 0;
  const outside = bind(declaration(gridSource, "clearSelectionOutsideGrid"), { selectionRef: { current: null }, selectionIncludesHeaders,
    body: { current: { contains: () => false } }, Node: ElementFixture, Element: ElementFixture,
    clearSelection() { selectionIncludesHeaders.current = false; cleared++; },
  });
  outside({ target: new ElementFixture() });
  assert.equal(cleared, 1); assert.equal(selectionIncludesHeaders.current, false);
  outside({ target: new ElementFixture() }); assert.equal(cleared, 1);
});
