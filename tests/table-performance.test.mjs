import assert from "node:assert/strict";
import test from "node:test";
import { tableRowWindow, rowScrollOffset } from "../app/tableViewport.ts";
import { createLatestRequest } from "../app/latestRequest.ts";

test("large tables mount a viewport-sized window with exact spacer heights", () => {
  for (const count of [0, 1, 2, 281, 2_000, 100_000]) {
    for (const scroll of [0, 46, 4_600, 1_000_000, 10_000_000]) {
      const range = tableRowWindow(count, scroll, 460);
      assert.ok(range.start >= 0 && range.start <= range.end && range.end <= count);
      assert.ok(range.end - range.start <= 26);
      assert.equal(range.top + (range.end - range.start) * 46 + range.bottom, count * 46);
    }
  }
});

test("viewport handles fractional row heights, resize and negative browser overscroll", () => {
  const initial = tableRowWindow(2_000, -20, 461, 46.5);
  assert.equal(initial.start, 0);
  assert.equal(initial.end, 18);
  const resized = tableRowWindow(2_000, 465, 930, 46.5);
  assert.equal(resized.start, 2);
  assert.equal(resized.end, 38);
  const filtered = tableRowWindow(2, 10_000, 930);
  assert.deepEqual(filtered, { start: 0, end: 2, top: 0, bottom: 0 });
});

test("keyboard navigation mounts distant rows before looking up a cell", () => {
  assert.equal(rowScrollOffset(2, 0, 460, 46), 0);
  assert.equal(rowScrollOffset(0, 460, 460, 46), 0);
  const offset = rowScrollOffset(1_999, 0, 460, 46);
  const range = tableRowWindow(2_000, offset, 460);
  assert.ok(range.start <= 1_999 && range.end > 1_999);
  assert.equal(offset + 460, 2_000 * 46);
});

test("new project/date reads cancel earlier reads, including already resolved responses", async () => {
  const gate = createLatestRequest();
  const first = gate.start();
  const oldResponse = Promise.resolve("old project");
  const second = gate.start();
  let accepted = "new project";
  const value = await oldResponse;
  if (!first.aborted) accepted = value;
  assert.equal(accepted, "new project");
  assert.equal(first.aborted, true);
  assert.equal(second.aborted, false);
  gate.cancel();
  assert.equal(second.aborted, true);
  assert.equal(gate.start().aborted, false);
});
