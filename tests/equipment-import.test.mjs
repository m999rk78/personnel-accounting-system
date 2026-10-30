import assert from "node:assert/strict";
import test from "node:test";
import { equipmentExcelName } from "../app/equipmentExcel.ts";
import { assertUniqueEquipmentImportIdentities, equipmentImportIndex, equipmentRegistryProjectIndex, matchEquipmentImportUnit, normalizeEquipmentImportRows, planEquipmentImport, resolveEquipmentRegistryProject } from "../app/equipmentImport.ts";
import { importEquipmentEntries } from "../app/equipmentImportServer.ts";

const unit = (id, overrides = {}) => ({ id, siteId: 1, active: 1, organization: "ООО Техника", equipmentType: "Кран", brand: "SANY", model: "STC250", registrationNumber: "А 001", ...overrides });
const input = (overrides = {}) => ({ workDate: "2026-10-01", equipmentName: equipmentExcelName(unit(1)), shiftName: "День", zoneName: "Новая зона", mainWorkTypeName: "Вспомогательные", subworkTypeName: "Перевозка", note: "", hours: "8", ...overrides });
const actor = { id: 7, fullName: "Прораб", role: "foreman" };
const references = () => ({
  units: [unit(1)],
  shifts: [{ id: 1, siteId: 1, name: "День", active: 1 }],
  mainWorkTypes: [{ id: 1, siteId: 1, name: "Вспомогательные", active: 1 }],
  subworkTypes: [{ id: 1, siteId: 1, name: "Перевозка", mainWorkTypeId: 1, active: 1 }],
});

test("registry imports reject repeated equipment and ambiguous project names instead of last-row wins", () => {
  const projects = equipmentRegistryProjectIndex([{ id: 1, name: "Проект" }, { id: 2, name: " ПРОЕКТ " }, { id: 3, name: "Уникальный" }]);
  assert.throws(() => resolveEquipmentRegistryProject(projects, "Проект", true), /неоднозначно/);
  assert.equal(resolveEquipmentRegistryProject(projects, " уникальный ", true), 3);
  assert.equal(resolveEquipmentRegistryProject(projects, "", true), null);
  assert.equal(resolveEquipmentRegistryProject(projects, "Без проекта", true), null);
  assert.equal(resolveEquipmentRegistryProject(projects, undefined, false), undefined);
  assert.throws(() => resolveEquipmentRegistryProject(projects, {}, true), /текстом/);
  assert.throws(() => resolveEquipmentRegistryProject(projects, "Нет проекта", true), /не найден/);
  assert.throws(() => assertUniqueEquipmentImportIdentities([{ identityKey: "грз:001" }, { identityKey: "грз:002" }, { identityKey: "грз:001" }]), /Строка 3:.*в строке 1/);
  assert.doesNotThrow(() => assertUniqueEquipmentImportIdentities([{ identityKey: "грз:001" }, { identityKey: "грз:002" }]));
});

test("matches the full equipment identity and never the last duplicate registration", () => {
  const a = unit(1);
  const b = unit(2, { organization: "Другая организация" });
  const index = equipmentImportIndex([a, b]);
  assert.equal(matchEquipmentImportUnit(index, equipmentExcelName(a)).id, 1);
  assert.equal(matchEquipmentImportUnit(index, equipmentExcelName(b)).id, 2);
  assert.equal(matchEquipmentImportUnit(index, " кран // sany stc250 // А001 // ооо техника ").id, 1);
  assert.throws(() => matchEquipmentImportUnit(index, "Экскаватор // CAT 320 // А001 // ООО Техника"), /полным наименованием не найдена/);
  assert.throws(() => matchEquipmentImportUnit(index, "А001"), /полным наименованием не найдена/);
  assert.throws(() => matchEquipmentImportUnit(equipmentImportIndex([a, { ...a, id: 3 }]), equipmentExcelName(a)), /неоднозначно/);
});

test("retains legacy model-only full names and long canonical names without truncation", () => {
  const long = unit(1, { equipmentType: "Т".repeat(120), brand: "Б".repeat(120), model: "М".repeat(180), registrationNumber: "", organization: "О".repeat(120) });
  const identifier = equipmentExcelName(long);
  assert.ok(identifier.length > 400);
  const normalized = normalizeEquipmentImportRows([input({ equipmentName: identifier })]);
  assert.equal(normalized[0].equipmentName, identifier);
  assert.equal(matchEquipmentImportUnit(equipmentImportIndex([long]), identifier).id, 1);
  assert.equal(matchEquipmentImportUnit(equipmentImportIndex([unit(1)]), "Кран // STC250 // А001 // ООО Техника").id, 1);
  const noNumber = unit(4, { registrationNumber: "" });
  assert.equal(matchEquipmentImportUnit(equipmentImportIndex([noNumber]), equipmentExcelName({ ...noNumber, registrationNumber: "—" })).id, 4);
});

test("validates actual calendar dates, hours and text strictly without coercion or truncation", () => {
  for (const workDate of ["2026-02-31", "1900-02-29", "2026-04-31", "0000-01-01", "2026-10-01garbage"]) {
    assert.throws(() => normalizeEquipmentImportRows([input({ workDate })]), /Строка 1:/);
  }
  assert.equal(normalizeEquipmentImportRows([input({ workDate: "2000-02-29" })])[0].workDate, "2000-02-29");
  for (const hours of [true, {}, "", "1e1", "8.5", 0, 11, 1.5, null]) assert.throws(() => normalizeEquipmentImportRows([input({ hours })]), /от 1 до 10/);
  assert.equal(normalizeEquipmentImportRows([input({ hours: 10 })])[0].hours, 10);
  assert.throws(() => normalizeEquipmentImportRows([input({ zoneName: "З".repeat(241) })]), /до 240/);
  assert.throws(() => normalizeEquipmentImportRows([input({ note: "П".repeat(501) })]), /до 500/);
  assert.throws(() => normalizeEquipmentImportRows([input({ equipmentName: {} })]), /текстом/);
  assert.throws(() => normalizeEquipmentImportRows([]), /от 1 до 5000/);
  assert.throws(() => normalizeEquipmentImportRows([null]), /Строка 1/);
});

test("plans scoped parent-child work references and rejects ambiguous dictionary names", () => {
  const refs = references();
  refs.subworkTypes.push({ id: 2, name: "Перевозка", mainWorkTypeId: 2 });
  const planned = planEquipmentImport(normalizeEquipmentImportRows([input()]), refs);
  assert.equal(planned[0].subworkTypeId, 1);
  assert.throws(() => planEquipmentImport(normalizeEquipmentImportRows([input()]), { ...refs, subworkTypes: refs.subworkTypes.slice(1) }), /Строка 1: Подвид работы выбранного вида/);
  assert.throws(() => planEquipmentImport(normalizeEquipmentImportRows([input()]), { ...refs, shifts: [...refs.shifts, { id: 3, name: "  ДЕНЬ " }] }), /Смена.*неоднозначен/);
  assert.throws(() => planEquipmentImport(normalizeEquipmentImportRows([input(), input({ shiftName: "Нет такой смены" })]), refs), /Строка 2:/);
});

function memoryDatabase(overrides = {}) {
  let state = { ...references(), sites: [{ id: 1, active: 1 }], zones: [], entries: [], marks: [], contributions: [], nextId: 100, ...overrides };
  const calls = [];
  let inTransaction = false;
  let transactions = 0;
  function execute(sql, values) {
    assert.equal(inTransaction, true, "all reads and writes belong to the same transaction");
    const query = sql.replace(/\s+/g, " ").trim();
    calls.push({ query, values });
    if (query.includes("pg_advisory_xact_lock")) return [];
    if (query.startsWith("SELECT id FROM sites")) return state.sites.filter((site) => site.id === values[0] && site.active === 1);
    if (query.includes("FROM equipment_units eu")) return state.units.filter((row) => row.siteId === values[0] && row.active === 1);
    for (const [table, key] of [["shifts", "shifts"], ["main_work_types", "mainWorkTypes"], ["subwork_types", "subworkTypes"], ["zones", "zones"]]) {
      if (query.includes(`FROM ${table} WHERE site_id`)) return state[key].filter((row) => row.siteId === values[0] && (table === "zones" || row.active === 1));
    }
    if (query.startsWith("UPDATE zones SET active")) {
      const zone = state.zones.find((row) => row.id === values[0] && row.siteId === values[1]);
      if (zone) zone.active = 1;
      return [];
    }
    if (query.startsWith("INSERT INTO zones")) {
      const row = { id: state.nextId++, siteId: values[0], name: values[1], active: 1 };
      state.zones.push(row);
      return [{ id: row.id }];
    }
    if (query.startsWith("SELECT id FROM equipment_entries")) {
      return state.entries.filter((row) => [row.siteId, row.workDate, row.equipmentId, row.shiftId, row.zoneId, row.mainWorkTypeId, row.subworkTypeId, row.note, row.hours].every((value, index) => value === values[index]) && !row.deletedAt);
    }
    if (query.includes("FROM equipment_timesheet_marks")) return state.marks.filter((row) => row.siteId === values[0] && row.equipmentId === values[1] && row.workDate === values[2] && row.productiveHours === 0 && row.downtimeHours > 0);
    if (query.startsWith("SELECT COALESCE(SUM(hours)")) return [{ hours: state.entries.filter((row) => row.siteId === values[0] && row.workDate === values[1] && row.equipmentId === values[2] && !row.deletedAt).reduce((sum, row) => sum + row.hours, 0) }];
    if (query.startsWith("INSERT INTO equipment_entries")) {
      const fields = ["siteId", "workDate", "equipmentId", "shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId", "note", "hours", "createdBy", "responsibleUserId", "createdByUserId", "updatedByUserId"];
      state.entries.push({ id: state.nextId++, ...Object.fromEntries(fields.map((key, index) => [key, values[index]])) });
      return [];
    }
    throw new Error(`Unexpected query: ${query}`);
  }
  const executor = { prepare(sql) { return { bind(...values) { return {
    async all() { return { results: execute(sql, values) }; },
    async first() { return execute(sql, values)[0] ?? null; },
    async run() { execute(sql, values); return { meta: { changes: 1 } }; },
  }; } }; } };
  return {
    calls,
    get state() { return state; },
    get transactions() { return transactions; },
    async transaction(callback) {
      assert.equal(inTransaction, false);
      transactions += 1;
      const before = structuredClone(state);
      inTransaction = true;
      try { return await callback(executor); }
      catch (error) { state = before; throw error; }
      finally { inTransaction = false; }
    },
  };
}

test("imports zones and entries atomically, preserving metadata and skipping repeats", async () => {
  const db = memoryDatabase();
  const touch = async (_transaction, dates) => db.state.contributions.push(...dates);
  assert.deepEqual(await importEquipmentEntries(db, 1, [input(), input()], actor, touch), { imported: 1, skipped: 1 });
  assert.equal(db.transactions, 1);
  assert.equal(db.state.zones.length, 1);
  assert.equal(db.state.entries.length, 1);
  assert.equal(db.state.entries[0].responsibleUserId, 7);
  assert.equal(db.state.entries[0].createdByUserId, 7);
  assert.deepEqual(db.state.contributions, ["2026-10-01"]);
  const saved = structuredClone(db.state);
  assert.deepEqual(await importEquipmentEntries(db, 1, [input()], actor, touch), { imported: 0, skipped: 1 });
  assert.deepEqual(db.state, saved, "an unchanged import must not reopen a submitted contribution");
  assert.deepEqual(await importEquipmentEntries(db, 1, [input({ zoneName: "  НОВАЯ   ЗОНА ", note: "Другая работа" })], actor), { imported: 1, skipped: 0 });
  assert.equal(db.state.zones.length, 1, "normalization reuses the existing zone");
});

test("invalid references, dates or duplicate identities never create or reactivate zones", async () => {
  for (const [changes, badInput, expected] of [
    [{}, input({ shiftName: "Неизвестная" }), /не найден/],
    [{}, input({ workDate: "2026-02-31" }), /календарная дата/],
    [{ units: [unit(1), unit(2)] }, input(), /неоднозначно/],
    [{ units: [unit(1, { siteId: 2 })] }, input(), /не найдена/],
  ]) {
    const db = memoryDatabase({ zones: [{ id: 9, siteId: 1, name: "Новая зона", active: 0 }], ...changes });
    const before = structuredClone(db.state);
    await assert.rejects(importEquipmentEntries(db, 1, [badInput], actor), expected);
    assert.deepEqual(db.state, before);
  }
});

test("a later timesheet conflict rolls back earlier entries, created zones and reactivation", async () => {
  const db = memoryDatabase({
    units: [unit(1), unit(2, { registrationNumber: "002" })],
    zones: [{ id: 9, siteId: 1, name: "Архивная зона", active: 0 }],
    marks: [{ siteId: 1, equipmentId: 2, workDate: "2026-10-01", productiveHours: 0, downtimeHours: 8, note: "Ремонт" }],
  });
  const before = structuredClone(db.state);
  await assert.rejects(importEquipmentEntries(db, 1, [input({ zoneName: "Архивная зона" }), input({ equipmentName: equipmentExcelName(unit(2, { registrationNumber: "002" })) })], actor), /Строка 2: техника недоступна.*Ремонт/);
  assert.ok(db.calls.some(({ query }) => query.startsWith("INSERT INTO equipment_entries")), "failure occurred after an earlier insert");
  assert.deepEqual(db.state, before);
});

test("day totals include every imported row and a late limit failure rolls the whole file back", async () => {
  const db = memoryDatabase();
  const before = structuredClone(db.state);
  await assert.rejects(importEquipmentEntries(db, 1, [input({ hours: 10, note: "Один" }), input({ hours: 10, note: "Два" }), input({ hours: 1, note: "Три" })], actor), /Строка 3:.*не более 20/);
  assert.deepEqual(db.state, before);
  assert.deepEqual(await importEquipmentEntries(db, 1, [input({ hours: 10, note: "Один" }), input({ hours: 10, note: "Два" })], actor), { imported: 2, skipped: 0 });
  assert.equal(db.state.entries.reduce((sum, entry) => sum + entry.hours, 0), 20);
});

test("contribution failures roll back all entries and newly created zones", async () => {
  const db = memoryDatabase();
  const before = structuredClone(db.state);
  await assert.rejects(importEquipmentEntries(db, 1, [input()], actor, async () => { throw new Error("Не удалось обновить отчёт"); }), /Не удалось обновить/);
  assert.deepEqual(db.state, before);
});
