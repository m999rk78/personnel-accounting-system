import { parseEquipmentReportDraftSnapshot, type EquipmentReportDraftBuffer, type EquipmentReportDraftSnapshot } from "./equipmentReportDraftBuffer.ts";

export type EquipmentDraftContent = Pick<EquipmentReportDraftSnapshot, "edits" | "sessions" | "importBatches">;
export type EquipmentDraftCache = { version: 1; userId: number; siteId: number; baseRevision: number | null; synced: boolean; snapshot: EquipmentReportDraftSnapshot | null };
export type EquipmentDraftAutosaveState = {
  ready: boolean;
  protected: boolean;
  status: "loading" | "saved" | "saving" | "local" | "error" | "conflict";
  message: string;
  lastSavedAt: string | null;
};

const emptyContent: EquipmentDraftContent = { edits: {}, sessions: {}, importBatches: [] };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : value;
export const equipmentDraftContentKey = (value: EquipmentDraftContent | null): string => JSON.stringify(canonical(value ? { edits: value.edits, sessions: value.sessions, importBatches: value.importBatches } : emptyContent));
export const equipmentDraftStorageKey = (userId: number, siteId: number) => `equipment-report-draft:v1:${userId}:${siteId}`;

export function parseEquipmentDraftCache(raw: string | null, userId: number, siteId: number): EquipmentDraftCache | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as EquipmentDraftCache;
    if (value.version !== 1 || value.userId !== userId || value.siteId !== siteId || typeof value.synced !== "boolean"
      || value.baseRevision !== null && (!Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0)) return null;
    return { ...value, snapshot: parseEquipmentReportDraftSnapshot(value.snapshot, userId, siteId) };
  } catch { return null; }
}

/** A missing ACK can be reconciled by content, but different revisions never overwrite silently. */
export function reconcileEquipmentDraftCache(local: EquipmentDraftCache | null, server: EquipmentReportDraftBuffer) {
  if (!local || local.synced || equipmentDraftContentKey(local.snapshot) === equipmentDraftContentKey(server.snapshot)) return { snapshot: server.snapshot, conflict: false };
  return { snapshot: local.snapshot, conflict: !(local.baseRevision === server.revision || local.baseRevision === null && server.revision === 0) };
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type Transport = (method: "GET" | "PUT", body?: { siteId: number; revision: number; snapshot: EquipmentReportDraftSnapshot | null }, keepalive?: boolean) => Promise<EquipmentReportDraftBuffer>;
type Options = { userId: number; siteId: number; storage?: Storage; transport: Transport; onRestore: (snapshot: EquipmentReportDraftSnapshot | null) => void; delay?: number };
export class EquipmentDraftConflict extends Error {
  readonly current: EquipmentReportDraftBuffer;
  constructor(current: EquipmentReportDraftBuffer) { super("Черновик изменён в другой вкладке или на другом устройстве."); this.current = current; }
}

export function createEquipmentDraftAutosave(options: Options) {
  const key = equipmentDraftStorageKey(options.userId, options.siteId);
  const listeners = new Set<() => void>();
  let state: EquipmentDraftAutosaveState = { ready: false, protected: false, status: "loading", message: "Загружаем ваш черновик…", lastSavedAt: null };
  let active = false, generation = 0, ready = false, revision: number | null = null;
  let desired: EquipmentReportDraftSnapshot | null = null, desiredKey = equipmentDraftContentKey(null), acknowledgedKey: string | null = null, localKey: string | null = null;
  let localCache: EquipmentDraftCache | null = null, conflict: EquipmentReportDraftBuffer | null = null;
  let awaitingRestoreKey: string | null = null, failure = "", storageFailure = "";
  let timer: ReturnType<typeof setTimeout> | undefined, sending: Promise<void> | null = null;
  const publish = (next: Partial<EquipmentDraftAutosaveState>) => {
    const updated = { ...state, ...next };
    if (Object.keys(updated).every(field => updated[field as keyof typeof updated] === state[field as keyof typeof state])) return;
    state = updated; listeners.forEach(listener => listener());
  };
  const updateState = () => {
    const protectedValue = desired === null || desiredKey === localKey || desiredKey === acknowledgedKey;
    if (!ready) { publish({ ready: false, protected: false, status: "loading", message: "Загружаем ваш черновик…" }); return; }
    if (conflict) { publish({ ready: true, protected: protectedValue, status: "conflict", message: protectedValue ? "Черновик изменён в другой вкладке. Ваши изменения сохранены на этом устройстве." : "Есть другая версия черновика. Ваши изменения пока остаются только на открытой странице." }); return; }
    if (failure || storageFailure && desiredKey !== acknowledgedKey) {
      const message = protectedValue ? "Черновик сохранён на этом устройстве. Сохранение на сервере пока недоступно." : "Не удалось автоматически сохранить черновик. Не закрывайте страницу и повторите сохранение.";
      publish({ ready: true, protected: protectedValue, status: protectedValue ? "local" : "error", message }); return;
    }
    if (desiredKey === acknowledgedKey) { publish({ ready: true, protected: protectedValue, status: "saved", message: desired ? "Черновик сохранён" : "Автосохранение включено" }); return; }
    publish({ ready: true, protected: protectedValue, status: revision === null ? "local" : "saving", message: revision === null ? "Черновик сохранён на этом устройстве" : "Сохраняем черновик…" });
  };
  const persist = () => {
    // A conflict must keep the original base. Storing the other tab's revision
    // would turn a reload into an unintended permission to overwrite its work.
    const baseRevision = conflict ? localCache?.baseRevision ?? null : revision ?? localCache?.baseRevision ?? null;
    localCache = { version: 1, userId: options.userId, siteId: options.siteId, baseRevision, synced: desiredKey === acknowledgedKey, snapshot: desired };
    try {
      if (!options.storage) throw new Error("Storage unavailable");
      options.storage.setItem(key, JSON.stringify(localCache));
      localKey = desiredKey; storageFailure = "";
    } catch { localKey = null; storageFailure = "Не удалось сохранить данные на этом устройстве."; }
  };
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = (restart = false) => {
    if (restart) clearTimer();
    if (timer !== undefined) return;
    if (!active || !ready || revision === null || conflict || desiredKey === acknowledgedKey || sending || awaitingRestoreKey !== null) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, options.delay ?? 1000);
  };
  const restore = (snapshot: EquipmentReportDraftSnapshot | null) => {
    desired = snapshot; desiredKey = equipmentDraftContentKey(snapshot); awaitingRestoreKey = desiredKey;
    options.onRestore(snapshot);
  };
  const readServer = async (initial = false) => {
    const token = generation;
    try {
      const server = await options.transport("GET");
      if (!active || token !== generation) return;
      const choice = reconcileEquipmentDraftCache(localCache, server);
      revision = server.revision; acknowledgedKey = equipmentDraftContentKey(server.snapshot); conflict = choice.conflict ? server : null;
      failure = "";
      if (initial || equipmentDraftContentKey(choice.snapshot) !== desiredKey) restore(choice.snapshot);
      else { desired = choice.snapshot; desiredKey = equipmentDraftContentKey(desired); }
      ready = true; persist(); updateState(); schedule();
      if (server.snapshot) publish({ lastSavedAt: server.snapshot.savedAt });
    } catch {
      if (!active || token !== generation) return;
      failure = "Не удалось загрузить сохранённый черновик.";
      if (initial) restore(localCache?.snapshot ?? null);
      ready = true; persist(); updateState();
    }
  };
  async function flush(keepalive = false): Promise<void> {
    clearTimer();
    if (!active || !ready || revision === null || conflict || desiredKey === acknowledgedKey || awaitingRestoreKey !== null) return;
    if (sending) return sending;
    const token = generation, sentSnapshot = desired, sentKey = desiredKey, sentRevision = revision;
    failure = ""; updateState();
    const pending = (async () => {
      try {
        const server = await options.transport("PUT", { siteId: options.siteId, revision: sentRevision, snapshot: sentSnapshot }, keepalive);
        if (!active || token !== generation) return;
        revision = server.revision; acknowledgedKey = sentKey; failure = "";
        publish({ lastSavedAt: sentSnapshot?.savedAt ?? new Date().toISOString() });
        persist();
      } catch (error) {
        if (!active || token !== generation) return;
        if (error instanceof EquipmentDraftConflict) {
          const currentKey = equipmentDraftContentKey(error.current.snapshot);
          if (currentKey === sentKey) { revision = error.current.revision; acknowledgedKey = sentKey; failure = ""; }
          else conflict = error.current;
        } else failure = "Не удалось сохранить черновик на сервере.";
        persist();
      } finally {
        if (token === generation) {
          sending = null;
          if (active) { updateState(); if (!failure && !conflict) schedule(); }
        }
      }
    })();
    sending = pending;
    return pending;
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
    activate() {
      active = true; generation++; ready = false; revision = null; acknowledgedKey = null; localKey = null; conflict = null; failure = ""; sending = null;
      try { localCache = parseEquipmentDraftCache(options.storage?.getItem(key) ?? null, options.userId, options.siteId); } catch { localCache = null; }
      desired = localCache?.snapshot ?? null; desiredKey = equipmentDraftContentKey(desired);
      acknowledgedKey = localCache?.synced ? desiredKey : null;
      // A fresh GET is required before any write, even if a browser cache has a revision.
      revision = null;
      updateState(); void readServer(true);
    },
    deactivate() { clearTimer(); void flush(true); active = false; generation++; },
    refreshLocalProtection() {
      // localStorage is shared by tabs. A different tab can replace this
      // draft's recovery copy without notifying this controller's writer.
      try {
        const stored = parseEquipmentDraftCache(options.storage?.getItem(key) ?? null, options.userId, options.siteId);
        localKey = stored ? equipmentDraftContentKey(stored.snapshot) : null;
        storageFailure = localKey === desiredKey ? "" : "Локальная копия изменена в другой вкладке.";
      } catch { localKey = null; storageFailure = "Не удалось проверить локальную копию черновика."; }
      updateState();
    },
    updateContent(content: EquipmentDraftContent) {
      if (!active || !ready) return;
      const nextKey = equipmentDraftContentKey(content);
      if (awaitingRestoreKey !== null) {
        if (nextKey !== awaitingRestoreKey) return;
        awaitingRestoreKey = null;
      }
      const changed = nextKey !== desiredKey;
      if (changed) {
        desiredKey = nextKey;
        desired = Object.keys(content.edits).length ? { ...content, version: 1, userId: options.userId, siteId: options.siteId, savedAt: new Date().toISOString() } : null;
        failure = ""; persist();
      }
      updateState(); schedule(changed);
    },
    flush,
    retry() { if (!ready) return; failure = ""; if (revision === null) void readServer(); else void flush(); updateState(); },
    acceptServer() {
      if (!conflict) return;
      revision = conflict.revision; acknowledgedKey = equipmentDraftContentKey(conflict.snapshot);
      restore(conflict.snapshot); conflict = null; failure = ""; persist(); updateState();
    },
    keepLocal() {
      if (!conflict) return;
      revision = conflict.revision; acknowledgedKey = equipmentDraftContentKey(conflict.snapshot); conflict = null; failure = "";
      persist(); updateState(); void flush();
    },
  };
}
