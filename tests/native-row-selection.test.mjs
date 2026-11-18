import assert from "node:assert/strict";
import test from "node:test";
import { nativeRowDragIds, nativeRowDropIds, nativeSelectedRowIds, selectNativeRow, toggleNativeRowSelection } from "../app/nativeRowSelection.ts";

test("explicit native row selection adds or removes individual rows without stale IDs", () => {
  let selection = { key: "project:1:2026-10", ids: [] };
  selection = toggleNativeRowSelection(selection, selection.key, [1, 2, 3], 2, true);
  selection = toggleNativeRowSelection(selection, selection.key, [1, 2, 3], 3, true);
  assert.deepEqual(selection.ids, [2, 3]);
  selection = toggleNativeRowSelection(selection, selection.key, [1, 2, 3], 2, false);
  assert.deepEqual(selection.ids, [3]);
  assert.deepEqual(toggleNativeRowSelection(selection, selection.key, [1, 2, 3], 9, true).ids, [3]);
});

const selectionKey = "personnel:1:2026-11";
const displayedIds = [40, 5, 90, 3, 12, 7];

test("Shift selects the inclusive displayed range in both directions rather than numeric ID order", () => {
  for (const [anchor, target, expected] of [[5, 3, [5, 90, 3]], [12, 5, [5, 90, 3, 12]]]) {
    const initial = selectNativeRow({ key: selectionKey, ids: [] }, selectionKey, displayedIds, anchor);
    const selected = selectNativeRow(initial, selectionKey, displayedIds, target, { shiftKey: true });
    assert.deepEqual(selected.ids, expected);
    assert.equal(selected.anchorId, anchor);
    assert.deepEqual(initial.ids, [anchor], "range selection does not mutate the previous state");
  }
});

test("repeated Shift clicks extend and shrink around the original anchor", () => {
  let selected = selectNativeRow({ key: selectionKey, ids: [] }, selectionKey, displayedIds, 90);
  selected = selectNativeRow(selected, selectionKey, displayedIds, 7, { shiftKey: true });
  assert.deepEqual(selected.ids, [90, 3, 12, 7]);
  selected = selectNativeRow(selected, selectionKey, displayedIds, 3, { shiftKey: true });
  assert.deepEqual(selected.ids, [90, 3]);
  selected = selectNativeRow(selected, selectionKey, displayedIds, 40, { shiftKey: true });
  assert.deepEqual(selected.ids, [40, 5, 90]);
  assert.equal(selected.anchorId, 90);
});

test("Ctrl and Command toggle rows and combine with Shift to add a range", () => {
  for (const modifier of ["ctrlKey", "metaKey"]) {
    let selected = selectNativeRow({ key: selectionKey, ids: [] }, selectionKey, displayedIds, 40);
    selected = selectNativeRow(selected, selectionKey, displayedIds, 90, { [modifier]: true });
    assert.deepEqual(new Set(selected.ids), new Set([40, 90]));
    assert.equal(selected.anchorId, 90);
    selected = selectNativeRow(selected, selectionKey, displayedIds, 12, { [modifier]: true, shiftKey: true });
    assert.deepEqual(new Set(selected.ids), new Set([40, 90, 3, 12]));
    assert.equal(selected.anchorId, 90);
    selected = selectNativeRow(selected, selectionKey, displayedIds, 3, { [modifier]: true });
    assert.deepEqual(new Set(selected.ids), new Set([40, 90, 12]));
    assert.equal(selected.anchorId, 3);
    selected = selectNativeRow(selected, selectionKey, displayedIds, 7);
    assert.deepEqual(selected.ids, [7], "an ordinary click replaces the whole selection");
    assert.equal(selected.anchorId, 7);
  }
});

test("Shift starts from the clicked row when selection was cleared or its context changed", () => {
  const previous = selectNativeRow({ key: selectionKey, ids: [] }, selectionKey, displayedIds, 5);
  for (const state of [
    { key: selectionKey, ids: [] },
    { key: selectionKey, ids: [], anchorId: 5 },
    { ...previous, key: "personnel:2:2026-11" },
    { ...previous, key: "personnel:1:2026-12" },
    { ...previous, key: "equipment:1:2026-11" },
  ]) {
    const selected = selectNativeRow(state, selectionKey, displayedIds, 12, { shiftKey: true });
    assert.deepEqual(selected.ids, [12]);
    assert.equal(selected.anchorId, 12);
    assert.equal(selected.key, selectionKey);
  }
});

test("a filtered-out anchor falls back to a remaining visible selection without selecting hidden rows", () => {
  const available = [40, 3, 12, 7];
  const selected = selectNativeRow({ key: selectionKey, ids: [90, 12], anchorId: 90 }, selectionKey, available, 7, { shiftKey: true });
  assert.deepEqual(selected.ids, [12, 7]);
  assert.equal(selected.anchorId, 12);
  const withoutVisibleSelection = selectNativeRow({ key: selectionKey, ids: [90], anchorId: 90 }, selectionKey, available, 7, { shiftKey: true });
  assert.deepEqual(withoutVisibleSelection.ids, [7]);
  assert.equal(withoutVisibleSelection.anchorId, 7);
});

test("invalid click targets and empty tables cannot retain hidden or duplicate selected rows", () => {
  const previous = { key: selectionKey, ids: [40, 40, 999, 12], anchorId: 40 };
  const selected = selectNativeRow(previous, selectionKey, displayedIds, 999, { shiftKey: true });
  assert.deepEqual(selected.ids, [40, 12]);
  assert.deepEqual(selectNativeRow(previous, selectionKey, [], 40, { shiftKey: true }).ids, []);
  assert.deepEqual(selectNativeRow(previous, "personnel:2:2026-11", displayedIds, 999, { ctrlKey: true }).ids, []);
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
