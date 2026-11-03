import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { existsSync } from "node:fs";
import { createMaintenanceGateway, defaultMaintenanceStateFile } from "./maintenance-gateway.mjs";
import { archiveMaintenanceAssets, maintenanceAssetsRoot } from "./maintenance-assets.mjs";

function positiveInteger(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Некорректный порт или таймаут production-сервера.");
  return parsed;
}

export async function startProduction({ cwd = process.cwd(), env = process.env, spawnProcess = spawn, signals = process, log = console } = {}) {
  const port = positiveInteger(env.PORT, 8080);
  const backendPort = positiveInteger(env.MAINTENANCE_BACKEND_PORT, port + 1);
  const controlPort = positiveInteger(env.MAINTENANCE_CONTROL_PORT, port + 2);
  if (new Set([port, backendPort, controlPort]).size !== 3 || Math.max(port, backendPort, controlPort) > 65535) throw new Error("Production-порты должны различаться.");
  const drainTimeoutMs = positiveInteger(env.MAINTENANCE_DRAIN_TIMEOUT_MS, 120000);
  const startupTimeoutMs = positiveInteger(env.MAINTENANCE_STARTUP_TIMEOUT_MS, 120000);
  const upstream = `http://127.0.0.1:${backendPort}`;
  const stateFile = env.MAINTENANCE_STATE_FILE ?? defaultMaintenanceStateFile(cwd);
  const archiveRoot = maintenanceAssetsRoot(stateFile);
  const backendScript = existsSync(resolve(cwd, "server.js")) ? "server.js" : "dist/standalone/server.js";
  const buildRoot = backendScript === "server.js" ? cwd : resolve(cwd, "dist/standalone");
  const gateway = createMaintenanceGateway({ upstream, stateFile, archiveRoot, htmlPath: resolve(cwd, "public/maintenance.html"), forcedMaintenance: /^(?:1|true|on)$/i.test(env.MAINTENANCE_MODE ?? "") });
  let backend;
  let migrationDone = Promise.resolve();
  let backendDone;
  let stopped = false;
  let stopTask;
  let stopFailed = false;
  let readinessTimer;
  const launch = (script, childEnv = env) => {
    const child = spawnProcess(process.execPath, [resolve(cwd, script)], { cwd, env: childEnv, stdio: "inherit" });
    const done = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    return { child, done };
  };
  const probe = async () => {
    try { const response = await fetch(`${upstream}/api/health`, { signal: AbortSignal.timeout(1500), cache: "no-store" }); await response.body?.cancel(); return response.ok; }
    catch { return false; }
  };
  const shutdown = () => {
    if (stopTask) return stopTask;
    stopped = true;
    gateway.setPhase("stopping");
    if (readinessTimer) clearInterval(readinessTimer);
    stopTask = (async () => {
      // A migration owns a transaction/lock; do not kill it halfway through.
      await migrationDone.catch(() => {});
      try { await gateway.waitForDrain({ timeoutMs: drainTimeoutMs }); }
      catch (error) {
        stopFailed = true;
        log.error(error.message);
        // Leave the backend alive rather than claim it is safe to interrupt it.
        try { await gateway.waitForDrain({ timeoutMs: 0 }); }
        catch { return; }
      }
      if (backend) { backend.kill("SIGTERM"); await backendDone.catch(() => {}); }
      await gateway.close();
    })();
    return stopTask;
  };
  const onSignal = () => { void shutdown(); };
  signals.on("SIGINT", onSignal); signals.on("SIGTERM", onSignal);
  try {
    await gateway.listen({ port, host: env.HOST ?? "0.0.0.0", controlPort });
    log.log(`Production gateway listening on ${port}; application is starting.`);
    archiveMaintenanceAssets({ sourceRoot: resolve(buildRoot, "dist/client/_next/static"), archiveRoot });
    const migration = launch("scripts/apply-postgres-migrations.mjs");
    migrationDone = migration.done.then(({ code, signal }) => { if (code !== 0) throw new Error(`Миграции завершились с кодом ${code ?? signal ?? "неизвестно"}.`); });
    await migrationDone;
    if (stopped) { await stopTask; return stopFailed ? 1 : 0; }
    const running = launch(backendScript, { ...env, HOST: "127.0.0.1", PORT: String(backendPort) });
    backend = running.child; backendDone = running.done;
    let exited = false;
    void backendDone.then(() => { exited = true; if (!stopped) gateway.setPhase("unavailable"); }, () => { exited = true; if (!stopped) gateway.setPhase("unavailable"); });
    const started = Date.now();
    while (!stopped && !exited && !await probe()) {
      if (Date.now() - started > startupTimeoutMs) throw new Error("Приложение не прошло проверку готовности за отведённое время.");
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    if (!stopped && !exited) gateway.setPhase("ready");
    let checking = false;
    readinessTimer = setInterval(() => {
      if (checking || stopped || exited) return;
      checking = true;
      void probe().then(ready => { if (!stopped && !exited) gateway.setPhase(ready ? "ready" : "unavailable"); }).finally(() => { checking = false; });
    }, 2000);
    const exit = await backendDone;
    if (stopped) { await stopTask; return stopFailed ? 1 : 0; }
    log.error(`Приложение остановилось: ${exit.code ?? exit.signal ?? "неизвестная причина"}.`);
    return 1;
  } catch (error) {
    gateway.setPhase("unavailable");
    log.error(error instanceof Error ? error.message : "Не удалось запустить приложение.");
    // No application requests are admitted before readiness, so stopping an
    // unsuccessful startup cannot interrupt an accepted user write.
    if (backend && !stopped) { backend.kill("SIGTERM"); await backendDone.catch(() => {}); }
    return 1;
  } finally {
    if (readinessTimer) clearInterval(readinessTimer);
    signals.off("SIGINT", onSignal); signals.off("SIGTERM", onSignal);
    await gateway.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await startProduction();
