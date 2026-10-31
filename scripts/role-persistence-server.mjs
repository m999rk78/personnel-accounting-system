// Isolated browser QA backed by real PostgreSQL and the built production app.
// Never writes business data. No mail/Bitrix credentials are inherited by the app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

assert.ok(process.env.DATABASE_URL, "Set DATABASE_URL for the local PostgreSQL server.");
const connectionUrl = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(connectionUrl.hostname), "Only loopback PostgreSQL is allowed.");
const portFlag = process.argv.indexOf("--port");
const port = portFlag < 0 ? 3112 : Number(process.argv[portFlag + 1]);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3000, "Choose a separate QA port.");
const databaseName = `personnel_role_qa_${randomUUID().replaceAll("-", "")}`;
const quote = name => `"${name.replaceAll('"', '""')}"`;
const control = new pg.Pool({ connectionString: connectionUrl.href, ssl: false, max: 1, connectionTimeoutMillis: 5000 });
const qaUrl = new URL(connectionUrl); qaUrl.pathname = `/${databaseName}`;
const qa = new pg.Pool({ connectionString: qaUrl.href, ssl: false, max: 2, connectionTimeoutMillis: 5000 });
const baseUrl = `http://127.0.0.1:${port}`;
const password = "Local-role-QA-only-2026";
const serverEnv = { PATH: process.env.PATH, NODE_ENV: "production", DATABASE_URL: qaUrl.href, DATABASE_SSL: "disable", HOST: "127.0.0.1", PORT: String(port) };
let created = false, server, closing;
const serverDirectory = await mkdtemp(join(tmpdir(), "role-persistence-app-"));
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  const finished = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  await finished;
  clearTimeout(timeout);
}
async function startServer() {
  server = spawn(process.execPath, [fileURLToPath(new URL("../dist/standalone/server.js", import.meta.url))], { cwd: serverDirectory, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.resume();
  let failure = "";
  server.stderr.on("data", chunk => { failure = `${failure}${chunk}`.slice(-2000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Isolated production server failed (${server.exitCode}): ${failure}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { console.log(`READY ${baseUrl} (isolated PostgreSQL, production build)`); return; }
    } catch { /* Wait for the server socket, never contact a remote host. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Isolated production server did not become ready.");
}
async function cleanup() {
  if (closing) return closing;
  closing = (async () => {
    await stopServer();
    await qa.end();
    if (created) { await control.query(`DROP DATABASE ${quote(databaseName)} WITH (FORCE)`); console.log("Temporary role QA database removed."); }
    await control.end();
    await rm(serverDirectory, { recursive: true, force: true });
  })();
  return closing;
}
async function checkConcurrentCreation() {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ email: "super@invalid.test", password }) });
  assert.equal(login.status, 200, "Synthetic admin login failed");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Login did not return a session");
  const names = ["Параллельная роль", " параллельная  РОЛЬ "];
  const replies = await Promise.all(names.map(name => fetch(`${baseUrl}/api/roles`, { method: "POST", headers: { Origin: baseUrl, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name, permissions: { workers_report: { view: true } } }) })));
  assert.deepEqual(replies.map(response => response.status).sort(), [201, 409], "Concurrent duplicates must create exactly one role");
  const rows = (await qa.query("SELECT id FROM custom_roles WHERE name_key='параллельная роль'")).rows;
  assert.equal(rows.length, 1);
  await qa.query("DELETE FROM custom_roles WHERE id=$1", [rows[0].id]);
  console.log("PASS: two simultaneous HTTP role creations persisted exactly one row (201 + 409).");
}
try {
  const allowed = (await control.query("SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname=current_user")).rows[0]?.allowed;
  assert.equal(allowed, true, "The local account cannot create a disposable QA database.");
  await control.query(`CREATE DATABASE ${quote(databaseName)}`); created = true;
  await migrate(drizzle(qa), { migrationsFolder: fileURLToPath(new URL("../drizzle-postgres", import.meta.url)) });
  await qa.query("INSERT INTO sites(name,code) VALUES ('Тестовый Север','QA-N'),('Тестовый Юг','QA-S')");
  const salt = randomBytes(16).toString("base64");
  const hash = pbkdf2Sync(password, Buffer.from(salt, "base64"), 600000, 32, "sha256").toString("base64");
  await qa.query(`INSERT INTO app_users(full_name,email,role,password_hash,password_salt,password_iterations,activated_at) VALUES
    ('Проверка Администратор','super@invalid.test','superadmin',$1,$2,600000,CURRENT_TIMESTAMP),
    ('Проверка Пользователь','engineer@invalid.test','engineer',$1,$2,600000,CURRENT_TIMESTAMP)`, [hash, salt]);
  await startServer();
  console.log(`Synthetic logins: super@invalid.test and engineer@invalid.test; QA-only password: ${password}`);
  console.log("Commands: restart / status / concurrent / quit. All roles and accounts belong only to this disposable database.");
  const input = createInterface({ input: process.stdin });
  let commands = Promise.resolve();
  input.on("line", line => {
    commands = commands.then(async () => {
      if (line.trim() === "restart") { await stopServer(); await startServer(); }
      if (line.trim() === "concurrent") await checkConcurrentCreation();
      if (line.trim() === "status") {
        const result = await qa.query(`SELECT role.name AS "roleName", target.full_name AS "userName", target.role AS "baseRole",
          access.all_projects AS "allProjects", access.can_view_pending_reports AS "pendingReports",
          COALESCE((SELECT json_agg(site_id ORDER BY site_id) FROM user_project_access_sites grants WHERE grants.user_id=target.id),'[]') AS projects
          FROM custom_roles role LEFT JOIN app_users target ON target.custom_role_id=role.id
          LEFT JOIN user_project_access access ON access.user_id=target.id ORDER BY role.id,target.id`);
        console.log(JSON.stringify({ persisted: result.rows }));
      }
      if (line.trim() === "quit") { input.close(); await cleanup(); }
    }).catch(error => { console.error(error.message); process.exitCode = 1; input.close(); });
  });
  const interrupted = () => { input.close(); void cleanup(); };
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  await once(input, "close");
  await commands;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { await cleanup(); }
