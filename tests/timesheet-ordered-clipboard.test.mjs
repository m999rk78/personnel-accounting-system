import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const originalPath = new URL("../app/useTimesheetClipboard.ts", import.meta.url);
const original = ts.createSourceFile(originalPath.pathname, await readFile(originalPath, "utf8"), ts.ScriptTarget.Latest, true);
const callbacks = new Map(), helpers = new Map();
const callbackNames = ["selectedText", "pasteText", "deleteSelection", "undoLastChange", "rememberUndo", "forgetUndo", "createHistoryId", "previousValues"];
const helperNames = ["matchingClipboardChanges", "clipboardSaveResult", "clipboardUndoChanges", "rebaseClipboardUndoHistory", "partialClipboardStatus", "selectionBounds", "selectionRanges", "selectionHasCell", "selectionAxes"];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.text)) helpers.set(node.name.text, node.getText(original));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && callbackNames.includes(node.name.text)) callbacks.set(node.name.text, node.initializer.arguments[0].getText(original));
  ts.forEachChild(node, visit);
}
visit(original);
assert.equal(callbacks.size, callbackNames.length);
assert.equal(helpers.size, helperNames.length);
const engineCode = ts.transpileModule([...helpers.values(), ...callbackNames.map(name => `const ${name} = ${callbacks.get(name)};`), `return { ${callbackNames.join(",")} };`].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const adapterSource = (await readFile(new URL("../app/useOrderedTimesheetClipboard.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function useOrderedTimesheetClipboard", "function useOrderedTimesheetClipboard");
const adapterCode = ts.transpileModule(`${adapterSource}\nreturn useOrderedTimesheetClipboard;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(overrides = {}) {
  const engines = [], calls = [];
  const options = {
    rowCount: 2, columnCount: 3, columnIndexes: [-5, 2, -2, 0, 1, 3], resetKey: "workers:month",
    getValue: (row, column) => `r${row}c${column}`, getHeader: column => `header ${column}`,
    getUndoValue: (row, column) => `before ${row}:${column}`,
    getUndoNote: (_row, column) => `note ${column}`,
    canPaste: (_row, column) => column >= 0 && column < 3,
    canDelete: () => true,
    onPaste: async (changes, context) => { calls.push({ changes, context }); return changes.length; },
    onDelete: async (changes, context) => { calls.push({ changes, context }); return changes.length; },
    ...overrides,
  };
  const hook = Function("useTimesheetClipboard", adapterCode)(mapped => {
    const scope = {
      ...mapped, selectionColumns: mapped.columnIndexes,
      selectionRef: { current: { start: { rowIndex: 0, columnIndex: 0 }, end: { rowIndex: 0, columnIndex: mapped.columnCount - 1 } } },
      dragging: { current: false }, lastHeaderCopy: { current: null },
      undoStack: { current: [] }, undoing: { current: false }, mutation: { current: null },
      scopeVersion: { current: 0 }, historySequence: { current: 0 },
      setStatus() {},
    };
    const api = Function(...Object.keys(scope), engineCode)(...Object.values(scope));
    const engine = { options: mapped, scope, api, remembered: [], forgotten: [], focused: null, activated: null };
    engines.push(engine);
    return {
      activeCell: { rowIndex: 1, columnIndex: 1 },
      focusCell: (row, column) => { engine.focused = { row, column }; },
      cellClass: (row, column) => `selected-${row}-${column}`,
      headerClass: column => `header-${column}`,
      cellHandlers: (row, column) => ({ "data-timesheet-row": row, "data-timesheet-column": column }),
      rememberUndo: api.rememberUndo,
      forgetUndo: api.forgetUndo,
      contextMenu: "menu", status: "ready", shellHandlers: {},
    };
  });
  const render = next => hook({ ...options, ...next });
  const view = render();
  return { view, engines, calls, render, options };
}

test("copy uses displayed order for rectangles and disjoint cells, including pinned days and read-only columns", () => {
  const { engines } = harness();
  const { scope, api } = engines[0];
  scope.selectionRef.current = { start: { rowIndex: 0, columnIndex: 1 }, end: { rowIndex: 0, columnIndex: 4 }, includeHeaders: true };
  assert.equal(api.selectedText(), "header 2\theader -2\theader 0\theader 1\nr0c2\tr0c-2\tr0c0\tr0c1");
  scope.selectionRef.current = { start: { rowIndex: 0, columnIndex: 1 }, end: { rowIndex: 0, columnIndex: 1 }, additionalRanges: [{ start: { rowIndex: 1, columnIndex: 3 }, end: { rowIndex: 1, columnIndex: 3 } }] };
  assert.equal(api.selectedText(), "r0c2\t\n\tr1c0");
});

test("paste maps visible positions to source dates and skips metadata and calculated totals", async () => {
  const { engines, calls } = harness();
  assert.equal(await engines[0].api.pasteText("number\t8\tname\t6\t4\ttotal"), 3);
  assert.deepEqual(calls[0].changes, [
    { rowIndex: 0, columnIndex: 2, value: "8" },
    { rowIndex: 0, columnIndex: 0, value: "6" },
    { rowIndex: 0, columnIndex: 1, value: "4" },
  ]);
  assert.deepEqual(engines[0].scope.undoStack.current[0].changes.map(change => [change.columnIndex, change.note]), [[1, "note 2"], [3, "note 0"], [4, "note 1"]]);
});

test("partial-save results and acknowledged revisions return to their visual cells, and undo sends canonical dates", async () => {
  const calls = [];
  const { engines } = harness({ onPaste: async (changes, context) => {
    calls.push({ changes, context });
    return { savedChanges: [changes[0]], failedChanges: changes.slice(1), revisions: [{ rowIndex: 0, columnIndex: changes[0].columnIndex, expectedRevision: "v2", previousRevision: "v1" }] };
  } });
  await engines[0].api.pasteText("number\t8\tname\t6\t4\ttotal");
  assert.equal(engines[0].scope.undoStack.current[0].changes.length, 1);
  assert.deepEqual(engines[0].scope.undoStack.current[0].changes[0], { rowIndex: 0, columnIndex: 1, value: "before 0:2", note: "note 2", expectedRevision: "v2", previousRevision: "v1" });
  await engines[0].api.undoLastChange();
  assert.equal(calls[1].context.operation, "undo");
  assert.deepEqual(calls[1].changes, [{ rowIndex: 0, columnIndex: 2, value: "before 0:2", note: "note 2", expectedRevision: "v2", previousRevision: "v1" }]);
});

test("delete and manual undo registration retain source identity after pinning", async () => {
  const { view, engines, calls } = harness();
  await engines[0].api.deleteSelection();
  assert.deepEqual(calls[0].changes.map(change => change.columnIndex), [2, 0, 1]);
  view.rememberUndo([{ rowIndex: 1, columnIndex: 0, value: "old", expectedRevision: "v3" }], "inline");
  assert.deepEqual(engines[0].scope.undoStack.current.at(-1).changes, [{ rowIndex: 1, columnIndex: 3, value: "old", expectedRevision: "v3" }]);
  view.forgetUndo("inline", [{ rowIndex: 1, columnIndex: 0, value: "old" }]);
  assert.equal(engines[0].scope.undoStack.current.some(entry => entry.id === "inline"), false);
});

test("cell DOM coordinates stay visual while public focus, selection and adjacent navigation stay canonical", () => {
  const { view, engines } = harness();
  assert.deepEqual(view.activeCell, { rowIndex: 1, columnIndex: 2 });
  assert.deepEqual(view.cellHandlers(1, 0), { "data-timesheet-row": 1, "data-timesheet-column": 3 });
  assert.equal(view.cellClass(1, 0), "selected-1-3");
  assert.equal(view.headerClass(0), "header-3");
  assert.equal(view.headerClass(99), "");
  assert.deepEqual(view.cellHandlers(1, 99), {});
  view.focusCell(1, 0);
  assert.deepEqual(engines[0].focused, { row: 1, column: 3 });
  assert.equal(view.adjacentColumn(0, -1), -2);
  assert.equal(view.adjacentColumn(2, 1), -2);
  assert.equal(view.adjacentColumn(-5, -1), -5);
  assert.equal(view.adjacentColumn(3, 1), 3);
});

test("activation and typing translate dates while refusing read-only metadata and totals", () => {
  const calls = [];
  const { engines } = harness({ onActivate: (...args) => calls.push(["activate", ...args]), onType: (...args) => calls.push(["type", ...args]) });
  const mapped = engines[0].options;
  const anchor = {};
  mapped.onActivate(1, 1, anchor);
  mapped.onType(0, 3, anchor, "9");
  mapped.onActivate(1, 2, anchor);
  mapped.onType(0, 5, anchor, "9");
  assert.deepEqual(calls, [["activate", 1, 2, anchor], ["type", 0, 0, anchor, "9"]]);
});

test("an in-flight save retains its own mapping when a later render changes pinned order", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const { engines, render } = harness({ onPaste: async changes => { calls.push(changes); await pending; return { savedChanges: changes, failedChanges: [] }; } });
  const saving = engines[0].api.pasteText("number\t8\tname\t6\t4\ttotal");
  render({ columnIndexes: [-5, -2, 0, 1, 2, 3] });
  release();
  assert.equal(await saving, 3);
  assert.deepEqual(calls[0].map(change => change.columnIndex), [2, 0, 1]);
  assert.deepEqual(engines[0].scope.undoStack.current[0].changes.map(change => change.columnIndex), [1, 3, 4]);
  assert.notEqual(engines[0].options.resetKey, engines[1].options.resetKey, "Selection/history cannot be reinterpreted under a different arrangement");
});
