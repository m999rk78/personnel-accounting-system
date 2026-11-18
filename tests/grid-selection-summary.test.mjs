import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { summarizeSpreadsheetSelection } from "../app/gridSelectionSummary.ts";
import { isStructuralSpreadsheetRow, spreadsheetDataColumns, spreadsheetPointRowIndex } from "../app/gridSpreadsheetRows.ts";

const column = id => Object.freeze({ getColId: () => id });
const row = (id, data, flags = {}) => Object.freeze({ id, data: Object.freeze(data), ...flags });
const personnelRows = [
  row("first", { zone: "12345", welders: 12000.5, installers: 345, other: 0, total: 12345.5 }),
  row("second", { zone: "Зона Б", welders: 8, installers: 0.25, other: 0, total: 8.25 }),
];
const bounds = (columns, rowStart = 0, rowEnd = 1, columnStart = 0, columnEnd = columns.length - 1) => ({ columns, rowStart, rowEnd, columnStart, columnEnd });

function fixture(rows = personnelRows, ids = ["zone", "welders", "installers", "other", "total"]) {
  const columns = ids.map(column);
  const reads = [];
  let destroyed = false;
  const operations = {
    getAllDisplayedColumns: () => columns,
    getDisplayedRowAtIndex: index => rows[index],
    getRowNode: id => {
      const rowIndex = rows.findIndex(node => node.id === id);
      return rowIndex < 0 ? undefined : { ...rows[rowIndex], rowIndex };
    },
    getCellValue: ({ rowNode, colKey, useFormatter }) => {
      assert.equal(useFormatter, false, "sums must use raw numbers, never localized display strings");
      reads.push([rowNode.id, colKey.getColId()]);
      return rowNode.data[colKey.getColId()];
    },
    isDestroyed: () => destroyed,
  };
  const grid = new Proxy(operations, {
    get(target, key) {
      assert.ok(Object.hasOwn(target, key), `Selection summary must not access a write or unknown API: ${String(key)}`);
      return target[key];
    },
    set() { throw new Error("Selection summary must not mutate the grid"); },
  });
  return { grid, columns, rows, reads, destroy() { destroyed = true; } };
}

test("selection sums raw personnel hours from selected columns and ignores numeric-looking zone names", () => {
  const { grid, columns } = fixture();
  assert.deepEqual(summarizeSpreadsheetSelection(grid, bounds(columns, 0, 1, 0, 3)), { count: 6, sum: 12353.75 });
  assert.equal(summarizeSpreadsheetSelection(grid, bounds(columns, 0, 1, 0, 0)), null);
  assert.deepEqual(summarizeSpreadsheetSelection(grid, bounds(columns, 0, 1, 4, 4)), { count: 2, sum: 12353.75 }, "two zone total cells are counted once each");
});

test("zero is a numeric selection and exact selected cells include totals when explicitly selected", () => {
  const { grid, columns } = fixture();
  assert.deepEqual(summarizeSpreadsheetSelection(grid, bounds(columns, 0, 1, 3, 3)), { count: 2, sum: 0 });
  assert.deepEqual(summarizeSpreadsheetSelection(grid, bounds(columns, 1, 1, 1, 4)), { count: 4, sum: 16.5 }, "the selection is not silently changed to avoid totals");
  assert.equal(summarizeSpreadsheetSelection(grid, null), null);
});

test("equipment selection adds working and downtime hours and rejects formatted, empty and nonfinite values", () => {
  const { grid, columns } = fixture([
    row("unit1", { productive: 4.5, downtime: 3.75, total: 8.25, text: "12\u202f345,5", invalid: NaN }),
    row("unit2", { productive: 0, downtime: 10, total: 10, text: "7,5", invalid: Infinity }),
    row("unit3", { productive: undefined, downtime: null, total: -Infinity, text: "9", invalid: true }),
  ], ["productive", "downtime", "total", "text", "invalid"]);
  assert.deepEqual(summarizeSpreadsheetSelection(grid, bounds(columns, 0, 2, 0, 1)), { count: 4, sum: 18.25 });
  assert.equal(summarizeSpreadsheetSelection(grid, bounds(columns, 0, 2, 3, 4)), null);
  assert.deepEqual(summarizeSpreadsheetSelection(grid, bounds(columns, 0, 2, 2, 2)), { count: 2, sum: 18.25 });
});

test("structural and missing rows never contribute to the selected-hours total", () => {
  const { grid, columns } = fixture([
    row("group", { hours: 100 }, { group: true }),
    row("record", { hours: 8.5 }),
    row("detail", { hours: 100 }, { detail: true }),
    row("footer", { hours: 100 }, { footer: true }),
    { id: "empty" },
  ], ["hours"]);
  assert.deepEqual(summarizeSpreadsheetSelection(grid, bounds(columns, 0, 7)), { count: 1, sum: 8.5 });
  assert.equal(summarizeSpreadsheetSelection(grid, bounds(columns, 2, 7)), null);
});

test("selection follows the displayed sorted model and reads virtual rows without mutating data", () => {
  const rows = Object.freeze(Array.from({ length: 1200 }, (_, index) => row(String(index), { hours: (1199 - index) / 4 })));
  const { grid, columns, reads } = fixture(rows, ["hours"]);
  const before = JSON.stringify(rows);
  assert.deepEqual(summarizeSpreadsheetSelection(grid, bounds(columns, 1, 1199)), { count: 1199, sum: 179550.25 });
  assert.equal(reads.length, 1199);
  assert.deepEqual(reads[0], ["1", "hours"]);
  assert.deepEqual(reads.at(-1), ["1199", "hours"]);
  assert.equal(JSON.stringify(rows), before);
});

const sourcePath = new URL("../app/GridFilters.tsx", import.meta.url);
const source = ts.createSourceFile(sourcePath.pathname, await readFile(sourcePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let result;
  const visit = node => {
    if (!result && (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(source) === name) result = node;
    if (!result) ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(result, `Missing real grid declaration: ${name}`);
  return ts.isVariableDeclaration(result) ? result.initializer.getText(source) : result.getText(source);
}
function bind(expression, environment) {
  const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment));
}
const spreadsheetBounds = bind(declaration("spreadsheetBounds"), { spreadsheetColumns: spreadsheetDataColumns, spreadsheetPointRowIndex });

function paintHarness({ enabled = true, ...options } = {}) {
  const source = fixture(options.rows, options.ids);
  const values = [], frames = [];
  const selectionRef = { current: null }, selectionIncludesHeaders = { current: false };
  const body = { current: { querySelectorAll: () => [] } };
  const selectionSummaryCallback = { current: enabled ? value => values.push(value) : undefined };
  const paint = bind(declaration("paintSelection"), {
    useCallback: callback => callback,
    requestAnimationFrame: callback => frames.push(callback),
    body, selectionRef, selectionIncludesHeaders, selectionSummaryCallback, lastSelectionSummary: { current: undefined },
    spreadsheetBounds, summarizeSpreadsheetSelection, spreadsheetColumns: spreadsheetDataColumns, isStructuralSpreadsheetRow,
  });
  const point = (index, columnId) => ({ rowIndex: index, rowId: source.rows[index]?.id, columnId });
  return {
    ...source, values, selectionRef, selectionIncludesHeaders, body,
    select(from, to) { selectionRef.current = { start: point(...from), end: point(...to) }; },
    schedule() { paint(source.grid); },
    flush() { for (const frame of frames.splice(0)) frame(); },
    repaint() { paint(source.grid); this.flush(); },
  };
}

test("actual selection painter reports reversed selections, deduplicates updates and clears stale sums", () => {
  const ui = paintHarness();
  ui.select([1, "total"], [0, "total"]); ui.repaint();
  assert.deepEqual(ui.values, [{ count: 2, sum: 12353.75 }]);
  ui.repaint(); ui.repaint();
  assert.equal(ui.values.length, 1, "scrolling and redundant paints do not rerender the consumer");
  ui.select([1, "other"], [0, "welders"]); ui.repaint();
  assert.deepEqual(ui.values.at(-1), { count: 6, sum: 12353.75 }, "count changes must notify even when the sum is unchanged");
  ui.selectionRef.current = null; ui.repaint(); ui.repaint();
  assert.deepEqual(ui.values, [{ count: 2, sum: 12353.75 }, { count: 6, sum: 12353.75 }, null]);
});

test("actual painter never parses a text-only selection and excludes headers from totals", () => {
  const ui = paintHarness();
  ui.select([0, "zone"], [1, "zone"]); ui.repaint();
  assert.deepEqual(ui.values, [null]);
  ui.select([0, "total"], [1, "total"]); ui.selectionIncludesHeaders.current = true; ui.repaint();
  assert.deepEqual(ui.values.at(-1), { count: 2, sum: 12353.75 });
});

test("grids without a summary subscriber perform no value reads", () => {
  const ui = paintHarness({ enabled: false });
  ui.select([0, "welders"], [1, "total"]); ui.repaint();
  assert.deepEqual(ui.reads, []);
  assert.deepEqual(ui.values, []);
});

test("scheduled paints read the current selection and skip a destroyed or unmounted grid", () => {
  const ui = paintHarness();
  ui.select([0, "total"], [1, "total"]); ui.schedule();
  ui.selectionRef.current = null; ui.flush();
  assert.deepEqual(ui.values, [null], "a delayed frame cannot restore a sum cleared by Escape or a filter change");
  ui.select([0, "total"], [1, "total"]); ui.schedule(); ui.destroy(); ui.flush();
  assert.deepEqual(ui.reads, []);
  const unmounted = paintHarness();
  unmounted.select([0, "total"], [1, "total"]); unmounted.schedule(); unmounted.body.current = null; unmounted.flush();
  assert.deepEqual(unmounted.values, []);
  assert.deepEqual(unmounted.reads, []);
});

test("a removed or filtered range endpoint cannot fall back to its old displayed row", () => {
  const ui = paintHarness();
  ui.select([0, "total"], [1, "total"]); ui.repaint();
  ui.selectionRef.current.end = { rowId: "removed", rowIndex: 1, columnId: "total" }; ui.repaint();
  assert.equal(ui.values.at(-1), null);
});
