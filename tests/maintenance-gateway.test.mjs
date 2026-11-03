import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaintenanceGateway, writeMaintenanceState } from "../scripts/maintenance-gateway.mjs";
import { controlMaintenance } from "../scripts/maintenance-control.mjs";
import { startProduction } from "../scripts/start-production.mjs";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
async function close(server) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); }
async function until(check, timeout = 3000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Condition timed out"); await sleep(10); }
}

async function fixture(t, handler = (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"status":"ok"}'); }, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "personnel-maintenance-test-"));
  const upstream = createServer((req, res) => { void handler(req, res); });
  const backendPort = await listen(upstream);
  const stateFile = join(directory, "maintenance.json");
  const gateway = createMaintenanceGateway({ upstream: `http://127.0.0.1:${backendPort}`, stateFile, html: "<!doctype html><html lang=ru><h1>Технические работы</h1></html>", initialPhase: "ready", ...options });
  const { address, controlAddress } = await gateway.listen({ host: "127.0.0.1", port: 0, controlPort: 0 });
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await gateway.close(); await close(upstream); await rm(directory, { recursive: true, force: true }); });
  return { gateway, url, stateFile, directory, controlOptions: { stateFile, publicPort: address.port, controlPort: controlAddress.port, timeoutMs: 1000 } };
}

test("starting gateway serves standalone HTML and JSON503 without hitting application", async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.end("unexpected"); }, { initialPhase: "starting" });
  const page = await fetch(`${f.url}/reports/workers`);
  assert.equal(page.status, 503); assert.match(await page.text(), /Технические работы/);
  assert.equal(page.headers.get("x-personnel-maintenance"), "1"); assert.equal(page.headers.get("retry-after"), "5");
  const api = await fetch(`${f.url}/api/personnel-report`, { method: "POST", body: "{}" });
  assert.equal(api.status, 503); assert.equal((await api.json()).code, "MAINTENANCE");
  const status = await fetch(`${f.url}/api/maintenance/status`);
  assert.equal(status.status, 200); assert.match(status.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await status.json(), { maintenance: true, phase: "starting", retryAfterSeconds: 5 });
  assert.equal((await fetch(`${f.url}/api/health`)).status, 503);
  assert.equal(hits, 0);
});

test("maintenance blocks all API methods and pages, keeps readiness healthy, and private control is not publicly reachable", async t => {
  const paths = [];
  const f = await fixture(t, (req, res) => { paths.push(req.url); res.end('{"status":"ok"}'); });
  writeMaintenanceState(f.stateFile, true);
  for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]) assert.equal((await fetch(`${f.url}/api/data`, { method })).status, 503);
  const head = await fetch(`${f.url}/settings/general`, { method: "HEAD" }); assert.equal(head.status, 503); assert.equal(await head.text(), "");
  assert.equal((await fetch(`${f.url}/__maintenance/control/status`)).status, 404);
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
  assert.deepEqual(paths, ["/api/health"]);
  assert.deepEqual(await (await fetch(`${f.url}/api/maintenance/status`)).json(), { maintenance: true, phase: "maintenance", retryAfterSeconds: 5 });
});

test("on waits for admitted GET and POST requests, rejects later traffic, and off checks health before reopening", async t => {
  const release = deferred(); let admitted = 0;
  const f = await fixture(t, async (req, res) => { if (req.url !== "/api/health") { admitted++; await release.promise; } res.end('{"status":"ok"}'); });
  const read = fetch(`${f.url}/api/data`); const write = fetch(`${f.url}/api/personnel-report`, { method: "POST", body: "{}" });
  await until(() => admitted === 2);
  let drained = false;
  const on = controlMaintenance("on", f.controlOptions).then(result => { drained = true; return result; });
  await until(() => f.gateway.snapshot().maintenance);
  assert.equal((await fetch(`${f.url}/api/data`)).status, 503);
  assert.equal((await fetch(`${f.url}/api/personnel-report`, { method: "POST" })).status, 503);
  assert.equal(admitted, 2); assert.equal(drained, false); assert.equal(f.gateway.snapshot().inFlightRequests, 2);
  release.resolve(); assert.equal((await read).status, 200); assert.equal((await write).status, 200);
  const result = await on; assert.equal(result.inFlightRequests, 0); assert.equal(result.inFlightWrites, 0);
  await controlMaintenance("off", f.controlOptions);
  assert.equal(f.gateway.snapshot().maintenance, false); assert.equal((await fetch(`${f.url}/api/data`)).status, 200);
});

test("browser disconnect does not falsely mark a still-running upstream save drained", async t => {
  const admitted = deferred(); const release = deferred();
  const f = await fixture(t, async (req, res) => { req.resume(); await new Promise(resolve => req.on("end", resolve)); admitted.resolve(); await release.promise; res.end("saved"); });
  const browser = request(`${f.url}/api/data`, { method: "POST" }); browser.on("error", () => {}); browser.end("payload");
  await admitted.promise; browser.destroy(); await sleep(20);
  const waiting = controlMaintenance("on", f.controlOptions);
  await until(() => f.gateway.snapshot().maintenance);
  assert.equal(f.gateway.snapshot().inFlightWrites, 1);
  release.resolve(); const result = await waiting;
  assert.equal(result.inFlightRequests, 0); assert.equal(result.uncertainRequests, 0);
});

test("drain timeout fails the deployment command while leaving maintenance enabled", async t => {
  const admitted = deferred(); const release = deferred();
  const f = await fixture(t, async (_req, res) => { admitted.resolve(); await release.promise; res.end("complete"); });
  const saving = fetch(`${f.url}/api/data`, { method: "POST" }); await admitted.promise;
  await assert.rejects(controlMaintenance("on", { ...f.controlOptions, timeoutMs: 40 }), /Не продолжайте деплой/);
  assert.equal(JSON.parse(await readFile(f.stateFile, "utf8")).maintenance, true);
  release.resolve(); await saving;
});

test("ambiguous upstream failures are never retried or called safely drained", async t => {
  let writes = 0;
  const f = await fixture(t, (req) => { writes++; req.socket.destroy(); });
  const response = await fetch(`${f.url}/api/data`, { method: "POST" }); assert.equal(response.status, 503);
  assert.equal(writes, 1); assert.equal(f.gateway.snapshot().uncertainRequests, 1);
  await assert.rejects(controlMaintenance("on", f.controlOptions), /неизвестным результатом/);
  await assert.rejects(f.gateway.waitForDrain(), /Нельзя подтвердить/);
});

test("unhealthy off and forced maintenance fail without reopening the site", async t => {
  let healthy = false;
  const f = await fixture(t, (_req, res) => { res.writeHead(healthy ? 200 : 503); res.end("health"); });
  writeMaintenanceState(f.stateFile, true);
  await assert.rejects(controlMaintenance("off", f.controlOptions), /ещё не готово/);
  assert.equal(f.gateway.snapshot().maintenance, true);
  healthy = true; await controlMaintenance("off", f.controlOptions); assert.equal(f.gateway.snapshot().maintenance, false);
  const forced = await fixture(t, undefined, { forcedMaintenance: true }); writeMaintenanceState(forced.stateFile, true);
  await assert.rejects(controlMaintenance("off", forced.controlOptions), /MAINTENANCE_MODE/);
  assert.equal(JSON.parse(await readFile(forced.stateFile, "utf8")).maintenance, true);
});

test("unreadable maintenance state fails closed instead of admitting mutations", async t => {
  const f = await fixture(t);
  await writeFile(f.stateFile, "{not json");
  assert.equal((await fetch(`${f.url}/api/data`, { method: "POST" })).status, 503);
  assert.equal(f.gateway.snapshot().stateError, true);
});

test("off with a healthy backend but unavailable control never briefly reopens writes", async t => {
  const f = await fixture(t);
  writeMaintenanceState(f.stateFile, true);
  const observations = [];
  const timer = setInterval(() => observations.push(f.gateway.snapshot().maintenance), 5);
  try {
    await assert.rejects(controlMaintenance("off", { ...f.controlOptions, controlPort: await reservePort(), timeoutMs: 150 }));
    assert.equal(f.gateway.snapshot().maintenance, true);
    assert.ok(observations.every(Boolean));
  } finally { clearInterval(timer); }
});

test("archived lazy chunks remain available200 while pages and writes are in maintenance", async t => {
  const directory = await mkdtemp(join(tmpdir(), "personnel-gateway-static-"));
  const archiveRoot = join(directory, "static");
  await mkdir(join(archiveRoot, "chunks"), { recursive: true });
  await writeFile(join(archiveRoot, "chunks", "old-Ab12cd34.js"), "export const old=true;");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, undefined, { archiveRoot });
  writeMaintenanceState(f.stateFile, true);
  const asset = await fetch(`${f.url}/_next/static/chunks/old-Ab12cd34.js`);
  assert.equal(asset.status, 200); assert.equal(await asset.text(), "export const old=true;");
  assert.equal((await fetch(`${f.url}/reports/workers`)).status, 503);
  assert.equal((await fetch(`${f.url}/api/data`, { method: "POST" })).status, 503);
});

test("malformed absolute request targets return400 without crashing the gateway", async t => {
  const f = await fixture(t);
  const result = await new Promise((resolveResult, reject) => {
    const req = request({ hostname: "127.0.0.1", port: new URL(f.url).port, path: "http://[" }, res => { res.resume(); res.once("end", () => resolveResult(res.statusCode)); });
    req.on("error", reject); req.end();
  });
  assert.equal(result, 400);
  assert.equal((await fetch(`${f.url}/api/maintenance/status`)).status, 200);
});

async function reservePort() { const server = createServer(); const port = await listen(server); await close(server); return port; }
test("production listener starts before migration, backend remains private, and SIGTERM waits for admitted saves", async t => {
  const directory = await mkdtemp(join(tmpdir(), "personnel-production-test-"));
  await mkdir(join(directory, "dist/standalone/dist/client/_next/static/chunks"), { recursive: true });
  await writeFile(join(directory, "dist/standalone/dist/client/_next/static/chunks/test-Ab12cd34.js"), "export const ready=true;");
  await mkdir(join(directory, "public")); await writeFile(join(directory, "public/maintenance.html"), "<h1>Технические работы</h1>");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ports = new Set(); while (ports.size < 3) ports.add(await reservePort());
  const [port, backendPort, controlPort] = [...ports];
  const signals = new EventEmitter(); const migration = new EventEmitter(); let backend; let backendServer; let kills = 0; const save = deferred(); let admitted = false;
  const logs = [];
  const running = startProduction({ cwd: directory, env: { PORT: String(port), HOST: "127.0.0.1", MAINTENANCE_BACKEND_PORT: String(backendPort), MAINTENANCE_CONTROL_PORT: String(controlPort) }, signals, log: { log() {}, error: message => logs.push(message) }, spawnProcess(_node, args, options) {
    if (args[0].endsWith("apply-postgres-migrations.mjs")) return migration;
    assert.equal(args[0], join(directory, "dist/standalone/server.js"));
    assert.equal(options.env.HOST, "127.0.0.1"); assert.equal(options.env.PORT, String(backendPort));
    backend = new EventEmitter();
    backendServer = createServer(async (req, res) => { if (req.url !== "/api/health") { admitted = true; await save.promise; } res.end('{"status":"ok"}'); });
    backendServer.listen(backendPort, "127.0.0.1");
    backend.kill = () => { kills++; backendServer.closeIdleConnections(); backendServer.close(() => backend.emit("exit", 0)); return true; };
    return backend;
  } });
  const url = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(`${url}/api/maintenance/status`)).ok; } catch { return false; } });
  assert.equal((await fetch(`${url}/reports/workers`)).status, 503); assert.equal(backend, undefined);
  migration.emit("exit", 0);
  await until(async () => (await (await fetch(`${url}/api/maintenance/status`)).json()).phase === "ready");
  const response = fetch(`${url}/api/data`, { method: "POST" }); await until(() => admitted);
  signals.emit("SIGTERM");
  assert.equal((await fetch(`${url}/api/data`, { method: "POST" })).status, 503); assert.equal(kills, 0);
  save.resolve(); assert.equal((await response).status, 200); assert.equal(await running, 0);
  assert.equal(kills, 1); assert.deepEqual(logs, []);
});

test("production health monitor recovers a transient proxy failure without clearing the manual maintenance switch or uncertain requests", async t => {
  const directory = await mkdtemp(join(tmpdir(), "personnel-production-recovery-"));
  await mkdir(join(directory, "dist/client/_next/static/chunks"), { recursive: true });
  await writeFile(join(directory, "dist/client/_next/static/chunks/test-Ab12cd34.js"), "export const ready=true;");
  await mkdir(join(directory, "public")); await writeFile(join(directory, "public/maintenance.html"), "<h1>Технические работы</h1>");
  await writeFile(join(directory, "server.js"), "// Standalone image layout");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ports = new Set(); while (ports.size < 3) ports.add(await reservePort());
  const [port, backendPort, controlPort] = [...ports];
  const stateFile = join(directory, "maintenance.json");
  let backend; let backendServer;
  const running = startProduction({ cwd: directory, env: { PORT: String(port), HOST: "127.0.0.1", MAINTENANCE_BACKEND_PORT: String(backendPort), MAINTENANCE_CONTROL_PORT: String(controlPort), MAINTENANCE_STATE_FILE: stateFile }, signals: new EventEmitter(), log: { log() {}, error() {} }, spawnProcess(_node, args) {
    const child = new EventEmitter();
    if (args[0].endsWith("apply-postgres-migrations.mjs")) { queueMicrotask(() => child.emit("exit", 0)); return child; }
    assert.equal(args[0], join(directory, "server.js"));
    backend = child;
    backendServer = createServer((req, res) => { if (req.url === "/api/transient") req.socket.destroy(); else res.end('{"status":"ok"}'); });
    backendServer.listen(backendPort, "127.0.0.1");
    child.kill = () => { backendServer.closeIdleConnections(); backendServer.close(() => child.emit("exit", 1)); return true; };
    return child;
  } });
  const url = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await (await fetch(`${url}/api/maintenance/status`)).json()).phase === "ready"; } catch { return false; } });
  assert.equal((await fetch(`${url}/api/transient`, { method: "POST" })).status, 503);
  assert.equal((await (await fetch(`${url}/api/maintenance/status`)).json()).phase, "unavailable");
  writeMaintenanceState(stateFile, true);
  await until(async () => (await (await fetch(`${url}/api/maintenance/status`)).json()).phase === "maintenance", 5000);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  const control = await (await fetch(`http://127.0.0.1:${controlPort}/status`)).json();
  assert.equal(control.backendReady, true); assert.equal(control.maintenance, true); assert.equal(control.uncertainRequests, 1);
  backend.kill(); assert.equal(await running, 1);
});
