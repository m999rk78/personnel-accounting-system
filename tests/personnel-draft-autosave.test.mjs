import assert from "node:assert/strict";
import test from "node:test";
import { createPersonnelDraftAutosave, parsePersonnelDraftCache, personnelDraftContentKey, personnelDraftStorageKey, PersonnelDraftConflict, reconcilePersonnelDraftCache } from "../app/personnelDraftAutosave.ts";

const scope = { userId: 10, siteId: 7 };
const empty = { edits: {}, sessions: {}, importBatches: [] };
const row = (note = "") => ({ key: "employee-1", employeeId: "1", employeeQuery: "Сотрудник 1", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", masterId: "", hours: "", note });
const content = note => ({ edits: { "new:2026-11-06": [row(note)] }, sessions: {}, importBatches: [] });
const snapshot = note => ({ ...scope, ...content(note), version: 1, savedAt: "2026-11-06T08:00:00.000Z" });
const cache = (note, baseRevision = 2, synced = false) => ({ ...scope, version: 1, baseRevision, synced, snapshot: note === null ? null : snapshot(note) });
const copy = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
function memoryStorage(initial) {
  const entries = new Map(initial ? [[personnelDraftStorageKey(scope.userId, scope.siteId), JSON.stringify(initial)]] : []);
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}
function harness({ initial, transport, storage = memoryStorage(initial) } = {}) {
  let server = { revision: 0, snapshot: null }, restored;
  const writes = [];
  const api = transport ?? (async (method, body) => {
    if (method === "GET") return copy(server);
    writes.push(copy(body));
    if (body.revision !== server.revision) throw new PersonnelDraftConflict(copy(server));
    server = { revision: server.revision + 1, snapshot: copy(body.snapshot) };
    return copy(server);
  });
  const controller = createPersonnelDraftAutosave({ ...scope, storage, transport: api, delay: 60_000, onRestore: value => { restored = value; } });
  return { controller, storage, writes, server: () => server, restored: () => restored,
    async start() { controller.activate(); await settle(); controller.updateContent(restored ?? empty); },
    savedCache() { return parsePersonnelDraftCache(storage.getItem(personnelDraftStorageKey(scope.userId, scope.siteId)), scope.userId, scope.siteId); } };
}

test("draft recovery validates identity and never shares another user's or project's browser data", () => {
  const raw = JSON.stringify(cache("Обед"));
  assert.equal(parsePersonnelDraftCache(raw, 11, 7), null);
  assert.equal(parsePersonnelDraftCache(raw, 10, 8), null);
  assert.equal(parsePersonnelDraftCache("broken", 10, 7), null);
  assert.equal(parsePersonnelDraftCache(JSON.stringify({ ...cache("test"), baseRevision: -1 }), 10, 7), null);
  assert.equal(parsePersonnelDraftCache(raw, 10, 7).snapshot.edits["new:2026-11-06"][0].note, "Обед");
  assert.notEqual(personnelDraftStorageKey(10, 7), personnelDraftStorageKey(11, 7));
  assert.notEqual(personnelDraftStorageKey(10, 7), personnelDraftStorageKey(10, 8));
});

test("content equality ignores saved timestamps and object property order but includes raw invalid cells", () => {
  const first = snapshot("До перерыва"), second = { savedAt: "2026-11-06T10:00:00Z", importBatches: [], sessions: {}, edits: first.edits };
  assert.equal(personnelDraftContentKey(first), personnelDraftContentKey(second));
  assert.notEqual(personnelDraftContentKey(first), personnelDraftContentKey({ ...first, edits: { "new:2026-11-06": [{ ...row(), inputValues: { hours: "ошибка" } }] } }));
});

test("recovery chooses pending local changes only at their original server revision", () => {
  assert.equal(reconcilePersonnelDraftCache(cache("Мой ввод", 2), { revision: 2, snapshot: snapshot("Старая версия") }).snapshot.edits["new:2026-11-06"][0].note, "Мой ввод");
  assert.equal(reconcilePersonnelDraftCache(cache("Мой ввод", 2), { revision: 3, snapshot: snapshot("Другой компьютер") }).conflict, true);
  assert.equal(reconcilePersonnelDraftCache(cache("Мой ввод", 2, true), { revision: 3, snapshot: snapshot("Другой компьютер") }).snapshot.edits["new:2026-11-06"][0].note, "Другой компьютер");
  assert.equal(reconcilePersonnelDraftCache(cache("Ответ потерян", 2), { revision: 3, snapshot: snapshot("Ответ потерян") }).conflict, false);
  assert.equal(reconcilePersonnelDraftCache(cache("Новый ввод", null), { revision: 0, snapshot: null }).conflict, false);
  assert.equal(reconcilePersonnelDraftCache(cache("Устарело", 2), { revision: 3, snapshot: null }).conflict, true, "a server tombstone is not permission to resurrect stale work");
});

test("incomplete and invalid cells are cached immediately, then saved without canonical report submission", async t => {
  const h = harness(); t.after(() => h.controller.deactivate()); await h.start();
  const current = { edits: { "new:2026-11-06": [{ ...row("Незакончено"), hours: "abc", inputValues: { hours: "abc" } }] }, sessions: {}, importBatches: [] };
  h.controller.updateContent(current);
  assert.equal(h.controller.getSnapshot().protected, true);
  assert.equal(h.savedCache().synced, false);
  assert.equal(h.savedCache().snapshot.edits["new:2026-11-06"][0].hours, "abc");
  await h.controller.flush();
  assert.equal(h.controller.getSnapshot().status, "saved");
  assert.equal(h.writes.length, 1);
  assert.equal(h.server().snapshot.edits["new:2026-11-06"][0].inputValues.hours, "abc");
});

test("typing while a save is in flight keeps the latest text and advances its optimistic base", async t => {
  let resolveWrite, server = { revision: 0, snapshot: null }; const writes = [];
  const h = harness({ transport: async (method, body) => {
    if (method === "GET") return server;
    writes.push(copy(body));
    if (writes.length === 1) return new Promise(resolve => { resolveWrite = () => { server = { revision: 1, snapshot: copy(body.snapshot) }; resolve(server); }; });
    assert.equal(body.revision, server.revision);
    server = { revision: server.revision + 1, snapshot: copy(body.snapshot) }; return server;
  } });
  t.after(() => h.controller.deactivate()); await h.start();
  h.controller.updateContent(content("Первый текст")); const sending = h.controller.flush();
  h.controller.updateContent(content("Дополнено во время запроса"));
  resolveWrite(); await sending;
  assert.equal(h.savedCache().baseRevision, 1);
  assert.equal(h.savedCache().synced, false);
  assert.equal(h.savedCache().snapshot.edits["new:2026-11-06"][0].note, "Дополнено во время запроса");
  await h.controller.flush();
  assert.equal(writes.length, 2); assert.equal(writes[1].revision, 1);
  assert.equal(server.snapshot.edits["new:2026-11-06"][0].note, "Дополнено во время запроса");
  assert.equal(h.controller.getSnapshot().status, "saved");
});

test("offline reload restores the local draft and retry never silently rebases onto another device", async t => {
  let offline = true, puts = 0;
  const h = harness({ initial: cache("Мой ввод", 2), transport: async (method) => {
    if (offline) throw new Error("Offline");
    if (method === "PUT") { puts++; throw new Error("Unexpected overwrite"); }
    return { revision: 3, snapshot: snapshot("Другой компьютер") };
  } });
  t.after(() => h.controller.deactivate()); await h.start();
  assert.equal(h.restored().edits["new:2026-11-06"][0].note, "Мой ввод");
  assert.equal(h.savedCache().baseRevision, 2, "loading offline must preserve the original optimistic base");
  assert.equal(h.controller.getSnapshot().status, "local");
  offline = false; h.controller.retry(); await settle();
  assert.equal(h.controller.getSnapshot().status, "conflict");
  assert.equal(h.savedCache().baseRevision, 2, "a conflict must survive a browser reload");
  await h.controller.flush(); assert.equal(puts, 0);
  h.controller.acceptServer();
  assert.equal(h.restored().edits["new:2026-11-06"][0].note, "Другой компьютер");
});

test("a lost acknowledgement is recognized by content, while a real conflict needs an explicit choice", async t => {
  let server = { revision: 0, snapshot: null }, failAck = true;
  const h = harness({ transport: async (method, body) => {
    if (method === "GET") return server;
    if (body.revision !== server.revision) throw new PersonnelDraftConflict(copy(server));
    server = { revision: server.revision + 1, snapshot: copy(body.snapshot) };
    if (failAck) { failAck = false; throw new Error("Reply lost after commit"); }
    return server;
  } });
  t.after(() => h.controller.deactivate()); await h.start();
  h.controller.updateContent(content("Сохранено, но ответ потерян")); await h.controller.flush();
  assert.equal(h.controller.getSnapshot().status, "local");
  await h.controller.flush(); assert.equal(h.controller.getSnapshot().status, "saved");
  h.controller.updateContent(content("Моя следующая версия")); server = { revision: server.revision + 1, snapshot: snapshot("Другая вкладка") };
  await h.controller.flush(); assert.equal(h.controller.getSnapshot().status, "conflict");
  h.controller.keepLocal(); await settle();
  assert.equal(server.snapshot.edits["new:2026-11-06"][0].note, "Моя следующая версия");
  assert.equal(h.controller.getSnapshot().status, "saved");
});

test("opening an already synced draft offline does not turn it into a conflicting local edit", async t => {
  let offline = true;
  const h = harness({ initial: cache("Вчера сохранено", 2, true), transport: async () => {
    if (offline) throw new Error("Offline");
    return { revision: 3, snapshot: snapshot("Обновлено с другого компьютера") };
  } });
  t.after(() => h.controller.deactivate()); await h.start();
  assert.equal(h.savedCache().synced, true);
  offline = false; h.controller.retry(); await settle();
  assert.notEqual(h.controller.getSnapshot().status, "conflict");
  assert.equal(h.restored().edits["new:2026-11-06"][0].note, "Обновлено с другого компьютера");
});

test("manual save cleanup persists a versioned empty tombstone so old drafts do not return", async t => {
  const h = harness(); t.after(() => h.controller.deactivate()); await h.start();
  h.controller.updateContent(content("Черновик")); await h.controller.flush();
  h.controller.updateContent(empty); await h.controller.flush();
  assert.deepEqual(h.server(), { revision: 2, snapshot: null });
  assert.equal(h.savedCache().snapshot, null);
  assert.equal(h.savedCache().synced, true);
});

test("unavailable local storage keeps navigation protected only after a successful server save", async t => {
  const h = harness({ storage: { getItem: () => null, setItem() { throw new Error("Quota"); } } });
  t.after(() => h.controller.deactivate()); await h.start();
  h.controller.updateContent(content("Не закрывать до сохранения"));
  assert.equal(h.controller.getSnapshot().protected, false);
  assert.equal(h.controller.getSnapshot().status, "error");
  await h.controller.flush();
  assert.equal(h.controller.getSnapshot().protected, true);
  assert.equal(h.controller.getSnapshot().status, "saved");
});

test("two offline tabs cannot both claim protection after replacing the shared local recovery copy", async t => {
  const storage = memoryStorage();
  const transport = async method => { if (method === "GET") return { revision: 0, snapshot: null }; throw new Error("Offline"); };
  const first = harness({ storage, transport }), second = harness({ storage, transport });
  t.after(() => { first.controller.deactivate(); second.controller.deactivate(); });
  await first.start(); await second.start();
  first.controller.updateContent(content("Первая вкладка"));
  assert.equal(first.controller.getSnapshot().protected, true);
  second.controller.updateContent(content("Вторая вкладка"));
  first.controller.refreshLocalProtection();
  assert.equal(first.controller.getSnapshot().protected, false);
  assert.equal(first.controller.getSnapshot().status, "error");
  assert.equal(second.controller.getSnapshot().protected, true);
  assert.equal(first.savedCache().snapshot.edits["new:2026-11-06"][0].note, "Вторая вкладка");
  // Checking protection must not start a last-writer-wins fight between tabs.
  first.controller.refreshLocalProtection();
  assert.equal(second.savedCache().snapshot.edits["new:2026-11-06"][0].note, "Вторая вкладка");
});

test("a replaced local cache does not invalidate a draft already acknowledged by the server", async t => {
  const h = harness(); t.after(() => h.controller.deactivate()); await h.start();
  h.controller.updateContent(content("На сервере")); await h.controller.flush();
  h.storage.setItem(personnelDraftStorageKey(10, 7), JSON.stringify(cache("Другая вкладка", 1)));
  h.controller.refreshLocalProtection();
  assert.equal(h.controller.getSnapshot().protected, true);
  assert.equal(h.controller.getSnapshot().status, "saved");
});

test("unrelated parent renders do not postpone the autosave debounce", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let restored, writes = 0;
  const controller = createPersonnelDraftAutosave({ ...scope, storage: memoryStorage(), delay: 1000,
    onRestore: value => { restored = value; }, transport: async (method, body) => {
      if (method === "GET") return { revision: 0, snapshot: null };
      writes++; return { revision: writes, snapshot: body.snapshot };
    } });
  t.after(() => controller.deactivate());
  controller.activate(); await settle(); controller.updateContent(restored ?? empty);
  controller.updateContent(content("Работа"));
  t.mock.timers.tick(600); controller.updateContent(copy(content("Работа")));
  t.mock.timers.tick(400); await settle();
  assert.equal(writes, 1, "the unchanged render at600ms must not restart the1000ms timer");
  assert.equal(controller.getSnapshot().status, "saved");
});
