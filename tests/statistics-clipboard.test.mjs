import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { statisticsClipboardNumber, statisticsClipboardText } from "../app/statisticsClipboard.ts";
import { formatStatisticsDate } from "../app/statisticsPeriod.ts";
import { parseSpreadsheetText } from "../app/spreadsheetClipboard.ts";
import { formatTimesheetHours } from "../app/timesheetFormatting.ts";

async function source(path) {
  return ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function declaration(file, name) {
  let result;
  const visit = node => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(file) === name) result = node;
    if (!result) ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(result, `Missing actual declaration: ${name}`);
  return ts.isVariableDeclaration(result) ? result.initializer.getText(file) : result.getText(file);
}
function evaluate(expression, environment = {}) {
  const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment));
}
const tableSource = await source("../app/StatisticsZoneTable.tsx");
const viewSource = await source("../app/StatisticsView.tsx");
const seriesByKind = evaluate(declaration(viewSource, "seriesByKind"));
const HoursCell = evaluate(declaration(tableSource, "HoursCell"), { formatTimesheetHours });
const columnsFor = (kind, byDay) => evaluate(declaration(tableSource, "columns"), {
  series: seriesByKind[kind], byDay, useMemo: callback => callback(), HoursCell, statisticsClipboardNumber, formatStatisticsDate,
});
const rowId = evaluate(declaration(tableSource, "rowId"));
const zone = (id, name, values = {}) => Object.freeze({ zoneId: id, zone: name, welders: 0, installers: 0, other: 0, productive: 0, downtime: 0, total: 0, ...values });
const first = zone(1, 'Зона "А"\tЭстакада\nУчасток 2', { welders: 12000.5, installers: 345, total: 12345.5 });
const second = zone(2, "Площадка Б", { welders: 8, other: 0.25, productive: 4.5, downtime: 3.75, total: 8.25 });
const unassigned = zone(null, "Без зоны");

/** The real column formatters run against a displayed model, with no DOM or write APIs. */
function fixture(kind, rows, { hiddenRows = [], displayedFields, structural = [], byDay = false } = {}) {
  const definitions = columnsFor(kind, byDay);
  const fields = displayedFields ?? definitions.map(definition => definition.field);
  const columns = fields.map(id => ({ getColId: () => id, definition: definitions.find(definition => definition.field === id) }));
  const nodes = rows.map((data, rowIndex) => Object.freeze({ id: rowId(data), data, rowIndex }));
  for (const [index, flags] of structural) nodes.splice(index, 0, Object.freeze({ id: `structural-${index}`, data: zone(-index, "Не копировать"), ...flags }));
  const hidden = hiddenRows.map(data => Object.freeze({ id: rowId(data), data, rowIndex: null }));
  const calls = [];
  const operations = {
    getAllDisplayedColumns: () => columns,
    getDisplayNameForColumn: (column, location) => { assert.equal(location, "header"); return column.definition?.headerName ?? column.getColId(); },
    getDisplayedRowCount: () => nodes.length,
    getDisplayedRowAtIndex: index => nodes[index],
    getRowNode: id => {
      const index = nodes.findIndex(node => node.id === id);
      return index < 0 ? hidden.find(node => node.id === id) : { ...nodes[index], rowIndex: index };
    },
    getCellValue: ({ rowNode, colKey, useFormatter }) => {
      assert.equal(useFormatter, true, "all copy modes must use the actual Excel-safe value formatter");
      assert.ok(colKey.definition, "selection/action columns must not enter the clipboard");
      const value = rowNode.data[colKey.getColId()];
      return colKey.definition.valueFormatter?.({ value, data: rowNode.data, node: rowNode, column: colKey }) ?? value;
    },
  };
  const grid = new Proxy(operations, {
    get(target, key) {
      assert.ok(Object.hasOwn(target, key), `Clipboard must not access a mutation or unknown API: ${String(key)}`);
      return (...args) => { calls.push(key); return target[key](...args); };
    },
    set() { throw new Error("Clipboard must not mutate the grid"); },
  });
  return { grid, calls, nodes, columns, definitions };
}

test("statistics clipboard numbers remain numeric Russian Excel values without unit or grouping characters", () => {
  for (const [value, expected] of [[0, "0"], [12345.5, "12345,5"], [0.125, "0,125"], [12.0000000001, "12,0000000001"]]) {
    assert.equal(statisticsClipboardNumber(value), expected);
    assert.doesNotMatch(statisticsClipboardNumber(value), /[\s\u00a0\u202fч]/u);
  }
  for (const value of [null, undefined, "12", NaN, Infinity, -Infinity]) assert.equal(statisticsClipboardNumber(value), "");
});

test("actual personnel columns preserve spaced screen numbers but copy exact ungrouped cells and quoted zone names", () => {
  const { grid, definitions } = fixture("personnel", [first, unassigned]);
  const numeric = definitions.find(column => column.field === "welders");
  assert.equal(numeric.cellRenderer({ value: 12345.5 }), "12\u202f345,5");
  assert.equal(numeric.valueFormatter({ value: 12345.5 }), "12345,5");
  const text = statisticsClipboardText(grid, { kind: "table" });
  assert.deepEqual(parseSpreadsheetText(text), [
    ["Зона", "Сварщики", "Монтажники", "Прочие", "Всего"],
    [first.zone, "12000,5", "345", "0", "12345,5"],
    ["Без зоны", "0", "0", "0", "0"],
  ]);
  assert.match(text, /"Зона ""А""\tЭстакада\nУчасток 2"/);
});

test("equipment copy contains work, downtime and totals with their own headers", () => {
  const { grid } = fixture("equipment", [second, unassigned]);
  assert.deepEqual(parseSpreadsheetText(statisticsClipboardText(grid, { kind: "table" })), [
    ["Зона", "Работа", "Простой", "Всего"],
    [second.zone, "4,5", "3,75", "8,25"],
    ["Без зоны", "0", "0", "0"],
  ]);
});

test("daily table copy uses the displayed date format and row copy uses the ISO date ID", () => {
  const dailyRows = [
    { workDate: "2026-10-30", productive: 4.5, downtime: 3.75, total: 8.25 },
    { workDate: "2026-11-02", productive: 1, downtime: 0, total: 1 },
  ];
  const { grid, definitions } = fixture("equipment", dailyRows, { byDay: true });
  assert.equal(definitions.find(column => column.field === "workDate").initialSort, "asc");
  assert.equal(definitions.find(column => column.field === "total").initialSort, undefined);
  assert.deepEqual(parseSpreadsheetText(statisticsClipboardText(grid, { kind: "table" })), [
    ["Дата", "Работа", "Простой", "Всего"], ["30.10.2026", "4,5", "3,75", "8,25"], ["02.11.2026", "1", "0", "1"],
  ]);
  assert.deepEqual(parseSpreadsheetText(statisticsClipboardText(grid, { kind: "row", rowId: "2026-11-02" })), [["02.11.2026", "1", "0", "1"]]);
});

test("table and column copy follow displayed sort order and columns, excluding hidden rows and controls", () => {
  const hidden = zone(9, "Скрытая поиском зона", { total: 99 });
  const { grid } = fixture("equipment", [unassigned, second], {
    hiddenRows: [first, hidden], displayedFields: ["ag-Grid-SelectionColumn", "total", "zone", "rowOrder", "actions"],
  });
  assert.deepEqual(parseSpreadsheetText(statisticsClipboardText(grid, { kind: "table" })), [
    ["Всего", "Зона"], ["0", "Без зоны"], ["8,25", second.zone],
  ]);
  assert.deepEqual(parseSpreadsheetText(statisticsClipboardText(grid, { kind: "column", columnId: "total" })), [["Всего"], ["0"], ["8,25"]]);
  assert.equal(statisticsClipboardText(grid, { kind: "column", columnId: "downtime" }), null);
  for (const columnId of ["ag-Grid-SelectionColumn", "rowOrder", "actions", "missing"]) assert.equal(statisticsClipboardText(grid, { kind: "column", columnId }), null);
});

test("row copy finds stable IDs after sorting and refuses hidden or removed rows instead of copying a neighbour", () => {
  const { grid } = fixture("personnel", [second, first], { hiddenRows: [unassigned] });
  assert.deepEqual(parseSpreadsheetText(statisticsClipboardText(grid, { kind: "row", rowId: "1" })), [[first.zone, "12000,5", "345", "0", "12345,5"]]);
  assert.equal(statisticsClipboardText(grid, { kind: "row", rowId: "unassigned" }), null);
  assert.equal(statisticsClipboardText(grid, { kind: "row", rowId: "deleted" }), null);
  const visibleNullZone = fixture("equipment", [unassigned]);
  assert.deepEqual(parseSpreadsheetText(statisticsClipboardText(visibleNullZone.grid, { kind: "row", rowId: "unassigned" })), [["Без зоны", "0", "0", "0"]]);
});

test("copy covers the entire displayed model beyond a viewport and does not mutate source data", () => {
  const rows = Object.freeze(Array.from({ length: 1200 }, (_, index) => zone(index + 1, `Зона ${index + 1}`, { downtime: index / 4, total: index / 4 })));
  const before = JSON.stringify(rows);
  const { grid, calls } = fixture("equipment", rows);
  const values = parseSpreadsheetText(statisticsClipboardText(grid, { kind: "column", columnId: "downtime" }));
  assert.equal(values.length, rows.length + 1);
  assert.deepEqual(values[0], ["Простой"]);
  assert.deepEqual(values[1], ["0"]);
  assert.deepEqual(values.at(-1), ["299,75"]);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(calls.filter(name => name === "getCellValue").length, rows.length);
});

test("empty models and structural rows do not create copied data", () => {
  const empty = fixture("personnel", []);
  assert.equal(statisticsClipboardText(empty.grid, { kind: "table" }), null);
  const structural = fixture("equipment", [second], { structural: [[0, { group: true }], [2, { footer: true }], [3, { detail: true }]] });
  assert.deepEqual(parseSpreadsheetText(statisticsClipboardText(structural.grid, { kind: "table" })), [
    ["Зона", "Работа", "Простой", "Всего"], [second.zone, "4,5", "3,75", "8,25"],
  ]);
});
