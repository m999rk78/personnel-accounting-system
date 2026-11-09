import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { isPersonnelTimesheetValue } from "../app/personnelTimesheetValues.ts";

const source = await readFile(new URL("../app/TimesheetView.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("TimesheetView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
const helpers = bind(["dateForDay", "cellKey", "effectiveHours", "markValue", "isReportTracked"].map(declaration).join("\n"), "{dateForDay,cellKey,effectiveHours,markValue,isReportTracked}");
const clipboard = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(ast) === "useTimesheetClipboard").arguments[0];
function clipboardCallback(name, environment) {
  const property = clipboard.properties.find(property => property.name?.getText(ast) === name);
  assert.ok(property?.initializer);
  return bind(`const callback = ${property.initializer.getText(ast)};`, "callback", { ...helpers, ...environment });
}
const month = "2026-11", days = Array.from({ length: 30 }, (_, index) => index + 1);
const employee = { id: 7, fullName: "Тестовый сотрудник", employmentType: "ОПР", department: "Монтаж", position: "Монтажник" };
const entriesByCell = new Map([["7:2026-11-01", { employeeId: 7, workDate: "2026-11-01", hours: 9, masters: "Мастер", zones: "А" }], ["7:2026-11-06", { employeeId: 7, workDate: "2026-11-06", hours: 8, masters: "Мастер", zones: "А" }], ["7:2026-11-08", { employeeId: 7, workDate: "2026-11-08", hours: 5, masters: "Мастер", zones: "А" }]]);
const marksByCell = new Map([["7:2026-11-06", { employeeId: 7, workDate: "2026-11-06", hours: 4, code: null, note: "Шестое число" }], ["7:2026-11-08", { employeeId: 7, workDate: "2026-11-08", hours: 3, code: null, note: "Восьмое число" }]]);
const base = { ...helpers, month, visibleDays: days, visibleEmployees: [employee], entriesByCell, marksByCell };

test("one or several day filters keep every date column and retain the filtered employee rows", () => {
  const code = ["visibleDays", "visibleDaysKey", "visibleEmployees"].map(declaration).join("\n");
  for (const dayCount of [28, 29, 30, 31]) {
    const calendarDays = Array.from({ length: dayCount }, (_, index) => index + 1);
    for (const ids of [["2026-11-02"], ["2026-11-08", "2026-11-06"], ["2026-12-06"], []]) {
      const selectedRows = [employee];
      const result = bind(code, "{visibleDays,visibleDaysKey,visibleEmployees}", {
        days: calendarDays, month, filters: { dayFilterIds: ids, rows: selectedRows }, useMemo: create => create(), dateForDay: helpers.dateForDay,
      });
      assert.equal(result.visibleDays, calendarDays, "Filtering rows must not replace or narrow the calendar tracks");
      assert.equal(result.visibleDaysKey, calendarDays.join("|"));
      assert.equal(result.visibleEmployees, selectedRows, "Only the matching employees remain visible");
    }
  }
  assert.doesNotMatch(source, /personnel-timesheet-day-focus|Выбранные дни/, "A day filter must not add a layout-shifting focus bar");
  assert.match(source, /<th colSpan=\{visibleDays\.length\}>Дни месяца<\/th>/);
  for (const tag of ["thead", "tbody", "tfoot"]) {
    const section = nodes.find(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === tag);
    assert.ok(section?.getText(ast).includes("visibleDays.map("), `${tag} must use the same complete calendar`);
  }
});

test("clipboard values, undo values and activation keep calendar indices after day filtering", () => {
  assert.equal(clipboardCallback("getValue", base)(0, 0), "9", "The unfiltered first date stays at its original coordinate");
  for (const [index, day] of [[5, 6], [7, 8]]) {
    assert.equal(clipboardCallback("getValue", base)(0, index), String(day === 6 ? 4 : 3));
    assert.equal(clipboardCallback("getUndoValue", base)(0, index), String(day === 6 ? 4 : 3));
    assert.equal(clipboardCallback("getUndoNote", base)(0, index), day === 6 ? "Шестое число" : "Восьмое число");
    const opened = [];
    clipboardCallback("onActivate", { ...base, openInlineEditor: (...args) => opened.push(args) })(0, index);
    assert.deepEqual(opened[0], [7, `2026-11-${String(day).padStart(2, "0")}`, 0, index]);
  }
});

function pasteHarness() {
  const requests = [];
  const environment = {
    ...base, isPersonnelTimesheetValue, dateLabel: value => value,
    payload: { siteId: 1, month, canEdit: true, canCreate: true, canUpdate: true, canDelete: true },
    navigationBusy: false, loading: false, activeScope: { current: `1:${month}` },
    clipboardViewScope: { current: "view:all-days:employee-7" },
    window: { location: { replace() { assert.fail("Unexpected redirect"); } } },
    fetch: async (_url, options) => { const body = JSON.parse(options.body); requests.push(body); return { ok: true, status: 200, json: async () => ({}) }; },
    batchSave: { getCellState: () => undefined, run: async jobs => ({ saved: await Promise.all(jobs.map(async job => ({ job, value: await job.save() }))), failed: [] }) },
  };
  return { requests, paste: bind(declaration("pasteTimesheetCells"), "pasteTimesheetCells", environment) };
}

test("pasting and clearing chosen cells do not remap dates or write to other calendar columns", async () => {
  for (const value of ["6", ""]) {
    const ui = pasteHarness();
    const changes = [{ rowIndex: 0, columnIndex: 5, value }, { rowIndex: 0, columnIndex: 7, value }];
    const result = await ui.paste(changes);
    assert.deepEqual(ui.requests.map(request => request.workDate), ["2026-11-06", "2026-11-08"]);
    assert.deepEqual(ui.requests.map(request => request.employeeId), [7, 7]);
    assert.deepEqual(result.savedChanges, changes);
    assert.deepEqual(result.failedChanges, []);
  }
});

test("day filters preserve clipboard column identity while row and month changes still invalidate it", () => {
  const code = declaration("rowOrderKey");
  const environment = { siteId: 1, month, visibleEmployees: [employee], visibleDaysKey: days.join("|"), useMemo: create => create() };
  const first = bind(code, "rowOrderKey", { ...environment, filters: { dayFilterIds: ["2026-11-06"] } });
  const second = bind(code, "rowOrderKey", { ...environment, filters: { dayFilterIds: ["2026-11-06", "2026-11-08"] } });
  assert.equal(first, second, "The same rows and calendar keep their existing coordinates");
  assert.notEqual(first, bind(code, "rowOrderKey", { ...environment, visibleEmployees: [] }));
  assert.notEqual(first, bind(code, "rowOrderKey", { ...environment, month: "2026-12" }));
});

test("monthly totals and Excel retain the full calendar while employee rows are filtered", () => {
  const payload = { siteName: "Учебный проект", employees: [employee] };
  const metrics = bind(declaration("rowMetricsByEmployee"), "rowMetricsByEmployee", { ...base, days, payload, useMemo: create => create() });
  assert.deepEqual(metrics.get(7), { timesheet: 16, reports: 22, difference: -6 });
  let preview;
  const exportPreview = bind(declaration("openTimesheetExportPreview"), "openTimesheetExportPreview", {
    ...base, days, payload, siteId: 1, reconciliationTimesheet: 16, reconciliationDifference: -6, dayTotals: new Map(),
    monthLabel: () => "Ноябрь 2026", excelFileName: () => "Табель.xlsx", setError() {}, openExcelExportPreview: value => { preview = value; },
  });
  exportPreview();
  assert.equal(preview.workbook.dates.length, 30);
  assert.equal(preview.workbook.dates[0], "2026-11-01");
  assert.equal(preview.workbook.rows[0].dailyValues[0], 9, "A different day's filter must not remove first-day values from export");
  assert.equal(preview.workbook.rows[0].timesheetHours, 16);
  assert.equal(preview.workbook.rows[0].reportHours, 22);
});

test("late single-cell saves do not insert stale visible-column indices into a different view's undo", async () => {
  for (const viewChanged of [false, true]) {
    let respond;
    const undo = [];
    const scope = { current: "view:all-days:employee-7" };
    const environment = {
      ...base,
      payload: { siteId: 1, month, canEdit: true, canCreate: true, canUpdate: true, canDelete: true },
      savingBulkMarks: false, activeScope: { current: `1:${month}` }, activeScopeVersion: { current: 0 },
      markWrites: { current: 0 }, markRevision: { current: 0 }, clipboardViewScope: scope,
      batchSave: { getCellState: () => undefined, clearCell() {} },
      setSavingMark() {}, setPayload() {}, rememberTimesheetUndo: changes => undo.push(...changes), refreshControl: { current: null },
      window: { location: { replace() { assert.fail("Unexpected redirect"); } } },
      fetch: () => new Promise(resolve => { respond = resolve; }),
    };
    const save = bind(declaration("persistMark"), "persistMark", environment);
    const pending = save({ employeeId: 7, workDate: "2026-11-06" }, "5");
    if (viewChanged) scope.current = "view:all-days:different-rows";
    respond({ ok: true, status: 200, json: async () => ({}) });
    assert.equal(await pending, true);
    assert.equal(undo.length, viewChanged ? 0 : 1);
    if (!viewChanged) assert.equal(undo[0].columnIndex, 5, "The sixth calendar day remains at its full-month coordinate");
  }
});
