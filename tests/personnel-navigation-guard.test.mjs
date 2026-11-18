import { readWorkspaceImplementation } from "./fixtures/read-implementation.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { isEmployeeNavigationTarget, isEquipmentNavigationTarget, validMonth, workspaceUrl } from "../app/appRoutes.ts";

const source = await readWorkspaceImplementation();
const ast = ts.createSourceFile("PersonnelApp.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
const collect = node => { nodes.push(node); ts.forEachChild(node, collect); };
collect(ast);
function declaration(name) {
  const node = nodes.find(node => (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name);
  assert.ok(node, `Expected actual application handler ${name}`);
  return node;
}
function bind(name, environment = {}, callback = false) {
  const node = declaration(name);
  const text = callback ? `const ${name} = ${node.initializer.arguments[0].getText(ast)};` : ts.isVariableDeclaration(node) ? `const ${node.getText(ast)};` : node.getText(ast);
  const compiled = ts.transpileModule(text.replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(environment), `${compiled}\nreturn ${name};`)(...Object.values(environment));
}
const decisions = bind("workspaceNavigationDiscards");
const empty = { settings: false, report: false, equipment: false, workTypes: false };

test("settings drafts guard every table exit and project/period change, while staying in the same table preserves them", () => {
  for (const view of ["directories", "employees", "users", "positions", "projects", "projectEmployees", "equipmentRegistry", "projectEquipment", "accessRights", "timesheet", "equipmentTimesheet"]) {
    const state = { ...empty, settings: true, view, focus: "zone" };
    assert.equal(decisions(state, "placement", "all").settings, true, view);
    assert.equal(decisions(state, view, "zone").settings, false, view);
    assert.equal(decisions(state, view, "zone", true).settings, true, `${view}: project or period`);
  }
  assert.equal(decisions({ ...empty, settings: true, view: "directories", focus: "zone" }, "directories", "shift").settings, true);
  assert.deepEqual(decisions({ ...empty, view: "directories", focus: "zone" }, "placement", "all"), empty);
});

test("report and work type sessions retain their existing navigation boundaries", () => {
  const state = { settings: false, report: true, equipment: true, workTypes: true, view: "directories", focus: "mainWorkType" };
  assert.equal(decisions(state, "placement", "all").report, false);
  assert.equal(decisions(state, "equipment", "all").equipment, false);
  assert.equal(decisions(state, "directories", "subworkType").workTypes, false);
  assert.equal(decisions(state, "directories", "zone").workTypes, true);
  assert.deepEqual(decisions(state, "directories", "subworkType", true), { ...empty, report: true, equipment: true, workTypes: true });
});

function harness({ view = "directories", focus = "zone", month = "2026-11", employeeId = null, equipmentId = null, deniedViews = [] } = {}) {
  const saved = { key: "new-zone", entity: "zone", name: "Новая зона без сохранения" };
  const trace = { prompts: [], resets: [], pushes: [], replacements: [], drafts: [saved], selectedSite: 1, view, focus, month, employeeId, equipmentId };
  const answer = { resolve: null };
  const navigationState = { current: { view, focus, month, employeeId, equipmentId, settings: true, busy: false } };
  const location = { pathname: workspaceUrl(view, focus, "2026-11-02", month, employeeId, equipmentId), search: "" };
  const environment = {
    navigationState, bitrixBulkRunning: { current: false }, childNavigationBusyRef: { current: false },
    personnelReportDirtyRef: { current: false }, equipmentReportDirtyRef: { current: false }, workTypesDirtyRef: { current: false },
    equipmentSettingsDirtyRef: { current: false }, accessRightsDirtyRef: { current: false }, nativeTimesheetDirtyRef: { current: false },
    personnelReportLocationRef: { current: location.pathname },
    viewAllowed: candidate => !deniedViews.includes(candidate), fallbackView: "placement", workDate: "2026-11-02", selectedMonth: month, initialToday: "2026-11-02", focusedEmployeeId: employeeId, focusedEquipmentId: equipmentId,
    siteId: 1, mayViewAllProjects: true, currentUser: { id: 1 }, view, directoryFocus: focus, settingsBackTarget: "settings",
    canAccessProject: () => true, rememberCurrentReportDraftSession() {}, takeReportDraftSession: () => null,
    workspaceNavigationDiscards: decisions, pendingWorkspaceGridInput: () => empty,
    workspaceUrl, validMonth, isEmployeeNavigationTarget, isEquipmentNavigationTarget, parseWorkspaceLocation: () => trace.nextLocation,
    confirm: options => { trace.prompts.push(options); return new Promise(resolve => { answer.resolve = resolve; }); },
    window: { location, history: { pushState(_state, _title, url) { trace.pushes.push(url); location.pathname = url; }, replaceState(_state, _title, url) { trace.replacements.push(url); location.pathname = url; } }, scrollTo() {} },
    listening: true, locationSequence: 0,
  };
  const resetCallback = declaration("discardSettingsEdits").initializer.arguments[0].getText(ast);
  const setterNames = [...new Set(resetCallback.match(/\bset[A-Z]\w*/g))];
  for (const name of [...setterNames, "setPersonnelReportDirty", "setEquipmentReportDirty", "setWorkTypesDirty", "setDraftRows", "setEditingRows", "setPreviousDayReport", "setSelectedRosterDraftKeys", "setPendingDeletes", "setDeleteConfirmationOpen", "setWorkDate", "setReportRangeEnd", "setError", "setNotice"]) environment[name] = value => {
    trace.resets.push(name);
    if (name === "setDirectoryDrafts") trace.drafts = value;
  };
  environment.setView = value => { trace.view = value; };
  environment.setDirectoryFocus = value => { trace.focus = value; };
  environment.setSelectedMonth = value => { trace.month = value; };
  environment.setFocusedEmployeeId = value => { trace.employeeId = value; };
  environment.setFocusedEquipmentId = value => { trace.equipmentId = value; };
  environment.setSiteId = value => { trace.selectedSite = value; };
  environment.getNavigationDiscards = bind("getNavigationDiscards", environment, true);
  environment.discardSettingsEdits = bind("discardSettingsEdits", environment, true);
  return { environment, trace, answer, navigate: bind("navigateTo", environment), changeSite: bind("changeSite", environment), changeMonth: bind("changeTimesheetMonth", environment), back: bind("restoreLocation", environment), clearEmployeeFocus: bind("clearEmployeeFocus", environment), clearEquipmentFocus: bind("clearEquipmentFocus", environment) };
}

for (const accepted of [false, true]) test(`actual sidebar navigation ${accepted ? "discards only after approval" : "retains entered zone on Cancel"}`, async () => {
  const ui = harness();
  const navigating = ui.navigate("placement");
  assert.equal(ui.trace.prompts.length, 1);
  assert.equal(ui.trace.drafts[0].name, "Новая зона без сохранения");
  assert.equal(ui.trace.resets.length, 0);
  ui.answer.resolve(accepted);
  assert.equal(await navigating, accepted);
  assert.deepEqual(ui.trace.drafts, accepted ? [] : [{ key: "new-zone", entity: "zone", name: "Новая зона без сохранения" }]);
  assert.equal(ui.trace.view, accepted ? "placement" : "directories");
});

test("actual settings sidebar and Back button handlers cannot clear drafts before async navigation is accepted", async () => {
  const handlers = nodes.filter(ts.isJsxOpeningElement).filter(node => node.tagName.getText(ast) === "button").flatMap(node => {
    const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
    const value = name => {
      const initializer = attributes.find(attribute => attribute.name.getText(ast) === name)?.initializer;
      return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
    };
    const control = value("aria-label") ?? value("className");
    const relevant = ["back-button", "page-heading-back"].includes(value("className")) || ["Общие настройки", "Настройки проекта"].includes(value("aria-label"));
    const expression = attributes.find(attribute => attribute.name.getText(ast) === "onClick")?.initializer;
    const handler = expression && ts.isJsxExpression(expression) && expression.expression;
    return relevant && handler?.getText(ast).includes("navigateTo(") ? [{ handler: handler.getText(ast), control }] : [];
  });
  for (const control of ["Общие настройки", "Настройки проекта", "page-heading-back"]) {
    assert.ok(handlers.some(item => item.control === control), `Cover the actual navigation control: ${control}`);
  }
  for (const { handler } of handlers) {
    const ui = harness();
    const environment = { ...ui.environment, navigateTo: ui.navigate };
    const compiled = ts.transpileModule(`const handler = ${handler};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const click = new Function(...Object.keys(environment), `${compiled}\nreturn handler;`)(...Object.values(environment));
    const navigating = click();
    assert.equal(ui.trace.prompts.length, 1, handler);
    assert.equal(ui.trace.resets.length, 0, `Draft reset before confirmation: ${handler}`);
    ui.answer.resolve(false); await navigating;
    assert.equal(ui.trace.drafts.length, 1, handler);
  }
});

test("the actual project switch waits for approval and never discards on Cancel", async () => {
  const ui = harness({ employeeId: 17 });
  const first = ui.changeSite(2);
  assert.equal(ui.trace.resets.length, 0);
  ui.answer.resolve(false); await first;
  assert.equal(ui.trace.selectedSite, 1);
  assert.equal(ui.trace.employeeId, 17);
  assert.equal(ui.trace.drafts.length, 1);
  const second = ui.changeSite(2);
  ui.answer.resolve(true); await second;
  assert.equal(ui.trace.selectedSite, 2);
  assert.equal(ui.trace.employeeId, null);
  assert.deepEqual(ui.trace.drafts, []);
});

for (const accepted of [false, true]) test(`employee timesheet navigation ${accepted ? "commits historical month and identity after approval" : "keeps month and identity on Cancel"}`, async () => {
  const ui = harness({ view: "placement", focus: "all", employeeId: 17 });
  ui.environment.personnelReportDirtyRef.current = true;
  const navigating = ui.navigate("timesheet", "all", { employeeId: 42, month: "2025-12" });
  assert.equal(ui.trace.prompts.length, 1);
  assert.equal(ui.trace.month, "2026-11");
  assert.equal(ui.trace.employeeId, 17);
  assert.deepEqual(ui.trace.pushes, []);
  ui.answer.resolve(accepted);
  assert.equal(await navigating, accepted);
  assert.equal(ui.trace.month, accepted ? "2025-12" : "2026-11");
  assert.equal(ui.trace.employeeId, accepted ? 42 : 17);
  assert.equal(ui.trace.selectedSite, 1);
  assert.equal(ui.trace.view, accepted ? "timesheet" : "placement");
  assert.deepEqual(ui.trace.pushes, accepted ? ["/timesheets/workers?month=2025-12&employeeId=42"] : []);
});

for (const targetView of ["timesheet", "employees", "projectEmployees"]) test(`employee navigation refuses inaccessible ${targetView} without falling back or prompting`, async () => {
  const ui = harness({ view: "placement", focus: "all", employeeId: 17, deniedViews: [targetView] });
  assert.equal(await ui.navigate(targetView, "all", { employeeId: 42, month: "2025-12" }), false);
  assert.equal(ui.trace.view, "placement");
  assert.equal(ui.trace.employeeId, 17);
  assert.equal(ui.trace.month, "2026-11");
  assert.deepEqual(ui.trace.prompts, []);
  assert.deepEqual(ui.trace.resets, []);
  assert.deepEqual(ui.trace.pushes, []);
});

test("employee navigation rejects invalid identity before touching drafts or location", async () => {
  const ui = harness({ employeeId: 17 });
  for (const employeeId of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await ui.navigate("timesheet", "all", { employeeId, month: "2025-12" }), false);
  }
  assert.equal(ui.trace.employeeId, 17);
  assert.deepEqual(ui.trace.prompts, []);
  assert.deepEqual(ui.trace.resets, []);
  assert.deepEqual(ui.trace.pushes, []);
});

test("browser Back restores the employee linked in the accepted target address", async () => {
  const ui = harness({ employeeId: 17 });
  ui.trace.nextLocation = { view: "timesheet", directoryFocus: "all", date: "2026-11-02", month: "2025-12", employeeId: 42 };
  const navigating = ui.back();
  assert.equal(ui.trace.employeeId, 17);
  assert.equal(ui.trace.month, "2026-11");
  ui.answer.resolve(true);
  await navigating;
  assert.equal(ui.trace.view, "timesheet");
  assert.equal(ui.trace.month, "2025-12");
  assert.equal(ui.trace.employeeId, 42);
});

for (const targetView of ["equipmentTimesheet", "equipmentRegistry", "projectEquipment"]) for (const accepted of [false, true]) test(`equipment navigation to ${targetView} ${accepted ? "commits identity and period after approval" : "keeps report drafts and location on Cancel"}`, async () => {
  const ui = harness({ view: "equipment", focus: "all", employeeId: 17, equipmentId: 21 });
  ui.environment.equipmentReportDirtyRef.current = true;
  const navigating = ui.navigate(targetView, "all", { equipmentId: 73, month: "2025-12" });
  assert.equal(ui.trace.prompts.length, 1);
  assert.equal(ui.trace.month, "2026-11");
  assert.equal(ui.trace.equipmentId, 21);
  assert.equal(ui.environment.equipmentReportDirtyRef.current, true);
  assert.deepEqual(ui.trace.pushes, []);
  ui.answer.resolve(accepted);
  assert.equal(await navigating, accepted);
  assert.equal(ui.trace.month, accepted ? "2025-12" : "2026-11");
  assert.equal(ui.trace.equipmentId, accepted ? 73 : 21);
  assert.equal(ui.trace.employeeId, accepted ? null : 17);
  assert.equal(ui.environment.equipmentReportDirtyRef.current, !accepted);
  assert.equal(ui.trace.selectedSite, 1);
  assert.equal(ui.trace.view, accepted ? targetView : "equipment");
  assert.deepEqual(ui.trace.pushes, accepted ? [workspaceUrl(targetView, "all", "2026-11-02", "2025-12", null, 73)] : []);
});

test("equipment navigation refuses inaccessible or incompatible destinations without touching drafts", async () => {
  const destinations = ["equipmentTimesheet", "equipmentRegistry", "projectEquipment"];
  const denied = harness({ view: "equipment", focus: "all", equipmentId: 21, deniedViews: destinations });
  const incompatible = harness({ view: "equipment", focus: "all", equipmentId: 21 });
  for (const targetView of destinations) {
    assert.equal(await denied.navigate(targetView, "all", { equipmentId: 73, month: "2025-12" }), false);
    assert.equal(await incompatible.navigate(targetView, "all", { employeeId: 73, month: "2025-12" }), false);
  }
  for (const targetView of ["timesheet", "employees", "projectEmployees", "equipment"]) {
    assert.equal(await incompatible.navigate(targetView, "all", { equipmentId: 73, month: "2025-12" }), false);
  }
  for (const { trace } of [denied, incompatible]) {
    assert.equal(trace.view, "equipment");
    assert.equal(trace.equipmentId, 21);
    assert.equal(trace.month, "2026-11");
    assert.deepEqual(trace.prompts, []);
    assert.deepEqual(trace.resets, []);
    assert.deepEqual(trace.pushes, []);
  }
});

test("equipment navigation rejects invalid identities and periods before touching drafts", async () => {
  const ui = harness({ view: "equipment", focus: "all", equipmentId: 21 });
  for (const equipmentId of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await ui.navigate("equipmentTimesheet", "all", { equipmentId, month: "2025-12" }), false);
  }
  for (const month of ["", "2025-13", "2025-12-31"]) {
    assert.equal(await ui.navigate("equipmentTimesheet", "all", { equipmentId: 73, month }), false);
  }
  assert.equal(ui.trace.equipmentId, 21);
  assert.deepEqual(ui.trace.prompts, []);
  assert.deepEqual(ui.trace.resets, []);
  assert.deepEqual(ui.trace.pushes, []);
});

for (const accepted of [false, true]) test(`browser Back ${accepted ? "restores" : "preserves on Cancel"} equipment focus within the same month`, async () => {
  const ui = harness({ view: "equipmentTimesheet", focus: "all", equipmentId: 21 });
  ui.environment.nativeTimesheetDirtyRef.current = true;
  ui.trace.nextLocation = { view: "equipmentTimesheet", directoryFocus: "all", date: "2026-11-02", month: "2026-11", equipmentId: 73 };
  const oldUrl = ui.environment.personnelReportLocationRef.current;
  const navigating = ui.back();
  assert.equal(ui.trace.prompts.length, 1);
  assert.equal(ui.trace.equipmentId, 21);
  ui.answer.resolve(accepted);
  await navigating;
  assert.equal(ui.trace.view, "equipmentTimesheet");
  assert.equal(ui.trace.month, "2026-11");
  assert.equal(ui.trace.equipmentId, accepted ? 73 : 21);
  assert.equal(ui.environment.nativeTimesheetDirtyRef.current, !accepted);
  assert.deepEqual(ui.trace.pushes, accepted ? [] : [oldUrl]);
});

test("changing equipment month retains its identity in the address", () => {
  const ui = harness({ view: "equipmentTimesheet", focus: "all", equipmentId: 73 });
  ui.changeMonth("2025-12");
  assert.equal(ui.trace.month, "2025-12");
  assert.equal(ui.trace.equipmentId, 73);
  assert.deepEqual(ui.trace.replacements, ["/timesheets/equipment?month=2025-12&equipmentId=73"]);
});

test("clearing a navigation filter removes its URL marker without discarding table edits", () => {
  for (const view of ["timesheet", "equipmentTimesheet", "equipmentRegistry", "projectEquipment"]) {
    const employee = view === "timesheet";
    const ui = harness({ view, focus: "all", employeeId: employee ? 42 : null, equipmentId: employee ? null : 73 });
    ui.environment.nativeTimesheetDirtyRef.current = true;
    ui.environment.equipmentSettingsDirtyRef.current = true;
    if (employee) ui.clearEmployeeFocus(); else ui.clearEquipmentFocus();
    assert.equal(ui.trace.employeeId, null);
    assert.equal(ui.trace.equipmentId, null);
    assert.equal(ui.trace.view, view);
    assert.equal(ui.trace.month, "2026-11");
    assert.equal(ui.trace.drafts.length, 1);
    assert.equal(ui.environment.nativeTimesheetDirtyRef.current, true);
    assert.equal(ui.environment.equipmentSettingsDirtyRef.current, true);
    assert.deepEqual(ui.trace.prompts, []);
    assert.deepEqual(ui.trace.resets, []);
    assert.deepEqual(ui.trace.replacements, [workspaceUrl(view, "all", "2026-11-02", "2026-11")]);
  }
});

for (const accepted of [false, true]) test(`project switch ${accepted ? "clears" : "preserves on Cancel"} equipment focus`, async () => {
  const ui = harness({ view: "equipmentTimesheet", focus: "all", equipmentId: 73 });
  const switching = ui.changeSite(2);
  assert.equal(ui.trace.equipmentId, 73);
  ui.answer.resolve(accepted);
  await switching;
  assert.equal(ui.trace.equipmentId, accepted ? null : 73);
  assert.equal(ui.trace.selectedSite, accepted ? 2 : 1);
  assert.deepEqual(ui.trace.replacements, accepted ? ["/timesheets/equipment?month=2026-11"] : []);
});

for (const period of [false, true]) test(`browser Back Cancel restores URL and preserves ${period ? "native period editor" : "zone drafts"}`, async () => {
  const ui = harness(period ? { view: "timesheet", focus: "all" } : {});
  ui.trace.nextLocation = { view: period ? "timesheet" : "placement", directoryFocus: "all", date: "2026-11-02", month: period ? "2026-10" : "2026-11" };
  const oldUrl = ui.environment.personnelReportLocationRef.current;
  const back = ui.back();
  assert.equal(ui.trace.prompts.length, 1);
  ui.answer.resolve(false); await back;
  assert.deepEqual(ui.trace.pushes, [oldUrl]);
  assert.equal(ui.trace.drafts.length, 1);
  assert.equal(ui.trace.month, "2026-11");
  assert.equal(ui.trace.view, period ? "timesheet" : "directories");
});

test("network writes block sidebar, project and browser Back without a misleading discard prompt", async () => {
  const ui = harness();
  ui.environment.childNavigationBusyRef.current = true;
  assert.equal(await ui.navigate("placement"), false);
  await ui.changeSite(2);
  await ui.back();
  assert.equal(ui.trace.prompts.length, 0);
  assert.equal(ui.trace.resets.length, 0);
  assert.equal(ui.trace.drafts.length, 1);
  assert.deepEqual(ui.trace.pushes, [ui.environment.personnelReportLocationRef.current]);
});
