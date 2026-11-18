export const MAINTENANCE_READY_EVENT = "personnel-maintenance-ready";
export const MAINTENANCE_STATUS_PATH = "/api/maintenance/status";

export type MaintenanceKind = "maintenance" | "unavailable";
export type MaintenanceSnapshot = { kind: MaintenanceKind | null; checking: boolean };
type Fetch = typeof fetch;

const temporaryMessage = "Сейчас ведутся технические работы. Доступ к системе скоро возобновится. Введённые данные остаются в открытой вкладке.";
const unavailableMessage = "Временно нет связи с сервером. Проверяем соединение. Введённые данные остаются в открытой вкладке.";

function temporaryResponse(kind: MaintenanceKind) {
  return Response.json({ error: kind === "maintenance" ? temporaryMessage : unavailableMessage, code: kind === "maintenance" ? "MAINTENANCE" : "SERVICE_UNAVAILABLE", maintenance: true }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "5", "X-Personnel-Maintenance": "1" },
  });
}

/** Keeps open editors alive. Requests already sent are never cancelled or replayed. */
export function createMaintenanceClient({ request, origin, onChange, onReady, timeoutMs = 5000 }: {
  request: Fetch;
  origin: string;
  onChange: (state: MaintenanceSnapshot) => void;
  onReady: () => void;
  timeoutMs?: number;
}) {
  let state: MaintenanceSnapshot = { kind: null, checking: false };
  let incident = 0;
  let stopped = false;
  let pendingCheck: Promise<void> | null = null;
  let statusAbort: AbortController | null = null;
  let inconclusiveChecks = 0;

  const update = (next: MaintenanceSnapshot) => {
    if (stopped || next.kind === state.kind && next.checking === state.checking) return;
    state = next;
    onChange(state);
  };
  const announce = (kind: MaintenanceKind) => {
    incident++;
    inconclusiveChecks = 0;
    update({ kind, checking: false });
  };
  const inconclusiveCheck = () => {
    if (state.kind) { update({ ...state, checking: false }); return; }
    // One lost background probe is not proof that the workspace is down.
    // Actual API failures and explicit status/offline signals still block immediately.
    if (++inconclusiveChecks >= 2) announce("unavailable");
  };
  const apiUrl = (input: RequestInfo | URL) => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), origin);
      return url.origin === origin && url.pathname.startsWith("/api/") ? url : null;
    } catch { return null; }
  };

  const guardedFetch: Fetch = async (input, init) => {
    const url = apiUrl(input);
    // The probe uses the original fetch, and remains available while editors are frozen.
    if (!url || url.pathname === MAINTENANCE_STATUS_PATH) return request(input, init);
    if (state.kind) return temporaryResponse(state.kind);
    try {
      const response = await request(input, init);
      if (stopped) return response;
      if (response.status === 503) {
        let kind: MaintenanceKind = response.headers.get("X-Personnel-Maintenance") === "1" ? "maintenance" : "unavailable";
        if (response.headers.get("Content-Type")?.includes("json")) {
          try {
            const body = await response.clone().json() as { code?: string; maintenance?: boolean; phase?: string };
            // Gateways use the maintenance header for both planned work and
            // temporary outages. The phase distinguishes what actually happened.
            if (body.phase === "unavailable" || body.code === "SERVICE_UNAVAILABLE") kind = "unavailable";
            else if (body.code === "MAINTENANCE" || body.maintenance === true) kind = "maintenance";
          } catch { /* A proxy can return HTML or an empty response during restart. */ }
        }
        announce(kind);
        return kind === "unavailable" || !response.headers.get("Content-Type")?.includes("json") ? temporaryResponse(kind) : response;
      }
      if (response.status === 502 || response.status === 504 || response.status >= 500 && !response.headers.get("Content-Type")?.includes("json")) {
        announce("unavailable");
        return temporaryResponse("unavailable");
      }
      return response;
    } catch (error) {
      if (!(error && typeof error === "object" && "name" in error && error.name === "AbortError")) announce("unavailable");
      throw error;
    }
  };

  function check(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (pendingCheck) return pendingCheck;
    const startedAtIncident = incident;
    const controller = new AbortController(); statusAbort = controller;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (state.kind) update({ ...state, checking: true });
    pendingCheck = (async () => {
      try {
        const response = await request(new URL(MAINTENANCE_STATUS_PATH, origin).href, { cache: "no-store", signal: controller.signal });
        const result = await response.json() as { maintenance?: boolean; phase?: string };
        if (stopped) return;
        if (result.phase === "unavailable") { announce("unavailable"); return; }
        if (result.maintenance === true || result.phase === "maintenance" || result.phase === "starting" || result.phase === "stopping") {
          announce("maintenance"); return;
        }
        if (!response.ok || result.maintenance !== false || result.phase !== "ready") { inconclusiveCheck(); return; }
        inconclusiveChecks = 0;
        // A delayed healthy probe predating a failed save must not dismiss its warning.
        if (incident !== startedAtIncident) { update({ ...state, checking: false }); return; }
        const resumed = state.kind !== null;
        update({ kind: null, checking: false });
        if (resumed) onReady();
      } catch {
        if (!stopped) inconclusiveCheck();
      } finally {
        clearTimeout(timeout);
        if (statusAbort === controller) statusAbort = null;
        pendingCheck = null;
      }
    })();
    return pendingCheck;
  }

  return {
    fetch: guardedFetch,
    check,
    unavailable: () => announce("unavailable"),
    snapshot: () => state,
    stop() { stopped = true; statusAbort?.abort(); },
  };
}
