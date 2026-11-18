import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { equipmentDisplayName as unitTitle } from "../app/equipmentDisplayName.ts";

const source = await readFile(new URL("../app/EquipmentAccountingView.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("EquipmentAccountingView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
const collect = node => { nodes.push(node); ts.forEachChild(node, collect); };
collect(ast);
function declaration(name) {
  const node = nodes.find(node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(ast) === name);
  assert.ok(node, `Expected actual implementation: ${name}`);
  return ts.isVariableDeclaration(node) ? `const ${node.getText(ast)};` : node.getText(ast);
}
function bind(code, result, environment = {}) {
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(environment), `${compiled}\nreturn ${result};`)(...Object.values(environment));
}
const helpers = bind(["equipmentCellKey", "formatEquipmentHours", "parseEquipmentClipboardHours"].map(declaration).join("\n"), "{equipmentCellKey,formatEquipmentHours,parseEquipmentClipboardHours,unitTitle}", { unitTitle });
const clipboard = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(ast) === "useTimesheetClipboard").arguments[0];
function clipboardCallback(name, environment) {
  const property = clipboard.properties.find(property => property.name?.getText(ast) === name);
  assert.ok(property?.initializer);
  return bind(`const callback = ${property.initializer.getText(ast)};`, "callback", { ...helpers, ...environment });
}
const month = "2026-11", monthDays = Array.from({ length: 30 }, (_, index) => index + 1);
const unit = { id: 7, equipmentType: "Кран", brand: "Тест", model: "К-1", registrationNumber: "А001", organization: "Организация А" };
const six = { productive: 4, downtime: 2, reportProductive: 8, reportDowntime: 0, mark: { productiveHours: 4, downtimeHours: 2 }, mismatch: true };
const eight = { productive: 0, downtime: 0, reportProductive: 5, reportDowntime: 0, mark: { productiveHours: 0, downtimeHours: 0 }, mismatch: true };
const monthRows = [{ unit, byDate: new Map([["2026-11-01", { productive: 9, downtime: 1, reportProductive: 9, reportDowntime: 1 }], ["2026-11-06", six], ["2026-11-08", eight]]), productive: 13, downtime: 3, total: 16 }];
const timesheetMarksByCell = new Map([["7:2026-11-06", { equipmentId: 7, workDate: "2026-11-06", productiveHours: 4, downtimeHours: 2, note: "Шестое число" }], ["7:2026-11-08", { equipmentId: 7, workDate: "2026-11-08", productiveHours: 0, downtimeHours: 0, note: "Восьмое число" }]]);
const base = { ...helpers, month, monthRows, visibleMonthDays: monthDays, timesheetMarksByCell };

test("equipment month defaults to imported order while preserving an explicitly saved manual order", () => {
  const code = declaration("monthFilters");
  for (const [rowOrder, expected] of [
    [null, false], [{ ready: true, hasImportOrder: false, hasSavedOrder: false }, false],
    [{ ready: true, hasImportOrder: true, hasSavedOrder: false, importOrderRevision: 3 }, true],
    [{ ready: true, hasImportOrder: true, hasSavedOrder: true }, false],
  ]) {
    const filter = bind(code, "monthFilters", {
      rowOrder, monthImportRank: () => 0, orderedMonthRows: monthRows, monthFilterColumns: [], equipmentMonthRowId: row => String(row.unit.id), siteId: 1, month, section: "month", focusedEquipmentId: null,
      useTimesheetFilters: options => options,
    });
    assert.equal(filter.presentation, "checklist"); assert.equal(filter.includeConditions, false);
    assert.equal(filter.importOrder.defaultSort, expected);
    assert.equal(filter.importOrder.activation, rowOrder?.importOrderRevision ?? 0);
  }
});

test("equipment navigation keeps historical identity and passes the full roster to a resettable column filter", () => {
  const historicalEntry = { ...unit, id: 900, equipmentId: 7, workDate: "2026-11-01", hours: 8 };
  const otherUnit = { ...unit, id: 8, registrationNumber: "А002" };
  const payload = { units: [otherUnit], entries: [historicalEntry] };
  const units = bind(declaration("monthUnits"), "monthUnits", { payload, useMemo: create => create() });
  assert.deepEqual(units.map(unit => unit.id), [8, 7], "Historical rows use equipment IDs, never report row IDs");
  assert.equal(historicalEntry.id, 900, "Source report identity must remain unchanged");
  const orderedMonthRows = [monthRows[0], { ...monthRows[0], unit: otherUnit }];
  for (const [section, focusedEquipmentId, expected] of [
    ["month", 7, "7"], ["month", 8, "8"], ["month", 99, "99"], ["month", null, undefined], ["registry", 7, undefined],
  ]) {
    const onClearEquipmentFocus = () => {};
    const filter = bind(declaration("monthFilters"), "monthFilters", {
      section, focusedEquipmentId, orderedMonthRows, rowOrder: null, monthImportRank: () => 0, monthFilterColumns: [],
      equipmentMonthRowId: row => String(row.unit.id), siteId: 1, month, loading: false, payload, onClearEquipmentFocus,
      useTimesheetFilters: options => options,
    });
    assert.equal(filter.rows, orderedMonthRows, "Resetting a filter must have every row available without another fetch");
    assert.equal(filter.navigationFilter?.value, expected);
    if (expected) {
      assert.equal(filter.navigationFilter.columnId, "equipment");
      assert.equal(filter.navigationFilter.onCleared, onClearEquipmentFocus);
      assert.equal(filter.navigationFilter.ready, true);
    }
  }
  assert.equal(orderedMonthRows.length, 2);
  for (const isActive of [true, false]) {
    const movement = bind(declaration("monthRowMoves"), "monthRowMoves", {
      rowOrder: {}, monthFilters: { isActive }, focusedEquipmentId: 7, timesheetEditor: null, timesheetInlineEditor: null,
      navigationBusy: false, loading: false, section: "month", siteId: 1, month, monthRows,
      useNativeRowMoves: (_order, filtered) => ({ filtered }),
    });
    assert.equal(movement.filtered, isActive, "Reset restores normal reordering through the actual filter state");
  }
  assert.doesNotMatch(source, /focusedMonthRows|employee-navigation-focus/);
});

test("equipment day filters keep the complete month and only change matching equipment rows", () => {
  const code = ["visibleMonthDays", "visibleDaysKey", "monthRows"].map(declaration).join("\n");
  for (const dayCount of [28, 29, 30, 31]) {
    const calendarDays = Array.from({ length: dayCount }, (_, index) => index + 1);
    for (const ids of [["2026-11-02"], ["2026-11-08", "2026-11-06"], ["2026-12-06"], []]) {
      const result = bind(code, "{visibleMonthDays,visibleDaysKey,monthRows}", {
        monthDays: calendarDays, month, monthFilters: { dayFilterIds: ids, rows: monthRows }, useMemo: create => create(),
      });
      assert.equal(result.visibleMonthDays, calendarDays, "A day filter must never shrink the month tracks");
      assert.equal(result.visibleDaysKey, calendarDays.join("|"));
      assert.equal(result.monthRows, monthRows, "The table keeps using the filtered equipment rows");
    }
  }
  assert.doesNotMatch(source, /personnel-timesheet-day-focus|Выбранные дни/, "Filtering must not insert a layout-shifting date focus bar");
  assert.match(source, /<th colSpan=\{visibleMonthDays\.length\}>Дни месяца<\/th>/);
  for (const tag of ["thead", "tbody", "tfoot"]) {
    const section = nodes.find(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === tag && node.getText(ast).includes("visibleMonthDays.map("));
    assert.ok(section, `${tag} must use the same complete calendar`);
  }
});

test("equipment clipboard keeps calendar coordinates and preserves manual zero and downtime", () => {
  assert.equal(clipboardCallback("getValue", base)(0, 0), "9/1", "An unfiltered date remains available in its original position");
  for (const [index, day, expected] of [[5, 6, "4/2"], [7, 8, "0"]]) {
    assert.equal(clipboardCallback("getValue", base)(0, index), expected);
    assert.equal(clipboardCallback("getUndoValue", base)(0, index), expected);
    assert.equal(clipboardCallback("getUndoNote", base)(0, index), day === 6 ? "Шестое число" : "Восьмое число");
    const opened = [];
    clipboardCallback("onActivate", { ...base, openTimesheetInlineEditor: (...args) => opened.push(args) })(0, index);
    assert.deepEqual(opened[0], [7, `2026-11-${String(day).padStart(2, "0")}`, 0, index]);
  }
});

test("equipment paste and deletion keep the selected calendar dates without changing neighbouring columns", async () => {
  for (const value of ["П 3", ""]) {
    const requests = [];
    const environment = {
      ...base, fullDate: value => value, siteId: 1, navigationBusy: false, loading: false,
      payload: { siteId: 1, month, canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true },
      clipboardViewScope: { current: "view:all-days:equipment-7" },
      post: async body => { requests.push(body); return {}; },
      batchSave: { getCellState: () => undefined, run: async jobs => ({ saved: await Promise.all(jobs.map(async job => ({ job, value: await job.save() }))), failed: [] }) },
    };
    const paste = bind(declaration("pasteEquipmentTimesheetCells"), "pasteEquipmentTimesheetCells", environment);
    const changes = [{ rowIndex: 0, columnIndex: 5, value }, { rowIndex: 0, columnIndex: 7, value }];
    const result = await paste(changes);
    assert.deepEqual(requests.map(request => request.workDate), ["2026-11-06", "2026-11-08"]);
    assert.deepEqual(requests.map(request => request.equipmentId), [7, 7]);
    assert.deepEqual(requests.map(request => value ? request.downtimeHours : request.clear), value ? [3, 3] : [true, true]);
    assert.deepEqual(result.savedChanges, changes);
    assert.deepEqual(result.failedChanges, []);
  }
});

test("equipment day filters retain column identity while changes to rows or month invalidate clipboard positions", () => {
  const code = declaration("monthRowOrderKey");
  const environment = { siteId: 1, section: "month", month, monthRows, visibleDaysKey: monthDays.join("|"), useMemo: create => create() };
  const first = bind(code, "monthRowOrderKey", { ...environment, monthFilters: { dayFilterIds: ["2026-11-06"] } });
  const second = bind(code, "monthRowOrderKey", { ...environment, monthFilters: { dayFilterIds: ["2026-11-06", "2026-11-08"] } });
  assert.equal(first, second, "Filtering the same rows must not renumber the day columns");
  assert.notEqual(first, bind(code, "monthRowOrderKey", { ...environment, monthRows: [] }));
  assert.notEqual(first, bind(code, "monthRowOrderKey", { ...environment, month: "2026-12" }));
});

test("equipment export retains the complete month and totals while equipment rows are filtered", () => {
  let preview;
  const exportPreview = bind(declaration("openTimesheetExportPreview"), "openTimesheetExportPreview", {
    ...base, monthDays, siteId: 1, payload: { siteName: "Учебный проект" }, focusedEquipmentId: 7, monthFilters: { context: { activeColumns: new Set(["equipment"]) } },
    timesheetEditor: null, timesheetInlineEditor: null, savingTimesheetMark: false,
    savingBulkTimesheetMarks: false, batchSave: { hasFailures: false }, timesheetMarkConflict: "",
    requireSavedExcelRows: () => true, setError() {},
    equipmentExcelName: () => "Кран Тест", titleCase: value => value,
    MONTH_FORMATTER: new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }),
    excelFileName: () => "Табель.xlsx", monthDayTotals: new Map([["2026-11-01", 10], ["2026-11-06", 6]]),
    monthSummary: { productive: 13, downtime: 3, total: 16 }, openExcelExportPreview: value => { preview = value; },
  });
  exportPreview();
  assert.equal(preview.workbook.dates.length, 30);
  assert.equal(preview.workbook.rows[0].dailyValues[0], "9 / П 1");
  assert.equal(preview.workbook.rows[0].dailyValues[7], 0, "A saved zero must stay distinct from an unfilled day in Excel");
  assert.equal(preview.workbook.rows[0].dailyValues[8], "");
  assert.equal(preview.workbook.dayTotals[0], 10);
  assert.equal(preview.workbook.productiveTotal, 13);
  assert.equal(preview.workbook.downtimeTotal, 3);
  assert.equal(preview.workbook.totalHours, 16);
  assert.deepEqual(preview.source.equipmentIds, [7], "Changing export dates must preserve the selected equipment");
});

test("late equipment saves do not add undo positions into a different date view", async () => {
  for (const viewChanged of [false, true]) {
    let respond;
    const undo = [], scope = { current: "view:all-days:equipment-7" };
    const environment = {
      ...base, payload: { siteId: 1, month, canUpdateTimesheet: true, canCreateTimesheet: true, canDeleteTimesheet: true }, savingBulkTimesheetMarks: false,
      activeScope: { current: `1:month:${month}` }, activeScopeVersion: { current: 0 },
      markWrites: { current: 0 }, markRevision: { current: 0 }, refreshControl: { current: null },
      clipboardViewScope: scope, batchSave: { getCellState: () => undefined, clearCell() {} },
      post: () => new Promise(resolve => { respond = resolve; }), setPayload() {}, setSavingTimesheetMark() {},
      rememberEquipmentTimesheetUndo: changes => undo.push(...changes),
    };
    const save = bind(declaration("persistEquipmentTimesheetMark"), "persistEquipmentTimesheetMark", environment);
    const pending = save({ equipmentId: 7, workDate: "2026-11-06" }, { productiveHours: 5, downtimeHours: 0, note: "", clear: false });
    if (viewChanged) scope.current = "view:all-days:different-rows";
    respond({});
    await pending;
    assert.equal(undo.length, viewChanged ? 0 : 1);
    if (!viewChanged) assert.deepEqual(undo[0], { rowIndex: 0, columnIndex: 5, value: "4/2", note: "Шестое число", expectedRevision: null, previousRevision: null });
  }
});

test("equipment export waits for bulk completion and unresolved conflicts", () => {
  for (const blocked of ["bulk", "failures", "conflict"]) {
    let warned = false;
    const open = bind(declaration("openTimesheetExportPreview"), "openTimesheetExportPreview", {
      timesheetEditor: null, timesheetInlineEditor: null, savingTimesheetMark: false,
      savingBulkTimesheetMarks: blocked === "bulk", batchSave: { hasFailures: blocked === "failures" },
      timesheetMarkConflict: blocked === "conflict" ? "Ячейка изменена" : "",
      requireSavedExcelRows: pending => { warned = Boolean(pending); return !pending; },
      openExcelExportPreview() { assert.fail("Export cannot publish a stale or partially saved view"); },
    });
    open();
    assert.equal(warned, true);
  }
});

test("late equipment retries cannot restore undo metadata into different filtered rows", () => {
  const undo = [];
  const apply = bind(declaration("applySavedEquipmentTimesheetCells"), "applySavedEquipmentTimesheetCells", {
    ...base, siteId: 1, clipboardViewScope: { current: "view:all-days:different-rows" }, setPayload() {},
    rememberEquipmentTimesheetUndo: changes => undo.push(...changes), forgetEquipmentTimesheetUndo() { assert.fail("Stale undo must not affect a new view"); },
  });
  apply([{ job: { key: "7:2026-11-06" }, value: { equipmentId: 7, workDate: "2026-11-06", viewScope: "view:all-days:equipment-7", undoValue: "4/2", undoNote: "" } }], true);
  assert.deepEqual(undo, []);
});
