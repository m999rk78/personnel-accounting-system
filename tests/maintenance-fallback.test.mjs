import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { createMaintenanceFallbackServer } from "../scripts/maintenance-fallback.mjs";

const HTML = "<!doctype html><html lang='ru'><title>Технические работы</title><body>Скоро вернёмся</body></html>";

async function withFallback(run, options = {}) {
  const server = createMaintenanceFallbackServer({ html: HTML, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
}

test("independent fallback serves old public chunks200 during a complete application gap", async () => {
  const archiveRoot = await mkdtemp(join(tmpdir(), "personnel-fallback-static-"));
  try {
    await mkdir(join(archiveRoot, "chunks"));
    await writeFile(join(archiveRoot, "chunks", "old-Ab12cd34.js"), "export const old=true;");
    await withFallback(async origin => {
      const response = await fetch(`${origin}/_next/static/chunks/old-Ab12cd34.js`);
      assert.equal(response.status, 200); assert.equal(await response.text(), "export const old=true;");
      assert.match(response.headers.get("cache-control"), /immutable/);
      assert.equal((await fetch(`${origin}/_next/static/chunks/missing-Ab12cd34.js`)).status, 404);
      assert.equal((await fetch(`${origin}/api/data`, { method: "POST" })).status, 503);
      assert.equal((await (await fetch(`${origin}/api/maintenance/status`)).json()).maintenance, true);
    }, { archiveRoot });
  } finally { await rm(archiveRoot, { recursive: true, force: true }); }
});

test("independent fallback serves self-contained HTML with an explicit uncached 503", async () => {
  await withFallback(async origin => {
    const response = await fetch(`${origin}/reports/workers?date=2026-11-02`);
    assert.equal(response.status, 503);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(response.headers.get("x-personnel-maintenance"), "1");
    assert.equal(await response.text(), HTML);
    assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
    const head = await fetch(`${origin}/settings/general`, { method: "HEAD" });
    assert.equal(head.status, 503);
    assert.equal(await head.text(), "");
  });
});

test("API writes are rejected as JSON and never reflected or processed", async () => {
  await withFallback(async origin => {
    const secret = "synthetic-secret-do-not-reflect";
    const response = await fetch(`${origin}/api/equipment`, {
      method: "POST", headers: { Authorization: secret, Cookie: `test=${secret}` }, body: JSON.stringify({ note: secret }),
    });
    assert.equal(response.status, 503);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.text();
    assert.equal(body.includes(secret), false);
    assert.equal(JSON.parse(body).code, "MAINTENANCE");
    assert.equal((await fetch(`${origin}/api/health`)).status, 503);
  });
});

test("status keeps existing pages blocked while only fallback process health is healthy", async () => {
  await withFallback(async origin => {
    const response = await fetch(`${origin}/api/maintenance/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { maintenance: true, phase: "unavailable", retryAfterSeconds: 5 });
    assert.deepEqual(await (await fetch(`${origin}/health`)).json(), { status: "ok" });
    assert.equal((await fetch(`${origin}/health`, { method: "POST" })).status, 503);
  });
});

test("Traefik errors wrapper preserves API JSON and strips original sensitive URL content", async () => {
  await withFallback(async origin => {
    const secret = "synthetic-query-secret";
    for (const original of [`/api/personnel-report?token=${secret}`, `https://resurs-otchet.ru/api/data?token=${secret}`, encodeURIComponent(`/api/timesheet?token=${secret}`)]) {
      const response = await fetch(`${origin}/maintenance?request=${encodeURIComponent(original)}`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "MAINTENANCE");
    }
    const status = await fetch(`${origin}/maintenance?request=${encodeURIComponent("/api/maintenance/status")}`);
    assert.equal((await status.json()).maintenance, true);
    const page = await fetch(`${origin}/maintenance?request=${encodeURIComponent(`/reports/workers?token=${secret}`)}`);
    assert.equal(await page.text(), HTML);
  });
});

test("malformed request targets cannot crash the independent responder", async () => {
  await withFallback(async origin => {
    const status = await new Promise((resolveStatus, reject) => {
      const req = request(origin, { path: "http://[", method: "GET" }, response => {
        response.resume(); response.once("end", () => resolveStatus(response.statusCode));
      });
      req.once("error", reject); req.end();
    });
    assert.equal(status, 503);
    assert.equal((await fetch(`${origin}/health`)).status, 200);
  });
});

test("fallback configuration is private, independent and restricted to personnel domains", async () => {
  const compose = await readFile(new URL("../ops/maintenance/compose.yml", import.meta.url), "utf8");
  const traefik = await readFile(new URL("../ops/maintenance/traefik.yml", import.meta.url), "utf8");
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /external: true/);
  const rules = [...traefik.matchAll(/^\s+rule: (.+)$/gm)].map(match => match[1]);
  assert.equal(rules.length, 3);
  assert.equal(rules.filter(rule => rule === "Host(`resurs-otchet.ru`) || Host(`www.resurs-otchet.ru`)").length, 2);
  assert.ok(rules.every(rule => rule.includes("Host(`resurs-otchet.ru`)") && rule.includes("Host(`www.resurs-otchet.ru`)")));
  assert.match(rules[0], /PathPrefix\(`\/_next\/static\/`\).*Method\(`GET`\).*Method\(`HEAD`\)/);
  assert.equal([...traefik.matchAll(/^\s+priority: 1$/gm)].length, 2);
  const chain = traefik.match(/^ {4}personnel-maintenance-errors:\n {6}chain:\n {8}middlewares:\n((?: {10}- [^\n]+\n)+)/m);
  assert.ok(chain, "The router's existing middleware name must keep the filtering chain.");
  assert.deepEqual([...chain[1].matchAll(/- (.+)/g)].map(match => match[1]), ["personnel-maintenance-drop-marker", "personnel-maintenance-errors-handler"]);
  assert.match(traefik, /^ {4}personnel-maintenance-drop-marker:\n {6}headers:\n {8}customRequestHeaders:\n {10}X-Personnel-Maintenance-Request: ""$/m);
  assert.match(traefik, /^ {4}personnel-maintenance-errors-handler:\n {6}errors:/m);
  const whitelist = traefik.match(/^ {8}errorRequestHeaders:\n((?: {10}- [^\n]+\n)+)/m);
  assert.ok(whitelist, "A nonempty whitelist must survive Coolify's YAML normalization.");
  assert.deepEqual([...whitelist[1].matchAll(/- (.+)/g)].map(match => match[1]), ["X-Personnel-Maintenance-Request"]);
  assert.equal([...traefik.matchAll(/errorRequestHeaders:/g)].length, 1);
  assert.doesNotMatch(traefik, /HostRegexp/);
  assert.match(compose, /PERSONNEL_STATIC_ARCHIVE/);
  assert.match(compose, /target: \/opt\/maintenance\/static/);
  const dockerfile = await readFile(new URL("../ops/maintenance/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /USER 1001:1001/);
});
