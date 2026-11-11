import assert from "node:assert/strict";
import test from "node:test";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";
import { emptyPermissionSet, normalizePermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";

const boundaryUrl = `data:text/javascript;base64,${Buffer.from(`
  let user, database;
  export function configure(actor, db) { user = actor; database = db; }
  export async function getAuthUser() { return user; }
  export function getDatabase() { return database; }
`).toString("base64")}`;
const boundary = await import(boundaryUrl);
const { GET } = await import(await compileModuleGraph(new URL("../app/api/statistics/route.ts", import.meta.url), {
  "../../../db/client": boundaryUrl,
  "../../auth": boundaryUrl,
}));

function request(changes = {}) {
  const params = new URLSearchParams({ siteId: "7", kind: "personnel", from: "2026-11-01", to: "2026-11-11", ...changes });
  return new Request(`http://localhost/api/statistics?${params}`);
}

function actor(role = "foreman") {
  return { id: 17, role, projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate(role) };
}

function configure(user, { activeSite = true, results = [] } = {}) {
  const calls = [];
  boundary.configure(user, {
    prepare(sql) {
      assert.match(sql, /^SELECT /, "Statistics only reads from the database");
      return {
        bind(...values) {
          calls.push({ sql, values });
          return { async first() { return activeSite ? { id: 7 } : null; }, async all() { return { results }; } };
        },
      };
    },
  });
  return calls;
}

test("personnel statistics combine saved position groups for the selected project's approved hours", async () => {
  const calls = configure(actor(), { results: [
    { zoneId: 21, zone: "Площадка А", title: "ЭЛЕКТРОГАЗОСВАРЩИК", hours: 10 },
    { zoneId: 21, zone: "Площадка А", title: "Сварщик-монтажник", hours: 4 },
    { zoneId: 21, zone: "Площадка А", title: "Монтажник стальных конструкций", hours: 7 },
    { zoneId: 21, zone: "Площадка А", title: "Слесарь", hours: 3 },
    { zoneId: 22, zone: "Архивная площадка", title: "Монтажник", hours: 5 },
    { zoneId: null, zone: null, title: "", hours: 2 },
  ] });
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await response.json()).rows, [
    { zoneId: 21, zone: "Площадка А", welders: 14, installers: 7, other: 3, productive: 0, downtime: 0, total: 24 },
    { zoneId: 22, zone: "Архивная площадка", welders: 0, installers: 5, other: 0, productive: 0, downtime: 0, total: 5 },
    { zoneId: null, zone: "Без зоны", welders: 0, installers: 0, other: 2, productive: 0, downtime: 0, total: 2 },
  ]);
  assert.deepEqual(calls.map(call => call.values), [[7], [7, "2026-11-01", "2026-11-11"]]);
  assert.match(calls[1].sql, /FROM placement_entries entry[\s\S]*entry\.site_id = \? AND entry\.work_date BETWEEN \? AND \? AND entry\.deleted_at IS NULL/);
  assert.match(calls[1].sql, /entry\.position_snapshot AS title/);
  assert.match(calls[1].sql, /entry\.employment_type_snapshot.*employee\.employment_type.*'ОПР'/);
});

test("equipment statistics use the same work and downtime split as the timesheet", async () => {
  const calls = configure(actor(), { results: [
    { zoneId: 21, zone: "Площадка А", title: "Перевозка материалов", hours: 16 },
    { zoneId: 21, zone: "Площадка А", title: "ПРОСТОЙ техники", hours: 5 },
    { zoneId: 21, zone: "Площадка А", title: "Плановый простой", hours: 3 },
  ] });
  const response = await GET(request({ kind: "equipment" }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).rows, [
    { zoneId: 21, zone: "Площадка А", welders: 0, installers: 0, other: 0, productive: 16, downtime: 8, total: 24 },
  ]);
  assert.match(calls[1].sql, /FROM equipment_entries entry[\s\S]*entry\.site_id = \? AND entry\.work_date BETWEEN \? AND \? AND entry\.deleted_at IS NULL/);
});

test("statistics requires authentication, project membership and its own permission for each tab", async () => {
  configure(null);
  assert.equal((await GET(request())).status, 401);
  const user = actor("engineer");
  user.permissions.workers_statistics.view = false;
  const calls = configure(user);
  assert.equal((await GET(request())).status, 403);
  assert.equal((await GET(request({ siteId: "8", kind: "equipment" }))).status, 403);
  assert.deepEqual(calls, []);
  const allowed = await GET(request({ kind: "equipment" }));
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { rows: [] });
});

test("statistics-only users can read aggregate hours while report permissions stay denied", async () => {
  for (const role of ["foreman", "engineer", "viewer"]) {
    for (const [kind, resource] of [["personnel", "workers_statistics"], ["equipment", "equipment_statistics"]]) {
      const user = actor(role);
      user.permissions = normalizePermissionSet({ ...emptyPermissionSet(), [resource]: { view: true } });
      const calls = configure(user);
      assert.equal((await GET(request({ kind }))).status, 200, `${role}: ${kind}`);
      assert.equal(calls.length, 2);
      assert.equal(user.permissions.workers_report.view, false);
      assert.equal(user.permissions.equipment_report.view, false);
      const otherKind = kind === "personnel" ? "equipment" : "personnel";
      assert.equal((await GET(request({ kind: otherKind }))).status, 403);
      assert.equal((await GET(request({ kind, siteId: "8" }))).status, 403);
      assert.equal(calls.length, 2, "Neither another statistics tab nor a foreign project may query hours");
    }
  }
});

test("revoking a statistics permission or project grant blocks the next request before reading hours", async () => {
  for (const [kind, resource] of [["personnel", "workers_statistics"], ["equipment", "equipment_statistics"]]) {
    const user = actor("engineer");
    configure(user);
    assert.equal((await GET(request({ kind }))).status, 200);
    const revoked = structuredClone(user);
    revoked.permissions[resource].view = false;
    let calls = configure(revoked);
    assert.equal((await GET(request({ kind }))).status, 403);
    assert.deepEqual(calls, []);
    calls = configure({ ...user, projectAccess: { mode: "selected", siteIds: [] } });
    assert.equal((await GET(request({ kind }))).status, 403);
    assert.deepEqual(calls, []);
  }
});

test("statistics validates dates before reading and rejects inactive projects", async () => {
  const calls = configure(actor(), { activeSite: false });
  for (const changes of [{ from: "2026-02-30" }, { to: "" }, { from: "2026-11-12" }, { from: "2025-01-01" }, { kind: "other" }]) {
    assert.equal((await GET(request(changes))).status, 400);
  }
  assert.deepEqual(calls, []);
  assert.equal((await GET(request())).status, 404);
  assert.equal(calls.length, 1);
});
