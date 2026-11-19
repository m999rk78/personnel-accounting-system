import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { findSpreadsheetDataRowIndex, isStructuralSpreadsheetRow, spreadsheetDataColumns, spreadsheetPointRowIndex } from "../app/gridSpreadsheetRows.ts";
import { isTableSelectAllShortcut, isTableTextEntryTarget } from "../app/tableSelectAllShortcut.ts";
import { historyShortcut } from "../app/undoShortcut.ts";

const source = ts.createSourceFile("GridFilters.tsx", await readFile(new URL("../app/GridFilters.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let result;
  const visit = node => { if (!result && (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(source) === name) result = node; if (!result) ts.forEachChild(node, visit); };
  visit(source); assert.ok(result, name);
  return ts.isFunctionDeclaration(result) ? result.getText(source) : (ts.isCallExpression(result.initializer) ? result.initializer.arguments[0] : result.initializer).getText(source);
}
function bind(code, environment) {
  return Function(...Object.keys(environment), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment));
}
const shortcutCode = (await readFile(new URL("../app/tableRowSelectionShortcut.ts", import.meta.url), "utf8")).replace(/^import .*;\n/m, "").replaceAll("export function", "function");
const columnIntent = bind(`${shortcutCode}; return tableColumnSelectionIntent;`, { isTableTextEntryTarget });
const intent = bind(`${shortcutCode}; return tableRowSelectionIntent;`, { isTableTextEntryTarget });

const event = (key = " ", overrides = {}) => {
  const value = { key, code: key === " " ? "Space" : key, shiftKey: true, ctrlKey: false, metaKey: false, ...overrides, preventDefault() { this.defaultPrevented = true; } };
  value.nativeEvent = value; return value;
};
function harness({ count = 5, structural = [] } = {}) {
  let rows = Array.from({ length: count }, (_, index) => ({ id: `id${index}`, data: Object.freeze({ name: `Name ${index}` }), ...(structural.includes(index) ? { detail: true } : {}) }));
  const columns = ["ag-Grid-SelectionColumn", "name", "hours", "total", "actions"].map(id => ({ getColId: () => id }));
  const seen = [], edits = [], state = { current: null }, last = { current: null };
  let focused = { rowIndex: 2, column: columns[2] }, editing = false;
  const api = {
    getDisplayedRowAtIndex: index => rows[index], getDisplayedRowCount: () => rows.length,
    getAllDisplayedColumns: () => columns,
    getRowNode: id => { const rowIndex = rows.findIndex(row => row.id === id); return rowIndex < 0 ? undefined : { ...rows[rowIndex], rowIndex }; },
    getFocusedCell: () => focused, isDestroyed: () => false, getEditingCells: () => editing ? [{}] : [],
    ensureIndexVisible: index => seen.push(index), ensureColumnVisible() {},
  };
  const environment = { api, spreadsheetColumns: spreadsheetDataColumns, spreadsheetPointRowIndex, isStructuralSpreadsheetRow, findSpreadsheetDataRowIndex, tableRowSelectionIntent: intent, tableColumnSelectionIntent: columnIntent,
    selectionRef: state, lastSelectionRef: last, dragging: { current: false }, selectionIncludesHeaders: { current: false },
    setIncludeSelectedHeaders() {}, setSelection: next => { state.current = next; }, setContextMenu() {}, body: { current: { focus() {} } },
    onSpreadsheetBatch: true, isInteractiveTarget: () => false,
    historyShortcut, isTableSelectAllShortcut,
    onSpreadsheetEdit: payload => { edits.push(payload); return true; }, rememberCellUndo() {}, setSpreadsheetStatus() {},
  };
  const funcs = bind(`${declaration("spreadsheetBounds")}; ${declaration("wholeSpreadsheetRows")}; ${declaration("wholeSpreadsheetColumns")}; ${declaration("spreadsheetActivePoint")}; const selectWholeColumns = ${declaration("selectWholeColumns")}; const selectWholeRows = ${declaration("selectWholeRows")}; const moveSelection = ${declaration("moveSelection")}; const editSelectedCell = ${declaration("editSelectedCell")}; const drag = ${declaration("extendSelection")}; const keydown = ${declaration("handleSpreadsheetKeyDown")}; return { columnsSelect: selectWholeColumns, select: selectWholeRows, move: moveSelection, drag, keydown, wholeSpreadsheetRows };`, environment);
  return { ...funcs, api, state, seen, edits, columns, environment, set rows(value) { rows = value; }, get rows() { return rows; }, set focused(value) { focused = value; }, set editing(value) { editing = value; } };
}

test("Shift+Space selects every data column, without action checkboxes or headers", () => {
  const ui = harness();
  const key = event(); assert.equal(ui.select(key), true); assert.equal(key.defaultPrevented, true);
  assert.deepEqual(ui.state.current, { start: { rowIndex: 2, rowId: "id2", columnId: "name" }, end: { rowIndex: 2, rowId: "id2", columnId: "total" }, rowModeColumnId: "hours" });
  assert.equal(ui.environment.selectionIncludesHeaders.current, false);
});

test("Shift arrows grow, shrink and reverse whole-row ranges, ordinary navigation restores the active column", () => {
  const ui = harness(); ui.select(event());
  ui.select(event("ArrowDown")); assert.equal(ui.state.current.end.rowIndex, 3);
  ui.select(event("ArrowUp")); assert.equal(ui.state.current.end.rowIndex, 2);
  ui.select(event("ArrowUp")); assert.equal(ui.state.current.end.rowIndex, 1); assert.equal(ui.state.current.start.rowIndex, 2);
  ui.move(event("ArrowDown", { shiftKey: false }));
  assert.deepEqual(ui.state.current, { start: { rowIndex: 2, rowId: "id2", columnId: "hours" }, end: { rowIndex: 2, rowId: "id2", columnId: "hours" } });
});

test("whole-row extension skips details, follows displayed order and covers virtualized data", () => {
  const ui = harness({ count: 1200, structural: [3] }); ui.select(event());
  ui.select(event("ArrowDown")); assert.equal(ui.state.current.end.rowIndex, 4);
  ui.environment.dragging.current = true;
  ui.drag({ api: ui.api, rowIndex: 1199, node: ui.rows[1199], column: ui.columns[1] });
  assert.equal(ui.state.current.start.rowIndex, 2); assert.equal(ui.state.current.end.rowIndex, 1199);
  assert.equal(ui.state.current.end.columnId, "total");
  ui.rows = [ui.rows[1199], ui.rows[2]];
  ui.select(event());
  assert.equal(ui.state.current.start.rowIndex, 1); assert.equal(ui.state.current.end.rowIndex, 0);
});

test("removed endpoints, empty tables, editors and other shortcut modifiers do not select unrelated records", () => {
  const ui = harness(); ui.select(event()); const before = ui.state.current;
  ui.rows = ui.rows.filter(row => row.id !== "id2"); ui.select(event("ArrowDown"));
  assert.equal(ui.state.current, before);
  const empty = harness({ count: 0 }); empty.focused = null; empty.select(event()); assert.equal(empty.state.current, null);
  const editing = harness(); editing.editing = true; assert.equal(editing.select(event()), false); assert.equal(editing.state.current, null);
  for (const overrides of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: false }, { isComposing: true }, { defaultPrevented: true }]) assert.equal(intent(event(" ", overrides)), null);
  assert.equal(intent(event("a")), null);
});

test("Shift+Space expands an existing reversed cell range without changing its anchor or source data", () => {
  const ui = harness(); const original = JSON.stringify(ui.rows);
  ui.state.current = { start: { rowIndex: 4, rowId: "id4", columnId: "hours" }, end: { rowIndex: 1, rowId: "id1", columnId: "name" } };
  ui.select(event()); assert.equal(ui.state.current.start.rowIndex, 4); assert.equal(ui.state.current.end.rowIndex, 1);
  assert.equal(ui.state.current.start.columnId, "name"); assert.equal(ui.state.current.end.columnId, "total");
  assert.equal(JSON.stringify(ui.rows), original);
});

test("typing, Enter and F2 after a row selection edit its original active column instead of the first column", () => {
  for (const key of ["8", "Enter", "F2"]) {
    const ui = harness(); ui.select(event()); ui.select(event("ArrowDown"));
    ui.keydown(event(key, { shiftKey: false }));
    assert.equal(ui.edits.length, 1);
    assert.equal(ui.edits[0].columnId, "hours"); assert.equal(ui.edits[0].rowIndex, 3);
    assert.equal(ui.edits[0].initialValue, key === "8" ? "8" : undefined);
    assert.equal(ui.state.current.rowModeColumnId, undefined);
    assert.equal(ui.state.current.start.columnId, "hours");
  }
});

const columnKey = (key = " ", overrides = {}) => event(key, { ctrlKey: key === " ", shiftKey: key !== " ", ...overrides });

test("Ctrl+Space selects a whole data column and its header across virtual rows, skips structural rows", () => {
  const ui = harness({ count: 1200, structural: [0, 1199] });
  const key = columnKey(); assert.equal(ui.columnsSelect(key), true); assert.equal(key.defaultPrevented, true);
  assert.deepEqual(ui.state.current, { start: { rowIndex: 1, rowId: "id1", columnId: "hours" }, end: { rowIndex: 1198, rowId: "id1198", columnId: "hours" }, columnModeRow: { rowIndex: 2, rowId: "id2" } });
  assert.equal(ui.environment.selectionIncludesHeaders.current, true);
  assert.ok(ui.rows.every(row => Object.isFrozen(row.data)));
});

test("Shift horizontal arrows grow, shrink and reverse column ranges and plain arrows restore the original row", () => {
  const ui = harness(); ui.columnsSelect(columnKey());
  ui.columnsSelect(columnKey("ArrowRight")); assert.equal(ui.state.current.end.columnId, "total");
  ui.columnsSelect(columnKey("ArrowLeft")); assert.equal(ui.state.current.end.columnId, "hours");
  ui.columnsSelect(columnKey("ArrowLeft")); assert.equal(ui.state.current.end.columnId, "name");
  assert.equal(ui.state.current.start.columnId, "hours");
  ui.columnsSelect(columnKey("ArrowLeft")); assert.equal(ui.state.current.end.columnId, "name", "No action column selected");
  ui.move(event("ArrowDown", { shiftKey: false }));
  assert.deepEqual(ui.state.current, { start: { rowIndex: 3, rowId: "id3", columnId: "name" }, end: { rowIndex: 3, rowId: "id3", columnId: "name" } });
  assert.equal(ui.environment.selectionIncludesHeaders.current, false);
});

test("switching between row and column mode preserves the active cell instead of selecting the entire grid", () => {
  const ui = harness(); ui.select(event()); ui.select(event("ArrowDown"));
  ui.columnsSelect(columnKey());
  assert.equal(ui.state.current.start.columnId, "hours"); assert.equal(ui.state.current.end.columnId, "hours");
  assert.equal(ui.state.current.columnModeRow.rowIndex, 3);
  ui.columnsSelect(columnKey("ArrowRight")); ui.select(event());
  assert.equal(ui.state.current.start.rowIndex, 3); assert.equal(ui.state.current.end.rowIndex, 3);
  assert.equal(ui.state.current.rowModeColumnId, "total");
});

test("column extension retains the original row through drag, copy mode does not hijack editing, removed IDs do not retarget", () => {
  for (const key of ["8", "Enter", "F2"]) {
    const ui = harness(); ui.columnsSelect(columnKey());
    ui.environment.dragging.current = true;
    ui.drag({ api: ui.api, rowIndex: 0, node: ui.rows[0], column: ui.columns[3] });
    ui.keydown(event(key, { shiftKey: false }));
    assert.equal(ui.edits.length, 1); assert.equal(ui.edits[0].rowIndex, 2); assert.equal(ui.edits[0].columnId, "total");
    assert.equal(ui.environment.selectionIncludesHeaders.current, false);
    assert.equal(ui.state.current.start.rowIndex, 2); assert.equal(ui.state.current.start.columnId, "total");
  }
  const ui = harness(); ui.columnsSelect(columnKey()); const before = ui.state.current;
  ui.rows = ui.rows.filter(row => row.id !== "id2"); ui.columnsSelect(columnKey("ArrowRight")); assert.equal(ui.state.current, before);
  const empty = harness({ count: 0 }); empty.focused = null; empty.columnsSelect(columnKey()); assert.equal(empty.state.current, null);
  const editing = harness(); editing.editing = true; assert.equal(editing.columnsSelect(columnKey()), false);
  for (const overrides of [{ metaKey: true }, { altKey: true }, { shiftKey: true }, { ctrlKey: false }, { isComposing: true }, { defaultPrevented: true }]) assert.equal(columnIntent(columnKey(" ", overrides)), null);
});


test("typing after a column selection never edits its original row when that row is filtered out", () => {
  const ui = harness(); ui.columnsSelect(columnKey());
  const originalGet = ui.api.getRowNode;
  ui.api.getRowNode = id => id === "id2" ? { ...ui.rows[2], rowIndex: null } : originalGet(id);
  ui.keydown(event("8", { shiftKey: false }));
  assert.equal(ui.edits.length, 0);
});


test("Option+Space selects the same full column on Mac, including NBSP keyboard events", () => {
  for (const eventFields of [{ key: " ", code: "Space" }, { key: "\u00a0", code: "Space" }, { key: "\u00a0", code: "" }]) {
    const ui = harness();
    const key = event(eventFields.key, { ...eventFields, ctrlKey: false, altKey: true, shiftKey: false });
    ui.keydown(key);
    assert.equal(key.defaultPrevented, true);
    assert.equal(ui.state.current.start.columnId, "hours");
    assert.equal(ui.state.current.end.columnId, "hours");
    assert.equal(ui.state.current.end.rowIndex, 4);
    ui.keydown(event("ArrowRight")); assert.equal(ui.state.current.end.columnId, "total");
    assert.deepEqual(ui.edits, []);
  }
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
    assert.equal(columnIntent(event("\u00a0", { code: "Space", ctrlKey: false, altKey: true, shiftKey: false, ...extra })), null);
  }
});
