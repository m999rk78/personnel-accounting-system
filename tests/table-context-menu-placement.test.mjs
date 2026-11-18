import assert from "node:assert/strict";
import test from "node:test";
import { placeTableContextMenu } from "../app/tableContextMenuPlacement.ts";

function place(overrides = {}) {
  const input = { x: 90, y: 400, width: 288, height: 158, viewportWidth: 390, viewportHeight: 844, ...overrides };
  return { ...placeTableContextMenu(input), width: input.width, height: Math.min(input.height, placeTableContextMenu(input).maxHeight) };
}

function assertNoOverlap(panel, anchor) {
  assert.ok(panel.left + panel.width <= anchor.left || panel.left >= anchor.right || panel.top + panel.height <= anchor.top || panel.top >= anchor.bottom,
    "The submenu must not capture the click that opens its parent trigger");
}

test("390px menu opens below its trigger without replacing the pending click with navigation", () => {
  const anchor = { left: 97, right: 371, top: 438, bottom: 474 };
  const panel = place({ anchor });
  assert.equal(panel.top, anchor.bottom);
  assert.equal(panel.left, 94);
  assertNoOverlap(panel, anchor);
  const click = { x: 220, y: 456 };
  assert.equal(click.x >= panel.left && click.x < panel.left + panel.width && click.y >= panel.top && click.y < panel.top + panel.height, false);
});

test("desktop flyouts keep right placement and flip left only when the full width fits", () => {
  const anchor = { left: 400, right: 674, top: 200, bottom: 236 };
  const right = place({ anchor, viewportWidth: 1200 });
  assert.equal(right.left, anchor.right);
  assert.equal(right.top, anchor.top);
  assertNoOverlap(right, anchor);
  const left = place({ anchor, viewportWidth: 800 });
  assert.equal(left.left + left.width, anchor.left);
  assert.equal(left.top, anchor.top);
  assertNoOverlap(left, anchor);
});

test("narrow flyout above a bottom trigger remains within the viewport", () => {
  const anchor = { left: 97, right: 371, top: 750, bottom: 786 };
  const panel = place({ anchor });
  assert.equal(panel.top + panel.height, anchor.top);
  assertNoOverlap(panel, anchor);
});

test("long narrow flyouts scroll in the larger space and never overlap their trigger", () => {
  for (const viewportHeight of [180, 390, 844]) {
    for (const top of [8, Math.floor(viewportHeight / 2), viewportHeight - 44]) {
      const anchor = { left: 15, right: 275, top, bottom: top + 36 };
      const panel = place({ anchor, viewportHeight, height: 1000 });
      assert.equal(panel.maxHeight, Math.max(anchor.top - 8, viewportHeight - 8 - anchor.bottom));
      assertNoOverlap(panel, anchor);
      assert.ok(panel.top >= 8);
      assert.ok(panel.top + panel.height <= viewportHeight - 8);
    }
  }
});

test("root menus and sideways flyouts clamp to viewport edges and retain scroll space", () => {
  const root = place({ x: 389, y: 843, height: 1000 });
  assert.equal(root.left, 94);
  assert.equal(root.top, 8);
  assert.equal(root.maxHeight, 828);
  const anchor = { left: 400, right: 674, top: 790, bottom: 826 };
  const panel = place({ anchor, viewportWidth: 1200 });
  assert.equal(panel.top + panel.height, 836);
  assertNoOverlap(panel, anchor);
});
