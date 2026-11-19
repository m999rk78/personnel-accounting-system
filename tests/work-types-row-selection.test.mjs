import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { findSpreadsheetDataRowIndex, isStructuralSpreadsheetRow, nativeSpreadsheetSelectionKey, nativeSpreadsheetSelectionValues, spreadsheetDataColumns, spreadsheetDataRowRanges, spreadsheetHeaderValues } from "../app/gridSpreadsheetRows.ts";
import { serializeSpreadsheetText, stripSpreadsheetHeaderRow } from "../app/spreadsheetClipboard.ts";

const source = ts.createSourceFile("WorkTypesTable.tsx", await readFile(new URL("../app/WorkTypesTable.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let result;
  const visit = node => { if (!result && predicate(node)) result = node; if (!result) ts.forEachChild(node, visit); };
  visit(source); assert.ok(result); return result;
}
function value(name) {
  const node = find(node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(source) === name);
  if (ts.isFunctionDeclaration(node)) return node.getText(source);
  return node.initializer.expression?.getText(source) === "useCallback" ? node.initializer.arguments[0].getText(source) : node.initializer.getText(source);
}
function bind(expression, scope) {
  const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(scope), code)(...Object.values(scope));
}
const shortcutSource = (await readFile(new URL("../app/tableRowSelectionShortcut.ts", import.meta.url), "utf8")).replace(/^import .*;\n/m, "").replaceAll("export function", "function");
const columnIntent = bind(`() => { ${shortcutSource}; return tableColumnSelectionIntent; }`, { isTableTextEntryTarget: () => false })();
const shared = { findSpreadsheetDataRowIndex, isStructuralSpreadsheetRow, nativeSpreadsheetSelectionKey, spreadsheetDataColumns, spreadsheetDataRowRanges };
const selectWorkTypeRowRange = bind(value("selectWorkTypeRowRange"), shared);
const selectedWorkTypeColumns = bind(value("selectedWorkTypeColumns"), shared);
const selectWorkTypeColumnRange = bind(value("selectWorkTypeColumnRange"), shared);
function fixture(rows = [
  { id: "b", data: { name: "Вид Б", childCount: 4 } },
  { id: "detail", detail: true, data: { name: "Вложенная таблица", childCount: 100 } },
  { id: "a", data: { name: "Вид А", childCount: 2 } },
  { id: "c", data: { name: "Вид В", childCount: 1 } },
]) {
  const columns = ["ag-Grid-SelectionColumn", "name", "childCount", "actions"].map(id => ({ getColId: () => id }));
  let ranges = [], focused = { rowIndex: 0, column: columns[2] }, editing = false;
  const calls = [];
  const api = {
    rows, columns, calls,
    getAllDisplayedColumns: () => columns,
    getDisplayedRowCount: () => rows.length,
    getDisplayedRowAtIndex: index => rows[index],
    getRowNode: id => { const rowIndex = rows.findIndex(row => row.id === id); return rowIndex < 0 ? undefined : { ...rows[rowIndex], rowIndex }; },
    getCellRanges: () => ranges,
    getFocusedCell: () => focused,
    getEditingCells: () => editing ? [{}] : [],
    isDestroyed: () => false, isModuleRegistered: () => true,
    clearCellSelection: () => { ranges = []; },
    addCellRange: range => ranges.push({ startRow: { rowIndex: range.rowStartIndex }, endRow: { rowIndex: range.rowEndIndex }, columns: range.columns.map(column => typeof column === "string" ? columns.find(item => item.getColId() === column) : column) }),
    setFocusedCell: (rowIndex, column) => { focused = { rowIndex, column: typeof column === "string" ? columns.find(item => item.getColId() === column) : column }; },
    ensureIndexVisible: index => calls.push(["visible", index]),
    ensureColumnVisible: id => calls.push(["visibleColumn", id]),
    setGridOption: (name, value) => calls.push(["option", name, value]),
    getCellValue: ({ rowNode, colKey }) => rowNode.data[colKey.getColId()],
    getDisplayNameForColumn: column => column.getColId(),
    set editing(value) { editing = value; },
  };
  const wholeRows = { current: null };
  const wholeColumns = { current: null }, selectionIncludesHeaders = { current: null };
  const scope = { api, wholeRows, wholeColumns, selectionIncludesHeaders, ...shared, selectWorkTypeRowRange, selectWorkTypeColumnRange, selectedWorkTypeColumns,
    Element: globalThis.Element ?? class {},
    clearSelectedHeaders: () => { selectionIncludesHeaders.current = null; calls.push(["clearHeaders"]); }, paintSelectedHeaders: () => calls.push(["headers"]),
    tableRowSelectionIntent: event => !event.shiftKey || event.editor ? null : event.key === " " ? "row" : event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : null,
    tableColumnSelectionIntent: event => event.editor ? null : columnIntent(event),
  };
  scope.selectWholeRows = bind(value("selectWholeRows"), scope);
  scope.selectWholeColumns = bind(value("selectWholeColumns"), scope);
  const keydown = bind(value("handleWholeRowKey"), scope);
  const columnKeydown = bind(value("handleWholeColumnKey"), scope);
  const key = (key, shiftKey = true, extra = {}) => {
    const event = { nativeEvent: { key, shiftKey, ...extra }, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    const handled = extra.ctrlKey || extra.altKey || key === "ArrowLeft" || key === "ArrowRight" ? columnKeydown(event) : keydown(event); return { ...event, handled };
  };
  return { api, wholeRows, wholeColumns, selectionIncludesHeaders, key, scope };
}

test("whole WorkTypes rows select all displayed data columns, exclude controls and split around detail panels", () => {
  const { api } = fixture();
  const selection = selectWorkTypeRowRange(api, 0, 3, "childCount");
  assert.deepEqual(api.getCellRanges().map(range => [range.startRow.rowIndex, range.endRow.rowIndex]), [[0, 0], [2, 3]]);
  assert.ok(api.getCellRanges().every(range => range.columns.map(column => column.getColId()).join() === "name,childCount"));
  assert.equal(selection.anchorId, "b"); assert.equal(selection.endId, "c"); assert.equal(selection.columnId, "childCount");
  assert.deepEqual(nativeSpreadsheetSelectionValues(api), [["Вид Б", "4"], ["Вид А", "2"], ["Вид В", "1"]]);
  assert.equal(api.rows.some(row => row.selected), false, "selection never checks action rows");
});

test("Shift+Space expands a cell range and Shift arrows extend, shrink and cross its anchor in displayed order", () => {
  const ui = fixture();
  ui.api.addCellRange({ rowStartIndex: 0, rowEndIndex: 2, columns: ["childCount"] });
  ui.api.setFocusedCell(2, "childCount");
  const initial = ui.key(" "); assert.equal(initial.handled, true); assert.equal(initial.stopped, true);
  assert.equal(ui.wholeRows.current.endId, "a");
  ui.key("ArrowUp"); assert.equal(ui.wholeRows.current.endId, "b", "skip detail panel");
  ui.key("ArrowUp"); assert.equal(ui.wholeRows.current.endId, "b", "clamp at first row");
  ui.key("ArrowDown"); ui.key("ArrowDown"); assert.equal(ui.wholeRows.current.endId, "c");
  ui.key("ArrowDown"); assert.equal(ui.wholeRows.current.endId, "c", "clamp at last row");
  assert.equal(ui.api.getFocusedCell().column.getColId(), "childCount", "remember the original active column");
  ui.scope.selectWholeRows(2, 2, "name"); ui.key("ArrowUp");
  assert.equal(ui.wholeRows.current.anchorId, "a"); assert.equal(ui.wholeRows.current.endId, "b");
  ui.key("ArrowDown"); assert.equal(ui.wholeRows.current.endId, "a");
});

test("empty, structural, editing and missing row endpoints cannot select or mutate unrelated data", () => {
  for (const rows of [[], [{ id: "detail", detail: true, data: {} }], [{ id: "group", group: true, data: {} }]]) {
    const ui = fixture(rows); assert.equal(ui.key(" ").handled, false); assert.deepEqual(ui.api.getCellRanges(), []);
  }
  const ui = fixture(); ui.api.editing = true;
  assert.equal(ui.key(" ").handled, false); ui.api.editing = false;
  assert.equal(ui.key("ArrowDown").handled, false, "plain range extension remains native before row mode");
  assert.equal(ui.key(" ", true, { editor: true }).handled, false);
  ui.key(" "); ui.api.rows.splice(0, 1);
  assert.equal(ui.key("ArrowDown").handled, false); assert.equal(ui.wholeRows.current, null, "removed anchor never falls back to old row index");
});

test("whole-row selection reads virtual rows and filtered order from AG's model", () => {
  const ui = fixture(Array.from({ length: 2000 }, (_, index) => ({ id: `row-${index}`, data: { name: `Вид ${index}`, childCount: index } })));
  const original = JSON.stringify(ui.api.rows);
  selectWorkTypeRowRange(ui.api, 1500, 1999, "name");
  assert.equal(nativeSpreadsheetSelectionValues(ui.api).length, 500);
  assert.deepEqual(nativeSpreadsheetSelectionValues(ui.api)[0], ["Вид 1500", "1500"]);
  assert.equal(JSON.stringify(ui.api.rows), original);
});

test("Shift-click extends row mode, while the master shortcut does not handle nested detail events", () => {
  const previousElement = globalThis.Element;
  class Element {
    constructor(rowIndex) { this.rowIndex = rowIndex; }
    closest(selector) { return selector.startsWith(".ag-cell") || selector.startsWith(".ag-row") ? this : this.owner; }
    getAttribute(name) { return name === "row-index" ? String(this.rowIndex) : null; }
  }
  globalThis.Element = Element;
  try {
    const ui = fixture(); ui.key(" ");
    const pointer = bind(value("extendWholeRowsToPointer"), { ...ui.scope, isTableRowSelectionBlocked: () => false });
    const event = { shiftKey: true, button: 0, target: new Element(3), preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    assert.equal(pointer(event), true); assert.equal(event.prevented, true); assert.equal(ui.wholeRows.current.endId, "c");
    assert.equal(pointer({ ...event, shiftKey: false }), false);
    const attribute = find(node => ts.isJsxAttribute(node) && node.name.getText(source) === "onKeyDownCapture");
    const nestedHandler = bind(attribute.initializer.expression.getText(source), {});
    nestedHandler({ target: event.target, currentTarget: {} }); // ownership guard returns before touching either API
  } finally {
    if (previousElement === undefined) delete globalThis.Element; else globalThis.Element = previousElement;
  }
});

test("Ctrl+Space selects one full column with its header, and Shift arrows expand/shrink across displayed data columns", () => {
  const ui = fixture();
  ui.api.setFocusedCell(2, "childCount");
  const event = ui.key(" ", false, { ctrlKey: true });
  assert.equal(event.handled, true); assert.equal(event.stopped, true);
  assert.equal(ui.wholeColumns.current.rowId, "a");
  assert.equal(ui.api.getFocusedCell().rowIndex, 2);
  assert.deepEqual(nativeSpreadsheetSelectionValues(ui.api, { includeHeaders: true }), [["childCount"], ["4"], ["2"], ["1"]]);
  assert.equal(ui.selectionIncludesHeaders.current, nativeSpreadsheetSelectionKey(ui.api));
  ui.key("ArrowLeft");
  assert.deepEqual(selectedWorkTypeColumns(ui.api).map(column => column.getColId()), ["name", "childCount"]);
  assert.equal(ui.api.getFocusedCell().rowIndex, 2, "horizontal expansion keeps the original active record");
  ui.key("ArrowLeft"); assert.equal(ui.wholeColumns.current.endId, "name", "clamp at first data column, skip checkbox control");
  ui.key("ArrowRight");
  assert.deepEqual(selectedWorkTypeColumns(ui.api).map(column => column.getColId()), ["childCount"]);
  ui.key("ArrowRight"); assert.equal(ui.wholeColumns.current.endId, "childCount", "clamp at last data column, skip action controls");
  assert.equal(ui.api.rows.some(row => row.selected), false);
});

test("switching row and column modes uses the original active column and record", () => {
  const ui = fixture();
  ui.api.setFocusedCell(2, "childCount"); ui.key(" ");
  ui.key(" ", false, { ctrlKey: true });
  assert.equal(ui.wholeRows.current, null);
  assert.equal(ui.wholeColumns.current.anchorId, "childCount");
  assert.equal(ui.wholeColumns.current.rowId, "a");
  ui.key("ArrowLeft"); ui.key(" ");
  assert.equal(ui.wholeColumns.current, null);
  assert.equal(ui.selectionIncludesHeaders.current, null);
  assert.equal(ui.wholeRows.current.anchorId, "a"); assert.equal(ui.wholeRows.current.endId, "a");
  assert.equal(ui.wholeRows.current.columnId, "name");
  assert.deepEqual(nativeSpreadsheetSelectionValues(ui.api), [["Вид А", "2"]]);
});

test("column mode excludes structural rows, handles virtual data and rejects removed endpoints or active editors", () => {
  const ui = fixture(Array.from({ length: 1800 }, (_, index) => ({ id: `id-${index}`, data: { name: `Зона ${index}`, childCount: index } })));
  ui.api.setFocusedCell(1400, "name"); ui.key(" ", false, { ctrlKey: true });
  assert.equal(nativeSpreadsheetSelectionValues(ui.api, { includeHeaders: true }).length, 1801);
  assert.equal(ui.api.getFocusedCell().rowIndex, 1400);
  ui.api.rows.splice(1400, 1);
  assert.equal(ui.key("ArrowRight").handled, false, "missing original row cannot fall back to a different record");
  assert.equal(selectWorkTypeColumnRange(ui.api, "missing", "name", "id-0"), null);
  const editing = fixture(); editing.api.editing = true;
  assert.equal(editing.key(" ", false, { ctrlKey: true }).handled, false);
  assert.deepEqual(editing.api.getCellRanges(), []);
});

test("selected column headers match only the active columns and partial own headers are stripped on paste", () => {
  const ui = fixture(); ui.api.setFocusedCell(2, "childCount"); ui.key(" ", false, { ctrlKey: true });
  const painted = [], root = {}, nested = {};
  root.querySelectorAll = () => [
    ...ui.api.columns.map(column => ({ closest: () => root, getAttribute: () => column.getColId(), classList: { toggle: (_name, active) => { if (active) painted.push(column.getColId()); } } })),
    { closest: () => nested, getAttribute: () => "childCount", classList: { toggle() { throw new Error("nested grid headers must not be painted"); } } },
  ];
  const paint = bind(value("paintSelectedHeaders"), { ...ui.scope, gridElement: { current: root }, requestAnimationFrame: callback => callback() });
  paint(ui.api); assert.deepEqual(painted, ["childCount"]);
  const lastHeaderClipboard = { current: "childCount\n4\n2\n1" }, lastHeaderValues = { current: ["childCount"] };
  const attr = find(node => ts.isJsxAttribute(node) && node.name.getText(source) === "processDataFromClipboard");
  const paste = bind(attr.initializer.expression.getText(source), { ...ui.scope, lastHeaderClipboard, lastHeaderValues, spreadsheetHeaderValues, serializeSpreadsheetText, stripSpreadsheetHeaderRow });
  ui.wholeColumns.current = null; ui.selectionIncludesHeaders.current = null;
  assert.deepEqual(paste({ api: ui.api, data: [["childCount"], ["4"], ["2"], ["1"]] }), [["4"], ["2"], ["1"]]);
  assert.deepEqual(paste({ api: ui.api, data: [["childCount"], ["literal value"]] }), [["childCount"], ["literal value"]], "unrelated text equal to a header is preserved");
});


test("Option+Space selects raw master/detail columns using the shared Mac shortcut", () => {
  const ui = fixture(); ui.api.setFocusedCell(2, "childCount");
  const key = ui.key("\u00a0", false, { code: "Space", altKey: true });
  assert.equal(key.handled, true); assert.equal(key.prevented, true);
  assert.deepEqual(nativeSpreadsheetSelectionValues(ui.api, { includeHeaders: true }), [["childCount"], ["4"], ["2"], ["1"]]);
  ui.key("ArrowLeft"); assert.equal(selectedWorkTypeColumns(ui.api).length, 2);
  const editor = fixture();
  assert.equal(editor.key("\u00a0", false, { code: "Space", altKey: true, editor: true }).handled, false);
});
