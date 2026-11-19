import assert from "node:assert/strict";
import test from "node:test";
import { createDraftUndo } from "../app/useDraftUndo.ts";

function fixture(initial = { name: "Исходное", permissions: { view: true }, projectAccess: { mode: "selected", siteIds: [1] } }, nativeTextFields = []) {
  const history = createDraftUndo(initial, "entity:1:revision:1", nativeTextFields);
  let value = structuredClone(initial), scope = "entity:1:revision:1";
  let restored = [];
  const replace = next => { value = next; restored.push(structuredClone(next)); };
  history.synchronize(value, scope, replace);
  return { history, get value() { return value; }, get restored() { return restored; },
    change(next) { value = structuredClone(next); history.synchronize(value, scope, replace); },
    acknowledge() { history.synchronize(value, scope, replace); },
    switchScope(next, key) { value = next; scope = key; history.synchronize(value, scope, replace); },
  };
}

test("draft history restores a full permission and project snapshot together", () => {
  const f = fixture(), original = structuredClone(f.value);
  f.change({ ...f.value, name: "Изменено", permissions: { view: false }, projectAccess: { mode: "all", siteIds: [] } });
  assert.equal(f.history.getSnapshot().canUndo, true);
  f.history.undo(); f.acknowledge();
  assert.deepEqual(f.value, original);
  assert.deepEqual(f.history.getSnapshot(), { canUndo: false, canRedo: true });
  f.history.redo(); f.acknowledge();
  assert.equal(f.value.name, "Изменено");
  assert.equal(f.value.permissions.view, false);
  assert.deepEqual(f.value.projectAccess, { mode: "all", siteIds: [] });
});

test("changing user, role, project or saved revision discards the prior scope", () => {
  const f = fixture();
  f.change({ ...f.value, name: "Правка" });
  const next = { ...f.value, name: "Сохранено сервером" };
  f.switchScope(next, "entity:1:revision:2");
  assert.deepEqual(f.history.getSnapshot(), { canUndo: false, canRedo: false });
  f.history.undo(); assert.deepEqual(f.value, next);
  f.change({ ...f.value, name: "Вторая правка" });
  f.switchScope(next, "entity:2:revision:1");
  assert.equal(f.history.getSnapshot().canUndo, false);
});

test("explicit reset after save or cancel cannot resurrect previous draft changes", () => {
  const f = fixture();
  f.change({ ...f.value, name: "Правка" });
  f.history.undo(); f.acknowledge();
  f.history.reset(f.value);
  f.history.redo();
  assert.equal(f.value.name, "Исходное");
  assert.deepEqual(f.history.getSnapshot(), { canUndo: false, canRedo: false });
});

test("rapid undo and redo survive batched or delayed controlled acknowledgements", () => {
  const f = fixture({ n: 0 });
  for (let n = 1; n <= 3; n++) f.change({ n });
  f.history.undo(); f.history.undo();
  assert.deepEqual(f.value, { n: 1 });
  f.acknowledge();
  f.history.redo(); f.history.redo(); f.acknowledge();
  assert.deepEqual(f.value, { n: 3 });
  assert.equal(f.history.getSnapshot().canRedo, false);
});

test("new changes invalidate redo while unchanged renders add no history", () => {
  const f = fixture({ n: 0 });
  f.acknowledge(); assert.equal(f.history.getSnapshot().canUndo, false);
  f.change({ n: 1 }); f.history.undo(); f.acknowledge();
  f.change({ n: 2 });
  assert.equal(f.history.getSnapshot().canRedo, false);
  f.history.undo(); f.acknowledge();
  assert.deepEqual(f.value, { n: 0 });
});

test("history copies nested drafts and is limited to fifty reversible changes", () => {
  const f = fixture({ n: 0, projectAccess: { siteIds: [1] } });
  for (let n = 1; n <= 60; n++) f.change({ n, projectAccess: { siteIds: [n] } });
  f.value.projectAccess.siteIds.push(999);
  for (let i = 0; i < 55; i++) f.history.undo();
  f.acknowledge();
  assert.deepEqual(f.value, { n: 10, projectAccess: { siteIds: [10] } });
  assert.equal(f.history.getSnapshot().canUndo, false);
});

test("a rejected restoration does not consume the pending undo step", () => {
  const f = fixture({ n: 0 }); f.change({ n: 1 });
  f.history.synchronize(f.value, "entity:1:revision:1", () => { throw new Error("Rejected"); });
  assert.throws(() => f.history.undo(), /Rejected/);
  assert.deepEqual(f.history.getSnapshot(), { canUndo: true, canRedo: false });
  f.acknowledge(); f.history.undo();
  assert.deepEqual(f.value, { n: 0 });
});

test("native text undo/redo rebases only text and retains interleaved checkbox history", () => {
  const f = fixture({ name: "Исходное", checked: false }, ["name"]);
  f.change({ name: "Исходное A", checked: false });
  f.change({ name: "Исходное AB", checked: false });
  f.change({ name: "Исходное AB", checked: true });
  f.history.noteNativeHistory("undo");
  f.change({ name: "Исходное", checked: true });
  f.history.undo(); f.acknowledge();
  assert.deepEqual(f.value, { name: "Исходное", checked: false }, "After blur, app undo reaches the prior checkbox instead of reapplying text");
  f.history.redo(); f.acknowledge();
  f.history.noteNativeHistory("redo");
  f.change({ name: "Исходное AB", checked: true });
  f.history.undo(); f.acknowledge();
  assert.deepEqual(f.value, { name: "Исходное AB", checked: false }, "Native redo does not replace unrelated checkbox state");
});
