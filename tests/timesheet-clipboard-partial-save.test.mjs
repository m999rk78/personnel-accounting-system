import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Exercise the real mutation callbacks without a DOM or a live database. The
// asynchronous save results model independent successes and failures by cell.
const path = new URL("../app/useTimesheetClipboard.ts", import.meta.url);
const parsed = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
const callbackNames = ["pasteText", "deleteSelection", "undoLastChange", "rememberUndo", "forgetUndo", "createHistoryId"];
const helperNames = ["matchingClipboardChanges", "clipboardSaveResult", "partialClipboardStatus", "selectionBounds"];
const callbacks = new Map();
const helpers = new Map();
let resetScope;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.text)) helpers.set(node.name.text, node.getText(parsed));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && callbackNames.includes(node.name.text)) {
    callbacks.set(node.name.text, node.initializer.arguments[0].getText(parsed));
  }
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === "useLayoutEffect") resetScope = node.arguments[0].getText(parsed);
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.equal(callbacks.size, callbackNames.length);
assert.equal(helpers.size, helperNames.length);
assert.ok(resetScope);
const compiled = ts.transpileModule([
  ...helpers.values(),
  ...callbackNames.map(name => `const ${name} = ${callbacks.get(name)};`),
  `const resetScope = ${resetScope};`,
  `return { ${callbackNames.join(",")}, resetScope };`,
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const cell = (columnIndex, value = String(columnIndex + 1), note = `note ${columnIndex}`) => ({ rowIndex: 0, columnIndex, value, note });
const deferred = () => { let resolve; let reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };

function harness(save = async changes => changes.length, remove = save) {
  const calls = [];
  const statuses = [];
  const scope = {
    selectionRef: { current: { start: { rowIndex: 0, columnIndex: 0 }, end: { rowIndex: 0, columnIndex: 2 } } },
    dragging: { current: false },
    lastHeaderCopy: { current: null },
    rowCount: 1,
    columnCount: 3,
    selectionColumns: [0, 1, 2],
    canPaste: () => true,
    canDelete: () => true,
    previousValues: changes => changes.map(change => cell(change.columnIndex)),
    onPaste: async (changes, context) => { calls.push({ kind: "paste", changes, context }); return save(changes, context); },
    onDelete: async (changes, context) => { calls.push({ kind: "delete", changes, context }); return remove(changes, context); },
    undoStack: { current: [] },
    undoing: { current: false },
    mutation: { current: null },
    scopeVersion: { current: 0 },
    historySequence: { current: 0 },
    setStatus: status => statuses.push(status),
    clearSelection() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  };
  const api = Function(...Object.keys(scope), compiled)(...Object.values(scope));
  return { api, scope, calls, statuses };
}

test("partial paste records undo only for confirmed cells and preserves notes", async () => {
  const env = harness(async changes => ({ savedChanges: [changes[0], changes[2]], failedChanges: [changes[1]] }));
  assert.equal(await env.api.pasteText("8\t9\t10"), 2);
  assert.equal(env.calls[0].context.operation, "paste");
  assert.equal(env.scope.undoStack.current.length, 1);
  assert.equal(env.scope.undoStack.current[0].id, env.calls[0].context.historyId);
  assert.deepEqual(env.scope.undoStack.current[0].changes, [cell(0), cell(2)]);
  assert.equal(env.statuses.at(-1), "Сохранено ячеек: 2 из 3. Не сохранено: 1.");
});

test("partial deletion records only the manual values actually removed", async () => {
  const env = harness(undefined, async changes => ({ savedChanges: [changes[1]], failedChanges: [changes[0], changes[2]] }));
  assert.equal(await env.api.deleteSelection(), 1);
  assert.equal(env.calls[0].context.operation, "delete");
  assert.deepEqual(env.calls[0].changes.map(change => change.value), ["", "", ""]);
  assert.deepEqual(env.scope.undoStack.current[0].changes, [cell(1)]);
  assert.equal(env.statuses.at(-1), "Сохранено ячеек: 1 из 3. Не сохранено: 2.");
});

test("successful retry joins the original undo entry and preserves each original value", async () => {
  const env = harness(async changes => ({ savedChanges: [changes[0], changes[2]], failedChanges: [changes[1]] }));
  await env.api.pasteText("8\t9\t10");
  const id = env.calls[0].context.historyId;
  env.api.rememberUndo([cell(1)], id);
  env.api.rememberUndo([cell(0, "wrong replacement")], id);
  assert.equal(env.scope.undoStack.current.length, 1, "Retry must not create a second undo step");
  assert.deepEqual(env.scope.undoStack.current[0].changes, [cell(0), cell(2), cell(1)]);
});

test("partially failed undo retries only its remaining cells with the same history ID", async () => {
  let attempt = 0;
  const env = harness(async changes => {
    attempt++;
    return attempt === 1 ? { savedChanges: [changes[0], changes[2]], failedChanges: [changes[1]] } : { savedChanges: changes, failedChanges: [] };
  });
  env.api.rememberUndo([cell(0), cell(1), cell(2)], "original");
  await env.api.undoLastChange();
  assert.equal(env.calls[0].context.operation, "undo");
  assert.equal(env.calls[0].context.historyId, "original");
  assert.deepEqual(env.scope.undoStack.current, [{ id: "original", changes: [cell(1)] }]);
  await env.api.undoLastChange();
  assert.deepEqual(env.calls[1].changes, [cell(1)]);
  assert.equal(env.calls[1].context.historyId, "original");
  assert.deepEqual(env.scope.undoStack.current, []);
});

test("retry completion removes only the matching failed undo entry", () => {
  const env = harness();
  env.api.rememberUndo([cell(0), cell(1)], "first");
  env.api.rememberUndo([cell(0), cell(2)], "second");
  env.api.forgetUndo("first", [cell(0)]);
  assert.deepEqual(env.scope.undoStack.current, [
    { id: "first", changes: [cell(1)] },
    { id: "second", changes: [cell(0), cell(2)] },
  ]);
  env.api.forgetUndo("first", [cell(1)]);
  assert.deepEqual(env.scope.undoStack.current, [{ id: "second", changes: [cell(0), cell(2)] }]);
});

test("total failure does not create undo for changes that were never saved", async () => {
  const env = harness(async changes => ({ savedChanges: [], failedChanges: changes }));
  assert.equal(await env.api.pasteText("8\t9\t10"), 0);
  assert.deepEqual(env.scope.undoStack.current, []);
  assert.equal(env.statuses.at(-1), "Сохранено ячеек: 0 из 3. Не сохранено: 3.");
});

test("changing the table scope discards late paste history and status", async () => {
  const pending = deferred();
  const env = harness(() => pending.promise);
  const paste = env.api.pasteText("8\t9\t10");
  env.api.resetScope();
  const statusCount = env.statuses.length;
  pending.resolve(3);
  assert.equal(await paste, 0);
  assert.equal(env.statuses.length, statusCount, "A previous month cannot replace the current status");
  assert.deepEqual(env.scope.undoStack.current, []);
});

test("in-flight paste prevents simultaneous paste, deletion and undo", async () => {
  const pending = deferred();
  const env = harness(() => pending.promise);
  env.api.rememberUndo([cell(0)], "older");
  const paste = env.api.pasteText("8\t9\t10");
  assert.equal(await env.api.pasteText("5"), 0);
  assert.equal(await env.api.deleteSelection(), 0);
  await env.api.undoLastChange();
  assert.equal(env.calls.length, 1);
  assert.equal(env.scope.undoStack.current[0].id, "older");
  pending.resolve(3);
  await paste;
  assert.equal(env.scope.mutation.current, null);
});

test("late completion in an old scope cannot unlock an operation in a new scope", async () => {
  const oldSave = deferred();
  const newSave = deferred();
  let calls = 0;
  const env = harness(() => ++calls === 1 ? oldSave.promise : newSave.promise);
  const oldPaste = env.api.pasteText("8\t9\t10");
  env.api.resetScope();
  env.scope.selectionRef.current = { start: { rowIndex: 0, columnIndex: 0 }, end: { rowIndex: 0, columnIndex: 2 } };
  const newPaste = env.api.pasteText("5\t6\t7");
  oldSave.resolve(3);
  await oldPaste;
  assert.notEqual(env.scope.mutation.current, null);
  assert.equal(await env.api.deleteSelection(), 0);
  assert.equal(env.calls.length, 2);
  newSave.resolve(3);
  await newPaste;
  assert.equal(env.scope.undoStack.current.length, 1);
});

test("a failed old-scope undo cannot put stale changes back into the new undo stack", async () => {
  const pending = deferred();
  const env = harness(() => pending.promise);
  env.api.rememberUndo([cell(0)], "old");
  const undo = env.api.undoLastChange();
  env.api.resetScope();
  env.api.rememberUndo([cell(2)], "new");
  const statusCount = env.statuses.length;
  pending.reject(new Error("offline"));
  await undo;
  assert.equal(env.statuses.length, statusCount);
  assert.deepEqual(env.scope.undoStack.current, [{ id: "new", changes: [cell(2)] }]);
});

test("legacy numeric save results retain their existing clipboard behavior", async () => {
  const env = harness();
  assert.equal(await env.api.pasteText("8\t9\t10"), 3);
  assert.deepEqual(env.scope.undoStack.current[0].changes, [cell(0), cell(1), cell(2)]);
  assert.equal(env.statuses.at(-1), "Вставлено ячеек: 3");
});
