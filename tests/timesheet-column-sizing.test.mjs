import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedTimesheetWidth,
  readTimesheetColumnWidths,
  timesheetColumnLayout,
  timesheetResizeReferenceWidth,
  timesheetSizingColumns,
} from "../app/timesheetColumnSizing.ts";

const sum = values => values.reduce((total, value) => total + value, 0);

test("dragging an auto-filled day uses a delta on the preference, not the expanded visual width", () => {
  for (const kind of ["workers", "equipment"]) {
    const columns = timesheetSizingColumns(kind, 31);
    const day = columns.find(column => column.id === "day-1");
    const before = timesheetColumnLayout(columns, {}, 3840);
    assert.ok(before.widths[day.id] > day.width);
    const reference = timesheetResizeReferenceWidth(day, {}, before.widths[day.id]);
    assert.equal(reference, day.width);
    const after = timesheetColumnLayout(columns, { [day.id]: reference + 1 }, 3840);
    assert.ok(Math.abs(after.widths[day.id] - before.widths[day.id]) <= 2, "A 1px gesture must never add the auto-filled surplus again");
    const keyboard = timesheetColumnLayout(columns, { [day.id]: reference + 8 }, 3840);
    assert.ok(Math.abs(keyboard.widths[day.id] - before.widths[day.id] - 8) <= 2);
    assert.equal(after.totalWidth, 3840);
  }
});
function assertGeometry(columns, layout) {
  assert.deepEqual(Object.keys(layout.widths), columns.map(column => column.id));
  assert.equal(layout.totalWidth, sum(Object.values(layout.widths)));
  let left = 0;
  for (const column of columns) {
    const width = layout.widths[column.id];
    assert.ok(Number.isFinite(width) && Number.isInteger(width) && width >= column.min, `${column.id}: finite, integer, nonnegative width`);
    if (column.sticky) {
      assert.equal(layout.lefts[column.id], left, `${column.id}: no gap in cumulative sticky offsets`);
      left += width;
    } else assert.equal(Object.hasOwn(layout.lefts, column.id), false);
  }
  assert.equal(layout.stickyWidth, left);
  assert.equal(layout.stickyCount, columns.filter(column => column.sticky).length);
}

test("workers include five pinned columns on wide screens and four when position is hidden", () => {
  const wide = timesheetSizingColumns("workers", 30);
  const narrow = timesheetSizingColumns("workers", 30, false);
  assert.equal(wide.length, 38);
  assert.equal(narrow.length, 37);
  assert.deepEqual(wide.filter(column => column.sticky).map(column => column.id), ["number", "employmentType", "department", "fullName", "position"]);
  assert.equal(narrow.some(column => column.id === "position"), false);
  for (const [columns, stickyWidth, stickyCount] of [[wide, 502, 5], [narrow, 362, 4]]) {
    const layout = timesheetColumnLayout(columns, {}, 1800);
    assertGeometry(columns, layout);
    assert.equal(layout.stickyWidth, stickyWidth);
    assert.equal(layout.stickyCount, stickyCount, "Footer metadata colspan follows the visible pinned columns");
  }
});

test("equipment has three pinned columns and its own three total columns", () => {
  const columns = timesheetSizingColumns("equipment", 30);
  assert.equal(columns.length, 36);
  assert.deepEqual(columns.filter(column => column.sticky).map(column => column.id), ["number", "equipment", "organization"]);
  assert.deepEqual(columns.slice(-3).map(column => column.id), ["productive", "downtime", "total"]);
  const layout = timesheetColumnLayout(columns, {}, 1800);
  assertGeometry(columns, layout);
  assert.deepEqual(layout.lefts, { number: 0, equipment: 44, organization: 332 });
  assert.equal(layout.stickyWidth, 502);
  assert.equal(layout.stickyCount, 3);
});

test("resizing a column changes only its track and the exact total width", () => {
  for (const kind of ["workers", "equipment"]) {
    const columns = timesheetSizingColumns(kind, 31);
    const baseline = timesheetColumnLayout(columns, {}, 1800);
    for (const [id, value] of [["day-6", 100], ["day-6", 40], ["number", 90], [columns.at(-1).id, 120]]) {
      const preferences = { [id]: value };
      const snapshot = { ...preferences };
      const next = timesheetColumnLayout(columns, preferences, 1800);
      assertGeometry(columns, next);
      assert.deepEqual(preferences, snapshot, "Layout calculation must not overwrite stored preferences");
      for (const column of columns) assert.equal(next.widths[column.id], column.id === id ? value : baseline.widths[column.id]);
      assert.equal(next.totalWidth - baseline.totalWidth, value - baseline.widths[id]);
    }
  }
});

test("expanding a pinned column moves every later sticky boundary without leaving a gap", () => {
  const columns = timesheetSizingColumns("workers", 31);
  const baseline = timesheetColumnLayout(columns, {}, 1800);
  const expanded = timesheetColumnLayout(columns, { department: 140 }, 1800);
  assertGeometry(columns, expanded);
  assert.equal(expanded.lefts.department, baseline.lefts.department);
  assert.equal(expanded.lefts.fullName, baseline.lefts.fullName + 70);
  assert.equal(expanded.lefts.position, baseline.lefts.position + 70);
  assert.equal(expanded.stickyWidth, baseline.stickyWidth + 70);
  assert.equal(expanded.totalWidth, baseline.totalWidth + 70);
});

test("width bounds reject non-numbers and nonfinite values and clamp finite values", () => {
  const column = timesheetSizingColumns("workers", 30).find(column => column.id === "fullName");
  for (const value of [NaN, Infinity, -Infinity, undefined, null, "250", {}, [], true]) assert.equal(boundedTimesheetWidth(column, value), 190);
  for (const [value, expected] of [[-1e9, 140], [0, 140], [140, 140], [250.4, 250], [250.5, 251], [900, 900], [1e9, 900]]) {
    assert.equal(boundedTimesheetWidth(column, value), expected);
  }
});

test("stored widths reject malformed payloads, unknown ids and invalid values", () => {
  for (const raw of [null, "", "broken json", "null", "[]", "42", '"widths"', "true"]) assert.deepEqual(readTimesheetColumnWidths(raw, "workers"), {});
  assert.deepEqual(readTimesheetColumnWidths('{"fullName":280.6,"day-6":58,"department":0,"position":10000,"day-32":95,"unknown":100,"reports":"80","timesheet":null,"difference":1e400}', "workers"), {
    department: 60, fullName: 281, position: 600, "day-6": 58,
  });
  assert.deepEqual(readTimesheetColumnWidths('{"equipment":400,"organization":200,"fullName":400,"position":250}', "equipment"), { equipment: 400, organization: 200 });
});

test("storage does not admit prototype pollution keys or inherited column preferences", () => {
  const pollutedBefore = Object.prototype.polluted;
  const parsed = readTimesheetColumnWidths('{"__proto__":{"fullName":900,"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":500,"fullName":240}', "workers");
  assert.deepEqual(parsed, { fullName: 240 });
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, "__proto__"), false);
  assert.equal(Object.hasOwn(parsed, "constructor"), false);
  assert.equal(Object.prototype.polluted, pollutedBefore);
});

test("pinned columns leave a usable day area whenever minimum widths permit it", () => {
  for (const [kind, showPosition, viewport] of [["workers", true, 1000], ["workers", false, 650], ["equipment", true, 700]]) {
    const columns = timesheetSizingColumns(kind, 31, showPosition);
    const preferences = Object.fromEntries(columns.filter(column => column.sticky).map(column => [column.id, column.max]));
    const layout = timesheetColumnLayout(columns, preferences, viewport);
    assertGeometry(columns, layout);
    const budget = Math.max(sum(columns.filter(column => column.sticky).map(column => column.min)), viewport - Math.min(120, Math.floor(viewport / 4)));
    assert.ok(layout.stickyWidth <= budget);
    assert.ok(viewport - layout.stickyWidth >= Math.min(120, Math.floor(viewport / 4)));
  }
});

test("very narrow viewports preserve pinned minimum widths instead of negative tracks", () => {
  for (const kind of ["workers", "equipment"]) {
    const columns = timesheetSizingColumns(kind, 28);
    const layout = timesheetColumnLayout(columns, Object.fromEntries(columns.map(column => [column.id, column.max])), 120);
    assertGeometry(columns, layout);
    for (const column of columns.filter(column => column.sticky)) assert.equal(layout.widths[column.id], column.min);
    assert.equal(layout.stickyWidth, sum(columns.filter(column => column.sticky).map(column => column.min)));
    assert.ok(layout.totalWidth > 120, "The whole table scrolls instead of silently compressing its pinned cells");
  }
});

test("giant viewports explicitly distribute integer spare space across days and fill exactly", () => {
  for (const kind of ["workers", "equipment"]) {
    for (const count of [28, 29, 30, 31]) {
      const columns = timesheetSizingColumns(kind, count);
      const layout = timesheetColumnLayout(columns, {}, 100_001.9);
      assertGeometry(columns, layout);
      assert.equal(layout.totalWidth, 100_001, "No hidden browser min-width allocation may disagree with the track plan");
      const dayWidths = columns.filter(column => column.id.startsWith("day-")).map(column => layout.widths[column.id]);
      assert.ok(Math.max(...dayWidths) - Math.min(...dayWidths) <= 1);
      for (const column of columns.filter(column => !column.id.startsWith("day-"))) assert.equal(layout.widths[column.id], column.width);
    }
  }
});

test("month lengths retain matching day preferences and restore end-of-month columns later", () => {
  const preferences = { "day-1": 58, "day-28": 80, "day-29": 90, "day-30": 100, "day-31": 110, position: 240 };
  for (const kind of ["workers", "equipment"]) {
    for (const count of [28, 29, 30, 31]) {
      const columns = timesheetSizingColumns(kind, count);
      const layout = timesheetColumnLayout(columns, preferences, 1500);
      assertGeometry(columns, layout);
      assert.equal(columns.filter(column => column.id.startsWith("day-")).length, count);
      for (const day of [1, 28, 29, 30, 31]) {
        if (day <= count) assert.equal(layout.widths[`day-${day}`], preferences[`day-${day}`]);
        else assert.equal(Object.hasOwn(layout.widths, `day-${day}`), false);
      }
    }
  }
  assert.equal(preferences["day-31"], 110);
  const narrow = timesheetColumnLayout(timesheetSizingColumns("workers", 31, false), preferences, 1800);
  const wide = timesheetColumnLayout(timesheetSizingColumns("workers", 31, true), preferences, 1800);
  assert.equal(Object.hasOwn(narrow.widths, "position"), false);
  assert.equal(wide.widths.position, 240);
});

test("filtered personnel dates retain real day ids, widths and complete table geometry", () => {
  const preferences = { "day-1": 80, "day-6": 70, "day-8": 90, "day-30": 100 };
  const selected = timesheetSizingColumns("workers", 30, true, [6, 8]);
  assert.deepEqual(selected.filter(column => column.id.startsWith("day-")).map(column => column.id), ["day-6", "day-8"]);
  const layout = timesheetColumnLayout(selected, preferences, 700);
  assertGeometry(selected, layout);
  assert.equal(layout.widths["day-6"], 70);
  assert.equal(layout.widths["day-8"], 90);
  assert.equal(Object.hasOwn(layout.widths, "day-1"), false);
  assert.equal(Object.hasOwn(layout.widths, "day-30"), false);
  const restored = timesheetColumnLayout(timesheetSizingColumns("workers", 30), preferences, 1800);
  assert.equal(restored.widths["day-1"], 80);
  assert.equal(restored.widths["day-30"], 100);
});

test("explicit day plans discard invalid and repeated dates without renumbering valid days", () => {
  const selected = timesheetSizingColumns("workers", 28, false, [6, 6, 0, -1, 8, 29, 31, NaN, Infinity, 2.5]);
  assert.deepEqual(selected.filter(column => column.id.startsWith("day-")).map(column => column.id), ["day-6", "day-8"]);
  assertGeometry(selected, timesheetColumnLayout(selected, {}, 1200));
  assert.deepEqual(timesheetSizingColumns("equipment", 30), timesheetSizingColumns("equipment", 30, true, undefined), "Equipment keeps the existing contiguous default plan");
});

test("invalid viewport dimensions and day counts still produce finite track plans", () => {
  for (const kind of ["workers", "equipment"]) {
    for (const viewport of [NaN, Infinity, -Infinity, -100, 0, 320, 843, 1440, 3000]) {
      for (const days of [NaN, -10, 0, 28.9, 31, 100, Infinity]) {
        const columns = timesheetSizingColumns(kind, days);
        assert.ok(columns.filter(column => column.id.startsWith("day-")).length <= 31);
        assertGeometry(columns, timesheetColumnLayout(columns, { "day-1": NaN, number: Infinity }, viewport));
      }
    }
  }
});
