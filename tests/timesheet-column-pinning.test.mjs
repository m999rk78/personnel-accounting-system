import assert from "node:assert/strict";
import test from "node:test";
import { applyTimesheetColumnPins, canPinTimesheetColumn, getTimesheetColumnPin, readTimesheetColumnPins } from "../app/timesheetColumnPinning.ts";
import { boundedTimesheetWidth, timesheetColumnLayout, timesheetResizeReferenceWidth, timesheetSizingColumns } from "../app/timesheetColumnSizing.ts";

for (const kind of ["workers", "equipment"]) {
  test(`${kind}: defaults preserve metadata pins and natural column order`, () => {
    const columns = timesheetSizingColumns(kind, 31);
    const applied = applyTimesheetColumnPins(columns, {});
    assert.deepEqual(applied.map(column => column.id), columns.map(column => column.id));
    for (const column of applied) assert.equal(column.pinSide ?? null, getTimesheetColumnPin(columns.find(original => original.id === column.id), {}));
    assert.deepEqual(columns.filter(column => column.sticky).map(column => column.id), applied.filter(column => column.pinSide === "left").map(column => column.id));
  });

  test(`${kind}: a date and total can pin to either side while metadata can unpin`, () => {
    const columns = timesheetSizingColumns(kind, 5);
    const identity = kind === "workers" ? "fullName" : "equipment";
    const total = columns.at(-1).id;
    const preferences = { [identity]: null, "day-3": "left", "day-5": "right", [total]: "right" };
    const snapshot = structuredClone(columns);
    const ordered = applyTimesheetColumnPins(columns, preferences);
    const left = ordered.filter(column => column.pinSide === "left");
    const center = ordered.filter(column => !column.pinSide);
    const right = ordered.filter(column => column.pinSide === "right");
    assert.deepEqual(ordered, [...left, ...center, ...right]);
    assert.equal(left.at(-1).id, "day-3");
    assert.equal(center[0].id, identity);
    assert.equal(center[0].sticky, false, "Explicit null overrides default metadata pin");
    assert.deepEqual(right.map(column => column.id), ["day-5", total]);
    assert.deepEqual(columns, snapshot, "Pinning never changes the caller's natural order/defaults");
    assert.deepEqual(preferences, { [identity]: null, "day-3": "left", "day-5": "right", [total]: "right" });
  });

  test(`${kind}: left/right offsets are cumulative on their own side and resize independently`, () => {
    const natural = timesheetSizingColumns(kind, 5);
    const total = natural.at(-1).id;
    const columns = applyTimesheetColumnPins(natural, { "day-3": "left", "day-5": "right", [total]: "right" });
    const layout = timesheetColumnLayout(columns, {}, 1800);
    let left = 0;
    for (const column of columns.filter(column => column.pinSide === "left")) {
      assert.equal(layout.lefts[column.id], left);
      assert.equal(Object.hasOwn(layout.rights, column.id), false);
      left += layout.widths[column.id];
    }
    assert.equal(layout.rights[total], 0);
    assert.equal(layout.rights["day-5"], layout.widths[total]);
    assert.equal(layout.leftStickyWidth, left);
    assert.equal(layout.rightStickyWidth, layout.widths[total] + layout.widths["day-5"]);
    assert.equal(layout.stickyWidth, layout.leftStickyWidth + layout.rightStickyWidth);
    const resized = timesheetColumnLayout(columns, { [total]: 200 }, 1800);
    assert.deepEqual(resized.lefts, layout.lefts);
    assert.equal(resized.rights["day-5"] - layout.rights["day-5"], 200 - layout.widths[total]);
    assert.equal(resized.rights[total], 0);
  });
}

test("saved preferences validate known columns and preserve null, hidden position and day 31", () => {
  const raw = '{"fullName":null,"position":"right","day-31":"left","day-32":"right","department":true,"reports":"right","equipment":"left","__proto__":"right","constructor":"left"}';
  const workers = readTimesheetColumnPins(raw, "workers");
  assert.deepEqual(workers, { fullName: null, position: "right", "day-31": "left", reports: "right" });
  assert.deepEqual(readTimesheetColumnPins(JSON.stringify(workers), "workers"), workers);
  assert.deepEqual(readTimesheetColumnPins(raw, "equipment"), { "day-31": "left", equipment: "left" });
  const februaryNarrow = applyTimesheetColumnPins(timesheetSizingColumns("workers", 28, false), workers);
  assert.equal(februaryNarrow.some(column => column.id === "position" || column.id === "day-31"), false);
  const marchWide = applyTimesheetColumnPins(timesheetSizingColumns("workers", 31, true), workers);
  assert.equal(marchWide.find(column => column.id === "position").pinSide, "right");
  assert.equal(marchWide.find(column => column.id === "day-31").pinSide, "left");
});

test("malformed, array and inherited preferences cannot pin unknown columns", () => {
  for (const raw of [null, "", "null", "true", "[]", "[\"left\"]", "{", '"left"']) assert.deepEqual(readTimesheetColumnPins(raw, "workers"), {});
  const columns = timesheetSizingColumns("workers", 3);
  const inherited = Object.create({ "day-2": "right" });
  assert.equal(getTimesheetColumnPin(columns.find(column => column.id === "day-2"), inherited), null);
  assert.equal(getTimesheetColumnPin(columns.find(column => column.id === "department"), { department: "invalid" }), "left");
  assert.equal(applyTimesheetColumnPins(columns, { nonexistent: "left" }).some(column => column.id === "nonexistent"), false);
});

test("pinning leaves room for the scrolling region and always permits unpinning", () => {
  const columns = timesheetSizingColumns("workers", 31, false);
  // Four metadata pins require 294px; at 500px, 380px remains available to pins.
  assert.equal(canPinTimesheetColumn(columns, {}, "day-1", "left", 500), true);
  assert.equal(canPinTimesheetColumn(columns, { "day-1": "left", "day-2": "right" }, "day-3", "right", 500), false);
  assert.equal(canPinTimesheetColumn(columns, {}, "fullName", "right", 500), true, "Moving a visible existing pin consumes no additional space");
  assert.equal(canPinTimesheetColumn(columns, {}, "fullName", "right", 250), false, "A temporarily released column cannot be forced into an overfull region");
  assert.equal(canPinTimesheetColumn(columns, {}, "fullName", null, 250), true);
  assert.equal(canPinTimesheetColumn(columns, {}, "day-1", "left", 250), false);
  assert.equal(canPinTimesheetColumn(columns, {}, "day-1", "left", 0), true, "Unknown viewport must not disable initial actions");
  assert.equal(canPinTimesheetColumn(columns, {}, "missing", "left", 1200), false);
  const everythingElsePinned = Object.fromEntries(columns.filter(column => column.id !== "day-31").map(column => [column.id, "left"]));
  assert.equal(canPinTimesheetColumn(columns, everythingElsePinned, "day-31", "right", 8000), false);
});

test("wide-screen spare space expands only scrolling days rather than covering them with pinned days", () => {
  const columns = applyTimesheetColumnPins(timesheetSizingColumns("equipment", 3), { "day-1": "left", "day-3": "right", total: "right" });
  const layout = timesheetColumnLayout(columns, {}, 2400);
  assert.equal(layout.widths["day-1"], 48);
  assert.equal(layout.widths["day-3"], 48);
  assert.ok(layout.widths["day-2"] > 48);
  assert.equal(layout.totalWidth, 2400);
});

test("pinned width budget includes both sides and preserves all minimum widths", () => {
  const columns = applyTimesheetColumnPins(timesheetSizingColumns("workers", 31), { "day-4": "right", difference: "right" });
  const layout = timesheetColumnLayout(columns, { fullName: 700, position: 500, "day-4": 200, difference: 300 }, 1000);
  assert.equal(layout.stickyWidth, 880);
  assert.ok(layout.leftStickyWidth > 0 && layout.rightStickyWidth > 0);
  for (const column of columns) assert.ok(layout.widths[column.id] >= column.min);
  assert.equal(layout.totalWidth, Object.values(layout.widths).reduce((sum, width) => sum + width, 0));
});

for (const kind of ["workers", "equipment"]) {
  test(`${kind}: saved wide-screen pins adapt to narrow windows and restore without changing preferences`, () => {
    const wide = timesheetSizingColumns(kind, 31, true);
    const totals = wide.slice(-3).map(column => column.id);
    const preferences = Object.fromEntries([
      ...Array.from({ length: 15 }, (_, index) => [`day-${index + 1}`, "left"]),
      ...totals.map(id => [id, "right"]),
    ]);
    const saved = JSON.stringify(preferences);
    const desired = applyTimesheetColumnPins(wide, preferences, 2000);
    assert.equal(desired.filter(column => column.pinSide === "right").length, 3);
    assert.equal(desired.find(column => column.id === "day-15").pinSide, "left");

    for (const viewport of [800, 500, 250]) {
      const natural = timesheetSizingColumns(kind, 31, false);
      const visible = applyTimesheetColumnPins(natural, preferences, viewport);
      const layout = timesheetColumnLayout(visible, {}, viewport);
      assert.ok(layout.stickyWidth <= viewport - Math.min(120, Math.floor(viewport / 4)), `${viewport}px leaves a usable scrolling region`);
      assert.ok(visible.some(column => !column.sticky));
      assert.equal(visible.find(column => column.id === "day-15").pinSide, undefined);
      assert.equal(canPinTimesheetColumn(natural, preferences, "day-15", "left", viewport), false);
      assert.equal(canPinTimesheetColumn(natural, preferences, "day-15", null, viewport), true);
      for (const column of visible) assert.ok(layout.widths[column.id] >= column.min);
      if (viewport >= 500) assert.ok(natural.filter(column => column.sticky).every(column => visible.find(item => item.id === column.id).pinSide === "left"), "Extra pins are released before default metadata");
      assert.equal(JSON.stringify(preferences), saved);
    }
    assert.deepEqual(applyTimesheetColumnPins(wide, preferences, 2000), desired);
    assert.equal(JSON.stringify(preferences), saved);
  });

  test(`${kind}: all saved pins still leave at least one unpinned column`, () => {
    const natural = timesheetSizingColumns(kind, 3);
    const preferences = Object.fromEntries(natural.map(column => [column.id, "right"]));
    const visible = applyTimesheetColumnPins(natural, preferences, 8000);
    assert.equal(visible.filter(column => !column.sticky).length, 1);
    assert.equal(visible.find(column => !column.sticky).id, natural.at(-1).id);
  });

  for (const dayCount of [3, 31]) {
    test(`${kind}: pinning all ${dayCount} dates fills a wide viewport with an existing scrolling track`, () => {
      const natural = timesheetSizingColumns(kind, dayCount);
      const identity = kind === "workers" ? "fullName" : "equipment";
      const totals = natural.slice(-3).map(column => column.id);
      for (const metadataCenter of [false, true]) {
        const pins = Object.fromEntries([
          ...Array.from({ length: dayCount }, (_, index) => [`day-${index + 1}`, index % 2 ? "right" : "left"]),
          ...(metadataCenter ? [[identity, null], ...totals.map(id => [id, "right"])] : [[totals.at(-1), "right"]]),
        ]);
        const columns = applyTimesheetColumnPins(natural, pins, 5000);
        assert.equal(columns.filter(column => !column.sticky && column.id.startsWith("day-")).length, 0);
        const widths = { [identity]: 220 };
        const saved = JSON.stringify(widths);
        const plan = timesheetColumnLayout(columns, widths, 5000);
        const flexId = metadataCenter ? identity : totals[0];
        assert.equal(plan.totalWidth, 5000, "No blank tail remains after the table");
        assert.equal(Object.values(plan.widths).reduce((sum, width) => sum + width, 0), 5000);
        assert.ok(plan.widths[flexId] > boundedTimesheetWidth(natural.find(column => column.id === flexId), widths[flexId]));
        assert.equal(timesheetResizeReferenceWidth(natural.find(column => column.id === flexId), widths, plan.widths[flexId]), boundedTimesheetWidth(natural.find(column => column.id === flexId), widths[flexId]), "Autofill is not added to the next manual resize preference");
        const right = columns.filter(column => column.pinSide === "right").reverse();
        let offset = 0;
        for (const column of right) { assert.equal(plan.rights[column.id], offset); offset += plan.widths[column.id]; }
        assert.equal(JSON.stringify(widths), saved, "Viewport filling never changes saved column widths");
      }
    });
  }
}

test("equipment organization is the fill track when it is the only scrolling metadata", () => {
  const natural = timesheetSizingColumns("equipment", 3);
  const pins = { organization: null, "day-1": "left", "day-2": "left", "day-3": "right", productive: "right", downtime: "right", total: "right" };
  const columns = applyTimesheetColumnPins(natural, pins, 2400);
  const plan = timesheetColumnLayout(columns, {}, 2400);
  assert.equal(plan.totalWidth, 2400);
  assert.ok(plan.widths.organization > 170);
  assert.equal(plan.widths.equipment, 288);
});
