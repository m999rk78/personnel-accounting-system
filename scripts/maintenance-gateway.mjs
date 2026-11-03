import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { serveMaintenanceAsset } from "./maintenance-assets.mjs";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const PHASES = new Set(["starting", "stopping", "ready", "unavailable"]);
export const defaultMaintenanceStateFile = (cwd = process.cwd()) => resolve(cwd, ".runtime/maintenance.json");

export function writeMaintenanceState(path, maintenance) {
  const value = { maintenance, revision: randomUUID() };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${value.revision}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return value;
}

function readMaintenanceState(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value.maintenance !== "boolean" || typeof value.revision !== "string") throw new Error("Invalid maintenance state");
    return { ...value, stateError: false };
  } catch (error) {
    if (error.code === "ENOENT") return { maintenance: false, revision: null, stateError: false };
    // A damaged or unreadable switch must never silently reopen writes.
    return { maintenance: true, revision: null, stateError: true };
  }
}

function copyHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())));
}
function requestPath(url) {
  try { return new URL(url ?? "/", "http://localhost").pathname; }
  catch { return null; }
}

export function createMaintenanceGateway({ upstream, stateFile, html, htmlPath, archiveRoot, forcedMaintenance = false, initialPhase = "starting", retryAfterSeconds = 5 }) {
  const target = new URL(upstream);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) throw new Error("Backend must use loopback HTTP.");
  const page = html ?? readFileSync(htmlPath, "utf8");
  let phase = initialPhase;
  let activeWrites = 0;
  let activeRequests = 0;
  let uncertainWrites = 0;
  let uncertainRequests = 0;
  let closing = false;
  let closeTask;
  const sockets = new Set();
  const state = () => {
    const disk = readMaintenanceState(stateFile);
    const maintenance = forcedMaintenance || disk.maintenance || phase !== "ready";
    return { ...disk, maintenance, phase: phase === "ready" && (forcedMaintenance || disk.maintenance) ? "maintenance" : phase, backendReady: phase === "ready", forcedMaintenance, inFlightRequests: activeRequests, inFlightWrites: activeWrites, uncertainWrites, uncertainRequests, retryAfterSeconds };
  };
  const headers = { "Cache-Control": "no-store, max-age=0", "Retry-After": String(retryAfterSeconds), "X-Personnel-Maintenance": "1" };
  const json = (res, body, status = 200, extra = {}) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }); res.end(JSON.stringify(body)); };
  const unavailable = (req, res) => {
    if (res.headersSent) { res.destroy(); return; }
    const path = requestPath(req.url) ?? "/";
    if (path.startsWith("/api/")) return json(res, { code: "MAINTENANCE", error: "Сейчас ведутся технические работы. Доступ к сайту скоро возобновится.", maintenance: true }, 503, headers);
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", ...headers });
    res.end(req.method === "HEAD" ? undefined : page);
  };
  const server = createServer((req, res) => {
    const pathname = requestPath(req.url);
    if (pathname === null) return json(res, { error: "Некорректный адрес запроса." }, 400);
    if (pathname === "/__maintenance/control" || pathname.startsWith("/__maintenance/control/")) return json(res, { error: "Not found" }, 404);
    // A lazy import already started by an open tab must still receive its code.
    if (archiveRoot && serveMaintenanceAsset(req, res, { archiveRoot })) return;
    const snapshot = state();
    if (pathname === "/api/maintenance/status" && ["GET", "HEAD"].includes(req.method)) return json(res, { maintenance: snapshot.maintenance, phase: snapshot.phase, retryAfterSeconds });
    const health = pathname === "/api/health" && ["GET", "HEAD"].includes(req.method);
    if (closing || snapshot.maintenance && !health || phase !== "ready") return unavailable(req, res);
    const unsafe = UNSAFE.has(req.method);
    activeRequests++;
    if (unsafe) activeWrites++;
    let finished = false;
    const finish = (uncertain = false) => {
      if (finished) return;
      finished = true;
      activeRequests--;
      if (uncertain && !health) uncertainRequests++;
      if (unsafe) { activeWrites--; if (uncertain) uncertainWrites++; }
    };
    const proxy = httpRequest(target, { method: req.method, path: req.url, headers: copyHeaders(req.headers) }, response => {
      if (!res.destroyed) res.writeHead(response.statusCode ?? 502, copyHeaders(response.headers));
      response.on("end", () => finish());
      response.on("aborted", () => { finish(true); if (!res.destroyed) res.destroy(); });
      response.on("error", () => { finish(true); if (!res.destroyed) res.destroy(); });
      // Keep consuming upstream even if the browser disconnects. Its write may
      // still be running, and the deployment must wait for its actual response.
      response.pipe(res);
      res.once("close", () => { response.unpipe(res); response.resume(); });
    });
    proxy.on("error", () => { finish(true); if (phase === "ready") phase = "unavailable"; unavailable(req, res); });
    req.on("aborted", () => { if (!req.complete) proxy.destroy(); });
    req.on("error", () => { if (!req.complete) proxy.destroy(); });
    req.pipe(proxy);
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const control = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/status") return json(res, { error: "Not found" }, 404);
    json(res, state());
  });
  const listen = (listener, port, host) => new Promise((resolveListen, reject) => { listener.once("error", reject); listener.listen(port, host, () => { listener.off("error", reject); resolveListen(listener.address()); }); });
  return {
    server, control, snapshot: state,
    setPhase(next) { if (!PHASES.has(next)) throw new Error("Unknown gateway phase"); phase = next; },
    async listen({ port, host = "0.0.0.0", controlPort }) {
      const address = await listen(server, port, host);
      try { const controlAddress = await listen(control, controlPort, "127.0.0.1"); return { address, controlAddress }; }
      catch (error) { await new Promise(resolveClose => server.close(resolveClose)); throw error; }
    },
    async waitForDrain({ timeoutMs = 120000 } = {}) {
      const started = Date.now();
      while (activeRequests) {
        if (timeoutMs > 0 && Date.now() - started >= timeoutMs) throw new Error(`Запросы не завершились: ${activeRequests}. Режим технических работ остаётся включённым.`);
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      if (uncertainRequests) throw new Error(`Нельзя подтвердить завершение ${uncertainRequests} запросов после обрыва соединения с приложением.`);
    },
    async close() {
      if (closeTask) return closeTask;
      closing = true;
      server.closeIdleConnections(); control.closeIdleConnections();
      closeTask = Promise.all([server, control].map(listener => new Promise(resolveClose => listener.close(resolveClose))));
      return closeTask;
    },
    destroyConnections() { for (const socket of sockets) socket.destroy(); },
  };
}
