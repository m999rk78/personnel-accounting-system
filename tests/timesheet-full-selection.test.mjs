import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { historyShortcut } from "../app/undoShortcut.ts";

const read = async path => ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const hookSource = await read("../app/useTimesheetClipboard.ts");
const shortcutSource = await read("../app/tableSelectAllShortcut.ts");
const rowShortcutSource = await read("../app/tableRowSelectionShortcut.ts");
const declarations = source => source.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(source).replace(/^export\s+/, "")).join("\n");
const code = ts.transpileModule(`${declarations(shortcutSource)}\n${declarations(rowShortcutSource)}\n${declarations(hookSource)}\nreturn useTimesheetClipboard;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

class Target {
  constructor(selector = "td", parent = null) { this.selector = selector; this.parent = parent; this.type = selector === "input" ? "text" : ""; }
  closest(selectors) { return selectors.split(",").map(value => value.trim()).includes(this.selector) ? this : this.parent?.closest(selectors) ?? null; }
}

/** Render the actual hook with stable React-style refs/state. Layout and the
 * clipboard boundary are synthetic: no DOM rows, browser permissions or DB. */
function harness(overrides = {}) {
  const slots = [], writes = [], copied = [], statuses = [], layouts = [], frames = [];
  let cursor = 0, api, escapeOptions;
  const table = new Target("div"); table.focus = () => {}; table.querySelector = () => ({ scrollIntoView() {} }); table.contains = () => true;
  const options = { rowCount: 1000, columnCount: 2, columnIndexes: [-3, -2, 0, 1, 2], resetKey: "site:month:filtered-order",
    shellRef: { current: table }, getValue: (row, col) => `${row}:${col}`, canPaste: () => true, canDelete: () => true,
    onPaste: async changes => { writes.push(changes); return changes.length; }, onDelete: async changes => { writes.push(changes); return changes.length; },
    onActivate: (...args) => writes.push({ activate: args }), onType: (...args) => writes.push({ type: args }), ...overrides };
  const environment = { Element: Target, createElement: (type, props) => ({ type, props }),
    useWorkspaceAccess: () => ({ edit: true, delete: true }), useTableEscapeSelection: options => { escapeOptions = options; }, useTablePageSelectAll() {}, TableContextMenu() {},
    useUndoShortcut() {}, historyShortcut, dispatchUndoShortcut() {},
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = initial; return [slots[id], next => { slots[id] = typeof next === "function" ? next(slots[id]) : next; if (typeof slots[id] === "string") statuses.push(slots[id]); }]; },
    useRef(initial) { const id = cursor++; if (!(id in slots)) slots[id] = { current: initial }; return slots[id]; },
    useCallback: callback => callback, useEffect() {}, useLayoutEffect: callback => layouts.push(callback), requestAnimationFrame: callback => frames.push(callback),
    cancelAnimationFrame() {}, window: { innerWidth: 1200, innerHeight: 900 },
  };
  const runClipboard = new Function(...Object.keys(environment), code)(...Object.values(environment));
  const render = () => { cursor = 0; api = runClipboard(options); return api; };
  const event = fields => ({ target: table, key: "a", code: "KeyA", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, button: 0,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...fields });
  const copy = () => { const input = event({ clipboardData: { setData: (_type, text) => copied.push(text) } }); api.shellHandlers.onCopy(input); return input; };
  const select = (row, col, fields) => { api.cellHandlers(row, col).onMouseDown(event({ ctrlKey: false, ...fields })); render(); };
  const context = (row, col) => {
    const cell = new Target("td"); cell.tagName = "TD"; cell.closest = () => table;
    api.cellHandlers(row, col).onContextMenu(event({ button: 2, currentTarget: cell, clientX: 100, clientY: 100 })); render();
  };
  render();
  return { options, writes, copied, statuses, layouts, event, render, copy, select, context,
    escape() { escapeOptions.clearSelection(); render(); },
    beginScopeReset() { layouts.at(-1)(); },
    finishScopeReset() { frames.at(-1)(); render(); },
    resetScope() { layouts.at(-1)(); frames.at(-1)(); render(); },
    get api() { return api; }, async flush() { await new Promise(resolve => setImmediate(resolve)); render(); } };
}

test("Ctrl+A copies every filtered row across virtualized metadata, days and totals without hidden column gaps", () => {
  const ui = harness();
  const key = ui.event(); ui.api.shellHandlers.onKeyDownCapture(key); ui.render();
  assert.equal(key.defaultPrevented, true); assert.equal(key.stopped, true);
  assert.equal(ui.api.activeCell.rowIndex, 999);
  assert.match(ui.api.cellClass(999, 2), /timesheet-cell-selected/);
  ui.copy();
  const lines = ui.copied[0].split("\n");
  assert.equal(lines.length, 1000);
  assert.equal(lines[0], "0:-3\t0:-2\t0:0\t0:1\t0:2");
  assert.equal(lines.at(-1), "999:-3\t999:-2\t999:0\t999:1\t999:2");
  assert.equal(ui.statuses.at(-1), "Скопировано: 1000 × 5");
});

for (const [kind, columns] of [["personnel", [-5, -4, -2, -1, 0, 1, 2, 3]], ["equipment", [-2, -1, 0, 1, 3, 4]]]) {
  test(`${kind}: Shift+Space copies whole displayed rows including identity and totals without headers or writes`, () => {
    const ui = harness({ columnIndexes: columns, getHeader: col => `Header ${col}` });
    ui.select(720, 1);
    const key = ui.event({ key: " ", code: "Space", ctrlKey: false, shiftKey: true });
    ui.api.shellHandlers.onKeyDownCapture(key); ui.render(); ui.copy();
    assert.equal(key.defaultPrevented, true); assert.equal(key.stopped, true);
    assert.equal(ui.api.headersSelected, false);
    assert.deepEqual(ui.api.activeCell, { rowIndex: 720, columnIndex: 1 });
    assert.equal(ui.copied.at(-1), columns.map(col => `720:${col}`).join("\t"));
    for (const col of columns) assert.match(ui.api.cellClass(720, col), /timesheet-cell-selected/);
    assert.equal(ui.api.cellClass(719, 1), ""); assert.equal(ui.api.cellClass(721, 1), "");
    assert.deepEqual(ui.writes, []);
  });
}

test("whole-row Shift arrows and Shift-click extend and shrink a range around its original anchor", async () => {
  const ui = harness({ rowCount: 10 });
  const key = (name, code = name) => {
    ui.api.shellHandlers.onKeyDownCapture(ui.event({ key: name, code, ctrlKey: false, shiftKey: true })); ui.render();
  };
  ui.select(4, 1); ui.select(2, 0, { shiftKey: true });
  key(" ", "Space"); ui.copy();
  assert.equal(ui.copied.at(-1).split("\n").length, 3);
  key("ArrowUp"); ui.copy();
  assert.equal(ui.copied.at(-1).split("\n").length, 4);
  assert.match(ui.api.cellClass(1, -3), /timesheet-cell-selected/);
  key("ArrowDown"); ui.copy();
  assert.equal(ui.copied.at(-1).split("\n").length, 3);
  assert.equal(ui.api.cellClass(1, -3), "");
  ui.select(7, -2, { shiftKey: true }); ui.copy();
  assert.equal(ui.copied.at(-1).split("\n").length, 4);
  assert.equal(ui.copied.at(-1).split("\n")[0], "4:-3\t4:-2\t4:0\t4:1\t4:2");
  assert.deepEqual(ui.api.activeCell, { rowIndex: 7, columnIndex: 0 });
  await ui.api.shellHandlers.onKeyDown(ui.event({ key: "ArrowDown", code: "ArrowDown", ctrlKey: false, shiftKey: false }));
  ui.render(); ui.copy();
  assert.deepEqual(ui.api.activeCell, { rowIndex: 8, columnIndex: 0 });
  assert.equal(ui.copied.at(-1), "8:0", "ordinary arrow returns to the original active column");
  assert.deepEqual(ui.writes, []);
});

test("row selection clamps at table edges, supports Shift-drag, and regular clicks leave row mode", () => {
  const ui = harness({ rowCount: 3 });
  const rowKey = key => { ui.api.shellHandlers.onKeyDownCapture(ui.event({ key, code: key === " " ? "Space" : key, ctrlKey: false, shiftKey: true })); ui.render(); };
  ui.select(0, 1); rowKey(" "); rowKey("ArrowUp"); ui.copy();
  assert.equal(ui.copied.at(-1).split("\n").length, 1);
  ui.select(1, -2, { shiftKey: true }); ui.api.cellHandlers(2, 0).onMouseEnter(); ui.render(); rowKey("ArrowDown"); ui.copy();
  assert.equal(ui.copied.at(-1).split("\n").length, 3);
  assert.equal(ui.api.activeCell.rowIndex, 2);
  ui.select(1, -2); ui.copy();
  assert.equal(ui.copied.at(-1), "1:-2");
  assert.deepEqual(ui.writes, []);
});

test("Shift+Space leaves editors and blocked/empty tables unchanged; scope reset invalidates row mode", () => {
  for (const overrides of [{ escapeBlocked: true }, { rowCount: 0 }]) {
    const ui = harness(overrides);
    const key = ui.event({ key: " ", code: "Space", ctrlKey: false, shiftKey: true });
    ui.api.shellHandlers.onKeyDownCapture(key); ui.render();
    assert.equal(ui.api.activeCell, null); assert.deepEqual(ui.writes, []);
  }
  const ui = harness(); ui.select(2, 1);
  for (const fields of [{ target: new Target("input") }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }]) {
    const key = ui.event({ key: " ", code: "Space", ctrlKey: false, shiftKey: true, ...fields });
    ui.api.shellHandlers.onKeyDownCapture(key); ui.render(); ui.copy();
    assert.equal(key.defaultPrevented, undefined); assert.equal(ui.copied.at(-1), "2:1");
  }
  ui.api.shellHandlers.onKeyDownCapture(ui.event({ key: " ", code: "Space", ctrlKey: false, shiftKey: true })); ui.render();
  ui.resetScope(); assert.equal(ui.api.activeCell, null); assert.equal(ui.copy().defaultPrevented, undefined);
});

test("Ctrl+A explicitly selects and copies visible headers, while partial selections return to body-only copying", () => {
  const ui = harness({ rowCount: 2, getHeader: columnIndex => `Заголовок ${columnIndex}` });
  ui.api.shellHandlers.onKeyDownCapture(ui.event()); ui.render();
  assert.equal(ui.api.headersSelected, true);
  ui.copy();
  assert.equal(ui.copied[0], "Заголовок -3\tЗаголовок -2\tЗаголовок 0\tЗаголовок 1\tЗаголовок 2\n0:-3\t0:-2\t0:0\t0:1\t0:2\n1:-3\t1:-2\t1:0\t1:1\t1:2");
  assert.equal(ui.statuses.at(-1), "Скопировано: 3 × 5");
  ui.select(0, -2); ui.copy();
  assert.equal(ui.api.headersSelected, false);
  assert.equal(ui.copied[1], "0:-2");
  ui.api.shellHandlers.onKeyDownCapture(ui.event()); ui.render();
  ui.select(0, 0, { shiftKey: true }); ui.copy();
  assert.equal(ui.api.headersSelected, false);
  assert.equal(ui.copied[2], "0:-3\t0:-2\t0:0");
});

test("pasting a select-all copy back strips only its exact visible header row and never shifts employee/date coordinates", async () => {
  const ui = harness({ rowCount: 2, getHeader: columnIndex => `Заголовок ${columnIndex}` });
  ui.api.shellHandlers.onKeyDownCapture(ui.event()); ui.render(); ui.copy();
  ui.api.shellHandlers.onPaste(ui.event({ clipboardData: { getData: () => ui.copied[0] } })); await ui.flush();
  assert.deepEqual(ui.writes[0], [
    { rowIndex: 0, columnIndex: 0, value: "0:0" }, { rowIndex: 0, columnIndex: 1, value: "0:1" },
    { rowIndex: 1, columnIndex: 0, value: "1:0" }, { rowIndex: 1, columnIndex: 1, value: "1:1" },
  ]);
});

test("choosing a first target after select-all copy retains exact header recognition and never shifts employees", async () => {
  const ui = harness({ rowCount: 2, getHeader: columnIndex => `Заголовок ${columnIndex}` });
  ui.api.shellHandlers.onKeyDownCapture(ui.event()); ui.render(); ui.copy();
  const copied = ui.copied[0];
  ui.select(0, -3); assert.equal(ui.api.headersSelected, false);
  ui.api.shellHandlers.onPaste(ui.event({ clipboardData: { getData: () => copied } })); await ui.flush();
  assert.deepEqual(ui.writes[0], [
    { rowIndex: 0, columnIndex: 0, value: "0:0" }, { rowIndex: 0, columnIndex: 1, value: "0:1" },
    { rowIndex: 1, columnIndex: 0, value: "1:0" }, { rowIndex: 1, columnIndex: 1, value: "1:1" },
  ]);
});

test("normal body copy clears header recognition, even when copied body values equal column captions", async () => {
  const ui = harness({ rowCount: 2, getHeader: columnIndex => `Заголовок ${columnIndex}`, getValue: (_row, columnIndex) => `Заголовок ${columnIndex}` });
  ui.api.shellHandlers.onKeyDownCapture(ui.event()); ui.render(); ui.copy();
  ui.select(0, -3); ui.api.cellHandlers(0, 2).onMouseEnter(); ui.render(); ui.copy();
  const body = ui.copied.at(-1);
  ui.api.shellHandlers.onPaste(ui.event({ clipboardData: { getData: () => body } })); await ui.flush();
  assert.deepEqual(ui.writes[0], [{ rowIndex: 0, columnIndex: 0, value: "Заголовок 0" }, { rowIndex: 0, columnIndex: 1, value: "Заголовок 1" }]);
});

test("an own header copy with incompatible current columns is rejected instead of shifting its data rows", async () => {
  const ui = harness({ rowCount: 2, getHeader: columnIndex => `Заголовок ${columnIndex}` });
  ui.api.shellHandlers.onKeyDownCapture(ui.event()); ui.render(); ui.copy();
  const copied = ui.copied[0];
  ui.select(0, 0);
  ui.api.shellHandlers.onPaste(ui.event({ clipboardData: { getData: () => copied } })); await ui.flush();
  assert.deepEqual(ui.writes, []);
  assert.match(ui.statuses.at(-1), /не совпадают с местом вставки/);
});

test("clearing the table scope clears header and data selection together", () => {
  const ui = harness({ rowCount: 2, getHeader: columnIndex => `Заголовок ${columnIndex}` });
  ui.api.shellHandlers.onKeyDownCapture(ui.event()); ui.render();
  assert.equal(ui.api.headersSelected, true);
  ui.resetScope();
  assert.equal(ui.api.headersSelected, false); assert.equal(ui.api.activeCell, null);
  assert.equal(ui.copy().defaultPrevented, undefined); assert.deepEqual(ui.copied, []);
});

test("a committed scope reset invalidates old copy/paste and dragging before the visual animation frame runs", async () => {
  for (const all of [false, true]) {
    const ui = harness({ rowCount: 2, getHeader: columnIndex => `Старый заголовок ${columnIndex}` });
    if (all) { ui.api.shellHandlers.onKeyDownCapture(ui.event()); ui.render(); }
    else ui.select(0, 0);
    ui.options.resetKey = "new-project:new-month:new-row-order";
    ui.options.getHeader = columnIndex => `Новый заголовок ${columnIndex}`;
    ui.options.getValue = (row, col) => `Новые данные ${row}:${col}`;
    ui.render(); ui.beginScopeReset();
    assert.equal(ui.copy().defaultPrevented, undefined, "old coordinates cannot read the new view before RAF");
    ui.api.shellHandlers.onPaste(ui.event({ clipboardData: { getData: () => "7\t8" } })); await ui.flush();
    await ui.api.shellHandlers.onKeyDown(ui.event({ key: "Delete", ctrlKey: false }));
    ui.api.cellHandlers(1, 1).onMouseEnter(); ui.render(); ui.copy();
    assert.deepEqual(ui.writes, []); assert.deepEqual(ui.copied, [], "an old drag cannot recreate the previous selection");
    ui.finishScopeReset();
    assert.equal(ui.api.activeCell, null); assert.equal(ui.api.headersSelected, false);
  }
});

test("an empty timesheet can select and copy only its headers without creating any editable cell", async () => {
  const ui = harness({ rowCount: 0, getHeader: columnIndex => `Заголовок ${columnIndex}` });
  const key = ui.event(); ui.api.shellHandlers.onKeyDownCapture(key); ui.render(); ui.copy();
  assert.equal(key.defaultPrevented, true); assert.equal(ui.api.headersSelected, true); assert.equal(ui.api.activeCell, null);
  assert.equal(ui.copied[0], "Заголовок -3\tЗаголовок -2\tЗаголовок 0\tЗаголовок 1\tЗаголовок 2");
  assert.equal(ui.statuses.at(-1), "Скопировано: 1 × 5");
  ui.api.shellHandlers.onPaste(ui.event({ clipboardData: { getData: () => "7\t8" } })); await ui.flush();
  await ui.api.shellHandlers.onKeyDown(ui.event({ key: "Delete", ctrlKey: false }));
  assert.deepEqual(ui.writes, []);
});

test("Cmd+A and physical Russian-layout KeyA select read-only timesheets too", () => {
  for (const fields of [{ ctrlKey: false, metaKey: true }, { key: "ф", code: "KeyA" }]) {
    const ui = harness({ rowCount: 2, canPaste: () => false, canDelete: () => false });
    const key = ui.event(fields); ui.api.shellHandlers.onKeyDownCapture(key); ui.render(); ui.copy();
    assert.equal(key.defaultPrevented, true); assert.equal(ui.copied[0].split("\n").length, 2); assert.deepEqual(ui.writes, []);
  }
});

test("drag and Shift ranges include read-only descriptors and keep hidden columns out of copied TSV", () => {
  const ui = harness({ rowCount: 3 });
  ui.select(0, -2);
  ui.api.cellHandlers(2, 1).onMouseEnter(); ui.render(); ui.copy();
  assert.equal(ui.copied[0], "0:-2\t0:0\t0:1\n1:-2\t1:0\t1:1\n2:-2\t2:0\t2:1");
  ui.select(1, 0, { shiftKey: true }); ui.copy();
  assert.equal(ui.copied[1], "0:-2\t0:0\n1:-2\t1:0");
});

for (const modifier of ["ctrlKey", "metaKey"]) {
  test(`${modifier}: separate cells stay highlighted and copy in displayed order without intervening values`, () => {
    const reads = [];
    const ui = harness({ rowCount: 10, getValue: (row, col) => { reads.push([row, col]); return `${row}:${col}`; } });
    ui.select(8, 1);
    ui.select(2, -2, { [modifier]: true });
    ui.select(8, -2, { [modifier]: true });
    for (const [row, col] of [[8, 1], [2, -2], [8, -2]]) assert.match(ui.api.cellClass(row, col), /timesheet-cell-selected/);
    for (const [row, col] of [[2, 1], [8, 0], [3, -2]]) assert.equal(ui.api.cellClass(row, col), "");
    ui.copy();
    assert.equal(ui.copied.at(-1), "2:-2\t\n8:-2\t8:1");
    assert.deepEqual(reads, [[2, -2], [8, -2], [8, 1]], "unselected intersections are never read or copied");
    assert.equal(ui.statuses.at(-1), "Скопировано: 2 × 2");
    assert.deepEqual(ui.writes, []);
  });
}

test("modifier clicks toggle chosen cells off, including a cell inside an earlier rectangle", () => {
  const ui = harness({ rowCount: 4 });
  ui.select(0, -2); ui.api.cellHandlers(2, 1).onMouseEnter(); ui.render();
  ui.select(1, 0, { metaKey: true });
  assert.equal(ui.api.cellClass(1, 0), "");
  assert.match(ui.api.cellClass(0, 0), /timesheet-cell-selected/);
  assert.match(ui.api.cellClass(1, -2), /timesheet-cell-selection-right/);
  assert.match(ui.api.cellClass(1, 1), /timesheet-cell-selection-left/);
  ui.copy();
  assert.equal(ui.copied.at(-1), "0:-2\t0:0\t0:1\n1:-2\t\t1:1\n2:-2\t2:0\t2:1");
  ui.select(3, 0); ui.select(3, 0, { ctrlKey: true });
  assert.equal(ui.api.activeCell, null);
  assert.equal(ui.copy().defaultPrevented, undefined);
});

test("modifier drag and Shift-click extend only the active range; ordinary clicks and arrows replace all ranges", async () => {
  const ui = harness({ rowCount: 5 });
  ui.select(0, -2); ui.select(2, 0, { metaKey: true });
  ui.api.cellHandlers(3, 1).onMouseEnter(); ui.render();
  ui.copy();
  assert.equal(ui.copied.at(-1), "0:-2\t\t\n\t2:0\t2:1\n\t3:0\t3:1");
  ui.select(4, 1, { shiftKey: true }); ui.copy();
  assert.equal(ui.copied.at(-1).split("\n").length, 4);
  assert.match(ui.api.cellClass(0, -2), /timesheet-cell-selected/);
  await ui.api.shellHandlers.onKeyDown(ui.event({ key: "ArrowUp", ctrlKey: false })); ui.render(); ui.copy();
  assert.equal(ui.copied.at(-1), "3:1");
  ui.select(0, -2, { metaKey: true }); ui.select(1, 0); ui.copy();
  assert.equal(ui.copied.at(-1), "1:0");
});

test("disjoint Delete and scalar paste affect chosen editable cells only; matrix paste is safely rejected", async () => {
  const ui = harness({ rowCount: 5 });
  ui.select(0, 0); ui.select(4, 1, { metaKey: true }); ui.select(2, -2, { metaKey: true });
  ui.api.shellHandlers.onPaste(ui.event({ clipboardData: { getData: () => "7" } })); await ui.flush();
  assert.deepEqual(ui.writes[0], [{ rowIndex: 0, columnIndex: 0, value: "7" }, { rowIndex: 4, columnIndex: 1, value: "7" }]);
  await ui.api.shellHandlers.onKeyDown(ui.event({ key: "Delete", ctrlKey: false }));
  assert.deepEqual(ui.writes[1], [{ rowIndex: 0, columnIndex: 0, value: "" }, { rowIndex: 4, columnIndex: 1, value: "" }]);
  ui.api.shellHandlers.onPaste(ui.event({ clipboardData: { getData: () => "8\t9\n7\t6" } })); await ui.flush();
  assert.equal(ui.writes.length, 2);
  assert.match(ui.statuses.at(-1), /один непрерывный диапазон/);
  ui.resetScope(); assert.equal(ui.api.activeCell, null); assert.equal(ui.copy().defaultPrevented, undefined);
});

test("right-click preserves selected islands but replaces selection when opening a menu on an unselected intersection", () => {
  const ui = harness({ rowCount: 5 });
  ui.select(0, 0); ui.select(4, 1, { metaKey: true });
  ui.context(0, 0); ui.copy(); assert.equal(ui.copied.at(-1), "0:0\t\n\t4:1");
  ui.context(4, 0); ui.copy(); assert.equal(ui.copied.at(-1), "4:0");
});

test("Escape clears every disjoint range and modifier clicks inside editors leave the selection alone", () => {
  const ui = harness({ rowCount: 5 });
  ui.select(0, 0); ui.select(4, 1, { metaKey: true });
  for (const selector of ["input", "textarea", "select", "[contenteditable='true']", "[role='combobox']"]) {
    ui.select(2, 1, { ctrlKey: true, target: new Target(selector) });
    assert.equal(ui.api.cellClass(2, 1), "");
    assert.match(ui.api.cellClass(4, 1), /timesheet-cell-selected/);
  }
  ui.escape();
  assert.equal(ui.api.activeCell, null); assert.equal(ui.copy().defaultPrevented, undefined);
  ui.api.cellHandlers(3, 0).onMouseEnter(); ui.render();
  assert.equal(ui.api.activeCell, null, "Escape also cancels the active additive drag");
});

test("paste and delete of an all-table range cannot mutate metadata/totals or shift day indices", async () => {
  const ui = harness({ rowCount: 1 });
  ui.api.shellHandlers.onKeyDownCapture(ui.event()); ui.render();
  ui.api.shellHandlers.onPaste(ui.event({ clipboardData: { getData: () => "number\tname\t7\t8\ttotal" } })); await ui.flush();
  assert.deepEqual(ui.writes[0], [{ rowIndex: 0, columnIndex: 0, value: "7" }, { rowIndex: 0, columnIndex: 1, value: "8" }]);
  await ui.api.shellHandlers.onKeyDown(ui.event({ key: "Delete", code: "Delete", ctrlKey: false }));
  assert.deepEqual(ui.writes[1], [{ rowIndex: 0, columnIndex: 0, value: "" }, { rowIndex: 0, columnIndex: 1, value: "" }]);
});

test("readonly cells cannot activate an editor, and arrows skip a hidden descriptor without changing day positions", async () => {
  const ui = harness({ rowCount: 1 });
  ui.select(0, -2);
  await ui.api.shellHandlers.onKeyDown(ui.event({ key: "Enter", code: "Enter", ctrlKey: false }));
  await ui.api.shellHandlers.onKeyDown(ui.event({ key: "9", code: "Digit9", ctrlKey: false }));
  assert.deepEqual(ui.writes, []);
  await ui.api.shellHandlers.onKeyDown(ui.event({ key: "ArrowRight", code: "ArrowRight", ctrlKey: false })); ui.render();
  assert.equal(ui.api.activeCell.columnIndex, 0);
  await ui.api.shellHandlers.onKeyDown(ui.event({ key: "Enter", code: "Enter", ctrlKey: false }));
  assert.equal(ui.writes[0].activate[1], 0);
});

test("native Ctrl+A remains inside editors/search fields; empty or popup-blocked tables do not consume it", () => {
  for (const target of [new Target("input"), new Target("textarea"), new Target("[role='combobox']"), new Target(".custom-select-menu")]) {
    const ui = harness(); const key = ui.event({ target }); ui.api.shellHandlers.onKeyDownCapture(key);
    assert.equal(key.defaultPrevented, undefined); assert.equal(ui.api.activeCell, null);
  }
  for (const overrides of [{ rowCount: 0 }, { columnIndexes: [] }, { escapeBlocked: true }]) {
    const ui = harness(overrides); const key = ui.event(); ui.api.shellHandlers.onKeyDownCapture(key);
    assert.equal(key.defaultPrevented, undefined); assert.equal(ui.api.activeCell, null);
  }
  const ui = harness(); const checkbox = new Target("input"); checkbox.type = "checkbox";
  const key = ui.event({ target: checkbox }); ui.api.shellHandlers.onKeyDownCapture(key);
  assert.equal(key.defaultPrevented, true, "row checkboxes use the table select-all, independently of row selection");
});

async function valueCallback(path, names, environment, property = "getValue") {
  const source = await read(path);
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useTimesheetClipboard") {
      callback = node.arguments[0].properties.find(item => item.name?.getText(source) === property).initializer.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(callback);
  const helpers = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(source)).join("\n");
  const compiled = ts.transpileModule(`${helpers}; return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), compiled)(...Object.values(environment));
}

test("personnel timesheet copies the actual descriptor/day/total values and retains visible compact-position metadata", async () => {
  const columnResize = { columnIds: ["number", "employmentType", "department", "fullName", "position", "day-3", "day-9", "timesheet", "reports", "difference"] };
  const reconciliationRows = new Map([[7, { timesheet: 8, reports: 6, difference: 2 }]]);
  const value = await valueCallback("../app/TimesheetView.tsx", ["dateForDay", "cellKey", "markValue"], {
    visibleEmployees: [{ id: 7, employmentType: "ИТР", department: "ПТО", fullName: "Тестовый сотрудник", position: "Инженер" }],
    visibleDays: [3, 9], month: "2026-11", columnResize,
    marksByCell: new Map([["7:2026-11-03", { hours: 0 }], ["7:2026-11-09", { code: "ОТ" }]]), entriesByCell: new Map(),
    reconciliationRows,
  });
  assert.deepEqual([-5, -4, -3, -2, -1, 0, 1, 2, 3, 4].map(col => value(0, col)), ["1", "ИТР", "ПТО", "Тестовый сотрудник", "Инженер", "0", "ОТ", "8", "6", "+2"]);
  columnResize.columnIds = columnResize.columnIds.filter(id => id !== "position");
  assert.equal(value(0, -2), "Тестовый сотрудник · Инженер");
  reconciliationRows.set(7, { timesheet: 0, reports: 0, difference: 0 });
  assert.deepEqual([2, 3, 4].map(col => value(0, col)), ["0", "0", "0"], "Zero totals stay numeric in copied columns");
});

test("equipment timesheet copies model and registration, organization, work/downtime and totals without editing-coordinate changes", async () => {
  const organization = "Учебная организация с длинным названием, которое выходит за ширину закреплённого столбца";
  const { equipmentDisplayName: unitTitle } = await import("../app/equipmentDisplayName.ts");
  const monthRows = [{ unit: { equipmentType: "Кран", brand: "Тест", model: "М1", registrationNumber: "QA-001", organization },
      byDate: new Map([["2026-11-03", { productive: 8, downtime: 2 }], ["2026-11-09", { productive: 0, downtime: 3 }]]), productive: 8, downtime: 5, total: 13 }];
  const value = await valueCallback("../app/EquipmentAccountingView.tsx", ["formatEquipmentHours"], {
    unitTitle, monthRows,
    visibleMonthDays: [3, 9], month: "2026-11",
  });
  assert.deepEqual([-3, -2, -1, 0, 1, 2, 3, 4].map(col => value(0, col)), ["1", "М1 // QA-001", organization, "8/2", "П 3", "8", "5", "13"]);
  Object.assign(monthRows[0], { productive: 0, downtime: 0, total: 0 });
  assert.deepEqual([2, 3, 4].map(col => value(0, col)), ["0", "0", "0"], "Zero totals stay numeric in copied columns");
});

test("selected readonly descriptors keep long text clipped and available in full without covering adjacent day editors", async () => {
  const css = await readFile(new URL("../app/timesheetSelection.css", import.meta.url), "utf8");
  assert.match(css, /\.timesheet-table tbody \.timesheet-sticky\.timesheet-cell-selected\s*\{[^}]*overflow:\s*hidden/);
  assert.doesNotMatch(css, /\.timesheet-table tbody :is\(td, th\)\.timesheet-cell-selected\s*\{[^}]*overflow:\s*hidden/,
    "day selections retain their existing visible editor/dropdown overflow");
  for (const [path, name] of [["../app/EquipmentAccountingView.tsx", "equipment-organization-column"], ["../app/TimesheetView.tsx", "timesheet-department-column"]]) {
    const source = await read(path); let cell;
    function visit(node) {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "td" && node.attributes.getText(source).includes(name)) cell = node;
      ts.forEachChild(node, visit);
    }
    visit(source); assert.ok(cell);
    assert.ok(cell.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.text === "title"), "full descriptor remains readable in its title");
  }
});

test("both timesheet headers keep actual sparse dates and correct readonly labels without creating editable header coordinates", async () => {
  for (const [path, environment, indexes, expected] of [
    ["../app/TimesheetView.tsx", { visibleDays: [3, 9], month: "2026-11" }, [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4], ["№", "Тип", "Отдел", "Сотрудник", "Должность", "03.11.2026", "09.11.2026", "Табель", "Отчёты", "Разница"]],
    ["../app/EquipmentAccountingView.tsx", { visibleMonthDays: [3, 9], month: "2026-11" }, [-3, -2, -1, 0, 1, 2, 3, 4], ["№", "Техника", "Организация", "03.11.2026", "09.11.2026", "Работа", "Простой", "Всего"]],
  ]) {
    const header = await valueCallback(path, [], environment, "getHeader");
    assert.deepEqual(indexes.map(header), expected);
  }
  const css = await readFile(new URL("../app/timesheetSelection.css", import.meta.url), "utf8");
  assert.match(css, /\.timesheet-clipboard-shell\.timesheet-headers-selected \.timesheet-table thead th(?:,[^{]+)?\s*\{[^}]*background:/);
});

for (const [kind, columns] of [["personnel", [-5, -4, -2, 0, 1, 2, 3]], ["equipment", [-3, -2, -1, 0, 1, 3, 4]]]) {
  test(`${kind}: Ctrl+Space copies full virtual columns with headers and zeros, including readonly identity`, () => {
    const ui = harness({ columnIndexes: columns, getHeader: col => `Header ${col}`, getValue: (row, col) => row === 999 ? "0" : `${row}:${col}`, canPaste: () => false, canDelete: () => false });
    for (const column of [-2, 1]) {
      ui.select(720, column);
      const key = ui.event({ key: " ", code: "Space" });
      ui.api.shellHandlers.onKeyDownCapture(key); ui.render(); ui.copy();
      assert.equal(key.defaultPrevented, true); assert.equal(key.stopped, true);
      assert.equal(ui.api.headersSelected, false, "partial columns must not highlight all headers");
      assert.deepEqual(ui.api.activeCell, { rowIndex: 720, columnIndex: column });
      const lines = ui.copied.at(-1).split("\n");
      assert.equal(lines.length, 1001); assert.equal(lines[0], `Header ${column}`);
      assert.equal(lines[1], `0:${column}`); assert.equal(lines.at(-1), "0");
      for (const col of columns) {
        assert.equal(Boolean(ui.api.cellClass(999, col)), col === column);
        assert.equal(Boolean(ui.api.headerClass(col)), col === column);
      }
    }
    assert.deepEqual(ui.writes, []);
  });
}

test("whole-column Shift arrows, Shift-click and drag expand/shrink only displayed columns and retain active row", async () => {
  const ui = harness({ rowCount: 4, columnIndexes: [-3, -2, 0, 2, 4], getHeader: col => `Header ${col}` });
  const key = name => { ui.api.shellHandlers.onKeyDownCapture(ui.event({ key: name, code: name === " " ? "Space" : name, ctrlKey: name === " ", shiftKey: name !== " " })); ui.render(); };
  ui.select(2, 0); key(" "); key("ArrowRight"); ui.copy();
  assert.equal(ui.copied.at(-1), "Header 0\tHeader 2\n0:0\t0:2\n1:0\t1:2\n2:0\t2:2\n3:0\t3:2");
  key("ArrowLeft"); assert.equal(ui.api.headerClass(2), "");
  key("ArrowLeft"); assert.match(ui.api.headerClass(-2), /selected/);
  ui.select(3, 4, { shiftKey: true }); ui.copy();
  assert.equal(ui.copied.at(-1).split("\n")[0], "Header 0\tHeader 2\tHeader 4");
  assert.deepEqual(ui.api.activeCell, { rowIndex: 2, columnIndex: 4 });
  ui.api.cellHandlers(1, -2).onMouseEnter(); ui.render(); ui.copy();
  assert.equal(ui.copied.at(-1).split("\n")[0], "Header -2\tHeader 0");
  assert.deepEqual(ui.api.activeCell, { rowIndex: 2, columnIndex: -2 });
  key("ArrowLeft"); key("ArrowLeft"); ui.copy();
  assert.equal(ui.copied.at(-1).split("\n")[0], "Header -3\tHeader -2\tHeader 0", "extension clamps at the first column");
  await ui.api.shellHandlers.onKeyDown(ui.event({ key: "ArrowDown", ctrlKey: false })); ui.render(); ui.copy();
  assert.deepEqual(ui.api.activeCell, { rowIndex: 3, columnIndex: -3 });
  assert.equal(ui.copied.at(-1), "3:-3", "ordinary arrow returns from column extent to original row");
  assert.equal(ui.api.headerClass(-3), ""); assert.deepEqual(ui.writes, []);
});

test("switching row and column modes uses original active coordinates instead of selecting the entire table", () => {
  const ui = harness({ rowCount: 4, getHeader: col => `Header ${col}` });
  const shortcut = row => { ui.api.shellHandlers.onKeyDownCapture(ui.event({ key: " ", code: "Space", ctrlKey: !row, shiftKey: row })); ui.render(); ui.copy(); };
  ui.select(2, 1); shortcut(true); shortcut(false);
  assert.equal(ui.copied.at(-1), "Header 1\n0:1\n1:1\n2:1\n3:1");
  shortcut(true);
  assert.equal(ui.copied.at(-1), "2:-3\t2:-2\t2:0\t2:1\t2:2");
  assert.deepEqual(ui.api.activeCell, { rowIndex: 2, columnIndex: 1 });
  assert.deepEqual(ui.writes, []);
});

test("column selection opens Enter/typing at the original row, then returns to cell mode", async () => {
  for (const key of ["Enter", "F2", "8"]) {
    const ui = harness({ rowCount: 4, getHeader: col => `Header ${col}` });
    ui.select(1, 0); ui.api.shellHandlers.onKeyDownCapture(ui.event({ key: " ", code: "Space" })); ui.render();
    await ui.api.shellHandlers.onKeyDown(ui.event({ key, code: key, ctrlKey: false })); ui.render(); ui.copy();
    const action = ui.writes[0].type ?? ui.writes[0].activate;
    assert.deepEqual(action.slice(0, 2), [1, 0]);
    assert.equal(ui.copied.at(-1), "1:0"); assert.equal(ui.api.headerClass(0), "");
  }
});

test("Ctrl+Space does not select empty/blocked tables or hijack editors, IME and other modifiers", () => {
  for (const overrides of [{ rowCount: 0, getHeader: col => `Header ${col}` }, { escapeBlocked: true }]) {
    const ui = harness(overrides), key = ui.event({ key: " ", code: "Space" });
    ui.api.shellHandlers.onKeyDownCapture(key); ui.render();
    assert.equal(key.defaultPrevented, undefined); assert.equal(ui.api.activeCell, null);
    assert.equal(ui.copy().defaultPrevented, undefined);
  }
  const ui = harness(); ui.select(2, 1);
  for (const fields of [{ target: new Target("input") }, { isComposing: true }, { shiftKey: true }, { metaKey: true }, { altKey: true }]) {
    const key = ui.event({ key: " ", code: "Space", ...fields });
    ui.api.shellHandlers.onKeyDownCapture(key); ui.render(); ui.copy();
    assert.equal(key.defaultPrevented, undefined); assert.equal(ui.copied.at(-1), "2:1");
  }
  ui.api.shellHandlers.onKeyDownCapture(ui.event({ key: " ", code: "Space" })); ui.render();
  ui.resetScope(); assert.equal(ui.api.activeCell, null); assert.equal(ui.api.headerClass(1), "");
  assert.equal(ui.copy().defaultPrevented, undefined); assert.deepEqual(ui.writes, []);
});

test("timesheet Option+Space selects a full column from Mac NBSP without hijacking input or mixed modifiers", () => {
  const ui = harness({ rowCount: 3, getHeader: col => `Header ${col}` });
  ui.select(1, 0);
  const fields = { key: "\u00a0", code: "Space", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true };
  const shortcut = ui.event(fields);
  ui.api.shellHandlers.onKeyDownCapture(shortcut); ui.render(); ui.copy();
  assert.equal(shortcut.defaultPrevented, true); assert.equal(shortcut.stopped, true);
  assert.deepEqual(ui.api.activeCell, { rowIndex: 1, columnIndex: 0 });
  assert.match(ui.api.headerClass(0), /selected/);
  assert.equal(ui.copied.at(-1), "Header 0\n0:0\n1:0\n2:0");

  ui.select(2, 1);
  for (const overrides of [{ target: new Target("input") }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    const ignored = ui.event({ ...fields, ...overrides });
    ui.api.shellHandlers.onKeyDownCapture(ignored); ui.render(); ui.copy();
    assert.equal(ignored.defaultPrevented, undefined); assert.equal(ignored.stopped, undefined);
    assert.equal(ui.api.headerClass(1), "");
    assert.equal(ui.copied.at(-1), "2:1");
  }
  assert.deepEqual(ui.writes, []);
});
