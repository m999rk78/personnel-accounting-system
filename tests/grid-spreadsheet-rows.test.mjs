import assert from "node:assert/strict";
import test from "node:test";
import { findSpreadsheetDataRowIndex, isStructuralSpreadsheetRow, spreadsheetPointRowIndex, spreadsheetRangeHasStructuralRows } from "../app/gridSpreadsheetRows.ts";

const grid = rows => ({ getDisplayedRowCount: () => rows.length, getDisplayedRowAtIndex: index => rows[index] });
const record = id => ({ data: { id } });
const dateHeader = { group: true };

test("spreadsheet movement skips date headers and stops when no record is displayed", () => {
  const source = grid([dateHeader, record(1), record(2), dateHeader, record(3)]);
  assert.equal(findSpreadsheetDataRowIndex(source, 0, 1), 1);
  assert.equal(findSpreadsheetDataRowIndex(source, 3, 1), 4);
  assert.equal(findSpreadsheetDataRowIndex(source, 3, -1), 2);
  assert.equal(findSpreadsheetDataRowIndex(source, 0, -1), null);
  assert.equal(findSpreadsheetDataRowIndex(grid([dateHeader, dateHeader]), 0, 1), null);
  assert.equal(findSpreadsheetDataRowIndex(grid([record(1), record(2)]), 1, -1), 1);
});

test("spreadsheet range guards detect structural rows before any batch changes", () => {
  const source = grid([dateHeader, record(1), record(2), dateHeader, record(3)]);
  assert.equal(spreadsheetRangeHasStructuralRows(source, 1, 2), false);
  assert.equal(spreadsheetRangeHasStructuralRows(source, 1, 4), true);
  assert.equal(spreadsheetRangeHasStructuralRows(source, 0, 0), true);
  assert.equal(isStructuralSpreadsheetRow(dateHeader), true);
  assert.equal(isStructuralSpreadsheetRow(record(1)), false);
});

test("flat spreadsheet paste can still append past the last real row", () => {
  const source = grid([record(1), record(2)]);
  assert.equal(spreadsheetRangeHasStructuralRows(source, 1, 4), false);
  assert.equal(isStructuralSpreadsheetRow(undefined), false);
  assert.equal(isStructuralSpreadsheetRow(null), false);
  assert.equal(findSpreadsheetDataRowIndex(source, 2, 1), null);
});

test("hidden or removed spreadsheet records never resolve to another row at their former index", () => {
  const nodes = { hidden: { rowIndex: null }, moved: { rowIndex: 4 } };
  const source = { getRowNode: id => nodes[id] };
  assert.equal(spreadsheetPointRowIndex(source, { rowId: "hidden", rowIndex: 1 }), null);
  assert.equal(spreadsheetPointRowIndex(source, { rowId: "removed", rowIndex: 1 }), null);
  assert.equal(spreadsheetPointRowIndex(source, { rowId: "moved", rowIndex: 1 }), 4);
  assert.equal(spreadsheetPointRowIndex(source, { rowIndex: 1 }), 1);
});
