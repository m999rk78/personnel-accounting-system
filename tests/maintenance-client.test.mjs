import assert from "node:assert/strict";
import test from "node:test";
import { createMaintenanceClient, MAINTENANCE_STATUS_PATH } from "../app/maintenanceClient.ts";

const ready = () => Response.json({ maintenance: false, phase: "ready", retryAfterSeconds: 5 });
const work = () => Response.json({ code: "MAINTENANCE", maintenance: true, error: "Работы" }, { status: 503 });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup(request, timeoutMs) {
  const changes = []; let resumes = 0;
  const client = createMaintenanceClient({ request, origin: "https://example.invalid", onChange: state => changes.push(state), onReady: () => resumes++, timeoutMs });
  return { client, changes, resumes: () => resumes };
}

test("healthy writes keep their original body and are forwarded exactly once", async () => {
  const calls = [];
  const { client } = setup(async (input, init) => { calls.push({ input, init }); return Response.json({ saved: true }); });
  const init = { method: "POST", body: JSON.stringify({ row: 8 }), headers: { "Content-Type": "application/json" } };
  const response = await client.fetch("/api/timesheet", init);
  assert.deepEqual(await response.json(), { saved: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].init, init);
  assert.deepEqual(client.snapshot(), { kind: null, checking: false });
  client.stop();
});

test("maintenance response is readable and new API writes and reads are blocked without replay", async () => {
  const calls = [];
  const { client, resumes } = setup(async input => { calls.push(String(input)); return String(input).endsWith(MAINTENANCE_STATUS_PATH) ? ready() : work(); });
  const response = await client.fetch("/api/data", { method: "POST", body: "synthetic" });
  assert.equal((await response.json()).code, "MAINTENANCE");
  assert.equal(client.snapshot().kind, "maintenance");
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const blocked = await client.fetch("/api/data", { method });
    assert.equal(blocked.status, 503); assert.equal((await blocked.json()).maintenance, true);
  }
  assert.equal(calls.length, 1);
  await client.check();
  assert.equal(calls.length, 2); assert.equal(resumes(), 1);
  assert.equal(client.snapshot().kind, null);
  assert.equal(calls.filter(url => url === "/api/data").length, 1, "Recovery does not resend an ambiguous write");
  client.stop();
});

test("a ready probe started before a failed write cannot dismiss the maintenance screen", async () => {
  const probe = deferred(); const writing = deferred(); let probes = 0;
  const { client, resumes } = setup(input => String(input).endsWith(MAINTENANCE_STATUS_PATH) ? (++probes === 1 ? probe.promise : Promise.resolve(ready())) : writing.promise);
  const save = client.fetch("/api/personnel-report", { method: "POST" });
  const checking = client.check();
  writing.resolve(work()); await save;
  probe.resolve(ready()); await checking;
  assert.equal(client.snapshot().kind, "maintenance"); assert.equal(resumes(), 0);
  await client.check(); assert.equal(client.snapshot().kind, null); assert.equal(resumes(), 1);
  client.stop();
});

test("a maintenance incident does not abort another already started save", async () => {
  const first = deferred(); const second = deferred(); let calls = 0;
  const abort = new AbortController();
  const { client } = setup(() => (++calls === 1 ? first.promise : second.promise));
  const saving = client.fetch("/api/equipment", { method: "POST", signal: abort.signal });
  const other = client.fetch("/api/timesheet", { method: "POST" });
  second.resolve(work()); await other;
  assert.equal(abort.signal.aborted, false);
  first.resolve(Response.json({ mark: { hours: 8 } }));
  assert.deepEqual(await (await saving).json(), { mark: { hours: 8 } });
  assert.equal(calls, 2); assert.equal(client.snapshot().kind, "maintenance");
  client.stop();
});

test("HTML proxy failures become JSON503 rather than corrupting catalog parsing", async () => {
  for (const status of [500, 502, 503, 504]) {
    const { client } = setup(async () => new Response("<!doctype html><h1>Restarting</h1>", { status, headers: { "Content-Type": "text/html" } }));
    const result = await client.fetch("/api/data?scope=settings");
    assert.equal(result.status, 503); assert.equal((await result.json()).maintenance, true);
    assert.equal(client.snapshot().kind, "unavailable"); client.stop();
  }
});

test("network failure freezes new writes and never retries the failed write", async () => {
  let calls = 0;
  const { client } = setup(async () => { calls++; throw new TypeError("Network unavailable"); });
  await assert.rejects(client.fetch("/api/data", { method: "POST" }), TypeError);
  assert.equal(client.snapshot().kind, "unavailable");
  assert.equal((await client.fetch("/api/data", { method: "POST" })).status, 503);
  assert.equal(calls, 1); client.stop();
});

test("normal validation/auth errors and intentionally cancelled reads do not freeze the app", async () => {
  for (const status of [400, 401, 403, 409, 422, 500]) {
    const { client } = setup(async () => Response.json({ error: "Rejected" }, { status }));
    assert.equal((await client.fetch("/api/data")).status, status);
    assert.equal(client.snapshot().kind, null); client.stop();
  }
  const { client } = setup(async () => { throw new DOMException("Cancelled", "AbortError"); });
  await assert.rejects(client.fetch("/api/data"), { name: "AbortError" });
  assert.equal(client.snapshot().kind, null); client.stop();
});

test("external requests and the status route bypass API gating", async () => {
  const calls = [];
  const { client } = setup(async input => { calls.push(String(input)); return Response.json({ ok: true }); });
  client.unavailable();
  assert.equal((await client.fetch("https://other.invalid/api/data", { method: "POST" })).status, 200);
  assert.equal((await client.fetch(MAINTENANCE_STATUS_PATH)).status, 200);
  assert.equal(calls.length, 2); client.stop();
});

test("probes are single flight and missing or unavailable status never unfreezes editors", async () => {
  const probe = deferred(); let calls = 0;
  const { client } = setup(async () => { calls++; return probe.promise; });
  client.unavailable();
  const one = client.check(); assert.equal(one, client.check()); assert.equal(calls, 1);
  probe.resolve(Response.json({ phase: "ready" })); await one;
  assert.equal(client.snapshot().kind, "unavailable"); client.stop();
  for (const phase of ["starting", "maintenance", "stopping", "unavailable"]) {
    const { client: other } = setup(async () => Response.json({ maintenance: phase !== "unavailable", phase }));
    await other.check(); assert.equal(other.snapshot().kind, phase === "unavailable" ? "unavailable" : "maintenance"); other.stop();
  }
});

test("probe timeout and unmount abort only the probe, never a mutation", async () => {
  const { client } = setup((_input, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")))), 5);
  await client.check(); assert.equal(client.snapshot().kind, "unavailable"); client.stop();
  const mutation = deferred(); let probeSignal;
  const { client: other, changes } = setup((input, init) => {
    if (String(input).endsWith(MAINTENANCE_STATUS_PATH)) { probeSignal = init.signal; return new Promise((_, reject) => probeSignal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")))); }
    return mutation.promise;
  });
  const save = other.fetch("/api/data", { method: "POST" }); const checking = other.check();
  other.stop(); await checking; assert.equal(probeSignal.aborted, true);
  mutation.resolve(Response.json({ saved: true })); assert.equal((await save).status, 200);
  assert.deepEqual(changes, []);
});
