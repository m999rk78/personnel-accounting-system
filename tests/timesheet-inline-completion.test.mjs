import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { isPersonnelTimesheetValue } from "../app/personnelTimesheetValues.ts";

const js = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const variants = [
  { name: "equipment", file: "EquipmentAccountingView.tsx", save: "saveTimesheetInlineValue", open: "openTimesheetInlineEditor", label: "Значение табеля техники:" },
  { name: "personnel", file: "TimesheetView.tsx", save: "saveInlineEditor", open: "openInlineEditor", label: "Значение табеля:" },
];
for (const variant of variants) {
  const path = new URL(`../app/${variant.file}`, import.meta.url);
  const source = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  variant.code = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && [variant.save, variant.open, "parseEquipmentClipboardHours", "canAddTimesheetMark"].includes(node.name?.text)) variant.code.set(node.name.text, node.getText(source));
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "input" && node.attributes.getText(source).includes(variant.label)) {
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && ["onBlur", "onKeyDown"].includes(attr.name.text)) variant.code.set(attr.name.text, attr.initializer.expression.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const name of [variant.save, variant.open, "onBlur", "onKeyDown"]) assert.ok(variant.code.has(name), `${variant.file}: actual ${name} must exist`);
}

function harness(variant, value = "8", mode = "success") {
  const editor = { session: 4, employeeId: 1, equipmentId: 1, workDate: "2026-11-01", rowIndex: 0, columnIndex: 0, value, error: "", selectAll: false };
  const state = { editor, writes: 0, focus: 0, moves: 0, waiting: [], persisted: [], moveTargets: [] };
  const session = { current: editor.session }, cancel = { current: false }, inFlight = { current: null };
  const update = next => { state.editor = typeof next === "function" ? next(state.editor) : next; };
  const persist = async (...args) => {
    state.writes++;
    state.persisted.push(args);
    if (mode === "pending") await new Promise((resolve, reject) => state.waiting.push({ resolve, reject }));
    if (mode === "failure") throw new Error("Synthetic API failure");
    return true;
  };
  const refs = {
    inlineSession: session, timesheetInlineSession: session,
    inlineCancelPending: cancel, timesheetInlineCancelPending: cancel,
    inlineSaveInFlight: inFlight, timesheetInlineSaveInFlight: inFlight,
    clipboardViewScope: { current: "1:2026-11:1:days=1|2" },
  };
  const scope = {
    ...refs,
    inlineEditor: editor, timesheetInlineEditor: editor,
    setInlineEditor: update, setTimesheetInlineEditor: update,
    activeScope: { current: "1:2026-11" }, activeScopeVersion: { current: 0 },
    isPersonnelTimesheetValue,
    marksByCell: new Map(), timesheetMarksByCell: new Map(), entriesByCell: new Map(),
    cellKey: (id, date) => `${id}:${date}`, equipmentCellKey: (id, date) => `${id}:${date}`,
    persistMark: persist, persistEquipmentTimesheetMark: persist,
    inlineGridFocusPending: { current: false }, timesheetInlineGridFocusPending: { current: false },
    restoreEquipmentTimesheetFocus: () => { state.focus++; },
    focusClipboardCell: () => { state.moves++; }, notifyTimesheetClipboard() {},
    focusEquipmentTimesheetCell: (...coordinates) => { state.moves++; state.moveTargets.push(coordinates); }, notifyEquipmentTimesheetClipboard() {},
    savingMark: false, savingTimesheetMark: false,
    savingBulkMarks: false, savingBulkTimesheetMarks: false, loading: false,
    payload: { canCreate: true, canUpdate: true, canCreateTimesheet: true, canUpdateTimesheet: true, employees: [{ id: 1 }, { id: 2 }] },
    inlineInputRef: { current: { focus: () => { state.focus++; } } },
    timesheetInlineInput: { current: { focus: () => { state.focus++; } } },
    monthRows: [], markValue: () => "", formatEquipmentHours: () => "",
    setEditor() {}, setTimesheetEditor() {},
  };
  const parser = variant.code.has("parseEquipmentClipboardHours") ? js(variant.code.get("parseEquipmentClipboardHours")) : "";
  const save = new Function(...Object.keys(scope), `${parser}${js(variant.code.get(variant.save))}; return ${variant.save};`)(...Object.values(scope));
  const handlerScope = { ...scope, [variant.save]: save };
  const eligibility = variant.code.has("canAddTimesheetMark") ? js(variant.code.get("canAddTimesheetMark")) : "";
  const open = new Function(...Object.keys(handlerScope), `${eligibility}${js(variant.code.get(variant.open))}; return ${variant.open};`)(...Object.values(handlerScope));
  const callbacks = Object.fromEntries(["onBlur", "onKeyDown"].map(name => [name,
    new Function(...Object.keys(handlerScope), `${js(`const callback = ${variant.code.get(name)};`)}; return callback;`)(...Object.values(handlerScope)),
  ]));
  function dispatch(type, key) {
    const input = new EventTarget();
    input.value = value;
    input.addEventListener(type, event => callbacks[type === "blur" ? "onBlur" : "onKeyDown"](event));
    input.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { key }));
  }
  async function settled() {
    if (inFlight.current) await inFlight.current.promise;
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }
  return { state, refs, save, open, dispatch, settled };
}

for (const variant of variants) {
  test(`${variant.name}: the actual blur handler saves a valid buffer before closing`, async () => {
    const env = harness(variant);
    env.dispatch("blur");
    await env.settled();
    assert.equal(env.state.writes, 1);
    assert.equal(env.state.editor, null);
    assert.equal(env.state.focus, 0, "Blur must not steal focus back from the target cell");
  });

  test(`${variant.name}: invalid blur and attempted new editor preserve the original buffer and error`, async () => {
    const env = harness(variant, "99");
    env.dispatch("blur");
    await env.settled();
    assert.equal(env.state.editor.value, "99");
    assert.ok(env.state.editor.error);
    await env.open(2, "2026-11-02", 1, 1);
    assert.equal(env.state.editor.session, 4);
    assert.equal(env.state.editor.value, "99");
    assert.equal(env.state.writes, 0);
  });

  test(`${variant.name}: an API error keeps the value available for correction after blur`, async () => {
    const env = harness(variant, "8", "failure");
    env.dispatch("blur");
    await env.settled();
    assert.equal(env.state.editor.value, "8");
    assert.equal(env.state.editor.error, "Synthetic API failure");
  });

  test(`${variant.name}: Enter followed by blur shares one write; a late response cannot close a reopened cell`, async () => {
    const env = harness(variant, "8", "pending");
    env.dispatch("keydown", "Enter");
    env.dispatch("blur");
    assert.equal(env.state.writes, 1);
    const reopened = { ...env.state.editor, session: 5, value: "9" };
    env.refs.inlineSession.current = 5;
    env.state.editor = reopened;
    env.state.waiting[0].resolve();
    await env.settled();
    assert.equal(env.state.editor, reopened);
    assert.equal(env.state.editor.value, "9");
  });

  test(`${variant.name}: Escape cancels explicitly and its ensuing blur never saves`, async () => {
    const env = harness(variant, "99");
    env.dispatch("keydown", "Escape");
    env.dispatch("blur");
    await env.settled();
    assert.equal(env.state.editor, null);
    assert.equal(env.state.writes, 0);
  });
}

for (const variant of variants) {
test(`${variant.name}: invalid arrow-key movement keeps the editor instead of discarding it`, async () => {
  const env = harness(variant, "99");
  env.dispatch("keydown", "ArrowRight");
  await env.settled();
  assert.equal(env.state.editor.value, "99");
  assert.ok(env.state.editor.error);
  assert.equal(env.state.moves, 0);
  assert.equal(env.state.writes, 0);
});

test(`${variant.name}: completing an edit after day filters change does not move selection into a different date`, async () => {
  const env = harness(variant, "8", "pending");
  env.dispatch("keydown", "ArrowRight");
  assert.equal(env.state.writes, 1);
  env.refs.clipboardViewScope.current = "1:2026-11:1:days=6";
  env.state.waiting[0].resolve();
  await env.settled();
  assert.equal(env.state.editor, null);
  assert.equal(env.state.moves, 0);
});

test(`${variant.name}: arrow navigation waits for acknowledgement and writes once when blur follows`, async () => {
  const env = harness(variant, "8", "pending");
  env.dispatch("keydown", "ArrowDown");
  env.dispatch("blur");
  assert.equal(env.state.writes, 1);
  assert.equal(env.state.moves, 0);
  env.state.waiting[0].resolve(); await env.settled();
  assert.equal(env.state.editor, null);
  assert.equal(env.state.moves, 1);
});
}

for (const [value, productiveHours, downtimeHours] of [["0", 0, 0], ["П 2", 0, 2], ["8/2", 8, 2]]) {
  test(`equipment: arrow completion preserves productive/downtime semantics for ${value}`, async () => {
    const env = harness(variants[0], value);
    env.dispatch("keydown", "ArrowRight"); await env.settled();
    assert.equal(env.state.moves, 1);
    assert.deepEqual(env.state.persisted[0][1], { clear: false, productiveHours, downtimeHours, note: "" });
  });
}

for (const [key, target] of [["ArrowLeft", [0, -1]], ["ArrowRight", [0, 1]], ["ArrowUp", [-1, 0]], ["ArrowDown", [1, 0]]]) {
  test(`equipment: ${key} uses the edited visible row and date coordinates`, async () => {
    const env = harness(variants[0]); env.dispatch("keydown", key); await env.settled();
    assert.deepEqual(env.state.moveTargets, [target]);
  });
}
