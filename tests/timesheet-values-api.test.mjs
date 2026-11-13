import assert from "node:assert/strict";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const boundaryUrl = moduleUrl(`export let actor, database;
  export function configure(user, db) { actor = user; database = db; }
  export const getDatabase = () => database;
  export const getAuthUser = async () => actor;
  export function assertSameOrigin(request) { if (request.headers.get('origin') !== new URL(request.url).origin) throw new Error('Invalid origin'); }
  export async function withAuditTrail(request, handler) { return handler(request); }`);
const boundary = await import(boundaryUrl);
const { POST } = await import(await compileModuleGraph(new URL("../app/api/timesheet/route.ts", import.meta.url), {
  "../../../db/client": boundaryUrl, "../../auth": boundaryUrl, "../../auditLog": boundaryUrl,
}));
process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;

const workDate = "2026-11-05";
const expectedCodes = ["В", "Б", "МО", "ДО", "ПЕ", "УВ", "Д", "ПР", "О", "К", "Н", "ЛН", "ЛО"];
function actor() {
  return { id: 17, role: "engineer", fullName: "Учебный инженер", assignedSiteId: 7,
    projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate("superadmin") };
}
function fixture(user = actor(), { existing = false, member = true, directoryActive = 1, reportDates = [] } = {}) {
  const writes = [];
  let revision = 1;
  let mark = existing ? { siteId: 7, employeeId: 101, workDate, hours: 8, code: null, note: "", updatedBy: "Предыдущий автор", revision: "r1" } : null;
  const database = {
    prepare(sql) {
      let values = [];
      return {
        bind(...parameters) { values = parameters; return this; },
        async first() {
          if (/SELECT id, name FROM sites/.test(sql)) return { id: 7, name: "Учебный проект" };
          if (sql.startsWith("WITH assignment_roster AS")) return member ? {
            id: 101, directoryActive, assignments: [{ startDate: "2000-01-01", endDate: null, active: true }], reportDates, markDates: mark ? [mark.workDate] : [], exits: [], profileDate: null,
          } : null;
          if (/pg_advisory_xact_lock/.test(sql)) return {};
          if (/AS revision FROM timesheet_marks/.test(sql)) return mark?.workDate === values[2] ? { revision: mark.revision } : null;
          if (/SELECT id FROM timesheet_marks/.test(sql)) return mark?.workDate === values[2] ? { id: 1 } : null;
          throw new Error(`Unexpected read: ${sql.slice(0, 80)}`);
        },
        async run() {
          writes.push({ sql, values: structuredClone(values) });
          if (/INSERT INTO timesheet_marks/.test(sql)) {
            const [siteId, employeeId, date, hours, code, note, updatedBy] = values;
            mark = { siteId, employeeId, workDate: date, hours, code, note, updatedBy, revision: `r${++revision}` };
          } else if (/DELETE FROM timesheet_marks/.test(sql)) mark = null;
          else throw new Error(`Unexpected write: ${sql.slice(0, 80)}`);
          return { meta: { changes: 1 } };
        },
      };
    },
    async transaction(callback) { return callback(database); },
  };
  boundary.configure(user, database);
  return { writes, mark: () => mark };
}
const save = (value, overrides = {}) => POST(new Request("http://localhost/api/timesheet", {
  method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" },
  body: JSON.stringify({ siteId: 7, employeeId: 101, workDate, value, note: "Проверка", ...overrides }),
}));

test("an archived employee requires monthly history but permits backdated corrections within that month", async () => {
  let state = fixture(actor(), { directoryActive: 0 });
  assert.equal((await save(8)).status, 404);
  assert.equal(state.writes.length, 0);

  state = fixture(actor(), { directoryActive: 0, existing: true });
  const response = await save(8, { workDate: "2026-11-06" });
  assert.equal(response.status, 200, "monthly historical membership permits correction of another day and supports undo");
  assert.equal(state.writes.length, 1);
  assert.equal((await save(7)).status, 200, "historical days remain editable");

  state = fixture(actor(), { directoryActive: 0, reportDates: [workDate] });
  assert.equal((await save(7)).status, 200, "a day with a historical report is still eligible for a correction");
});

test("the actual timesheet API saves every reference code and all hours from one through ten", async () => {
  for (const value of [...Array.from({ length: 10 }, (_, hour) => hour + 1), ...expectedCodes]) {
    const state = fixture();
    const response = await save(value);
    assert.equal(response.status, 200, `Reference value ${value} must save`);
    const { mark } = await response.json();
    assert.equal(mark.hours, typeof value === "number" ? value : null);
    assert.equal(mark.code, typeof value === "string" ? value : null);
    assert.equal(state.writes.length, 1);
    assert.match(state.writes[0].sql, /INSERT INTO timesheet_marks/);
    assert.equal(state.mark().hours, mark.hours);
    assert.equal(state.mark().code, mark.code);
  }
});

test("zero is rejected without changing or deleting a mark; only an empty value deletes it", async () => {
  const state = fixture(actor(), { existing: true });
  for (const value of [0, "0"]) {
    const response = await save(value);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /от 1 до 10/);
    assert.equal(state.mark().hours, 8);
    assert.deepEqual(state.writes, []);
  }
  const response = await save("");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, true);
  assert.equal(state.mark(), null);
  assert.match(state.writes.at(-1).sql, /DELETE FROM timesheet_marks/);
});

test("code normalization preserves the new codes and replaces a numeric mark with a code", async () => {
  const state = fixture(actor(), { existing: true });
  for (const code of expectedCodes) {
    const response = await save(` ${code.toLocaleLowerCase("ru-RU")} `);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mark.code, code);
    assert.equal(state.mark().hours, null);
  }
});

test("invalid hours and unknown codes never write a mark", async () => {
  for (const value of [-1, 11, 0.5, "1.5", "999", "UNKNOWN", "ББ", "Infinity"]) {
    const state = fixture();
    assert.equal((await save(value)).status, 400, `Reject ${value}`);
    assert.deepEqual(state.writes, []);
  }
});

test("invalid calendar dates cannot save a mark on a normalized different date", async () => {
  for (const workDate of ["2026-02-29", "2026-02-30", "2026-04-31", "0000-01-01", "2026-13-01", "2026-11-00"]) {
    const state = fixture();
    const response = await save(8, { workDate });
    assert.equal(response.status, 400, `Reject impossible date ${workDate}`);
    assert.deepEqual(state.writes, []);
  }
  const state = fixture();
  assert.equal((await save(8, { workDate: "2028-02-29" })).status, 200);
  assert.equal(state.mark().workDate, "2028-02-29", "A real leap day remains writable");
});

test("new codes respect independent create, update and delete permissions", async () => {
  const updateOnly = actor();
  Object.assign(updateOnly.permissions.workers_timesheet, { create: false, update: true, delete: false });
  const absent = fixture(updateOnly);
  assert.equal((await save("Б")).status, 403);
  assert.deepEqual(absent.writes, []);
  const existing = fixture(updateOnly, { existing: true });
  assert.equal((await save("Б")).status, 200);
  assert.equal(existing.mark().code, "Б");
  assert.equal((await save("")).status, 403);
  assert.equal(existing.mark().code, "Б");

  const createOnly = actor();
  Object.assign(createOnly.permissions.workers_timesheet, { create: true, update: false, delete: false });
  const created = fixture(createOnly);
  assert.equal((await save("ЛН")).status, 200);
  assert.equal((await save("ЛО")).status, 403);
  assert.equal(created.mark().code, "ЛН");
});

test("the expanded values do not bypass authentication, project or employee membership guards", async () => {
  for (const [user, options, overrides, status] of [
    [null, {}, {}, 401],
    [{ ...actor(), role: "viewer", permissions: rolePermissionTemplate("viewer") }, {}, {}, 403],
    [actor(), {}, { siteId: 8 }, 403],
    [actor(), { member: false }, {}, 404],
  ]) {
    const state = fixture(user, options);
    assert.equal((await save("ЛО", overrides)).status, status);
    assert.deepEqual(state.writes, []);
  }
});

for (const role of ["foreman", "viewer"]) test(`${role} can save, edit and delete a mark when matching actions are granted`, async () => {
  const user = { ...actor(), role };
  const state = fixture(user);
  assert.equal((await save(8)).status, 200);
  assert.equal(state.mark().hours, 8);
  assert.equal((await save("О")).status, 200);
  assert.equal(state.mark().code, "О");
  assert.equal((await save("")).status, 200);
  assert.equal(state.mark(), null);
});


test("stale edits and retries cannot overwrite a later saved mark or delete it", async () => {
  const state = fixture(actor(), { existing: true });
  const first = await save(6, { expectedRevision: "r1" });
  assert.equal(first.status, 200);
  const saved = (await first.json()).mark;
  assert.notEqual(saved.revision, "r1");
  for (const value of [9, "", "ПЕ"]) {
    assert.equal((await save(value, { expectedRevision: "r1" })).status, 409);
    assert.equal(state.mark().hours, 6);
    assert.equal(state.writes.length, 1);
  }
  assert.equal((await save(7, { expectedRevision: saved.revision })).status, 200);
});

test("a concurrent create cannot replace a mark when the client saw an empty day", async () => {
  const state = fixture();
  assert.equal((await save(8, { expectedRevision: null })).status, 200);
  assert.equal((await save(3, { expectedRevision: null })).status, 409);
  assert.equal(state.mark().hours, 8);
});

test("the server requires confirmation before a guarded delete removes the final historical row", async () => {
  const state = fixture(actor(), { directoryActive: 0, existing: true });
  assert.equal((await save("", { expectedRevision: "r1" })).status, 409);
  assert.equal(state.mark().hours, 8);
  assert.equal((await save("", { expectedRevision: "r1", allowRosterRemoval: true })).status, 200);
  assert.equal(state.mark(), null);
});
