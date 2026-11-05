import assert from "node:assert/strict";
import test from "node:test";
import { emptyColumnGridBackground, visibleEmptyColumnEdges } from "../app/emptyColumnGrid.ts";

test("blank column edges follow scroll positions and never overlap pinned sections", () => {
  const columns = [
    { left: 0, right: 44, pinned: "left" },
    { left: 44, right: 110, pinned: "left" },
    { left: -90, right: 60, pinned: null },
    { left: 60, right: 260, pinned: null },
    { left: 260, right: 550, pinned: null },
    { left: 480, right: 600, pinned: "right" },
  ];
  assert.deepEqual(visibleEmptyColumnEdges(columns, 600), [44, 110, 260, 480, 600]);
  assert.deepEqual(visibleEmptyColumnEdges([{ left: 0, right: 200, pinned: null }, { left: 200, right: 400, pinned: null }], 320), [200]);
});

test("blank column paint deduplicates edges and ignores invalid positions", () => {
  assert.equal(emptyColumnGridBackground([]), "none");
  assert.equal(emptyColumnGridBackground([NaN, -1, 0, Infinity]), "none");
  assert.equal(emptyColumnGridBackground([44, 44], "#ddd"), "linear-gradient(to right, transparent 0px, transparent 43px, #ddd 43px, #ddd 44px, transparent 44px, transparent 100%)");
  assert.match(emptyColumnGridBackground([80.5, 44]), /43px.*44px.*79.5px.*80.5px/);
});
