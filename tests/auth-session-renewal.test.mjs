import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const source = ts.createSourceFile("auth.ts", await readFile(new URL("../app/auth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function declaration(name) {
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === name));
  assert.ok(node, `Missing actual auth declaration: ${name}`);
  return node.getText(source).replace(/^export /, "");
}
const sha256 = value => createHash("sha256").update(value).digest("base64");
const token = "isolated-session-token";
const request = (value = token, origin = "https://example.invalid") => new Request(`${origin}/api/auth/status`, { headers: value === null ? {} : { cookie: `personnel_session=${encodeURIComponent(value)}` } });

function harness({ expires = "+10 minutes", revoked = false, active = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE app_users (id INTEGER PRIMARY KEY, active INTEGER NOT NULL);
    CREATE TABLE user_sessions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL, revoked_at TEXT);`);
  sqlite.prepare("INSERT INTO app_users (id, active) VALUES (7, ?)").run(Number(active));
  sqlite.prepare("INSERT INTO user_sessions (id,user_id,token_hash,expires_at,revoked_at) VALUES (1,7,?,DATETIME('now',?),?)").run(sha256(token), expires, revoked ? "2026-01-01 00:00:00" : null);
  const writes = [];
  const database = () => ({ prepare(sql) {
    return { bind(...values) { return { async run() { writes.push({ sql, values }); const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; } }; } };
  } });
  const input = ["SESSION_COOKIE", "SESSION_DAYS", "cookieValue", "sessionCookie", "refreshAuthSession"].map(declaration).join("\n");
  const code = ts.transpileModule(`${input}\nreturn { refreshAuthSession, sessionCookie };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const auth = new Function("database", "sha256", code)(database, sha256);
  const row = () => sqlite.prepare("SELECT * FROM user_sessions WHERE id=1").get();
  return { sqlite, writes, ...auth, row, close: () => sqlite.close() };
}

test("activity renews the same valid session to 30 days from database time and refreshes the protected cookie", async () => {
  const ui = harness();
  try {
    const previous = ui.row();
    const cookie = await ui.refreshAuthSession(request(), 7);
    assert.match(cookie, /^personnel_session=isolated-session-token;/);
    assert.match(cookie, /Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
    const renewed = ui.row();
    assert.equal(renewed.token_hash, previous.token_hash, "renewal does not rotate the token or create another login");
    assert.equal(renewed.created_at, previous.created_at);
    assert.equal(renewed.revoked_at, null);
    assert.equal(ui.sqlite.prepare("SELECT COUNT(*) AS count FROM user_sessions").get().count, 1);
    assert.equal(ui.sqlite.prepare("SELECT ABS(unixepoch(expires_at)-unixepoch('now','+30 days')) AS delta FROM user_sessions WHERE id=1").get().delta, 0);
    assert.ok(renewed.expires_at > previous.expires_at);
    assert.equal(await ui.refreshAuthSession(request(), 7), cookie, "repeated activity remains on the same session");
    assert.ok(ui.writes.every(({ sql }) => /^UPDATE user_sessions/.test(sql)));
  } finally { ui.close(); }
});

for (const [name, options, credential, userId] of [
  ["expired", { expires: "-1 second" }, token, 7],
  ["exact expiry boundary", { expires: "+0 seconds" }, token, 7],
  ["revoked", { revoked: true }, token, 7],
  ["disabled account", { active: false }, token, 7],
  ["another account", {}, token, 8],
  ["unknown token", {}, "another-session-token", 7],
]) test(`renewal cannot revive or extend a ${name} session`, async () => {
  const ui = harness(options);
  try {
    const previous = ui.row();
    assert.equal(await ui.refreshAuthSession(request(credential), userId), null);
    assert.deepEqual(ui.row(), previous);
  } finally { ui.close(); }
});

test("no cookie performs no writes; HTTP localhost retains the existing development cookie behavior", async () => {
  const ui = harness();
  try {
    assert.equal(await ui.refreshAuthSession(request(null), 7), null);
    assert.equal(ui.writes.length, 0);
    assert.doesNotMatch(await ui.refreshAuthSession(request(token, "http://localhost"), 7), /; Secure/);
  } finally { ui.close(); }
});

const boundaryUrl = `data:text/javascript;base64,${Buffer.from(`
  let actor=null, cookie=null, failure=false;export const calls=[];
  export function configure(value,renewed=null,fail=false){actor=value;cookie=renewed;failure=fail;calls.length=0;}
  export async function ensureAuthSchema(){}
  export async function getAuthUser(){return actor;}
  export async function refreshAuthSession(request,id){calls.push(id);if(failure)throw new Error('Temporary isolated renewal failure');return cookie;}
  export function getDatabase(){return {prepare(sql){if(!sql.startsWith('SELECT id FROM app_users'))throw new Error('Unexpected SQL');return {async first(){return {id:7};}};}};}
`).toString("base64")}`;
const boundary = await import(boundaryUrl);
const { GET } = await import(await compileModuleGraph(new URL("../app/api/auth/status/route.ts", import.meta.url), {
  "../../../../db/client": boundaryUrl, "../../../auth": boundaryUrl,
}));

test("actual auth status renews an authenticated session and sends an uncached cookie response", async () => {
  const user = { id: 7, role: "engineer" };
  boundary.configure(user, "personnel_session=isolated; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure");
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("set-cookie"), /Max-Age=2592000/);
  assert.deepEqual(await response.json(), { authenticated: true, bootstrapRequired: false, user });
  assert.deepEqual(boundary.calls, [7]);
});

test("status fails closed if a concurrent logout or password change revokes the session before renewal", async () => {
  boundary.configure({ id: 7 }, null);
  const response = await GET(request());
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { authenticated: false, bootstrapRequired: false, user: null });
  assert.deepEqual(boundary.calls, [7]);
});

test("an anonymous status check does not create or renew a session", async () => {
  boundary.configure(null);
  const response = await GET(request(null));
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await response.json()).authenticated, false);
  assert.deepEqual(boundary.calls, []);
});

test("renewal database failures stay server failures rather than false authenticated/unauthenticated responses", async () => {
  boundary.configure({ id: 7 }, null, true);
  await assert.rejects(GET(request()), /Temporary isolated renewal failure/);
});
