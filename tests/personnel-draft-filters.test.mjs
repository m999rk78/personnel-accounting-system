import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { compareGridValues, filterDateKey, matchesPersonnelFilter, normalizeFilterText } from "../app/gridFilterModel.ts";
import { pastePersonnelCells, personnelCellErrors, personnelOptionFields } from "../app/personnelSpreadsheet.ts";
import { personnelActivityTime } from "../app/personnelReportSorting.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const { dateTreeSetFilterParams } = await import(await compileModuleGraph(new URL("../app/DateTreeSetFilter.tsx", import.meta.url), {
  "./dateTreeSetFilter.css": "data:text/javascript,export%20default%20%7B%7D",
}));

async function sourceFile(path) {
  return ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const sharedGrid = await sourceFile("../app/GridFilters.tsx");
const reportGrid = await sourceFile("../app/PersonnelReportGrid.tsx");
const enterpriseFilters = await sourceFile("../app/GridEnterpriseFilters.tsx");

function descendants(file) {
  const nodes = [];
  const collect = node => { nodes.push(node); ts.forEachChild(node, collect); };
  collect(file);
  return nodes;
}
function declaration(file, name) {
  const node = descendants(file).find(node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(file) === name);
  assert.ok(node, `Expected actual implementation declaration: ${name}`);
  return ts.isVariableDeclaration(node) ? `const ${node.getText(file)};` : node.getText(file).replace(/^export\s+/, "");
}
function bind(code, result, environment = {}) {
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(environment), `${compiled}\nreturn ${result};`)(...Object.values(environment));
}
const filterLifecycle = descendants(sharedGrid).find(node => ts.isCallExpression(node)
  && node.expression.getText(sharedGrid) === "useEffect"
  && node.arguments[0]?.getText(sharedGrid).includes("previousEditState.current?.api"));
assert.ok(filterLifecycle, "Expected the native filter lifecycle effect");

/** Run the actual React effect against the native grid API boundary. */
function editorHarness(initialRows) {
  const clears = [];
  let model = null;
  const api = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    isAnyFilterPresent: () => model !== null,
    setFilterModel(next) { clears.push(next); model = next; },
  };
  const previousEditState = { current: null };
  const run = (rows = initialRows, blocked = false, nativeFilters = true) => bind(
    `const effect = ${filterLifecycle.arguments[0].getText(sharedGrid)};`, "effect", {
      api, nativeFilters, sourceRows: rows, sourceGetRowId: ({ data }) => data.rowKey,
      sourceContext: undefined, previousEditState, rowOrderBlocked: blocked,
    },
  )();
  run();
  return { api, run, clears, get model() { return model; }, set model(next) { model = next; } };
}
const appliedFilters = () => ({
  employeeName: { filterType: "multi", filterModels: [null, { filterType: "set", values: ["Иванов"] }, null] },
  hours: { filterType: "multi", filterModels: [null, null, { filterType: "number", type: "greaterThan", filter: 4 }] },
});

test("opening, typing in and closing an existing personnel draft cell preserves combined filters", () => {
  // PersonnelReportGrid uses kind=entry for all workflow states, including drafts.
  const rows = [{ kind: "entry", rowKey: "report-17-101" }];
  const ui = editorHarness(rows);
  const filters = appliedFilters();
  ui.model = filters;
  ui.run(rows, true);
  assert.deepEqual(ui.model, filters, "Opening the cell must not discard the filter selection");
  ui.run(rows.map(row => ({ ...row })), true);
  ui.run(rows, false);
  assert.deepEqual(ui.model, filters);
  assert.deepEqual(ui.clears, []);
});

test("new legacy editing rows are revealed once, while edits of the same row retain a reapplied filter", () => {
  const rows = [{ kind: "entry", rowKey: "saved-1" }];
  const ui = editorHarness(rows);
  ui.model = appliedFilters();
  const editing = [{ kind: "edit", rowKey: "saved-1" }];
  ui.run(editing, true);
  assert.equal(ui.model, null, "A newly inserted editing row must remain reachable");
  assert.equal(ui.clears.length, 1);
  const filters = appliedFilters();
  ui.model = filters;
  ui.run(editing.map(row => ({ ...row })), true);
  ui.run(editing, false);
  assert.deepEqual(ui.model, filters);
  assert.equal(ui.clears.length, 1);
  ui.run([...editing, { kind: "draft", rowKey: "blank-2" }]);
  assert.equal(ui.model, null);
  assert.equal(ui.clears.length, 2);
});

test("ordinary draft refreshes and unavailable native grid instances do not erase filters", () => {
  const rows = [{ kind: "entry", rowKey: "draft-1" }];
  const ui = editorHarness(rows);
  const filters = appliedFilters();
  ui.model = filters;
  ui.run([...rows, { kind: "entry", rowKey: "draft-2" }]);
  ui.run([{ kind: "draft", rowKey: "new-legacy" }], true, false);
  ui.api.destroyed = true;
  ui.run([{ kind: "draft", rowKey: "new-legacy" }], true);
  assert.deepEqual(ui.model, filters);
  assert.deepEqual(ui.clears, []);
});

test("filter summary rerenders preserve native filter definitions while spreadsheet permission changes update keyboard handling", () => {
  const source = ["isInteractiveTarget", "sourceDefaultColDef", "hasSpreadsheetBatch", "enhancedDefaultColDef"]
    .map(name => declaration(sharedGrid, name)).join("\n");
  let memo;
  const useMemo = (create, dependencies) => {
    if (!memo || dependencies.length !== memo.dependencies.length || dependencies.some((value, index) => !Object.is(value, memo.dependencies[index]))) {
      memo = { dependencies, value: create() };
    }
    return memo.value;
  };
  class DomElement {
    constructor(tagName) { this.tagName = tagName; }
    closest(selector) { return selector.split(",").some(part => part.trim() === this.tagName) ? this : null; }
  }
  const sourceDefault = { suppressKeyboardEvent: ({ event }) => event.key === "Escape" };
  const render = onSpreadsheetBatch => bind(source, "enhancedDefaultColDef", {
    props: { defaultColDef: sourceDefault }, onSpreadsheetBatch, compareGridValues,
    useMemo, Element: DomElement,
  });
  const plainKey = { event: { target: new DomElement("div"), key: "ArrowDown" } };
  const initial = render(() => true);
  assert.equal(initial.suppressKeyboardEvent(plainKey), true);
  for (let index = 0; index < 3; index++) {
    assert.equal(render(() => true), initial, "Filtering changes totals and inline callbacks; replacing colDef would destroy AG Grid's open Multi Filter");
  }
  const readOnly = render(undefined);
  assert.notEqual(readOnly, initial, "Revoking spreadsheet editing must update the keyboard guard");
  assert.equal(readOnly.suppressKeyboardEvent(plainKey), false, "Read-only grids retain normal AG Grid navigation");
  assert.equal(readOnly.suppressKeyboardEvent({ event: { target: new DomElement("input"), key: "ArrowDown" } }), true, "Typing inside filter inputs must still bypass AG Grid keyboard handling");
  assert.equal(readOnly.suppressKeyboardEvent({ event: { target: new DomElement("div"), key: "Escape" } }), true, "Column-specific keyboard guards remain effective");
  assert.equal(render(undefined), readOnly);
  const editableAgain = render(() => true);
  assert.notEqual(editableAgain, readOnly);
  assert.equal(editableAgain.suppressKeyboardEvent(plainKey), true);
});

function nativeParams(kind, options = {}) {
  const source = ["setCellHeight", "dateComparator", "enterpriseFilterParams"].map(name => declaration(enterpriseFilters, name)).join("\n");
  const configure = bind(source, "enterpriseFilterParams", {
    sortingChild: {}, compareGridValues, filterDateKey, normalizeFilterText, dateTreeSetFilterParams,
    document: { createElement: () => ({ getContext: () => ({ font: "", measureText: value => ({ width: String(value).length * 8 }) }) }) },
    window: { innerWidth: 907 },
  });
  const nodes = ["Иванов", "Петров", null].map(value => ({ value }));
  const params = {
    api: { forEachNode: callback => nodes.forEach(callback), getCellValue: ({ rowNode }) => rowNode.value },
    column: { getColId: () => "value" }, colDef: {},
    getValue: node => node.value, doesRowPassOtherFilter: () => true,
  };
  const result = configure(params, { kind, ...options });
  return { ...result, filters: result.filters.map(filter => ({ ...filter, filterParams: typeof filter.filterParams === "function" ? filter.filterParams(params) : filter.filterParams })) };
}

test("compact and full native filters keep existing selections and condition models in compatible child slots", () => {
  for (const [kind, condition] of [
    ["text", { filterType: "text", type: "contains", filter: "Иванов" }],
    ["number", { filterType: "number", type: "greaterThan", filter: 4 }],
    ["date", { filterType: "date", type: "equals", dateFrom: "2026-11-06 00:00:00" }],
  ]) {
    const model = { filterType: "multi", filterModels: [null, { filterType: "set", values: [kind === "date" ? "2026-11-06" : kind === "number" ? "8" : "Иванов"] }, condition] };
    const slots = model.filterModels.map(child => child?.filterType ?? null);
    for (const presentation of ["full", "compact"]) {
      const configuration = nativeParams(kind, { presentation });
      assert.equal(configuration.filters.length, slots.length);
      const destinations = configuration.filters.map((child, index) => !slots[index] ? null : child.filter === "agSetColumnFilter" ? "set" : child.filter === "agDateColumnFilter" ? "date" : child.filter === "agNumberColumnFilter" ? "number" : child.filter === "agTextColumnFilter" ? "text" : "unsupported");
      assert.deepEqual(destinations, slots, "Changing presentation must not reinterpret the applied Set selection or condition as a different child filter");
    }
  }
});

test("native date checklist uses tree presentation while preserving original date values", () => {
  const { filterParams } = nativeParams("date").filters.find(item => item.filter === "agSetColumnFilter");
  assert.equal(filterParams.treeList, true);
  assert.deepEqual(filterParams.treeListPathGetter("2026-11-06"), ["2026", "11", "06"]);
  assert.equal(filterParams.treeListFormatter("11", 1, ["2026"]), "Ноябрь 2026");
  assert.equal(filterParams.treeListFormatter("06", 2, ["2026", "11"]), "06.11.2026");
  assert.equal(filterParams.keyCreator, undefined, "Date hierarchy must not replace ISO model keys with presentation paths");
});

test("native checklists re-read mutable draft values on opening without broadening an explicit selection", () => {
  for (const kind of ["text", "number", "date"]) {
    const filter = nativeParams(kind).filters.find(item => item.filter === "agSetColumnFilter");
    assert.ok(filter);
    assert.equal(filter.filterParams.refreshValuesOnOpen, true, "Draft values change through valueGetter refs, so the checklist must reload");
    assert.equal(filter.filterParams.suppressClearModelOnRefreshValues, true, "Selecting all currently available values must not silently select future values");
    assert.equal(filter.filterParams.valueFormatter({ value: null }), "(Пустые)");
    assert.equal(filter.filterParams.valueFormatter({ value: 0 }), "0");
    assert.equal(filter.filterParams.textFormatter("  ФЁДОР  "), "федор");
  }
});

test("native draft conditions handle numeric zero, invalid numbers and inclusive date boundaries", () => {
  const number = nativeParams("number").filters.find(item => item.filter === "agNumberColumnFilter").filterParams;
  assert.equal(number.numberParser("0"), 0);
  assert.equal(number.numberParser(" 3,5 "), 3.5);
  assert.equal(number.numberParser(""), null);
  assert.equal(number.numberParser("ошибка"), null);
  const date = nativeParams("date").filters.find(item => item.filter === "agDateColumnFilter").filterParams;
  const boundary = new Date(2026, 10, 2);
  assert.equal(date.comparator(boundary, "02.11.2026"), 0);
  assert.equal(date.comparator(boundary, "01.11.2026") < 0, true);
  assert.equal(date.comparator(boundary, "03.11.2026") > 0, true);
  assert.equal(date.inRangeInclusive, true);
  assert.equal(date.isValidDate("31.11.2026"), false);
});

test("native checklist search selects matching values with Excel semantics when Apply is clicked", () => {
  for (const kind of ["text", "number", "date"]) {
    const filter = nativeParams(kind).filters.find(item => item.filter === "agSetColumnFilter");
    assert.equal(filter.filterParams.excelMode, "windows", "AG Grid's plain mini-search only narrows the list; Excel mode makes applying the search select its results");
    assert.equal(filter.filterParams.textFormatter("ПЁТР"), "петр");
  }
});

test("timesheet state search uses the same selection semantics and keeps state predicates separate from values", () => {
  const states = {
    values: [{ value: "manual", label: "Ручная правка" }, { value: "mismatch", label: "Расхождение" }],
    getValue: row => [row.manual && "manual", row.mismatch && "mismatch"].filter(Boolean),
  };
  const params = nativeParams("number", { stateFilter: states });
  const state = params.filters.find(item => item.title === "Состояние ячейки");
  assert.equal(state.filterParams.excelMode, "windows");
  assert.deepEqual(state.filterParams.values, ["manual", "mismatch"]);
  assert.equal(state.filterParams.valueFormatter({ value: "mismatch" }), "Расхождение");
  assert.deepEqual(state.filterValueGetter({ data: { manual: true, mismatch: false } }), ["manual"]);
  assert.deepEqual(state.filterValueGetter({ data: { manual: true, mismatch: true } }), ["manual", "mismatch"]);
  assert.deepEqual(params.buttons, ["clear", "cancel", "apply"], "Both checklists commit together through the parent Apply");
});

test("imported personnel names remain filterable after catalog matching and preservation of unknown Excel text", () => {
  const valueFor = bind(["displayDate", "statusLabels", "valueFor"].map(name => declaration(reportGrid, name)).join("\n"), "valueFor", {
    optionFields: personnelOptionFields, personnelActivityTime,
  });
  const catalogs = {
    employees: [{ id: 101, fullName: "Иван Тестовый" }, { id: 102, fullName: "Пётр Примеров" }],
    shifts: [{ id: 1, name: "День" }], zones: [{ id: 2, name: "Зона 1" }],
    mainWorkTypes: [{ id: 3, name: "Вспомогательные" }],
    subworkTypes: [{ id: 4, name: "Уборка территории", mainWorkTypeId: 3 }], masters: [{ id: 5, name: "Мастер" }],
  };
  // The browser upload smoke test covers XLSX parsing. Exercise the same parsed
  // strings through the production import adapter, draft storage and grid getter.
  const imported = [
    { workDate: "2026-10-25", employeeName: "  иван   тестовый ", hours: "08" },
    { workDate: "2026-10-26", employeeName: "Петр Примеров", hours: " 6,0 " },
    { workDate: "2026-10-25", employeeName: "Импортированный Неизвестный", hours: "ошибка" },
  ];
  const rows = imported.map((row, index) => ({
    rowKey: `import-${index}`, workDate: row.workDate, status: "draft",
    draft: pastePersonnelCells({ key: `import-${index}`, employeeId: "", employeeQuery: "", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", masterId: "", hours: "", note: "" }, {
      employeeName: row.employeeName, hours: row.hours, shift: "День", zone: "Зона 1",
      mainWork: "Вспомогательные", subwork: "Уборка территории", master: "Мастер", note: "Из Excel",
    }, catalogs),
  }));
  assert.deepEqual(rows.map(row => row.draft.employeeId), ["101", "102", ""]);
  assert.deepEqual(rows.map(row => valueFor(row, "employeeName", catalogs)), ["Иван Тестовый", "Пётр Примеров", "Импортированный Неизвестный"]);
  assert.equal(rows[2].draft.inputValues.employeeName, imported[2].employeeName);
  assert.deepEqual(rows.map(row => valueFor(row, "workDate", catalogs)), ["25.10.2026", "26.10.2026", "25.10.2026"]);
  assert.deepEqual(rows.map(row => valueFor(row, "hours", catalogs)), [8, 6, "ошибка"]);
  const filter = patch => ({ filterType: "personnel", kind: "text", values: null, conditions: [], operator: "AND", ...patch });
  const select = model => rows.filter(row => matchesPersonnelFilter(valueFor(row, "employeeName", catalogs), model)).map(row => row.rowKey);
  assert.deepEqual(select(filter({ conditions: [{ type: "contains", value: "петр" }] })), ["import-1"]);
  assert.deepEqual(select(filter({ values: ["Импортированный Неизвестный"] })), ["import-2"]);
  assert.deepEqual(select(filter({ values: ["Иван Тестовый", "Пётр Примеров"] })), ["import-0", "import-1"]);
  assert.deepEqual(rows.filter(row => matchesPersonnelFilter(valueFor(row, "workDate", catalogs), filter({ kind: "date", conditions: [{ type: "equals", value: "2026-10-25" }] }))
    && matchesPersonnelFilter(valueFor(row, "hours", catalogs), filter({ kind: "number", conditions: [{ type: "greaterThan", value: "6" }] }))).map(row => row.rowKey), ["import-0"]);
});

test("filtered draft totals use the current employee identity, excluding cleared and hidden employees", () => {
  const reportSummary = descendants(reportGrid).find(node => ts.isVariableDeclaration(node) && node.name.getText(reportGrid) === "reportSummary");
  assert.ok(reportSummary);
  const declarations = ["emptySummary", "displayDate", "statusLabels", "valueFor"].map(name => declaration(reportGrid, name)).join("\n");
  const source = `${declarations}\nconst reportSummary = ${reportSummary.initializer.arguments[0].getText(reportGrid)};`;
  const empty = { rows: 0, dates: 0, employees: 0, hours: 0, approved: 0, submitted: 0, draft: 0, rejected: 0, unapprovedRows: 0 };
  const draft = (employeeId, hours) => ({ employeeId, hours, note: "", employeeQuery: "", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", masterId: "" });
  const rows = [
    { rowKey: "cleared", workDate: "2026-11-02", status: "draft", draft: draft("", "2"), entry: { employeeId: 11, hours: 2 } },
    { rowKey: "changed", workDate: "2026-11-02", status: "draft", draft: draft("22", "8"), entry: { employeeId: 11, hours: 8 } },
    { rowKey: "hidden", workDate: "2026-11-01", status: "approved", entry: { employeeId: 33, hours: 6 } },
  ];
  const visible = [{ group: true }, ...rows.slice(0, 2).map(row => ({ data: { rowKey: row.rowKey } }))];
  const catalogs = { employees: [{ id: 22 }, { id: 33 }], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [] };
  let summary = empty;
  const reportedKeys = [];
  const summarize = bind(source, "reportSummary", {
    rowsRef: { current: new Map(rows.map(row => [row.rowKey, row])) },
    propsRef: { current: { ...catalogs, onVisibleRowsChange: keys => reportedKeys.push(keys) } },
    lastVisibleKeys: { current: null }, optionFields: personnelOptionFields, personnelActivityTime, personnelCellErrors,
    setSummary: update => { summary = update(summary); },
  });
  const api = { forEachNodeAfterFilterAndSort: callback => visible.forEach(callback) };
  summarize(api);
  assert.deepEqual(summary, { ...empty, rows: 2, dates: 1, employees: 1, hours: 10, draft: 10, unapprovedRows: 2 });
  assert.deepEqual(reportedKeys, [["cleared", "changed"]]);
  summarize(api);
  assert.equal(reportedKeys.length, 1, "An unchanged visible set must not trigger repeated parent updates");
  rows[0].draft.employeeId = "33";
  rows[0].draft.hours = "не число";
  summarize(api);
  assert.equal(summary.employees, 2);
  assert.equal(summary.hours, 8);
  assert.equal(summary.draft, 8);
});
