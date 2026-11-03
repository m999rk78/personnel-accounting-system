export const MAINTENANCE_READY_EVENT = "personnel-maintenance-ready";
export const MAINTENANCE_STATUS_PATH = "/api/maintenance/status";

export type MaintenanceKind = "maintenance" | "unavailable";
export type MaintenanceSnapshot = { kind: MaintenanceKind | null; checking: boolean };
type Fetch = typeof fetch;

const temporaryMessage = "Сейчас ведутся технические работы. Доступ к системе скоро возобновится. Введённые данные остаются в открытой вкладке.";

function temporaryResponse(kind: MaintenanceKind) {
  return Response.json({ error: temporaryMessage, code: kind === "maintenance" ? "MAINTENANCE" : "SERVICE_UNAVAILABLE", maintenance: true }, {
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

  const update = (next: MaintenanceSnapshot) => {
    if (stopped || next.kind === state.kind && next.checking === state.checking) return;
    state = next;
    onChange(state);
  };
  const announce = (kind: MaintenanceKind) => {
    incident++;
    update({ kind, checking: false });
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
        let explicitMaintenance = response.headers.get("X-Personnel-Maintenance") === "1";
        if (!explicitMaintenance && response.headers.get("Content-Type")?.includes("json")) {
          try {
            const body = await response.clone().json() as { code?: string; maintenance?: boolean };
            explicitMaintenance = body.code === "MAINTENANCE" || body.maintenance === true;
          } catch { /* A proxy can return HTML or an empty response during restart. */ }
        }
        announce(explicitMaintenance ? "maintenance" : "unavailable");
        return response.headers.get("Content-Type")?.includes("json") ? response : temporaryResponse(explicitMaintenance ? "maintenance" : "unavailable");
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
        if (!response.ok || typeof result.maintenance !== "boolean") { announce("unavailable"); return; }
        if (result.maintenance || result.phase !== "ready") { announce(result.phase === "unavailable" ? "unavailable" : "maintenance"); return; }
        // A delayed healthy probe predating a failed save must not dismiss its warning.
        if (incident !== startedAtIncident) { update({ ...state, checking: false }); return; }
        const resumed = state.kind !== null;
        update({ kind: null, checking: false });
        if (resumed) onReady();
      } catch {
        if (!stopped) announce("unavailable");
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
