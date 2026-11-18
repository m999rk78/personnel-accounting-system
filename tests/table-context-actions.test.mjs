import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function sourceFile(relativePath) {
  const path = new URL(relativePath, import.meta.url);
  return ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const filters = await sourceFile("../app/GridFilters.tsx");
const closeDeclaration = filters.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "closeContextActionsAfterSelection");
assert.ok(closeDeclaration);
const wrapActions = new Function(`${compile(closeDeclaration.getText(filters))}; return closeContextActionsAfterSelection;`)();

test("nested custom actions close only after the selected leaf succeeds and retain failures for the caller", async () => {
  const events = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const actions = wrapActions([{ label: "Перейти", onSelect: () => {}, children: [{
    label: "В табель", onSelect: async () => { events.push("navigate"); await pending; },
  }] }], () => events.push("close"));
  await actions[0].onSelect();
  assert.deepEqual(events, [], "Opening a submenu does not navigate or close it");
  const selected = actions[0].children[0].onSelect();
  assert.deepEqual(events, ["navigate"]);
  finish();
  await selected;
  assert.deepEqual(events, ["navigate", "close"]);

  const failed = wrapActions([{ label: "Перейти", onSelect() {}, children: [{
    label: "В табель", onSelect: async () => { throw new Error("Navigation unavailable"); },
  }] }], () => events.push("unexpected close"));
  await assert.rejects(failed[0].children[0].onSelect(), /Navigation unavailable/);
  assert.deepEqual(events, ["navigate", "close"]);
});

const moves = await sourceFile("../app/TableRowMoves.tsx");
const moveHook = moves.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useRowMoveActions");
let getActions;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "getActions") getActions = node.initializer.getText(moves);
  ts.forEachChild(node, visit);
}
visit(moveHook);
assert.ok(getActions);
const createActions = new Function("order", "disabled", "datedReport", "pending", "setPending", `return (${compile(`const callback = ${getActions}`).replace(/^const callback = /, "").trim().replace(/;$/, "")});`);

function moveHarness(overrides = {}) {
  const operations = [];
  const selected = [];
  let closed = 0;
  const order = { canWrite: true, busy: false, move: async operation => { operations.push(operation); return true; }, ...overrides.order };
  const callback = createActions(order, overrides.disabled ?? false, overrides.datedReport ?? false, overrides.pending ?? [], values => selected.push(values));
  return { actions: (id, ids = []) => callback(id, ids, () => closed++), operations, selected, closeCount: () => closed };
}

test("grouped movement keeps multi-row targets, pending insertion and read-only constraints", async () => {
  const env = moveHarness({ datedReport: true });
  const [group] = env.actions(3, [2, 3]);
  assert.equal(group.label, "Перемещение");
  await group.onSelect();
  assert.deepEqual(env.operations, []);
  assert.equal(env.closeCount(), 0);
  await group.children.find(action => action.label.startsWith("Переместить в начало")).onSelect();
  assert.deepEqual(env.operations, [{ movingIds: [2, 3], placement: "start" }]);
  assert.deepEqual(env.selected, [[]]);
  assert.equal(env.closeCount(), 1);

  const single = moveHarness();
  await single.actions(4, [2, 3])[0].children.find(action => action.label.startsWith("Переместить в конец")).onSelect();
  assert.deepEqual(single.operations, [{ movingIds: [4], placement: "end" }]);

  const pending = moveHarness({ pending: [2, 3] });
  const actions = pending.actions(4)[0].children;
  await actions.find(action => action.label.startsWith("Вставить ниже")).onSelect();
  assert.deepEqual(pending.operations, [{ movingIds: [2, 3], placement: "after", targetId: 4 }]);
  assert.equal(pending.actions(2)[0].children.find(action => action.label.startsWith("Вставить выше")).disabled, true);

  assert.deepEqual(moveHarness({ order: { canWrite: false } }).actions(3), []);
  for (const overrides of [{ disabled: true }, { order: { busy: true } }]) {
    assert.ok(moveHarness(overrides).actions(3)[0].children.every(action => action.disabled));
  }
});

async function reportContextBinder(path) {
  const grid = await sourceFile(path);
  let callback;
  function findContext(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(grid) === "getSpreadsheetContextActions") {
      callback = node.initializer.expression.getText(grid);
    }
    ts.forEachChild(node, findContext);
  }
  findContext(grid);
  assert.ok(callback);
  return new Function("rowsRef", "propsRef", `${compile(`const callback = ${callback};`)} return callback;`);
}
const bindEquipmentContext = await reportContextBinder("../app/EquipmentReportGrid.tsx");
const bindPersonnelContext = await reportContextBinder("../app/PersonnelReportGrid.tsx");

test("equipment report navigation respects draft identity, view access and an in-flight save", () => {
  const navigations = [];
  const destinations = [
    { view: "equipmentTimesheet", label: "В табель техники" },
    { view: "equipmentRegistry", label: "В реестр техники" },
    { view: "projectEquipment", label: "В технику проекта" },
  ];
  const propsRef = { current: { canCreate: false, equipmentNavigationTargets: destinations, onNavigateEquipment: (...args) => navigations.push(args) } };
  const rowsRef = { current: new Map() };
  const context = bindEquipmentContext(rowsRef, propsRef);
  const source = { rowKey: "entry-99", workDate: "2026-10-12", entry: { id: 99, equipmentId: 7 } };
  rowsRef.current.set(source.rowKey, source);
  const [group] = context({ row: source });
  assert.equal(group.label, "Перейти", "Read-only report users can still navigate to accessible linked tables");
  assert.deepEqual(group.children.map(child => child.label), destinations.map(target => target.label));
  group.children.forEach(child => child.onSelect());
  assert.deepEqual(navigations, destinations.map(target => [target.view, 7, "2026-10-12"]));

  source.draft = { equipmentId: "8" };
  context({ row: source })[0].children[0].onSelect();
  assert.deepEqual(navigations[3], ["equipmentTimesheet", 8, "2026-10-12"]);
  for (const equipmentId of ["", "0", "-1", "1.5", "invalid"]) {
    source.draft.equipmentId = equipmentId;
    assert.deepEqual(context({ row: source }), [], "A cleared or invalid draft cannot navigate to the previous unit");
  }
  source.draft.equipmentId = "8";
  propsRef.current.navigationDisabled = true;
  assert.equal(context({ row: source })[0].children[0].disabled, true);
  group.children[0].onSelect();
  assert.equal(navigations.length, 4, "A menu opened before saving must also refuse navigation while the save is running");
  propsRef.current.navigationDisabled = false;
  propsRef.current.equipmentNavigationTargets = destinations.slice(1);
  assert.deepEqual(context({ row: source })[0].children.map(child => child.label), destinations.slice(1).map(target => target.label));
  group.children[0].onSelect();
  assert.equal(navigations.length, 4, "A menu opened before access changed must not invoke a revoked destination");
  propsRef.current.equipmentNavigationTargets = [];
  assert.deepEqual(context({ row: source }), [], "No navigation group is exposed with an empty destination list");
  propsRef.current.equipmentNavigationTargets = destinations;
  propsRef.current.onNavigateEquipment = undefined;
  assert.deepEqual(context({ row: source }), [], "No navigation is exposed without access to the destination");
});

test("personnel report navigation respects draft identity and current permissions even for an already open menu", () => {
  const navigations = [];
  const destinations = [
    { view: "timesheet", label: "В табель персонала" },
    { view: "employees", label: "В справочник сотрудников" },
    { view: "projectEmployees", label: "В сотрудники проекта" },
  ];
  const propsRef = { current: { canCreate: false, employeeNavigationTargets: destinations, onNavigateEmployee: (...args) => navigations.push(args) } };
  const source = { rowKey: "entry-42", workDate: "2026-10-09", entry: { id: 42, employeeId: 7 } };
  const context = bindPersonnelContext({ current: new Map([[source.rowKey, source]]) }, propsRef);
  const [opened] = context({ row: source });
  assert.equal(opened.label, "Перейти", "Viewing a report is enough to navigate to accessible linked tables");
  assert.deepEqual(opened.children.map(child => child.label), destinations.map(target => target.label));
  opened.children.forEach(child => child.onSelect());
  assert.deepEqual(navigations, destinations.map(target => [target.view, 7, source.workDate]));

  source.draft = { employeeId: "8" };
  context({ row: source })[0].children[1].onSelect();
  assert.deepEqual(navigations[3], ["employees", 8, source.workDate], "The current draft identity wins over the original report row");
  for (const employeeId of ["", "0", "-1", "1.5", "invalid"]) {
    source.draft.employeeId = employeeId;
    assert.deepEqual(context({ row: source }), [], "Cleared or invalid draft identities never fall back to the old employee");
  }
  source.draft.employeeId = "8";
  propsRef.current.navigationDisabled = true;
  assert.ok(context({ row: source })[0].children.every(child => child.disabled));
  opened.children.forEach(child => child.onSelect());
  assert.equal(navigations.length, 4, "Starting a save disables actions in an already open menu");

  propsRef.current.navigationDisabled = false;
  propsRef.current.employeeNavigationTargets = destinations.slice(1);
  assert.deepEqual(context({ row: source })[0].children.map(child => child.label), destinations.slice(1).map(target => target.label));
  opened.children[0].onSelect();
  assert.equal(navigations.length, 4, "An already open menu cannot navigate to a revoked destination");
  propsRef.current.employeeNavigationTargets = [];
  assert.deepEqual(context({ row: source }), []);
  propsRef.current.employeeNavigationTargets = destinations;
  propsRef.current.onNavigateEmployee = undefined;
  assert.deepEqual(context({ row: source }), []);
});
