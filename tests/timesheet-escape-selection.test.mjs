import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { nativeRowDropIds } from "../app/nativeRowSelection.ts";

// Run the clipboard hook's real Escape contract without mounting a database-backed
// page. The shared keyboard hook covers DOM/editor routing in its own tests.
const path = new URL("../app/useTimesheetClipboard.ts", import.meta.url);
const source = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
const callbacks = new Map();
let escapeOptions;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["clearSelection", "selectCell", "extendSelection"].includes(node.name.text)) {
    callbacks.set(node.name.text, node.initializer.arguments[0].getText(source));
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useTableEscapeSelection") escapeOptions = node.arguments[0].getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(callbacks.size, 3);
assert.ok(escapeOptions);
const compiled = ts.transpileModule([
  ...[...callbacks].map(([name, callback]) => `const ${name} = ${callback};`),
  `return { options: ${escapeOptions}, selectCell, extendSelection };`,
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness({ cells = true, rows = true, blocked = false, menu = null, mounted = true } = {}) {
  const updates = { selection: undefined, status: "Copied", menu, rowClears: 0 };
  const scope = {
    selectionRef: { current: cells ? { start: { rowIndex: 1, columnIndex: 2 }, end: { rowIndex: 4, columnIndex: 5 } } : null },
    dragging: { current: true },
    setSelection: selection => { updates.selection = selection; },
    setStatus: status => { updates.status = status; },
    setContextMenu: contextMenu => { updates.menu = contextMenu; },
    hasSelectedRows: rows,
    onClearRowSelection: () => { updates.rowClears++; },
    escapeBlocked: blocked,
    contextMenu: menu,
    shellRef: { current: mounted ? { focus() {} } : null },
  };
  const api = Function(...Object.keys(scope), compiled)(...Object.values(scope));
  return { ...api, scope, updates };
}

test("Escape clears both selected rows and a cell range, and cancels its drag", () => {
  const env = harness();
  assert.equal(env.options.hasSelection(), true);
  assert.equal(env.options.isEditing(), false);
  env.options.clearSelection();
  assert.equal(env.scope.selectionRef.current, null);
  assert.equal(env.scope.dragging.current, false);
  assert.equal(env.updates.selection, null);
  assert.equal(env.updates.status, "");
  assert.equal(env.updates.menu, null);
  assert.equal(env.updates.rowClears, 1);
  env.extendSelection(8, 9);
  assert.equal(env.scope.selectionRef.current, null, "A cancelled drag cannot recreate the range");
});

test("Escape also reaches row-only and range-only selection", () => {
  for (const selection of [{ cells: false, rows: true }, { cells: true, rows: false }]) {
    const env = harness(selection);
    assert.equal(env.options.hasSelection(), true);
    env.options.clearSelection();
    assert.equal(env.scope.selectionRef.current, null);
    assert.equal(env.updates.rowClears, 1);
  }
  assert.equal(harness({ cells: false, rows: false }).options.hasSelection(), false);
});

test("the next Shift-click starts a new range after Escape", () => {
  const env = harness();
  env.options.clearSelection();
  env.selectCell(8, 9, { button: 0, shiftKey: true, preventDefault() {} });
  assert.deepEqual(env.scope.selectionRef.current, {
    start: { rowIndex: 8, columnIndex: 9 },
    end: { rowIndex: 8, columnIndex: 9 },
  });
});

test("editors, filters, cell menus and unmounted tables keep their selection for cancellation", () => {
  for (const state of [{ blocked: true }, { menu: { rowIndex: 1 } }, { mounted: false }]) {
    const env = harness(state);
    assert.equal(env.options.isEditing(), true);
    assert.notEqual(env.scope.selectionRef.current, null);
    assert.equal(env.updates.rowClears, 0);
  }
});

const rowMovePath = new URL("../app/TableRowMoves.tsx", import.meta.url);
const rowMoveSource = ts.createSourceFile(rowMovePath.pathname, await readFile(rowMovePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const rowMoveCallbacks = new Map();
function visitRowMoves(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["clearSelection", "rowProps"].includes(node.name.text)) {
    rowMoveCallbacks.set(node.name.text, node.initializer.getText(rowMoveSource));
  }
  ts.forEachChild(node, visitRowMoves);
}
visitRowMoves(rowMoveSource);
assert.equal(rowMoveCallbacks.size, 2);
const rowMoveCode = ts.transpileModule([
  ...[...rowMoveCallbacks].map(([name, callback]) => `const ${name} = ${callback};`),
  "return { clearSelection, rowProps };",
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("a saved row drop selects its moved block, but cannot restore selection cleared while saving", async () => {
  for (const cancelWhileSaving of [false, true]) {
    const key = "personnel:1:2026-11";
    let selection = { key, ids: [] };
    let finishSave;
    const saving = new Promise(resolve => { finishSave = resolve; });
    const requests = [];
    const scope = {
      key,
      selected: [],
      dragged: { current: { key, ids: [2] } },
      trailingClick: { current: { key, id: 2 } },
      selectionRevision: { current: 0 },
      context: { ids: [1, 2, 3] },
      blocked: false,
      stopDragScroll() {},
      nativeRowDropIds,
      order: { move: operation => { requests.push(operation); return saving; } },
      setSelection: update => { selection = typeof update === "function" ? update(selection) : update; },
    };
    const api = Function(...Object.keys(scope), rowMoveCode)(...Object.values(scope));
    api.rowProps(1).onDrop({
      clientY: 4,
      currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 30 }) },
      preventDefault() {}, stopPropagation() {},
    });
    assert.deepEqual(requests, [{ movingIds: [2], placement: "before", targetId: 1 }]);
    if (cancelWhileSaving) api.clearSelection();
    finishSave(true);
    await saving;
    assert.deepEqual(selection.ids, cancelWhileSaving ? [] : [2]);
  }
});
