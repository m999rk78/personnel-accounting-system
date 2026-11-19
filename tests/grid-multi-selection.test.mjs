import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { selectedSpreadsheetAreas, selectedSpreadsheetCells, spreadsheetSelectionContains, spreadsheetSelectionValues, toggleSpreadsheetCell } from "../app/gridMultiSelection.ts";
import { isStructuralSpreadsheetRow, spreadsheetDataColumns, spreadsheetPointRowIndex } from "../app/gridSpreadsheetRows.ts";
import { summarizeSpreadsheetSelection } from "../app/gridSelectionSummary.ts";
import { serializeSpreadsheetText, parseSpreadsheetText } from "../app/spreadsheetClipboard.ts";

function fixture(count = 5) {
  let rows = Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, rowIndex: index, data: { a: `A${index}`, b: index + 1, c: index + 10 } }));
  const columns = ["ag-Grid-SelectionColumn", "a", "b", "c", "actions"].map(id => ({ getColId: () => id }));
  const reads = [];
  const grid = {
    getAllDisplayedColumns: () => columns,
    getColumn: id => columns.find(column => column.getColId() === id),
    getDisplayedRowAtIndex: index => rows[index],
    getRowNode: id => { const rowIndex = rows.findIndex(row => row.id === id); return rowIndex < 0 ? undefined : { ...rows[rowIndex], rowIndex }; },
    getCellValue: ({ rowNode, colKey }) => { const id = typeof colKey === "string" ? colKey : colKey.getColId(); reads.push([rowNode.id, id]); return rowNode.data[id]; },
    getDisplayNameForColumn: column => column.getColId().toUpperCase(),
  };
  const point = (rowIndex, columnId) => ({ rowIndex, rowId: rows[rowIndex]?.id, columnId });
  return { grid, columns, point, reads, get rows() { return rows; }, set rows(value) { rows = value; } };
}

test("Ctrl/Cmd cells add, toggle off, and copy only selected intersections in display order", () => {
  const ui = fixture();
  let selected = toggleSpreadsheetCell(ui.grid, null, ui.point(3, "c"));
  selected = toggleSpreadsheetCell(ui.grid, selected, ui.point(0, "a"));
  selected = toggleSpreadsheetCell(ui.grid, selected, ui.point(3, "b"));
  assert.deepEqual(spreadsheetSelectionValues(ui.grid, selected), [["A0", "", ""], ["", "4", "13"]]);
  assert.deepEqual(ui.reads, [["row-0", "a"], ["row-3", "b"], ["row-3", "c"]], "unselected values must never be read or exposed to the clipboard");
  assert.deepEqual(spreadsheetSelectionValues(ui.grid, selected, true)[0], ["A", "B", "C"]);
  selected = toggleSpreadsheetCell(ui.grid, selected, ui.point(3, "b"));
  assert.deepEqual(spreadsheetSelectionValues(ui.grid, selected), [["A0", ""], ["", "13"]]);
  selected = toggleSpreadsheetCell(ui.grid, selected, ui.point(0, "a"));
  selected = toggleSpreadsheetCell(ui.grid, selected, ui.point(3, "c"));
  assert.equal(selected, null);
});

test("removing a cell from overlapping large rectangles stays compact and never selects the removed cell", () => {
  const ui = fixture(10000);
  const area = { start: ui.point(0, "a"), end: ui.point(9999, "c") };
  const selected = toggleSpreadsheetCell(ui.grid, { ...area, ranges: [area] }, ui.point(5000, "b"));
  assert.ok((selected.ranges?.length ?? 0) <= 7, "ranges, not tens of thousands of cell objects, represent the selection");
  assert.equal(spreadsheetSelectionContains(ui.grid, selected, ui.point(5000, "b")), false);
  const cells = selectedSpreadsheetCells(ui.grid, selected);
  assert.equal([...cells.values()].reduce((count, ids) => count + ids.size, 0), 29999);
  assert.deepEqual([...cells.get(5000)], ["a", "c"]);
});

test("stable row IDs survive sorting, removed or hidden rows never retarget another record", () => {
  const ui = fixture();
  const selected = toggleSpreadsheetCell(ui.grid, toggleSpreadsheetCell(ui.grid, null, ui.point(0, "a")), ui.point(4, "c"));
  ui.rows = [ui.rows[4], ui.rows[1], ui.rows[0]];
  assert.deepEqual(spreadsheetSelectionValues(ui.grid, selected), [["", "14"], ["A0", ""]]);
  ui.rows = ui.rows.filter(row => row.id !== "row-0");
  assert.deepEqual(spreadsheetSelectionValues(ui.grid, selected), [["14"]]);
  assert.equal(spreadsheetSelectionContains(ui.grid, selected, { rowIndex: 0, rowId: "removed", columnId: "c" }), false);
});

test("structural rows and control columns are excluded; overlapping numeric cells contribute only once", () => {
  const ui = fixture();
  ui.rows[1] = { ...ui.rows[1], detail: true };
  const range = { start: ui.point(0, "b"), end: ui.point(2, "c") };
  const selected = { ...range, ranges: [range] };
  assert.deepEqual(summarizeSpreadsheetSelection(ui.grid, selectedSpreadsheetAreas(ui.grid, selected)), { count: 4, sum: 26 });
  assert.deepEqual(spreadsheetSelectionValues(ui.grid, selected), [["1", "10"], ["3", "12"]]);
  assert.equal(toggleSpreadsheetCell(ui.grid, selected, ui.point(1, "a")), selected);
  assert.equal(toggleSpreadsheetCell(ui.grid, selected, ui.point(0, "actions")), selected);
});

const source = ts.createSourceFile("GridFilters.tsx", await readFile(new URL("../app/GridFilters.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let result;
  const visit = node => { if (!result && (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(source) === name) result = node; if (!result) ts.forEachChild(node, visit); };
  visit(source); assert.ok(result, name);
  return ts.isFunctionDeclaration(result) ? result.getText(source)
    : (ts.isCallExpression(result.initializer) ? result.initializer.arguments[0] : result.initializer).getText(source);
}
function bind(name, environment) {
  const body = ts.transpileModule(`return (${declaration(name)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return Function(...Object.keys(environment), body)(...Object.values(environment));
}
function jsxAttributeExpression(name) {
  let result;
  const visit = node => { if (!result && ts.isJsxAttribute(node) && node.name.getText(source) === name) result = node.initializer?.expression; if (!result) ts.forEachChild(node, visit); };
  visit(source); assert.ok(result, name);
  return result;
}
function bindJsxAttribute(name, environment) {
  const body = ts.transpileModule(`return (${jsxAttributeExpression(name).getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return Function(...Object.keys(environment), body)(...Object.values(environment));
}
function harness() {
  const ui = fixture();
  const selectionRef = { current: null }, dragging = { current: false };
  const changes = [], messages = [];
  const environment = {
    api: ui.grid, onSpreadsheetBatch: undefined, onSpreadsheetPaste: undefined,
    useCallback: callback => callback,
    selectionRef, lastSelectionRef: { current: null }, selectionIncludesHeaders: { current: false }, lastHeaderClipboard: { current: null },
    dragging, setSelection: next => { selectionRef.current = next; }, setIncludeSelectedHeaders() {}, body: { current: { focus() {} } },
    isInteractiveTarget: () => false, isStructuralSpreadsheetRow, spreadsheetColumns: spreadsheetDataColumns, spreadsheetPointRowIndex,
    spreadsheetSelectionContains, selectedSpreadsheetCells, toggleSpreadsheetCell, spreadsheetSelectionValues, serializeSpreadsheetText,
    setSpreadsheetStatus: message => messages.push(message), canWriteSpreadsheetCell: () => true,
  };
  environment.spreadsheetBounds = bind("spreadsheetBounds", environment);
  return { ...ui, environment, selectionRef, changes, messages,
    select(index, columnId, modifiers = {}) { bind("selectCell", environment)({ rowIndex: index, column: ui.columns.find(column => column.getColId() === columnId), node: ui.rows[index], api: ui.grid, event: { button: 0, preventDefault() {}, ...modifiers } }); },
    copy() { return parseSpreadsheetText(bind("selectedText", environment)()); },
    clear(operation = "clear", requireAllWritable = false) { environment.onSpreadsheetBatch = batch => { changes.push(batch); return true; }; return bind("changeRange", environment)(operation, requireAllWritable); },
  };
}

test("actual grid pointer/copy callbacks support both modifiers, ordinary click replaces and right click retains", () => {
  for (const modifier of ["metaKey", "ctrlKey"]) {
    const ui = harness();
    ui.select(0, "a"); ui.select(3, "c", { [modifier]: true });
    assert.deepEqual(ui.copy(), [["A0", ""], ["", "13"]]);
    ui.select(0, "a", { button: 2 });
    assert.deepEqual(ui.copy(), [["A0", ""], ["", "13"]]);
    ui.select(1, "b");
    assert.deepEqual(ui.copy(), [["2"]]);
    ui.select(1, "b", { [modifier]: true }); assert.equal(ui.selectionRef.current, null);
  }
});

test("synchronous pointer capture finishes dragging before deferred AG callbacks and later plain hover", () => {
  let deferredSelectionCall = false;
  const inspect = node => { if (ts.isIdentifier(node) && node.text === "selectCell") deferredSelectionCall = true; ts.forEachChild(node, inspect); };
  inspect(jsxAttributeExpression("onCellMouseDown"));
  assert.equal(deferredSelectionCall, false, "AG's deferred mousedown must not select cells or revive a finished drag");

  for (const modifier of ["metaKey", "ctrlKey"]) for (const batchEditing of [false, true]) {
    const ui = harness();
    const forwarded = [];
    class CellTarget {
      constructor(index, columnId) { this.index = index; this.columnId = columnId; }
      getAttribute(name) { return name === "col-id" ? this.columnId : null; }
      closest(selector) {
        if (selector === ".ag-cell[col-id]") return this;
        if (selector === ".ag-row[row-index]") return { getAttribute: name => name === "row-index" ? String(this.index) : null };
        return null;
      }
    }
    Object.assign(ui.environment, {
      Element: CellTarget,
      props: { onCellMouseDown: event => forwarded.push(event) },
      onSpreadsheetBatch: batchEditing ? () => true : undefined,
    });
    ui.environment.selectCell = bind("selectCell", ui.environment);
    const capture = bindJsxAttribute("onPointerDownCapture", ui.environment);
    const deferredMouseDown = bindJsxAttribute("onCellMouseDown", ui.environment);
    const pointerUp = bind("finishDrag", ui.environment);
    const hover = bind("extendSelection", ui.environment);
    const agEvent = (index, columnId, modifiers = {}) => ({ rowIndex: index, column: ui.grid.getColumn(columnId), node: ui.rows[index], api: ui.grid, event: { button: 0, preventDefault() {}, ...modifiers } });
    const pointerDown = (index, columnId, modifiers = {}) => {
      const nativeEvent = { target: new CellTarget(index, columnId), button: 0, preventDefault() {}, ...modifiers };
      capture({ ...nativeEvent, nativeEvent, currentTarget: ui.environment.body.current, stopPropagation() {} });
    };

    pointerDown(0, "a");
    assert.deepEqual(ui.copy(), [["A0"]], "ordinary clicks select immediately on every grid");
    pointerUp();
    deferredMouseDown(agEvent(0, "a"));
    assert.equal(ui.environment.dragging.current, false);
    pointerDown(3, "c", { [modifier]: true });
    assert.deepEqual(ui.copy(), [["A0", ""], ["", "13"]], "modifier clicks add immediately before AG dispatches its callbacks");
    pointerUp();
    deferredMouseDown(agEvent(3, "c", { [modifier]: true }));
    const completedSelection = ui.selectionRef.current;
    hover(agEvent(4, "b"));
    assert.equal(ui.environment.dragging.current, false, "a deferred callback cannot re-arm dragging after pointerup");
    assert.equal(ui.selectionRef.current, completedSelection, "plain hover after pointerup cannot enlarge the selected ranges");
    assert.deepEqual(ui.copy(), [["A0", ""], ["", "13"]]);
    assert.equal(forwarded.length, 2, "consumer mousedown callbacks are still forwarded");

    pointerDown(1, "b");
    hover(agEvent(2, "c"));
    assert.deepEqual(ui.copy(), [["2", "11"], ["3", "12"]], "hover still expands a selection while the pointer is held");
    pointerUp();
  }
});

test("actual clear/cut changes chosen cells only and validates every cell before dispatching", () => {
  const ui = harness(); ui.select(0, "b"); ui.select(3, "c", { metaKey: true });
  assert.equal(ui.clear(), true);
  assert.deepEqual(ui.changes[0].rows.map(({ rowIndex, values }) => [rowIndex, values]), [[0, { b: "" }], [3, { c: "" }]]);
  ui.environment.canWriteSpreadsheetCell = (_row, id) => id !== "c";
  assert.equal(ui.clear("clear", true), false);
  assert.equal(ui.changes.length, 1);
  assert.equal(ui.clear("down"), false);
  assert.equal(ui.changes.length, 1);
});

test("actual paste refuses ambiguous disjoint destinations without writing adjacent cells", () => {
  const ui = harness(); ui.select(0, "b"); ui.select(3, "c", { ctrlKey: true });
  ui.environment.onSpreadsheetPaste = () => { throw new Error("Must not paste into disjoint holes"); };
  assert.equal(bind("pasteText", ui.environment)("8\t9\n7\t6"), false);
  assert.match(ui.messages.at(-1), /одну ячейку или один непрерывный диапазон/);
});
