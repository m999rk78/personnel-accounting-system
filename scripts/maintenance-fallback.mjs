import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serveMaintenanceAsset } from "./maintenance-assets.mjs";

const STATUS_PATH = "/api/maintenance/status";

// Traefik supplies the escaped original URL for an errors-middleware request.
// It is used only to choose HTML versus JSON, never logged, echoed or fetched.
function originalPath(value) {
  let candidate = value ?? "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const pathname = new URL(candidate, "http://maintenance.invalid").pathname;
      if (pathname === "/api" || pathname.startsWith("/api/")) return pathname;
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return pathname;
      candidate = decoded;
    } catch { return ""; }
  }
  return "";
}

export function createMaintenanceFallbackServer({ html, archiveRoot, retryAfterSeconds = 5 }) {
  if (typeof html !== "string" || !html.trim()) throw new Error("Maintenance HTML is required.");
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 3600) throw new Error("Invalid retry interval.");
  const server = createServer((request, response) => {
    let url;
    try { url = new URL(request.url ?? "/", "http://maintenance.invalid"); }
    catch { url = new URL("http://maintenance.invalid/"); }
    if (archiveRoot && serveMaintenanceAsset(request, response, { archiveRoot })) return;
    if (url.pathname.startsWith("/_next/static/")) { response.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain" }); response.end(request.method === "HEAD" ? undefined : "Not found"); return; }
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    const sendJson = (status, payload) => {
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : JSON.stringify(payload));
    };
    // This probes only the fallback process, not application/database readiness.
    if (url.pathname === "/health" && ["GET", "HEAD"].includes(request.method)) return sendJson(200, { status: "ok" });
    response.setHeader("Retry-After", String(retryAfterSeconds));
    response.setHeader("X-Personnel-Maintenance", "1");
    request.resume(); // Discard any body without buffering or processing it.
    const path = url.pathname === "/maintenance" ? originalPath(url.searchParams.get("request")) : url.pathname;
    if (path === STATUS_PATH && ["GET", "HEAD"].includes(request.method)) {
      return sendJson(200, { maintenance: true, phase: "unavailable", retryAfterSeconds });
    }
    if (path === "/api" || path.startsWith("/api/")) {
      return sendJson(503, { code: "MAINTENANCE", maintenance: true, error: "Сейчас ведутся технические работы. Доступ скоро возобновится." });
    }
    response.statusCode = 503;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    response.end(request.method === "HEAD" ? undefined : html);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function startMaintenanceFallback({
  port = Number(process.env.MAINTENANCE_FALLBACK_PORT ?? process.env.PORT ?? 8099),
  host = process.env.HOST ?? "0.0.0.0",
  htmlPath = new URL("../public/maintenance.html", import.meta.url),
  archiveRoot = process.env.MAINTENANCE_STATIC_ARCHIVE,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid fallback port.");
  const html = await readFile(htmlPath, "utf8");
  const server = createMaintenanceFallbackServer({ html, archiveRoot });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.removeListener("error", reject); resolveListen(); });
  });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = await startMaintenanceFallback();
  console.info("Independent maintenance fallback is listening.");
  const stop = () => {
    const forceClose = setTimeout(() => server.closeAllConnections(), 10_000);
    forceClose.unref();
    server.close(() => clearTimeout(forceClose));
    server.closeIdleConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
