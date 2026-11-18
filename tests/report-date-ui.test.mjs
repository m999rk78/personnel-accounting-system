import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { isReportWorkDate, moveUnsavedReportDay, moveUnsavedReportRow } from "../app/reportDateChanges.ts";
import { draftHistoryReducer } from "../app/personnelSpreadsheet.ts";
import { isPersonnelReportDraft } from "../app/personnelReportActions.ts";
import { personnelReportImportTarget, personnelReportNewKey } from "../app/personnelReportSessions.ts";
import { equipmentReportImportTarget, equipmentReportNewKey } from "../app/equipmentReportSessions.ts";
import { parseCalendarDate, calendarDate, calendarMonthDays, shiftCalendarDate, shiftCalendarMonth, calendarMonthGrid, calendarKeyDate } from "../app/reportDateCalendar.ts";

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const controlsSource = await readFile(new URL("../app/ReportDateControls.tsx", import.meta.url), "utf8");
function compileControls(react = import.meta.resolve("react"), reactDom = import.meta.resolve("react-dom"), prefix = "") {
  let code = ts.transpileModule(controlsSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const [specifier, target] of Object.entries({ react, "react-dom": reactDom, "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"), "./reportDateCalendar": new URL("../app/reportDateCalendar.ts", import.meta.url).href, "./reportDateChanges": new URL("../app/reportDateChanges.ts", import.meta.url).href })) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return dataUrl(prefix + code);
}

const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" && node.props ? [node, ...nodes(node.props.children)] : [];
const textOf = node => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
const find = (tree, predicate) => { const node = nodes(tree).find(predicate); assert.ok(node, "Expected date control"); return node; };


test("report calendar accepts valid unrestricted days and rejects normalized, zero-year or non-calendar values", () => {
  for (const date of ["0001-01-01", "9999-12-31", "2028-02-29", "2000-02-29", "2026-01-01", "2030-11-02"]) assert.equal(isReportWorkDate(date), true, date);
  for (const date of ["0000-01-01", "2026-02-29", "1900-02-29", "2026-02-30", "2026-13-01", "2026-00-01", "2026-11-00", "2026-1-01", "2026-11-02T00:00:00Z", "02.11.2026", " 2026-11-02", "", null, 20261102]) assert.equal(isReportWorkDate(date), false, String(date));
});

test("unsaved date transfer merges all source rows before destination rows without changing identities or input", () => {
  const first = Object.freeze({ key: "source", employeeId: "15", hours: "8" });
  const second = Object.freeze({ key: "destination", employeeId: "16", hours: "4" });
  const third = Object.freeze({ key: "unrelated" });
  const original = Object.freeze({ "new:2026-11-02": Object.freeze([first]), "new:2026-10-30": Object.freeze([second]), other: Object.freeze([third]) });
  const moved = moveUnsavedReportDay(original, "new:2026-11-02", "new:2026-10-30");
  assert.deepEqual(moved["new:2026-10-30"], [first, second]);
  assert.equal(moved["new:2026-10-30"][0], first); assert.equal(moved["new:2026-10-30"][1], second);
  assert.equal(moved.other, original.other); assert.equal(moved["new:2026-11-02"], undefined);
  assert.deepEqual(Object.keys(original), ["new:2026-11-02", "new:2026-10-30", "other"]);
});

test("unsaved transfers can append to an existing report while preserving its saved row IDs", () => {
  const source = { key: "draft-new", employeeId: "15" };
  const saved = { key: "report-17-101", reportRowId: 101, employeeId: "16" };
  const original = { "new:2026-11-02": [source] };
  const moved = moveUnsavedReportDay(original, "new:2026-11-02", "17", [saved]);
  assert.deepEqual(moved, { 17: [source, saved] });
  assert.equal(moved[17][1], saved); assert.equal(saved.reportRowId, 101);
  const editedSaved = { ...saved, hours: "9" };
  const edited = moveUnsavedReportDay({ ...original, 17: [editedSaved] }, "new:2026-11-02", "17", [saved]);
  assert.equal(edited[17][1], editedSaved);
});

test("date transfer validates original identities and row limits and participates in undo/redo", () => {
  const original = { "new:2026-11-02": [{ key: "a" }] };
  assert.equal(moveUnsavedReportDay(original, "new:2026-11-02", "new:2026-11-02"), original);
  for (const key of ["17", "new:2026-02-30", "new:0000-01-01", "new:2026-10-30"]) assert.throws(() => moveUnsavedReportDay(original, key, "new:2026-11-03"), /исходный черновик/);
  const full = { "new:2026-11-02": [{ key: "a" }], "new:2026-11-03": Array.from({ length: 1000 }, (_, id) => ({ key: `b-${id}` })) };
  assert.throws(() => moveUnsavedReportDay(full, "new:2026-11-02", "new:2026-11-03"), /1000 строк/);
  assert.equal(full["new:2026-11-02"].length, 1); assert.equal(full["new:2026-11-03"].length, 1000);
  const moved = draftHistoryReducer({ present: original, past: [], future: [] }, { type: "change", update: current => moveUnsavedReportDay(current, "new:2026-11-02", "new:2026-10-30") });
  const undone = draftHistoryReducer(moved, { type: "undo" });
  assert.equal(undone.present, original);
  const redone = draftHistoryReducer(undone, { type: "redo" });
  assert.equal(redone.present, moved.present); assert.deepEqual(redone.present["new:2026-10-30"], original["new:2026-11-02"]);
});

test("moving one unsaved row preserves other edits, identities and a single undo/redo step", () => {
  const saved = Object.freeze({ key: "report-17-101", reportRowId: 101, hours: "9" });
  const moved = Object.freeze({ key: "new-row", hours: "", inputValues: { hours: "8," }, importBatchId: "file-1", createdAt: "2026-11-18T10:00:00Z" });
  const otherNew = Object.freeze({ key: "other-new", note: "Оставить здесь" });
  const destination = Object.freeze({ key: "report-18-102", reportRowId: 102, note: "Не перезаписывать" });
  const original = Object.freeze({ 17: Object.freeze([moved, saved, otherNew]), 18: Object.freeze([destination]), other: Object.freeze([{ key: "other" }]) });
  const history = draftHistoryReducer({ present: original, past: [], future: [] }, { type: "change", update: current => moveUnsavedReportRow(current, "17", "18", moved.key, [{ ...destination, note: "Старая версия" }]) });
  assert.deepEqual(history.present[17], [saved, otherNew]);
  assert.deepEqual(history.present[18], [moved, destination]);
  assert.equal(history.present[18][0], moved); assert.equal(history.present[18][1], destination);
  assert.equal(history.present.other, original.other);
  const undone = draftHistoryReducer(history, { type: "undo" }); assert.equal(undone.present, original);
  assert.equal(draftHistoryReducer(undone, { type: "redo" }).present, history.present);
});

test("single-row date transfer rejects persisted identities, duplicates and overflow without changing the source", () => {
  const row = { key: "new-row" }, original = { 17: [row] };
  assert.throws(() => moveUnsavedReportRow({ 17: [{ ...row, reportRowId: 101 }] }, "17", "new:2026-10-30", row.key), /несохранённую/);
  assert.throws(() => moveUnsavedReportRow({ 17: [{ key: "report-17-101" }] }, "17", "new:2026-10-30", "report-17-101"), /несохранённую/);
  assert.throws(() => moveUnsavedReportRow({ 17: [row, row] }, "17", "18", row.key), /несохранённую/);
  assert.throws(() => moveUnsavedReportRow(original, "17", "18", row.key, [row]), /уже присутствует/);
  assert.throws(() => moveUnsavedReportRow(original, "17", "18", row.key, Array.from({ length: 1000 }, (_, id) => ({ key: `target-${id}` }))), /1000 строк/);
  assert.deepEqual(original, { 17: [row] });
});

test("a single-row transfer drops only an exactly unchanged source and undo restores its original group", () => {
  const saved = { key: "report-17-101", reportRowId: 101, hours: "8", note: "" };
  const moved = { key: "new-row", hours: "4" };
  const original = { 17: [moved, saved] };
  const history = draftHistoryReducer({ present: original, past: [], future: [] }, {
    type: "change", update: current => moveUnsavedReportRow(current, "17", "new:2026-10-30", moved.key, [], [{ ...saved }]),
  });
  assert.equal(Object.hasOwn(history.present, "17"), false);
  assert.deepEqual(history.present["new:2026-10-30"], [moved]);
  const undone = draftHistoryReducer(history, { type: "undo" }); assert.equal(undone.present, original);
  assert.equal(draftHistoryReducer(undone, { type: "redo" }).present, history.present);
  for (const remaining of [
    [{ ...saved, hours: "9" }],
    [{ ...saved, inputValues: { hours: "8," } }],
    [{ ...saved, updatedAt: "2026-11-18T10:00:00Z" }],
    [saved, { key: "another-new-row" }],
  ]) {
    const result = moveUnsavedReportRow({ 17: [moved, ...remaining] }, "17", "new:2026-10-30", moved.key, [], [saved]);
    assert.deepEqual(result[17], remaining, "Any content or metadata difference preserves the original source edit");
  }
  const second = { ...saved, key: "report-17-102", reportRowId: 102 };
  assert.deepEqual(moveUnsavedReportRow({ 17: [moved, second, saved] }, "17", "18", moved.key, [], [saved, second])[17], [second, saved]);
});

async function appendHarness(kind, settings = {}) {
  const path = new URL(`../app/${kind}ReportWorkspace.tsx`, import.meta.url);
  const file = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "appendOnDate") declaration = node; ts.forEachChild(node, visit); }
  visit(file); assert.ok(declaration, "Expected actual workspace append callback");
  const code = ts.transpileModule(`const ${declaration.getText(file)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let state = settings.edits ?? {}, error = "", remembered = [];
  let view = "approved", focused = "previous", selected = ["old-row"], visible = ["old-row"];
  const bindings = { today: "2026-11-02", permissions: { create: true }, locked: false, fetching: false, props: { loading: false }, isReportWorkDate,
    personnelReportImportTarget, equipmentReportImportTarget, personnelReportNewKey, equipmentReportNewKey, reports: [], sessions: {}, siteId: 7, currentUser: { id: 9 }, keyOf: report => String(report.id),
    canEdit: () => true, toDraft: row => ({ ...row, key: `saved-${row.id}` }), ...settings,
    edits: state, rememberSessions(keys) { remembered.push(...keys); }, setEdits(update) { state = typeof update === "function" ? update(state) : update; },
    setError(value) { error = value; }, setNotice() {}, setWorkflowView(value) { view = value; },
    setFocusedReportKey(value) { focused = value; }, setSelected(value) { selected = value; }, setVisible(value) { visible = value; },
  };
  const append = new Function(...Object.keys(bindings), `${code}; return appendOnDate;`)(...Object.values(bindings));
  return { append, result: () => ({ state, error, remembered, view, focused, selected, visible }) };
}

for (const kind of ["Personnel", "Equipment"]) {
  test(`${kind} add uses explicit selected date, defaults to today and reuses only own destination report`, async () => {
    const row = { key: "new-row" };
    const selected = await appendHarness(kind); selected.append([row], "2026-10-30");
    assert.deepEqual(selected.result().state, { "new:2026-10-30": [row] });
    if (kind === "Personnel") {
      assert.equal(selected.result().view, "draft");
      assert.equal(selected.result().focused, null);
      assert.deepEqual(selected.result().selected, []);
      assert.equal(selected.result().visible, null);
    }
    const defaults = await appendHarness(kind); defaults.append([row]);
    assert.deepEqual(defaults.result().state, { "new:2026-11-02": [row] });
    const own = { id: 17, siteId: 7, ownerUserId: 9, status: "draft", workDate: "2026-10-30", rows: [{ id: 101 }] };
    const existing = await appendHarness(kind, { reports: [own, { ...own, id: 18, ownerUserId: 10 }, { ...own, id: 19, siteId: 8 }] });
    existing.append([row], own.workDate);
    assert.deepEqual(existing.result().state, { 17: [row, { id: 101, key: "saved-101" }] });
    assert.deepEqual(existing.result().remembered, ["17"]);
  });

  test(`${kind} add rejects unavailable permissions, invalid date and row overflow while allowing a local dated row beside a submitted report`, async () => {
    const row = { key: "new-row" };
    for (const settings of [{ permissions: { create: false } }, { locked: true }, { fetching: true }, { props: { loading: true } }]) {
      const denied = await appendHarness(kind, settings); denied.append([row], "2026-10-30");
      assert.deepEqual(denied.result().state, {}); assert.deepEqual(denied.result().remembered, []);
    }
    const submitted = await appendHarness(kind, { reports: [{ id: 17, siteId: 7, ownerUserId: 9, status: "submitted", workDate: "2026-10-30", rows: [] }] });
    submitted.append([row], "2026-10-30"); assert.equal(submitted.result().error, ""); assert.deepEqual(submitted.result().state, { "new:2026-10-30": [row] }); assert.deepEqual(submitted.result().remembered, ["new:2026-10-30"]);
    const readOnly = await appendHarness(kind, { reports: [{ id: 17, siteId: 7, ownerUserId: 9, status: "draft", workDate: "2026-10-30", rows: [] }], canEdit: () => false });
    readOnly.append([row], "2026-10-30"); assert.match(readOnly.result().error, /Нет права изменять/); assert.deepEqual(readOnly.result().state, {});
    const invalid = await appendHarness(kind); invalid.append([row], "2026-02-30"); assert.match(invalid.result().error, /корректную дату/); assert.deepEqual(invalid.result().state, {});
    const edits = { "new:2026-10-30": Array.from({ length: 1000 }, (_, id) => ({ key: String(id) })) };
    const overflow = await appendHarness(kind, { edits }); overflow.append([row], "2026-10-30");
    assert.match(overflow.result().error, /1000 строк/); assert.equal(overflow.result().state, edits); assert.equal(edits["new:2026-10-30"].length, 1000);
  });
}


test("mini calendar uses real Gregorian days, including years 1 through 99 and leap centuries", () => {
  for (const value of ["0001-01-01", "0099-12-31", "0100-01-01", "2000-02-29", "2028-02-29", "9999-12-31"]) {
    const parsed = parseCalendarDate(value); assert.ok(parsed, value);
    assert.equal(calendarDate(parsed.year, parsed.month, parsed.day), value);
  }
  for (const value of ["0000-01-01", "10000-01-01", "1900-02-29", "2026-02-30", "2026-1-02", "", "02.11.2026"]) assert.equal(parseCalendarDate(value), null, value);
  assert.equal(calendarMonthDays(2000, 2), 29); assert.equal(calendarMonthDays(1900, 2), 28);
  assert.equal(calendarMonthDays(1, 2), 28); assert.equal(calendarMonthDays(99, 12), 31);
  assert.equal(calendarDate(2026, 2, 29), null); assert.equal(calendarDate(0, 1, 1), null);
});

test("mini calendar renders six Monday-first weeks with adjacent month days and supported-year bounds", () => {
  const november = calendarMonthGrid(2026, 11);
  assert.equal(november.length, 42); assert.equal(november[0].date, "2026-10-26");
  assert.equal(november[6].date, "2026-11-01"); assert.equal(november[6].inMonth, true);
  assert.equal(november[0].inMonth, false); assert.equal(november.filter(day => day.inMonth).length, 30);
  const leap = calendarMonthGrid(2028, 2);
  assert.equal(leap.length, 42); assert.equal(leap.filter(day => day.inMonth).length, 29);
  assert.equal(leap.filter(day => day.date === "2028-02-29").length, 1);
  const first = calendarMonthGrid(1, 1), last = calendarMonthGrid(9999, 12);
  assert.equal(first.length, 42); assert.equal(first[0].date, "0001-01-01");
  assert.equal(last.length, 42); assert.ok(last.some(day => day.date === null));
  for (const cell of [...november, ...leap, ...first, ...last]) if (cell.date) assert.equal(isReportWorkDate(cell.date), true, cell.date);
});

test("calendar navigation clamps month ends and stops at supported date boundaries", () => {
  assert.equal(shiftCalendarDate("0099-12-31", 1), "0100-01-01");
  assert.equal(shiftCalendarDate("0001-01-01", -1), null); assert.equal(shiftCalendarDate("9999-12-31", 1), null);
  assert.equal(shiftCalendarMonth("2026-01-31", 1), "2026-02-28");
  assert.equal(shiftCalendarMonth("2028-01-31", 1), "2028-02-29");
  assert.equal(shiftCalendarMonth("0099-12-31", 1), "0100-01-31");
  assert.equal(shiftCalendarMonth("0001-01-01", -1), null); assert.equal(shiftCalendarMonth("9999-12-31", 1), null);
  for (const [key, expected] of [["ArrowLeft", "2026-11-01"], ["ArrowRight", "2026-11-03"], ["ArrowUp", "2026-10-26"], ["ArrowDown", "2026-11-09"], ["Home", "2026-11-02"], ["End", "2026-11-08"], ["PageUp", "2026-10-02"], ["PageDown", "2026-12-02"]]) assert.equal(calendarKeyDate("2026-11-02", key), expected, key);
  assert.equal(calendarKeyDate("2028-02-29", "PageDown", true), "2029-02-28");
});

test("both reports omit the extra date toolbar and confirmation dialog", async () => {
  for (const kind of ["Personnel", "Equipment"]) {
    const workspace = await readFile(new URL(`../app/${kind}ReportWorkspace.tsx`, import.meta.url), "utf8");
    const grid = await readFile(new URL(`../app/${kind}ReportGrid.tsx`, import.meta.url), "utf8");
    assert.doesNotMatch(workspace, /ReportAddDate|ReportDateDialog|Дата новых строк|chosenAddDate/);
    assert.match(grid, /ReportDatePicker/);
    assert.doesNotMatch(controlsSource, /<dialog|Изменить дату отчёта<|type="submit"/);
  }
});

async function changeHarness(kind, settings = {}) {
  const path = new URL(`../app/${kind}ReportWorkspace.tsx`, import.meta.url);
  const file = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "changeReportDate") declaration = node; ts.forEachChild(node, visit); }
  visit(file); assert.ok(declaration, "Expected actual workspace date change callback");
  const code = ts.transpileModule(declaration.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const row = { rowKey: "row-1", workDate: "2026-11-02", editable: true, status: "draft" };
  let state = settings.edits ?? { "new:2026-11-02": [{ key: "row-1" }] };
  const requests = [], history = [], busy = [], remembered = [], notices = [];
  let sessions = settings.sessions ?? {}, entrySessions = {}, data = settings.data ?? { reports: settings.reports ?? [], entries: [] };
  const bindings = {
    locked: false, fetching: false, props: { loading: false }, permissions: { create: true }, isReportWorkDate, moveUnsavedReportDay, moveUnsavedReportRow,
    isPersonnelReportDraft, isEquipmentReportDraft: isPersonnelReportDraft,
    ownerByRow: new Map([[row.rowKey, "new:2026-11-02"]]), reports: [], data, currentUser: { id: 9, fullName: "Тестовый прораб" },
    personnelReportImportTarget, equipmentReportImportTarget, sessions, siteId: 7,
    keyOf: report => String(report.id), entryKey: entry => `entry-${entry.id}`, canEdit: () => true,
    toDraft: row => ({ ...row, key: `saved-${row.id}` }), displayDate: date => date.split("-").reverse().join("."),
    edits: state, ...settings,
    setEdits(update) { state = typeof update === "function" ? update(state) : update; }, rememberSessions(keys) { remembered.push(...keys); },
    setFocusedReportKey() {}, setSelected() {}, setRequiredReports() {}, setNotice(value) { notices.push(value); },
    setBusy(value) { busy.push(value); }, setError() {}, dispatchEdits(action) { history.push(action); },
    setSessions(update) { sessions = update(sessions); }, setEntrySessions(update) { entrySessions = update(entrySessions); }, setData(update) { data = update(data); },
    async load() {}, async fetch(url, options) { requests.push({ url, body: JSON.parse(options.body) }); return settings.response ?? { ok: true, async json() { return { report: { ...settings.reports?.[0], workDate: requests.at(-1).body.workDate, rows: [] } }; } }; },
  };
  const change = new Function(...Object.keys(bindings), `${code}; return changeReportDate;`)(...Object.values(bindings));
  return { change: (date, patch = {}) => change({ ...row, ...patch }, date), result: () => ({ state, requests, history, busy, remembered, notices, sessions, entrySessions, data }) };
}

for (const kind of ["Personnel", "Equipment"]) {
  test(`${kind} direct date selection updates a new draft without a save request and preserves unrelated edits`, async () => {
    const other = [{ key: "other" }];
    const harness = await changeHarness(kind, { edits: { "new:2026-11-02": [{ key: "row-1" }], other } });
    await harness.change("2026-10-30");
    const result = harness.result();
    assert.deepEqual(result.state, { "new:2026-10-30": [{ key: "row-1" }], other });
    assert.equal(result.state.other, other); assert.deepEqual(result.requests, []); assert.deepEqual(result.history, []);
    assert.match(result.notices.at(-1), /30\.10\.2026/);
  });

  test(`${kind} saved report date calls the guarded API directly and retains unrelated dirty rows`, async () => {
    const report = { id: 17, revision: 4, workDate: "2026-11-02", siteId: 7, ownerUserId: 9, rows: [] };
    const other = [{ key: "other", note: "Не терять" }], edits = { other };
    const harness = await changeHarness(kind, { reports: [report], ownerByRow: new Map([["row-1", "17"]]), edits, sessions: { 17: report, other: { id: 18 } } });
    await harness.change("2026-10-30");
    const result = harness.result();
    assert.deepEqual(result.requests, [{ url: `/api/${kind.toLowerCase()}-report`, body: { action: "change-date", reportId: 17, revision: 4, workDate: "2026-10-30" } }]);
    assert.deepEqual(result.history, [{ type: "reset", value: edits }]); assert.equal(result.state.other, other);
    assert.deepEqual(result.busy, [true, false]); assert.equal(result.sessions[17], undefined); assert.deepEqual(result.sessions.other, { id: 18 });
    assert.equal(result.data.reports[0].workDate, "2026-10-30");
  });

  test(`${kind} rejected date change preserves edits, sessions and undo history and exposes the server error`, async () => {
    const report = { id: 17, revision: 4, workDate: "2026-11-02", siteId: 7, ownerUserId: 9, rows: [] };
    const settings = { reports: [report], ownerByRow: new Map([["row-1", "17"]]), edits: { unrelated: [{ key: "keep" }] }, sessions: { 17: report }, response: { ok: false, async json() { return { error: "На выбранную дату уже есть отчёт" }; } } };
    const harness = await changeHarness(kind, settings);
    await assert.rejects(harness.change("2026-10-30"), /уже есть отчёт/);
    const result = harness.result(); assert.equal(result.state, settings.edits); assert.equal(result.sessions, settings.sessions);
    assert.deepEqual(result.history, []); assert.deepEqual(result.busy, [true, false]); assert.equal(result.data.reports[0], report);
    const dirty = await changeHarness(kind, { ...settings, edits: { 17: [{ key: "unsaved", hours: "9" }] } });
    await assert.rejects(dirty.change("2026-10-30"), /Сначала сохраните изменения/); assert.deepEqual(dirty.result().requests, []);
    const readOnly = await changeHarness(kind); await assert.rejects(readOnly.change("2026-10-30", { editable: false })); assert.deepEqual(readOnly.result().requests, []);
  });

  test(`${kind} a newly appended row leaves a saved draft alone without moving the saved report or other new rows`, async () => {
    const report = { id: 17, revision: 4, workDate: "2026-11-02", siteId: 7, ownerUserId: 9, status: "draft", rows: [{ id: 101, reportId: 17 }] };
    const saved = { key: "report-17-101", reportRowId: 101, hours: "9" }, row = { key: "row-1", hours: "", inputValues: { hours: "8," } }, otherNew = { key: "row-2" };
    const edits = { 17: [row, saved, otherNew], unrelated: [{ key: "keep" }] }, sessions = { 17: report };
    const harness = await changeHarness(kind, { reports: [report], ownerByRow: new Map([[row.key, "17"]]), edits, sessions });
    await harness.change("2026-10-30", { draft: row });
    const result = harness.result();
    assert.deepEqual(result.state[17], [saved, otherNew]); assert.deepEqual(result.state["new:2026-10-30"], [row]);
    assert.equal(result.state["new:2026-10-30"][0], row); assert.equal(result.state.unrelated, edits.unrelated);
    assert.deepEqual(result.requests, []); assert.deepEqual(result.history, []); assert.deepEqual(result.busy, []);
    assert.equal(result.sessions, sessions); assert.equal(result.data.reports[0], report); assert.equal(report.revision, 4);
    assert.deepEqual(result.remembered, ["17", "new:2026-10-30"]);
    assert.match(result.notices.at(-1), /Дата новой строки изменена/);
  });

  test(`${kind} an unsaved row can join an edited destination draft without rebasing its session`, async () => {
    const source = { id: 17, revision: 4, workDate: "2026-11-02", siteId: 7, ownerUserId: 9, status: "rejected", rows: [] };
    const destination = { ...source, id: 18, revision: 2, status: "draft", workDate: "2026-10-30", rows: [{ id: 102, reportId: 18 }] };
    const row = { key: "row-1", importBatchId: "file-1" }, editedTarget = { key: "report-18-102", reportRowId: 102, hours: "7" };
    const edits = { 17: [row], 18: [editedTarget] }, sessions = { 17: source, 18: destination };
    const harness = await changeHarness(kind, { reports: [source, destination], ownerByRow: new Map([[row.key, "17"]]), edits, sessions });
    await harness.change(destination.workDate, { draft: row, status: "rejected" });
    const result = harness.result();
    assert.equal(Object.hasOwn(result.state, "17"), false); assert.deepEqual(result.state[18], [row, editedTarget]);
    assert.equal(result.state[18][1], editedTarget); assert.equal(result.sessions[18], destination);
    assert.deepEqual(result.requests, []); assert.deepEqual(result.remembered, ["17", "18"]);
  });

  test(`${kind} single-row transfer respects destination status and permissions without mutating either draft`, async () => {
    const source = { id: 17, revision: 4, workDate: "2026-11-02", siteId: 7, ownerUserId: 9, status: "draft", rows: [] };
    const destination = { ...source, id: 18, workDate: "2026-10-30", status: "submitted" };
    const row = { key: "row-1" }, edits = { 17: [row] }, sessions = { 17: source };
    for (const settings of [
      { reports: [source, destination] },
      { reports: [source, { ...destination, status: "draft" }], canEdit: report => report.id === source.id },
      { reports: [source], permissions: { create: false } },
      { reports: [source, { ...destination, status: "draft" }], permissions: { create: false } },
    ]) {
      const harness = await changeHarness(kind, { ownerByRow: new Map([[row.key, "17"]]), edits, sessions, ...settings });
      await assert.rejects(harness.change(destination.workDate, { draft: row }), /на проверку|Нет права/);
      const result = harness.result(); assert.equal(result.state, edits); assert.equal(result.sessions, sessions);
      assert.deepEqual(result.requests, []); assert.deepEqual(result.remembered, []); assert.deepEqual(result.history, []);
    }
  });

  test(`${kind} moving the only appended row leaves a clean saved source out of the next save while retaining its frozen session`, async () => {
    const source = { id: 17, revision: 4, workDate: "2026-11-02", siteId: 7, ownerUserId: 9, status: "draft", rows: [{ id: 101, reportId: 17 }] };
    const saved = { ...source.rows[0], key: "saved-101" }, row = { key: "row-1" };
    const edits = { 17: [row, saved] }, sessions = { 17: source };
    const harness = await changeHarness(kind, { reports: [source], ownerByRow: new Map([[row.key, "17"]]), edits, sessions });
    await harness.change("2026-10-30", { draft: row });
    const result = harness.result();
    assert.deepEqual(Object.keys(result.state), ["new:2026-10-30"]);
    assert.equal(result.sessions[17], source, "Undo still has the original source version");
    assert.equal(result.data.reports[0], source); assert.deepEqual(result.requests, []);
    assert.deepEqual(result.state["new:2026-10-30"], [row]);
  });

  test(`${kind} the first row in a visually empty saved draft moves from November 18 to 16 for either owner with identical permissions`, async () => {
    for (const ownerUserId of [9, 10]) for (const existingDestination of [false, true]) {
      const source = { id: 17, revision: 4, workDate: "2026-11-18", siteId: 7, ownerUserId, status: "draft", rows: [] };
      const destination = { ...source, id: 18, revision: 2, workDate: "2026-11-16" };
      const row = { key: "row-1", ...(kind === "Personnel" ? { employeeId: "25", employeeQuery: "Первый сотрудник" } : { equipmentId: "25", equipmentQuery: "Первая единица техники" }), hours: "", note: "" };
      const edits = { 17: [row] }, sessions = { 17: source };
      const harness = await changeHarness(kind, {
        reports: existingDestination ? [source, destination] : [source],
        currentUser: { id: ownerUserId, fullName: `Прораб ${ownerUserId}` }, permissions: { create: true, update: true },
        ownerByRow: new Map([[row.key, "17"]]), edits, sessions,
      });
      await harness.change("2026-11-16", { workDate: "2026-11-18", draft: row });
      const result = harness.result(), targetKey = existingDestination ? "18" : "new:2026-11-16";
      assert.deepEqual(result.state, { [targetKey]: [row] });
      assert.equal(result.state[targetKey][0], row); assert.equal(result.sessions[17], source);
      assert.deepEqual(source.rows, []); assert.equal(source.workDate, "2026-11-18"); assert.equal(source.revision, 4);
      assert.deepEqual(destination.rows, []); assert.equal(destination.revision, 2);
      assert.deepEqual(result.requests, []); assert.deepEqual(result.remembered, ["17", targetKey]);
      const moved = draftHistoryReducer({ present: edits, past: [], future: [] }, { type: "change", update: result.state });
      const undone = draftHistoryReducer(moved, { type: "undo" }); assert.equal(undone.present, edits);
      assert.equal(draftHistoryReducer(undone, { type: "redo" }).present, result.state);
    }
  });

  test(`${kind} persisted rows and unowned or reviewed source reports still cannot bypass the dirty-report guard`, async () => {
    const source = { id: 17, revision: 4, workDate: "2026-11-02", siteId: 7, ownerUserId: 9, status: "draft", rows: [] };
    const row = { key: "row-1" };
    for (const [report, draft, patch] of [
      [source, { ...row, reportRowId: 101 }, {}],
      [{ ...source, ownerUserId: 10 }, row, {}],
      [{ ...source, siteId: 8 }, row, {}],
      [{ ...source, status: "submitted" }, row, {}],
      [{ ...source, status: "approved" }, row, {}],
      [source, row, { entry: { id: 101 } }],
    ]) {
      const edits = { 17: [draft] };
      const harness = await changeHarness(kind, { reports: [report], ownerByRow: new Map([[row.key, "17"]]), edits });
      await assert.rejects(harness.change("2026-10-30", { draft, ...patch }), /Сначала сохраните изменения/);
      assert.equal(harness.result().state, edits); assert.deepEqual(harness.result().requests, []);
    }
  });
}


const { ReportDatePicker } = await import(compileControls());

test("date cell displays one direct calendar trigger and no extra editor or apply form", () => {
  const html = renderToStaticMarkup(createElement(ReportDatePicker, { workDate: "2026-11-02", onChange: async () => {}, disabled: true }));
  assert.match(html, /02\.11\.2026/); assert.match(html, /aria-haspopup="dialog"/); assert.match(html, /aria-expanded="false"/); assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /Дата новых строк|<form|<input|<dialog|Изменить дату<|Применить|Сохранить/);
});

let pickerHarnessId = 0;
async function pickerHarness() {
  const reactUrl = dataUrl(`// direct picker hook harness ${++pickerHarnessId}
    let states=[], cursor=0; export function begin(){cursor=0;}
    export function useState(initial){const key=cursor++;if(!(key in states))states[key]=typeof initial==='function'?initial():initial;return [states[key],next=>{states[key]=typeof next==='function'?next(states[key]):next;}];}
    export function useRef(initial){const key=cursor++;if(!(key in states))states[key]={current:initial};return states[key];}
    export function useEffect(){cursor++;} export function useLayoutEffect(){cursor++;}
    export function useCallback(fn){cursor++;return fn;} export function useId(){return 'picker-'+cursor++;}
  `);
  const hooks = await import(reactUrl);
  const reactDom = dataUrl("export const createPortal = child => child;");
  const { ReportDatePicker: Picker } = await import(compileControls(reactUrl, reactDom, "const document={body:{}}; const requestAnimationFrame=callback=>{callback();return 1;};\n"));
  return props => { hooks.begin(); return Picker(props); };
}

test("single date-cell click opens the six-week mini calendar and date click immediately starts one guarded save", async () => {
  const render = await pickerHarness(); let resolve; const dates = [];
  const props = { workDate: "2026-11-02", scopeLabel: "Весь отчёт · 7 строк", onChange(date) { dates.push(date); return new Promise(yes => { resolve = yes; }); } };
  let tree = render(props);
  const trigger = find(tree, node => node.type === "button" && node.props.className === "report-date-cell");
  assert.equal(trigger.props["aria-expanded"], false);
  trigger.props.onClick({ stopPropagation() {} }); tree = render(props);
  const popup = find(tree, node => node.props.role === "dialog"); assert.equal(popup.props["aria-modal"], "false");
  assert.equal(nodes(popup).filter(node => node.type === "button" && node.props["data-date"]).length, 42);
  assert.match(textOf(popup), /Весь отчёт · 7 строк/); assert.doesNotMatch(textOf(popup), /Применить|Отмена|Изменить дату|Подтвердить/);
  const selected = find(tree, node => node.props["data-date"] === "2026-11-03"); selected.props.onClick(); selected.props.onClick();
  assert.deepEqual(dates, ["2026-11-03"]);
  tree = render({ ...props, disabled: true });
  const pending = find(tree, node => node.props.role === "dialog"); assert.equal(pending.props["aria-busy"], true); assert.match(textOf(pending), /Сохраняем/);
  assert.ok(nodes(pending).filter(node => node.type === "button").every(node => node.props.disabled));
  find(pending, node => node.props.role === "presentation" && typeof node.props.onKeyDown === "function").props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  tree = render(props); assert.ok(nodes(tree).some(node => node.props.role === "dialog"), "pending selection cannot be dismissed before result");
  resolve(); await Promise.resolve(); await Promise.resolve();
  tree = render({ ...props, workDate: "2026-11-03" }); assert.equal(nodes(tree).some(node => node.props.role === "dialog"), false);
});

test("failed day selection keeps mini calendar and inline error for retry; selecting original day simply closes", async () => {
  const render = await pickerHarness(); let reject, resolve; const dates = [];
  const props = { workDate: "2026-11-02", onChange(date) { dates.push(date); return new Promise((yes, no) => { resolve = yes; reject = no; }); } };
  let tree = render(props); find(tree, node => node.props.className === "report-date-cell").props.onClick({ stopPropagation() {} });
  tree = render(props); find(tree, node => node.props["data-date"] === "2026-11-03").props.onClick();
  reject(new Error("На выбранную дату превышены часы")); await Promise.resolve(); await Promise.resolve();
  tree = render(props); assert.match(textOf(find(tree, node => node.props.role === "alert")), /превышены часы/);
  assert.equal(find(tree, node => node.props.role === "dialog").props["aria-busy"], false);
  find(tree, node => node.props["data-date"] === "2026-11-03").props.onClick(); resolve(); await Promise.resolve(); await Promise.resolve();
  tree = render(props); assert.equal(nodes(tree).some(node => node.props.role === "dialog"), false); assert.deepEqual(dates, ["2026-11-03", "2026-11-03"]);
  find(tree, node => node.props.className === "report-date-cell").props.onClick({ stopPropagation() {} }); tree = render(props);
  find(tree, node => node.props["data-date"] === props.workDate).props.onClick(); tree = render(props);
  assert.equal(nodes(tree).some(node => node.props.role === "dialog"), false); assert.equal(dates.length, 2);
});
