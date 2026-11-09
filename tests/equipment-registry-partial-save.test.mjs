import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { validateEquipmentRegistryDrafts } from "../app/equipmentDirectorySpreadsheet.ts";

const source = ts.createSourceFile("EquipmentAccountingView.tsx", await readFile(new URL("../app/EquipmentAccountingView.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let save;
function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "saveUnits") save = node; ts.forEachChild(node, visit); }
visit(source); assert.ok(save);
const implementation = ts.transpileModule(save.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const draft = (key, overrides = {}) => ({ key, organization: "Подрядчик", equipmentType: "Кран", brand: "SANY", model: `Модель ${key}`, registrationNumber: `ТЕСТ-${key}`, note: "Введённое примечание", projectSiteId: "1", ...overrides });
function harness(initial = [draft("first"), draft("second")]) {
  const sites = [{ id: 1, name: "Проект" }], writes = [], reads = [], saved = [], errors = [];
  const state = { unitDrafts: initial, unitFullRowEditIds: initial.flatMap(row => row.id ? [row.id] : []), loading: false, saving: false, importing: false,
    payload: { canCreateRegistry: true, canUpdateRegistry: false, currentUserRole: "superadmin", units: [], sites }, visible: [1], notice: "", reloads: 0, failKey: "second", refreshFails: false };
  const setter = field => next => { state[field] = typeof next === "function" ? next(state[field]) : next; };
  const post = async body => {
    writes.push({ ...body });
    if (body.key === state.failKey) throw new Error("Ошибка второй строки");
    saved.push({ id: saved.length + 1, ...body });
  };
  const fetch = async (url, options) => {
    reads.push({ url, ...options });
    if (state.refreshFails) throw new Error("Не удалось обновить снимок");
    return { status: 200, ok: true, json: async () => ({ ...state.payload, units: [...saved] }) };
  };
  return { state, writes, reads, saved, errors, async save() {
    // Each React render captures a fixed draft snapshot; setters publish to the
    // next render, so a later retry sees only the remaining failed rows.
    const environment = { ...state, siteId: 1, workDate: "2026-11-09", month: "2026-11", currentUserProjectAccess: undefined,
      accessibleProjectIds: () => null, validateEquipmentRegistryDrafts, post, fetch, window: { location: { replace() {} } },
      setUnitDrafts: setter("unitDrafts"), setUnitFullRowEditIds: setter("unitFullRowEditIds"), setSaving: setter("saving"),
      setPayload: setter("payload"), setVisibleUnitIds: setter("visible"), setNotice: setter("notice"),
      setError: value => errors.push(value), reload: () => state.reloads++ };
    const run = new Function(...Object.keys(environment), `${implementation}; return saveUnits;`)(...Object.values(environment));
    await run();
  } };
}

test("partial registry save removes only acknowledged creates and retries the failed input without requiring update permission", async () => {
  const ui = harness();
  await ui.save();
  assert.deepEqual(ui.writes.map(row => row.key), ["first", "second"]);
  assert.deepEqual(ui.state.unitDrafts.map(row => row.key), ["second"]);
  assert.equal(ui.state.unitDrafts[0].note, "Введённое примечание");
  assert.equal(ui.state.payload.units.length, 1, "the first confirmed create is re-read from the server");
  assert.equal(ui.state.saving, false); assert.equal(ui.errors.at(-1), "Ошибка второй строки");
  assert.equal(ui.reads.length, 1); assert.match(ui.reads[0].url, /scope=global&view=registry&section=registry/);
  assert.equal(ui.reads[0].cache, "no-store");
  ui.state.failKey = null;
  await ui.save();
  assert.deepEqual(ui.writes.map(row => row.key), ["first", "second", "second"], "a create-only user never replays the confirmed first row");
  assert.deepEqual(ui.state.unitDrafts, []); assert.equal(ui.state.reloads, 1);
});

test("failed snapshot refresh keeps the last readable data, failed draft and original save error", async () => {
  const ui = harness([draft("first", { id: 5 }), draft("second", { id: 6 })]);
  ui.state.payload.canUpdateRegistry = true; ui.state.refreshFails = true;
  const original = ui.state.payload;
  await ui.save();
  assert.equal(ui.state.payload, original);
  assert.deepEqual(ui.state.unitDrafts.map(row => row.id), [6]);
  assert.deepEqual(ui.state.unitFullRowEditIds, [6]);
  assert.equal(ui.errors.at(-1), "Ошибка второй строки");
  assert.equal(ui.state.saving, false);
});

test("loading, concurrent saves and imports cannot start a registry write or recovery GET", async () => {
  for (const flag of ["loading", "saving", "importing"]) {
    const ui = harness(); ui.state[flag] = true;
    await ui.save();
    assert.deepEqual(ui.writes, [], flag); assert.deepEqual(ui.reads, [], flag);
    assert.equal(ui.state.unitDrafts.length, 2);
  }
});
