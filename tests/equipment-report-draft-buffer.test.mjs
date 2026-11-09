import assert from "node:assert/strict";
import { after, test } from "node:test";
import { parseEquipmentReportDraftSnapshot } from "../app/equipmentReportDraftBuffer.ts";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const dataUrl = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const store = await import(await compileModuleGraph(new URL("../app/equipmentReportDraftBufferStore.ts", import.meta.url)));
const time = "2026-11-06T09:00:00.000Z";
const actor = (patch = {}) => ({ id: 10, role: "foreman", fullName: "Прораб", assignedSiteId: 7,
  projectAccess: { mode: "selected", siteIds: [7, 8] }, permissions: rolePermissionTemplate(patch.role ?? "foreman"), ...patch });
const draft = (index = 1) => ({ key: `row-${index}`, equipmentId: String(index), equipmentQuery: `Техника ${index}`, shiftId: "", zoneId: "", mainWorkTypeId: "",
  subworkTypeId: "", hours: "", note: "", createdAt: time, updatedAt: time });
const snapshot = (userId = 10, siteId = 7) => ({ version: 1, userId, siteId, savedAt: time,
  edits: { "new:2026-11-06": Array.from({ length: 10 }, (_, index) => draft(index + 1)) }, sessions: {}, importBatches: [] });
const session = () => ({ id: 18, siteId: 7, workDate: "2026-11-05", ownerUserId: 10, ownerName: "Прораб", status: "draft", revision: 2,
  submittedAt: null, reviewedAt: null, reviewedByUserId: null, reviewedByName: null, reviewComment: "", createdAt: time, updatedAt: time, rows: [] });

/** In-memory SQL boundary. Every unexpected query fails; no real database exists. */
function database() {
  const values = new Map(), queries = [];
  const db = { values, queries, active: true,
    prepare(sql) {
      let params = [];
      const execute = () => {
        queries.push({ sql, params });
        if (sql.includes("FROM sites WHERE")) return db.active ? { id: params[0] } : null;
        if (sql.startsWith("SELECT revision, snapshot FROM equipment_report_draft_buffers")) return values.get(`${params[0]}:${params[1]}`) ?? null;
        if (sql.startsWith("INSERT INTO equipment_report_draft_buffers")) {
          assert.match(sql, /ON CONFLICT\(user_id, site_id\) DO NOTHING/);
          const key = `${params[0]}:${params[1]}`;
          if (values.has(key)) return null;
          const row = { revision: 1, snapshot: params[2] }; values.set(key, row); return row;
        }
        if (sql.startsWith("UPDATE equipment_report_draft_buffers")) {
          assert.match(sql, /WHERE user_id = \? AND site_id = \? AND revision = \?/);
          const key = `${params[1]}:${params[2]}`, previous = values.get(key);
          if (!previous || previous.revision !== params[3]) return null;
          const row = { revision: previous.revision + 1, snapshot: params[0] }; values.set(key, row); return row;
        }
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS equipment_report_draft_buffers")) return null;
        throw new Error(`Unexpected SQL: ${sql}`);
      };
      const statement = { bind(...next) { params = next; return statement; }, async first() { return execute(); }, async run() { execute(); return { success: true }; } };
      return statement;
    },
  };
  return db;
}

const context = { user: actor(), db: database(), databaseCalls: 0 };
globalThis.__equipmentDraftBufferRouteTest = context;
const route = await import(await compileModuleGraph(new URL("../app/api/equipment-report-draft/route.ts", import.meta.url), {
  "../../../db/client": dataUrl("export function getDatabase() { const context=globalThis.__equipmentDraftBufferRouteTest; context.databaseCalls++; return context.db; }"),
  "../../auth": dataUrl("export async function getAuthUser() { return globalThis.__equipmentDraftBufferRouteTest.user; } export function assertSameOrigin(request) { if (request.headers.get('origin') !== new URL(request.url).origin) throw new Error('Foreign origin'); }"),
}));
after(() => { delete globalThis.__equipmentDraftBufferRouteTest; });
const request = (method, body, headers = {}) => new Request("http://localhost:3000/api/equipment-report-draft?siteId=7", { method,
  headers: { origin: "http://localhost:3000", "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("a ten-unit incomplete draft and invalid typed cells survive snapshot parsing without truncation", () => {
  const value = snapshot();
  value.edits["new:2026-11-06"][0].hours = "не заполнено";
  value.edits["new:2026-11-06"][0].inputValues = { hours: "не заполнено", zone: "новая зона" };
  value.edits["new:2026-11-06"][9].note = "Перерыв на обед\nПродолжить после обеда";
  const before = JSON.stringify(value);
  const parsed = parseEquipmentReportDraftSnapshot(JSON.parse(before), 10, 7);
  assert.equal(parsed.edits["new:2026-11-06"].length, 10);
  assert.equal(JSON.stringify(parsed), before);
  assert.equal(parseEquipmentReportDraftSnapshot(null, 10, 7), null);
});

test("snapshot validation isolates users/projects and rejects foreign or published report sessions", () => {
  const own = session();
  const value = { ...snapshot(), edits: { 18: [draft()] }, sessions: { 18: own } };
  assert.deepEqual(parseEquipmentReportDraftSnapshot(value, 10, 7), value);
  const invalid = error => error.code === "INVALID_DRAFT_BUFFER";
  assert.throws(() => parseEquipmentReportDraftSnapshot(value, 11, 7), invalid);
  assert.throws(() => parseEquipmentReportDraftSnapshot(value, 10, 8), invalid);
  for (const patch of [{ ownerUserId: 11 }, { siteId: 8 }, { status: "submitted" }, { status: "approved" }, { id: 19 }]) {
    assert.throws(() => parseEquipmentReportDraftSnapshot({ ...value, sessions: { 18: { ...own, ...patch } } }, 10, 7), invalid);
  }
  assert.throws(() => parseEquipmentReportDraftSnapshot({ ...value, sessions: {} }, 10, 7), invalid);
  for (const key of ["new:2026-02-30", "new:0000-01-01", "new", "entry-18", "__proto__"]) {
    assert.throws(() => parseEquipmentReportDraftSnapshot({ ...snapshot(), edits: { [key]: [draft()] } }, 10, 7), invalid);
  }
  assert.throws(() => parseEquipmentReportDraftSnapshot({ ...snapshot(), edits: { "new:2026-11-06": [draft(), draft()] } }, 10, 7), invalid);
  assert.throws(() => parseEquipmentReportDraftSnapshot({ ...snapshot(), edits: { "new:2026-11-06": [{ ...draft(), note: 4 }] } }, 10, 7), invalid);
});

test("buffer saves and reads are scoped to both author and project without creating canonical reports", async () => {
  const db = database();
  assert.deepEqual(await store.readEquipmentReportDraftBuffer(db, actor(), 7), { revision: 0, snapshot: null });
  const first = await store.writeEquipmentReportDraftBuffer(db, actor(), 7, 0, snapshot());
  assert.equal(first.revision, 1);
  assert.deepEqual(await store.readEquipmentReportDraftBuffer(db, actor(), 7), first);
  assert.deepEqual(await store.readEquipmentReportDraftBuffer(db, actor({ id: 11 }), 7), { revision: 0, snapshot: null });
  assert.deepEqual(await store.readEquipmentReportDraftBuffer(db, actor(), 8), { revision: 0, snapshot: null });
  const changed = snapshot(); changed.edits["new:2026-11-06"][0].note = "После обеда";
  assert.equal((await store.writeEquipmentReportDraftBuffer(db, actor(), 7, 1, changed)).revision, 2);
  assert.equal(db.values.size, 1);
  assert.ok(db.queries.every(({ sql }) => !/\bequipment_reports\b|\bequipment_report_rows\b|\bequipment_entries\b/.test(sql)));
});

test("optimistic versions and versioned clearing prevent concurrent tabs from overwriting or resurrecting a draft", async () => {
  const db = database();
  await store.writeEquipmentReportDraftBuffer(db, actor(), 7, 0, snapshot());
  const conflict = error => error.status === 409 && error.code === "DRAFT_BUFFER_CONFLICT" && error.details.revision === 1;
  await assert.rejects(store.writeEquipmentReportDraftBuffer(db, actor(), 7, 0, snapshot()), conflict);
  const result = await store.writeEquipmentReportDraftBuffer(db, actor(), 7, 1, null);
  assert.deepEqual(result, { revision: 2, snapshot: null });
  await assert.rejects(store.writeEquipmentReportDraftBuffer(db, actor(), 7, 1, snapshot()), error => error.code === "DRAFT_BUFFER_CONFLICT" && error.details.revision === 2 && error.details.snapshot === null);
  await assert.rejects(store.writeEquipmentReportDraftBuffer(db, actor(), 7, 0, snapshot()), error => error.code === "DRAFT_BUFFER_CONFLICT");
  assert.deepEqual(await store.readEquipmentReportDraftBuffer(db, actor(), 7), { revision: 2, snapshot: null });
});

test("access rights deny readonly/foreign users before SQL, and inactive projects cannot retain a new buffer", async () => {
  const forbidden = [actor({ role: "viewer" }), actor({ projectAccess: { mode: "selected", siteIds: [8] } }),
    actor({ permissions: { equipment_report: { view: true, create: false, update: false } } }),
    actor({ permissions: { equipment_report: { view: false, create: true, update: true } } })];
  for (const user of forbidden) {
    const db = database();
    await assert.rejects(store.readEquipmentReportDraftBuffer(db, user, 7), error => error.status === 403);
    await assert.rejects(store.writeEquipmentReportDraftBuffer(db, user, 7, 0, snapshot()), error => error.status === 403);
    assert.equal(db.queries.length, 0);
  }
  const db = database(); db.active = false;
  await assert.rejects(store.writeEquipmentReportDraftBuffer(db, actor(), 7, 0, snapshot()), error => error.status === 404);
  assert.equal(db.values.size, 0);
  for (const permission of [{ view: true, create: true, update: false }, { view: true, create: false, update: true }]) {
    assert.doesNotThrow(() => store.assertEquipmentReportDraftBufferAccess(actor({ permissions: { equipment_report: permission } }), 7));
  }
});

test("draft API checks authentication/origin/permissions and rejects oversized payloads before database access", async () => {
  context.databaseCalls = 0; context.user = null;
  assert.equal((await route.GET(request("GET"))).status, 401);
  assert.equal((await route.PUT(request("PUT", {}))).status, 401);
  context.user = actor();
  assert.equal((await route.PUT(request("PUT", {}, { origin: "https://foreign.test" }))).status, 403);
  context.user = actor({ role: "viewer" });
  assert.equal((await route.GET(request("GET"))).status, 403);
  context.user = actor();
  assert.equal((await route.PUT(request("PUT", {}, { "content-length": String(8 * 1024 * 1024 + 1) }))).status, 413);
  assert.equal(context.databaseCalls, 0);
});

test("draft API returns no-store versions, rejects stale writes and keeps clearing separate from report submission", async () => {
  context.user = actor(); context.db = database();
  let response = await route.GET(request("GET"));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { revision: 0, snapshot: null });
  response = await route.PUT(request("PUT", { siteId: 7, revision: 0, snapshot: snapshot() }));
  assert.equal(response.status, 200); assert.equal((await response.json()).revision, 1);
  response = await route.PUT(request("PUT", { siteId: 7, revision: 0, snapshot: snapshot() }));
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "DRAFT_BUFFER_CONFLICT");
  response = await route.PUT(request("PUT", { siteId: 7, revision: 1, snapshot: null }));
  assert.deepEqual(await response.json(), { revision: 2, snapshot: null });
  response = await route.GET(request("GET"));
  assert.deepEqual(await response.json(), { revision: 2, snapshot: null });
});
