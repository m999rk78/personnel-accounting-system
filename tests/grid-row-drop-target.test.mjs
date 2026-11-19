import assert from "node:assert/strict";
import test from "node:test";
import { resolveGridRowDropTarget } from "../app/gridRowDropTarget.ts";

function fixture() {
  const grid = {};
  const otherGrid = {};
  const nodes = [0, 1, 2].map(index => ({ id: String(index), data: { id: index + 1 }, rowTop: index * 44, rowHeight: 44, rowIndex: index }));
  const rows = nodes.map((node, index) => ({
    index: String(index), grid, top: 50 + index * 44,
    closest() { return this.grid; },
    getAttribute(name) { return name === "row-index" ? this.index : null; },
    getBoundingClientRect() { return { top: this.top, bottom: this.top + 44, height: 44 }; },
  }));
  const root = {
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, right: 500, top: 0, bottom: 300 }),
    querySelector: selector => selector === ".ag-root" ? grid : { getBoundingClientRect: () => ({ left: 0, right: 500, top: 50, bottom: 270 }) },
    querySelectorAll: () => rows,
  };
  const api = { isDestroyed: () => false, getRowNode: id => nodes.find(node => node.id === id), getDisplayedRowAtIndex: index => nodes[index] };
  const event = { api, node: nodes[0], nodes: [nodes[0]], overNode: nodes[0], overIndex: 0, y: 1, event: { clientX: 20, clientY: 100 } };
  const getMove = e => e.overNode === e.node ? null : { movingIds: [e.node.data.id], targetId: e.overNode.data.id, placement: e.y < e.overNode.rowTop + e.overNode.rowHeight / 2 ? "before" : "after" };
  return { root, rows, grid, otherGrid, nodes, event, getMove, resolve: () => resolveGridRowDropTarget(root, event, getMove) };
}

test("before/after preview follows the actual pointer half and preserves the saved move", () => {
  const f = fixture();
  const before = f.resolve();
  assert.equal(before.row, f.rows[1]);
  assert.equal(before.rowNumber, 2);
  assert.deepEqual(before.operation, { movingIds: [1], targetId: 2, placement: "before" });
  f.event.event.clientY = 120;
  assert.deepEqual(f.resolve().operation, { movingIds: [1], targetId: 2, placement: "after" });
});

test("stationary cursor follows newly rendered rows after autoscroll, ignoring stale AG overNode", () => {
  const f = fixture();
  assert.equal(f.resolve().operation.targetId, 2);
  f.rows[1].index = "2";
  assert.equal(f.resolve().operation.targetId, 3);
  assert.equal(f.resolve().rowNumber, 3);
  assert.equal(f.resolve().operation.placement, "before");
});

test("both preview and drop reject a target inside the selected block", () => {
  const f = fixture();
  f.event.event.clientY = 60;
  assert.equal(f.resolve(), null);
  const blocked = () => null;
  f.event.event.clientY = 100;
  assert.equal(resolveGridRowDropTarget(f.root, f.event, blocked), null);
});

test("nested detail grids and external source grids cannot become same-grid targets", () => {
  const f = fixture();
  f.rows[1].grid = f.otherGrid;
  assert.equal(f.resolve(), null);
  f.rows[1].grid = f.grid;
  f.event.node = { ...f.nodes[0] };
  assert.equal(f.resolve(), null);
});

test("detail, pinned, missing, and blank rows are never offered as insertion destinations", () => {
  for (const variant of ["detail", "pinned", "missing", "blank", "pinnedIndex"]) {
    const f = fixture();
    if (variant === "detail") f.nodes[1].detail = true;
    if (variant === "pinned") f.nodes[1].rowPinned = "top";
    if (variant === "missing") f.rows[1].index = "10";
    if (variant === "blank") delete f.nodes[1].data;
    if (variant === "pinnedIndex") f.rows[1].index = "t-1";
    assert.equal(f.resolve(), null, variant);
  }
});

test("pointer outside visible body, header, and invalid coordinates hide the target", () => {
  for (const [clientX, clientY] of [[-1, 100], [500, 100], [20, 49], [20, 270], [NaN, 100]]) {
    const f = fixture();
    f.event.event = { clientX, clientY };
    assert.equal(f.resolve(), null);
  }
});

test("touch input uses the same placement and does not invent a target after unmount", () => {
  const f = fixture();
  f.event.event = { touches: [{ clientX: 20, clientY: 120 }], changedTouches: [] };
  assert.equal(f.resolve().operation.placement, "after");
  f.root.isConnected = false;
  assert.equal(f.resolve(), null);
  f.root.isConnected = true;
  f.event.api.isDestroyed = () => true;
  assert.equal(f.resolve(), null);
});

test("multi-row operation and displayed-order metadata are passed through unchanged", () => {
  const f = fixture();
  const move = { movingIds: [1, 3], targetId: 2, placement: "after", displayedIds: [3, 1, 2] };
  assert.deepEqual(resolveGridRowDropTarget(f.root, f.event, () => move).operation, move);
});
