import assert from "node:assert/strict";
import test from "node:test";
import { nativeRowDragIds, nativeRowDropIds, nativeSelectedRowIds, toggleNativeRowSelection } from "../app/nativeRowSelection.ts";

test("explicit native row selection adds or removes individual rows without stale IDs", () => {
  let selection = { key: "project:1:2026-10", ids: [] };
  selection = toggleNativeRowSelection(selection, selection.key, [1, 2, 3], 2, true);
  selection = toggleNativeRowSelection(selection, selection.key, [1, 2, 3], 3, true);
  assert.deepEqual(selection.ids, [2, 3]);
  selection = toggleNativeRowSelection(selection, selection.key, [1, 2, 3], 2, false);
  assert.deepEqual(selection.ids, [3]);
  assert.deepEqual(toggleNativeRowSelection(selection, selection.key, [1, 2, 3], 9, true).ids, [3]);
});

test("site and month switches cannot inherit selected IDs, even when row IDs overlap", () => {
  const old = { key: "project:1:2026-10", ids: [1, 2] };
  assert.deepEqual(nativeSelectedRowIds(old, "project:2:2026-10", [1, 2]), []);
  assert.deepEqual(nativeSelectedRowIds(old, "project:1:2026-11", [1, 2]), []);
  assert.deepEqual(toggleNativeRowSelection(old, "project:2:2026-10", [1, 2], 2, true), { key: "project:2:2026-10", ids: [2] });
  assert.deepEqual(nativeSelectedRowIds({ ...old, ids: [1, 2, 2, 9] }, old.key, [1, 2]), [1, 2]);
});

test("dragging a row number moves that row or its selected block, while guards prevent all drags", () => {
  assert.deepEqual(nativeRowDragIds([2, 3], 1, false), [1]);
  assert.deepEqual(nativeRowDragIds([], 1, false), [1]);
  assert.deepEqual(nativeRowDragIds([2, 3], 2, true), []);
  const selected = [2, 3];
  const drag = nativeRowDragIds(selected, 2, false);
  assert.deepEqual(drag, [2, 3]);
  assert.notEqual(drag, selected);
  selected.pop();
  assert.deepEqual(drag, [2, 3], "the started gesture keeps its own block snapshot");
});

test("drop guards reject blocked, changed-context, removed and self-target gestures atomically", () => {
  const dragged = { key: "project:1:2026-10", ids: [2, 3] };
  assert.deepEqual(nativeRowDropIds(dragged, dragged.key, [1, 2, 3], 1, false), [2, 3]);
  assert.deepEqual(nativeRowDropIds(dragged, dragged.key, [1, 2, 3], 1, true), []);
  assert.deepEqual(nativeRowDropIds(dragged, "project:2:2026-10", [1, 2, 3], 1, false), []);
  assert.deepEqual(nativeRowDropIds(dragged, dragged.key, [1, 2], 1, false), [], "never move a partial stale selection");
  assert.deepEqual(nativeRowDropIds(dragged, dragged.key, [2, 3], 1, false), []);
  assert.deepEqual(nativeRowDropIds(dragged, dragged.key, [1, 2, 3], 2, false), []);
  assert.deepEqual(nativeRowDropIds({ ...dragged, ids: [] }, dragged.key, [1, 2, 3], 1, false), []);
});
