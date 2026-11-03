import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultMaintenanceStateFile, writeMaintenanceState } from "./maintenance-gateway.mjs";

export async function controlMaintenance(action, { stateFile = process.env.MAINTENANCE_STATE_FILE ?? defaultMaintenanceStateFile(), publicPort = Number(process.env.PORT ?? 8080), controlPort = Number(process.env.MAINTENANCE_CONTROL_PORT ?? Number(process.env.PORT ?? 8080) + 2), timeoutMs = Number(process.env.MAINTENANCE_DRAIN_TIMEOUT_MS ?? 120000) } = {}) {
  if (!["on", "off", "status"].includes(action)) throw new Error("Используйте maintenance-control.mjs on | off | status.");
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535 || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Некорректный порт или таймаут управления.");
  // Never reopen a deployment whose new backend is not actually healthy.
  if (action === "off") {
    // Verify the acknowledgement channel before changing the shared switch.
    // A wrong control port must never briefly reopen production traffic.
    try {
      const response = await fetch(`http://127.0.0.1:${controlPort}/status`, { signal: AbortSignal.timeout(Math.min(2000, timeoutMs)), cache: "no-store" });
      const status = response.ok ? await response.json() : null;
      if (!status?.backendReady || status.stateError) throw new Error("Приложение ещё не готово.");
      if (status.forcedMaintenance) throw new Error("Режим принудительно включён через MAINTENANCE_MODE.");
      if (status.uncertainRequests) throw new Error("Есть запросы с неизвестным результатом.");
    } catch (error) {
      writeMaintenanceState(stateFile, true);
      throw new Error(`${error.message} Режим технических работ остаётся включённым.`);
    }
    try {
      const health = await fetch(`http://127.0.0.1:${publicPort}/api/health`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
      await health.body?.cancel();
      if (!health.ok) throw new Error("Not ready");
    } catch {
      writeMaintenanceState(stateFile, true);
      throw new Error("Приложение ещё не готово. Режим технических работ остаётся включённым.");
    }
  }
  const desired = action === "status" ? null : writeMaintenanceState(stateFile, action === "on");
  const started = Date.now();
  let lastError;
  do {
    try {
      const response = await fetch(`http://127.0.0.1:${controlPort}/status`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
      if (!response.ok) throw new Error("Управляющий сервер недоступен.");
      const status = await response.json();
      if (!desired) return status;
      if (status.revision === desired.revision) {
        if (action === "off" && status.forcedMaintenance) throw new Error("Режим принудительно включён через MAINTENANCE_MODE. Измените переменную и перезапустите приложение.");
        if (status.stateError) throw new Error("Файл состояния недоступен приложению.");
        if (status.uncertainRequests) throw new Error("Есть запросы с неизвестным результатом. Развёртывание остановлено; проверьте их завершение.");
        if (action === "off" || status.inFlightRequests === 0) return status;
      }
    } catch (error) {
      lastError = error;
      if (action === "off") { writeMaintenanceState(stateFile, true); throw error; }
      if (error.message.includes("MAINTENANCE_MODE") || error.message.includes("неизвестным результатом")) {
        if (action === "off") writeMaintenanceState(stateFile, true);
        throw error;
      }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  } while (Date.now() - started < timeoutMs);
  if (action === "off") writeMaintenanceState(stateFile, true);
  throw new Error(`Не удалось дождаться безопасной остановки записи. Не продолжайте деплой. ${lastError?.message ?? "Запросы ещё выполняются."}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const action = process.argv[2] ?? "status";
    const status = await controlMaintenance(action);
    console.log(action === "status" ? JSON.stringify(status) : action === "on" ? "Технические работы включены. Принятые сохранения завершены; можно начинать работы." : "Ручной режим технических работ выключен. Доступ откроется после готовности приложения.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
