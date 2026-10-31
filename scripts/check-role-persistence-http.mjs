// Only for role-persistence-server.mjs: real HTTP checks against its synthetic users.
import assert from "node:assert/strict";

const portIndex = process.argv.indexOf("--port");
const port = portIndex < 0 ? 3112 : Number(process.argv[portIndex + 1]);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3000, "Use the isolated QA port.");
const origin = `http://127.0.0.1:${port}`;
const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "engineer@invalid.test", password: "Local-role-QA-only-2026" }) });
assert.equal(login.status, 200, "Synthetic user login failed");
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
const get = path => fetch(`${origin}${path}`, { headers: { Cookie: cookie } });
const auth = await get("/api/auth/status");
assert.equal(auth.status, 200);
const { user, authenticated } = await auth.json();
assert.equal(authenticated, true);
assert.equal(user.fullName, "Проверка Пользователь", "This must be the synthetic QA database");
assert.equal(user.customRoleName, "Плановый контроль");
assert.equal(user.role, "viewer");
assert.deepEqual(user.projectAccess, { mode: "selected", siteIds: [1] });
assert.equal(user.canViewPendingReports, true);
assert.equal(user.permissions.workers_report.view, true);
assert.equal(user.permissions.workers_timesheet.view, true);
assert.equal(user.permissions.equipment_report.view, false);
for (const row of Object.values(user.permissions)) for (const action of ["create", "update", "delete"]) assert.equal(row[action], false);
const navigation = await get("/api/data?scope=navigation");
assert.equal(navigation.status, 200);
assert.deepEqual((await navigation.json()).sites.map(site => site.id), [1]);
assert.equal((await get("/api/personnel-report?siteId=1&all=true")).status, 200);
assert.equal((await get("/api/personnel-report?siteId=2&all=true")).status, 403);
assert.equal((await get("/api/equipment-report?siteId=1&all=true")).status, 403);
assert.equal((await get("/api/access-rights")).status, 403);
assert.equal((await get("/api/roles")).status, 403);
for (const [method, path, body] of [
  ["POST", "/api/roles", { name: "Unauthorized test", permissions: {} }],
  ["POST", "/api/access-rights", { userId: user.id, projectAccess: { mode: "all", siteIds: [] } }],
  ["PATCH", "/api/data", { action: "update-user", userId: user.id, role: "superadmin" }],
  ["POST", "/api/personnel-report", { action: "save", siteId: 1, workDate: "2026-11-01", rows: [] }],
  ["POST", "/api/timesheet", { siteId: 1, employeeId: 1, workDate: "2026-11-01", value: "8" }],
]) {
  const response = await fetch(`${origin}${path}`, { method, headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 403, `${method} ${path} must reject readonly writes`);
}
console.log("PASS: persisted role name/template, exact project and pending scope, real login, permitted reads, denied foreign projects/sections and five forged writes on the isolated production server.");
