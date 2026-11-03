import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { workspaceUrl } from "../app/appRoutes.ts";

const source = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
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
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
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

function harness({ view = "directories", focus = "zone", month = "2026-11" } = {}) {
  const saved = { key: "new-zone", entity: "zone", name: "Новая зона без сохранения" };
  const trace = { prompts: [], resets: [], pushes: [], drafts: [saved], selectedSite: 1, view, focus, month };
  const answer = { resolve: null };
  const navigationState = { current: { view, focus, month, settings: true, busy: false } };
  const location = { pathname: workspaceUrl(view, focus, "2026-11-02", month), search: "" };
  const environment = {
    navigationState, bitrixBulkRunning: { current: false }, childNavigationBusyRef: { current: false },
    personnelReportDirtyRef: { current: false }, equipmentReportDirtyRef: { current: false }, workTypesDirtyRef: { current: false },
    equipmentSettingsDirtyRef: { current: false }, accessRightsDirtyRef: { current: false }, nativeTimesheetDirtyRef: { current: false },
    personnelReportLocationRef: { current: location.pathname },
    viewAllowed: () => true, fallbackView: "placement", workDate: "2026-11-02", selectedMonth: month, initialToday: "2026-11-02",
    siteId: 1, mayViewAllProjects: true, currentUser: { id: 1 }, view, directoryFocus: focus, settingsBackTarget: "settings",
    canAccessProject: () => true, rememberCurrentReportDraftSession() {}, takeReportDraftSession: () => null,
    workspaceNavigationDiscards: decisions, pendingWorkspaceGridInput: () => empty,
    workspaceUrl, parseWorkspaceLocation: () => trace.nextLocation,
    confirm: options => { trace.prompts.push(options); return new Promise(resolve => { answer.resolve = resolve; }); },
    window: { location, history: { pushState(_state, _title, url) { trace.pushes.push(url); location.pathname = url; } }, scrollTo() {} },
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
  environment.setSiteId = value => { trace.selectedSite = value; };
  environment.getNavigationDiscards = bind("getNavigationDiscards", environment, true);
  environment.discardSettingsEdits = bind("discardSettingsEdits", environment, true);
  return { environment, trace, answer, navigate: bind("navigateTo", environment), changeSite: bind("changeSite", environment), back: bind("restoreLocation", environment) };
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
  const ui = harness();
  const first = ui.changeSite(2);
  assert.equal(ui.trace.resets.length, 0);
  ui.answer.resolve(false); await first;
  assert.equal(ui.trace.selectedSite, 1);
  assert.equal(ui.trace.drafts.length, 1);
  const second = ui.changeSite(2);
  ui.answer.resolve(true); await second;
  assert.equal(ui.trace.selectedSite, 2);
  assert.deepEqual(ui.trace.drafts, []);
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
