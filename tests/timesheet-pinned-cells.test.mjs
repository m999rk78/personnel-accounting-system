import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Children, Fragment, createElement } from "react";
import { timesheetSizingColumns } from "../app/timesheetColumnSizing.ts";
import { applyTimesheetColumnPins } from "../app/timesheetColumnPinning.ts";

// Compile the actual renderer and JSX; only the stylesheet is omitted in Node.
const rendererFile = new URL("../app/timesheetPinnedCells.tsx", import.meta.url);
const built = await build({ entryPoints: [fileURLToPath(rendererFile)], bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic",
  external: ["react", "react/jsx-runtime"], loader: { ".css": "empty" }, logLevel: "silent" });
let code = built.outputFiles[0].text;
for (const specifier of ["react", "react/jsx-runtime"]) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(import.meta.resolve(specifier)));
const { arrangeTimesheetCells, arrangeTimesheetHeaders, arrangeTimesheetFooter } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const list = value => Children.toArray(value);
const byId = nodes => new Map(list(nodes).map(node => [node.props["data-timesheet-column-id"], node]));
const trackCount = nodes => list(nodes).reduce((sum, node) => sum + (node.props.colSpan ?? 1), 0);
function view(kind, pins, { showPosition = true, days = 4 } = {}) {
  const source = timesheetSizingColumns(kind, days, true);
  return { sourceIds: source.map(column => column.id), columns: applyTimesheetColumnPins(timesheetSizingColumns(kind, days, showPosition), pins), metadataCount: kind === "workers" ? 5 : 3 };
}
function headers(v) {
  const source = v.sourceIds.map(id => createElement("th", { key: id, rowSpan: id.startsWith("day-") ? undefined : 2, className: `source-${id}` },
    createElement("span", { "data-label": id }, id), createElement("button", { "data-resize-owner": id, "data-column-id": id })));
  return arrangeTimesheetHeaders(createElement(Fragment, null, source.filter(cell => !cell.key.startsWith("day-")), createElement("th", { colSpan: 4 }, "Old month group")),
    createElement(Fragment, null, source.filter(cell => cell.key.startsWith("day-"))), v);
}
function footer(v) {
  return createElement(Fragment, null, createElement("th", { colSpan: v.metadataCount, className: "timesheet-sticky timesheet-summary-label" }, "Итого по дням"),
    v.sourceIds.slice(v.metadataCount).map(id => createElement("td", { key: id, title: `hint-${id}` }, `sum-${id}`)));
}

for (const kind of ["workers", "equipment"]) {
  test(`${kind}: left/right date pins and unpinned metadata produce matching split header groups`, () => {
    const metadata = kind === "workers" ? "department" : "organization";
    const total = kind === "workers" ? "difference" : "total";
    const v = view(kind, { [metadata]: null, "day-1": "left", "day-3": "right", "day-4": "right", [total]: "right" });
    const rows = list(headers(v).props.children);
    assert.equal(rows.length, 2);
    const top = list(rows[0].props.children), bottom = list(rows[1].props.children);
    assert.equal(trackCount(top), v.columns.length, "Top header spans exactly the arranged colgroup");
    const groups = top.filter(cell => cell.props.className.includes("timesheet-month-column-group"));
    assert.deepEqual(groups.map(cell => [cell.props["data-timesheet-column-id"], cell.props.colSpan, cell.props["data-timesheet-pin"]]), [
      ["day-1", 1, "left"], ["day-2", 1, "none"], ["day-3", 2, "right"],
    ]);
    assert.equal(groups[2].props.style["--timesheet-cell-right"], "var(--timesheet-right-day-4, 0px)", "A merged right heading anchors to its final track");
    assert.deepEqual(bottom.map(cell => cell.props["data-timesheet-column-id"]), ["day-1", "day-2", "day-3", "day-4"]);
    assert.deepEqual(top.filter(cell => !cell.props.className.includes("timesheet-month-column-group")).map(cell => cell.props.rowSpan), Array(v.columns.length - 4).fill(2));
    assert.equal(byId(top).get(metadata).props["data-timesheet-pin"], "none");
    for (const cell of bottom) {
      const button = list(cell.props.children).find(child => child.type === "button");
      assert.equal(button.props["data-resize-owner"], cell.props["data-timesheet-column-id"]);
    }
  });

  test(`${kind}: reordered body cells retain values, original edit callbacks and unrelated styling`, () => {
    const metadata = kind === "workers" ? "department" : "organization";
    const v = view(kind, { [metadata]: null, "day-2": "left", "day-1": "right" });
    const calls = [];
    const callbacks = new Map(v.sourceIds.map(id => [id, () => calls.push(id)]));
    const original = v.sourceIds.map(id => createElement(id === "fullName" || id === "equipment" ? "th" : "td", {
      key: id, className: `value-${id} ${id === metadata ? "timesheet-sticky" : ""}`, title: `title-${id}`, style: { color: "red" }, onDoubleClick: callbacks.get(id),
    }, `value-${id}`));
    const result = list(arrangeTimesheetCells(createElement(Fragment, null, original.slice(0, 3), createElement(Fragment, null, original.slice(3))), v));
    assert.deepEqual(result.map(cell => cell.props["data-timesheet-column-id"]), v.columns.map(column => column.id));
    for (const cell of result) {
      const id = cell.props["data-timesheet-column-id"];
      assert.equal(cell.props.children, `value-${id}`);
      assert.equal(cell.props.title, `title-${id}`);
      assert.equal(cell.props.style.color, "red");
      assert.equal(cell.props.onDoubleClick, callbacks.get(id));
    }
    const cells = byId(result);
    cells.get("day-1").props.onDoubleClick();
    cells.get("day-2").props.onDoubleClick();
    assert.deepEqual(calls, ["day-1", "day-2"], "Moving a date never changes the edited source date");
    assert.equal(cells.get(metadata).props["data-timesheet-pin"], "none");
    assert.ok(!cells.get(metadata).props.className.split(/\s+/).includes("timesheet-sticky"));
    assert.equal(cells.get("day-1").props["data-timesheet-pin"], "right");
    assert.ok(cells.get("day-1").props.className.split(/\s+/).includes("timesheet-sticky"));
    assert.equal(original[0].props["data-timesheet-pin"], undefined, "The source React elements remain unchanged");
  });

  test(`${kind}: footer merges only same-side adjacent metadata and keeps each date/total in its own track`, () => {
    const pins = kind === "workers" ? { employmentType: "right", fullName: "right", department: null, position: null }
      : { number: null, equipment: "right", organization: "right" };
    const total = kind === "workers" ? "difference" : "total";
    const v = view(kind, { ...pins, "day-1": "left", "day-4": "right", [total]: "right" });
    const result = list(arrangeTimesheetFooter(footer(v), v));
    assert.equal(trackCount(result), v.columns.length, "Footer spans all and only physical tracks after pinning");
    const groups = result.filter(cell => cell.props.className?.includes("timesheet-summary-label"));
    assert.equal(groups.reduce((sum, group) => sum + group.props.colSpan, 0), v.metadataCount);
    assert.equal(groups.filter(group => group.props.children === "Итого по дням").length, 1, "The label occurs once even when metadata splits into several regions");
    const rightGroup = groups.find(group => group.props["data-timesheet-pin"] === "right");
    assert.equal(rightGroup.props.colSpan, 2);
    assert.equal(rightGroup.props.style["--timesheet-cell-right"], `var(--timesheet-right-${kind === "workers" ? "fullName" : "organization"}, 0px)`);
    const output = byId(result);
    for (const id of v.sourceIds.slice(v.metadataCount)) {
      assert.equal(output.get(id).props.children, `sum-${id}`);
      assert.equal(output.get(id).props.title, `hint-${id}`);
    }
  });
}

test("hidden personnel position is omitted without shifting date/total values or footer tracks", () => {
  const v = view("workers", { position: "right", department: null, "day-2": "left", reports: "right" }, { showPosition: false });
  assert.ok(v.sourceIds.includes("position"));
  assert.ok(!v.columns.some(column => column.id === "position"));
  const body = arrangeTimesheetCells(v.sourceIds.map(id => createElement("td", { key: id }, id)), v);
  assert.deepEqual(list(body).map(cell => cell.props.children), v.columns.map(column => column.id));
  assert.equal(byId(body).get("day-1").props.children, "day-1");
  assert.equal(byId(body).get("timesheet").props.children, "timesheet");
  const head = headers(v);
  assert.ok(list(head.props.children).every(row => list(row.props.children).every(cell => cell.props["data-timesheet-column-id"] !== "position")));
  const foot = arrangeTimesheetFooter(footer(v), v);
  assert.equal(trackCount(foot), v.columns.length);
  assert.equal(list(foot).filter(cell => cell.props.className?.includes("timesheet-summary-label")).reduce((sum, cell) => sum + cell.props.colSpan, 0), 4);
  assert.equal(byId(foot).get("day-1").props.children, "sum-day-1");
  assert.equal(byId(foot).get("reports").props.children, "sum-reports");
});

test("empty footer remains absent", () => {
  assert.equal(arrangeTimesheetFooter(null, view("workers", {})), null);
});
