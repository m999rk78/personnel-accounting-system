import assert from "node:assert/strict";
import test from "node:test";
import { choiceMenuPosition } from "../app/choiceMenuLayout.ts";

test("choice menus expand beyond narrow fields and remain inside small viewports", () => {
  for (const width of [240, 320, 768, 1440]) {
    for (const height of [240, 480, 900]) {
      for (const left of [8, width / 2, width - 80]) {
        for (const top of [8, height / 2, height - 48]) {
          const result = choiceMenuPosition({ left, top, bottom: top + 40, width: 72 }, { width, height }, 640);
          assert.ok(result.left >= 8);
          assert.ok(result.left + result.width <= width - 8);
          assert.ok(result.maxHeight >= 0);
          const popupTop = result.top ?? height - result.bottom - result.maxHeight;
          assert.ok(popupTop >= 8);
          assert.ok(popupTop + result.maxHeight <= height - 8);
        }
      }
    }
  }
});

test("choice menus open above bottom-edge fields with room for wrapped rows", () => {
  const result = choiceMenuPosition({ left: 920, top: 700, bottom: 740, width: 180 }, { width: 1200, height: 768 }, 600);
  assert.equal(result.placement, "top");
  assert.equal(result.bottom, 74);
  assert.equal(result.maxHeight, 420);
  assert.equal(result.width, 600);
});

test("short screens limit menu height to the available space", () => {
  const result = choiceMenuPosition({ left: 10, top: 100, bottom: 140, width: 200 }, { width: 320, height: 240 }, 600);
  assert.equal(result.placement, "bottom");
  assert.equal(result.maxHeight, 86);
});
