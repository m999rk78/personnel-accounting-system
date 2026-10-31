import assert from "node:assert/strict";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { projectAccessHarness } from "./fixtures/project-access-boundary.mjs";

process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;

async function fixture() {
  const h = await projectAccessHarness();
  await h.asUser(4);
  h.db.state.sessions = new Map([
    [11, { userId: 3, revokedAt: null }],
    [12, { userId: 4, revokedAt: null }],
    [13, { userId: 3, revokedAt: "already-revoked" }],
  ]);
  h.db.state.invitations = new Map([
    [21, { userId: 3, usedAt: null }],
    [22, { userId: 4, usedAt: null }],
    [23, { userId: 3, usedAt: "already-used" }],
  ]);
  const observations = [], controls = { beforeCriticalSection: null, failInvitationRevocation: false };
  let transaction = 0, sequence = 0, locked = false;
  const originalPrepare = h.db.prepare.bind(h.db), originalTransaction = h.db.transaction.bind(h.db), originalBatch = h.db.batch.bind(h.db);
  const committedChange = () => { const hook = controls.beforeCriticalSection; controls.beforeCriticalSection = null; hook?.(); };
  h.db.transaction = async callback => {
    // Represent a different transaction committing while this request waits for
    // the shared role-management lock. Its commit must survive our rollback.
    committedChange();
    return originalTransaction(async () => {
      transaction = ++sequence;
      try { return await callback(h.db); } finally { transaction = 0; locked = false; }
    });
  };
  h.db.batch = async statements => {
    if (!transaction) committedChange();
    return originalBatch(statements);
  };
  h.db.prepare = sql => {
    const handled = /pg_advisory_xact_lock|SELECT role FROM app_users|SELECT COUNT\(\*\).*FROM app_users|UPDATE app_users SET active = 0|UPDATE user_sessions SET revoked_at|UPDATE user_invitations SET used_at/.test(sql);
    if (!handled) return originalPrepare(sql);
    let values = [];
    const execute = () => {
      observations.push({ sql, values: structuredClone(values), transaction, locked });
      let rows = [], changes = 0;
      if (sql.includes("pg_advisory_xact_lock")) {
        assert.equal(values[0], "user-role-management", "deletion must share the reassignment lock");
        assert.ok(transaction); locked = true;
      } else if (sql.startsWith("SELECT role FROM app_users")) {
        const user = h.db.state.users.get(values[0]);
        rows = user && user.active !== 0 ? [{ role: user.role }] : [];
      } else if (sql.startsWith("SELECT COUNT(*)")) rows = [{ count: [...h.db.state.users.values()].filter(user => user.active !== 0 && ["superadmin", "office"].includes(user.role)).length }];
      else if (sql.startsWith("UPDATE app_users SET active")) {
        const user = h.db.state.users.get(values[0]);
        if (user && user.active !== 0) { user.active = 0; changes = 1; }
      } else if (sql.startsWith("UPDATE user_sessions")) {
        for (const session of h.db.state.sessions.values()) if (session.userId === values[0] && session.revokedAt === null) { session.revokedAt = "revoked-now"; changes++; }
      } else if (sql.startsWith("UPDATE user_invitations")) {
        if (controls.failInvitationRevocation) throw new Error("Injected invitation revocation failure");
        for (const invitation of h.db.state.invitations.values()) if (invitation.userId === values[0] && invitation.usedAt === null) { invitation.usedAt = "used-now"; changes++; }
      }
      return { results: rows, success: true, meta: { changes: rows.length || changes, last_row_id: null } };
    };
    const statement = { bind(...next) { values = next; return statement; }, async first() { return execute().results[0] ?? null; }, async all() { return execute(); }, async run() { return execute(); } };
    return statement;
  };
  const data = await h.loadDataRoute();
  async function remove(id) {
    const previous = console.error;
    try {
      // Expected handler errors should not dump an entire compiled data URL.
      console.error = () => undefined;
      return await data.DELETE(new Request(`http://localhost/api/data?entity=user&id=${id}`, { method: "DELETE" }));
    } finally { console.error = previous; }
  }
  return { ...h, controls, observations, remove };
}

for (const [name, change] of [
  ["role reassignment", user => { user.role = "engineer"; }],
  ["another user deletion", user => { user.active = 0; }],
]) test(`a concurrent ${name} cannot remove the last remaining super-admin`, async () => {
  const h = await fixture();
  h.db.state.users.set(8, { id: 8, role: "superadmin", fullName: "Второй администратор", email: "second@invalid.test", active: 1 });
  h.controls.beforeCriticalSection = () => change(h.db.state.users.get(4));
  const response = await h.remove(8);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /последнего администратора/);
  assert.equal(h.db.state.users.get(8).active, 1);
  assert.equal([...h.db.state.users.values()].filter(user => user.active !== 0 && user.role === "superadmin").length, 1);
  const reads = h.observations.filter(query => !query.sql.includes("pg_advisory_xact_lock"));
  assert.ok(reads.every(query => query.transaction && query.locked), "role and last-admin checks run after acquiring the lock");
  assert.match(reads[0].sql, /FOR UPDATE/);
  assert.ok(h.observations.every(query => !query.sql.startsWith("UPDATE")), "failed delete cannot revoke sessions or invitations");
});

test("ordinary deletion disables the user and revokes only their open sessions/invitations in one transaction", async () => {
  const h = await fixture();
  h.db.state.users.get(3).customRoleId = 41;
  const response = await h.remove(3);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(h.db.state.users.get(3).active, 0);
  assert.equal(h.db.state.users.get(3).customRoleId, 41, "soft deletion retains role history");
  assert.equal(h.db.state.sessions.get(11).revokedAt, "revoked-now");
  assert.equal(h.db.state.sessions.get(12).revokedAt, null);
  assert.equal(h.db.state.sessions.get(13).revokedAt, "already-revoked");
  assert.equal(h.db.state.invitations.get(21).usedAt, "used-now");
  assert.equal(h.db.state.invitations.get(22).usedAt, null);
  assert.equal(h.db.state.invitations.get(23).usedAt, "already-used");
  const writes = h.observations.filter(query => query.sql.startsWith("UPDATE"));
  assert.equal(writes.length, 3);
  assert.ok(writes.every(query => query.transaction === 1 && query.locked));
});

test("revocation failure rolls back both user status and previously revoked sessions", async () => {
  const h = await fixture();
  h.controls.failInvitationRevocation = true;
  const before = structuredClone(h.db.state);
  const response = await h.remove(3);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /revocation failure/);
  assert.deepEqual(h.db.state, before);
});

test("legacy office admins share the last-admin protection and another admin may be removed when one remains", async () => {
  const h = await fixture();
  h.db.state.users.set(8, { id: 8, role: "office", fullName: "Прежний администратор", email: "office@invalid.test", active: 1 });
  let response = await h.remove(8);
  assert.equal(response.status, 200);
  assert.equal(h.db.state.users.get(8).active, 0);
  h.db.state.users.set(8, { id: 8, role: "office", active: 1 });
  h.db.state.users.get(4).role = "engineer";
  response = await h.remove(8);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /последнего администратора/);
  assert.equal(h.db.state.users.get(8).active, 1);
});

test("self deletion, unknown targets and read-only actors cannot revoke account state", async () => {
  const h = await fixture();
  let response = await h.remove(4);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /собственную/);
  response = await h.remove(999);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /не найден/);
  await h.asUser(3, { projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("superadmin") });
  response = await h.remove(2);
  assert.equal(response.status, 403);
  assert.ok(h.observations.every(query => !query.sql.startsWith("UPDATE")));
});
