import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { auditNavigationAllowed } from "../app/auditNavigation.ts";
import { isEmployeeNavigationTarget, isEquipmentNavigationTarget, validMonth, workspaceUrl } from "../app/appRoutes.ts";
import { canAccessProject } from "../app/roles.ts";

const allowed = { viewAllowed: () => true, projectAllowed: id => [1, 2].includes(id) };

test("audit destinations require the actual project and a compatible stable entity identity", () => {
  for (const view of ["placement", "equipment", "timesheet", "equipmentTimesheet", "projectEmployees", "projectEquipment", "projectSettings"]) {
    assert.equal(auditNavigationAllowed({ view }, allowed), false, `${view}: never silently use the current project`);
    assert.equal(auditNavigationAllowed({ view, siteId: 2 }, allowed), true, view);
    assert.equal(auditNavigationAllowed({ view, siteId: 3 }, allowed), false, `${view}: inaccessible project`);
  }
  for (const view of ["employees", "projectEmployees", "timesheet"]) {
    assert.equal(auditNavigationAllowed({ view, siteId: 2, employeeId: 42, month: "2026-10" }, allowed), true);
    assert.equal(auditNavigationAllowed({ view, siteId: 2, equipmentId: 42 }, allowed), false);
  }
  for (const view of ["equipmentRegistry", "projectEquipment", "equipmentTimesheet"]) {
    assert.equal(auditNavigationAllowed({ view, siteId: 2, equipmentId: 42, month: "2026-10" }, allowed), true);
    assert.equal(auditNavigationAllowed({ view, siteId: 2, employeeId: 42 }, allowed), false);
  }
  assert.equal(auditNavigationAllowed({ view: "users" }, allowed), true);
  assert.equal(auditNavigationAllowed({ view: "users", employeeId: 42 }, allowed), false, "A report ID cannot become a user filter");
  assert.equal(auditNavigationAllowed({ view: "directories", siteId: 2, directoryFocus: "zone" }, allowed), true);
  assert.equal(auditNavigationAllowed({ view: "directories", siteId: 2, directoryFocus: "shift" }, allowed), false, "No usable route exists for that directory");
});

test("audit destinations reject malformed identities, dates and inaccessible sections", () => {
  for (const employeeId of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(auditNavigationAllowed({ view: "employees", employeeId }, allowed), false);
  }
  for (const siteId of [0, -1, 1.5, NaN, Infinity]) {
    assert.equal(auditNavigationAllowed({ view: "projectSettings", siteId }, allowed), false);
  }
  for (const month of ["", "2026-13", "2026-11-18"]) {
    assert.equal(auditNavigationAllowed({ view: "timesheet", siteId: 2, month }, allowed), false);
  }
  assert.equal(auditNavigationAllowed({ view: "users" }, { ...allowed, viewAllowed: () => false }), false);
  assert.equal(auditNavigationAllowed({ view: "/api/data" }, allowed), false);
  assert.equal(auditNavigationAllowed({ view: "employees", employeeId: 42, equipmentId: 73 }, allowed), false);
});

const source = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("PersonnelApp.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
function bind(name, environment) {
  assert.ok(declarations.has(name), `Expected actual handler ${name}`);
  const code = ts.transpileModule(declarations.get(name), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), `${code}; return ${name};`)(...Object.values(environment));
}
function harness({ dirty = false, view = "auditLog", deniedViews = [], busy = false, visibleSites = [{ id: 1 }, { id: 2 }], accessibleSites = [1, 2] } = {}) {
  const trace = { siteId: 1, view, employeeId: null, equipmentId: null, month: "2026-11", prompts: [], pushes: [], changes: [], guards: [] };
  let answer;
  const environment = {
    siteId: 1, selectedMonth: "2026-11", workDate: "2026-11-18", focusedEmployeeId: null, focusedEquipmentId: null,
    currentUser: { role: "engineer", projectAccess: { mode: "selected", siteIds: accessibleSites } }, visibleSites,
    viewAllowed: target => !deniedViews.includes(target), fallbackView: "placement", auditNavigationAllowed, canAccessProject,
    isEmployeeNavigationTarget, isEquipmentNavigationTarget, validMonth, workspaceUrl,
    navigationState: { current: { view, focus: "all", busy: false } }, bitrixBulkRunning: { current: false }, childNavigationBusyRef: { current: busy },
    personnelReportDirtyRef: { current: dirty }, equipmentReportDirtyRef: { current: dirty }, workTypesDirtyRef: { current: dirty },
    getNavigationDiscards(nextView, focus, contextChanged) {
      trace.guards.push({ nextView, focus, contextChanged });
      return { settings: dirty, report: dirty, equipment: dirty, workTypes: dirty };
    },
    confirm(options) { trace.prompts.push(options); return new Promise(resolve => { answer = resolve; }); },
    discardSettingsEdits() { trace.changes.push("discard"); },
    window: { location: { pathname: "/settings/general/activity", search: "" }, history: { pushState(_state, _title, url) { trace.pushes.push(url); } }, scrollTo() {} },
  };
  for (const [setter, key] of Object.entries({ setSiteId: "siteId", setView: "view", setSelectedMonth: "month", setFocusedEmployeeId: "employeeId", setFocusedEquipmentId: "equipmentId", setReportSource: "reportSource", setDirectoryFocus: "focus", setWorkDate: "date" })) {
    environment[setter] = value => { trace.changes.push(setter); trace[key] = value; };
  }
  for (const setter of ["setPersonnelReportDirty", "setEquipmentReportDirty", "setWorkTypesDirty"]) environment[setter] = () => { trace.changes.push(setter); };
  environment.navigateTo = bind("navigateTo", environment);
  environment.canNavigateAuditTarget = bind("canNavigateAuditTarget", environment);
  return { trace, environment, respond: accepted => answer(accepted), navigate: bind("navigateAuditTarget", environment) };
}

for (const accepted of [false, true]) test(`audit link ${accepted ? "switches project, month and employee together after acceptance" : "keeps project, period and input when cancelled"}`, async () => {
  const ui = harness({ dirty: true });
  const navigating = ui.navigate({ view: "timesheet", siteId: 2, employeeId: 42, month: "2026-10" });
  assert.equal(ui.trace.prompts.length, 1);
  assert.deepEqual(ui.trace.changes, []);
  assert.equal(ui.trace.siteId, 1);
  assert.equal(ui.trace.view, "auditLog");
  ui.respond(accepted);
  assert.equal(await navigating, accepted);
  assert.equal(ui.trace.siteId, accepted ? 2 : 1);
  assert.equal(ui.trace.view, accepted ? "timesheet" : "auditLog");
  assert.equal(ui.trace.employeeId, accepted ? 42 : null);
  assert.equal(ui.trace.month, accepted ? "2026-10" : "2026-11");
  assert.deepEqual(ui.trace.pushes, accepted ? ["/timesheets/workers?month=2026-10&employeeId=42"] : []);
  if (!accepted) assert.deepEqual(ui.trace.changes, []);
});

test("audit links stay inert for missing projects, denied resources and active saves", async () => {
  for (const options of [{ visibleSites: [{ id: 1 }] }, { accessibleSites: [1] }, { deniedViews: ["timesheet"] }, { busy: true }]) {
    const ui = harness(options);
    assert.equal(await ui.navigate({ view: "timesheet", siteId: 2, employeeId: 42, month: "2026-10" }), false);
    assert.deepEqual(ui.trace.changes, []);
    assert.deepEqual(ui.trace.prompts, []);
    assert.deepEqual(ui.trace.pushes, []);
  }
});

test("project-only navigation guards the context even when the section remains the same", async () => {
  const ui = harness({ view: "projectSettings" });
  assert.equal(await ui.navigate({ view: "projectSettings", siteId: 2 }), true);
  assert.equal(ui.trace.guards[0].contextChanged, true);
  assert.equal(ui.trace.siteId, 2);
  assert.equal(ui.trace.view, "projectSettings");
});

test("audit reports open the ordinary section without statistics filters, and equipment uses the normal ID filter", async () => {
  const report = harness();
  assert.equal(await report.navigate({ view: "placement", siteId: 2 }), true);
  assert.deepEqual(report.trace.pushes, ["/reports/workers?date=2026-11-18"]);
  assert.equal(report.trace.reportSource, undefined);
  assert.equal(report.trace.siteId, 2);
  const equipment = harness();
  assert.equal(await equipment.navigate({ view: "equipmentTimesheet", siteId: 2, equipmentId: 73, month: "2026-09" }), true);
  assert.deepEqual(equipment.trace.pushes, ["/timesheets/equipment?month=2026-09&equipmentId=73"]);
  assert.equal(equipment.trace.employeeId, null);
  assert.equal(equipment.trace.equipmentId, 73);
});
