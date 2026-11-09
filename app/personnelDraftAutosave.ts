import { parsePersonnelReportDraftSnapshot, type PersonnelReportDraftBuffer, type PersonnelReportDraftSnapshot } from "./personnelReportDraftBuffer.ts";

export type PersonnelDraftContent = Pick<PersonnelReportDraftSnapshot, "edits" | "sessions" | "importBatches">;
export type PersonnelDraftCache = { version: 1; userId: number; siteId: number; baseRevision: number | null; synced: boolean; snapshot: PersonnelReportDraftSnapshot | null };
export type PersonnelDraftAutosaveState = {
  ready: boolean;
  protected: boolean;
  status: "loading" | "saved" | "saving" | "local" | "error" | "conflict";
  message: string;
  lastSavedAt: string | null;
};

const emptyContent: PersonnelDraftContent = { edits: {}, sessions: {}, importBatches: [] };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : value;
export const personnelDraftContentKey = (value: PersonnelDraftContent | null): string => JSON.stringify(canonical(value ? { edits: value.edits, sessions: value.sessions, importBatches: value.importBatches } : emptyContent));
export const personnelDraftStorageKey = (userId: number, siteId: number) => `personnel-report-draft:v1:${userId}:${siteId}`;

export function parsePersonnelDraftCache(raw: string | null, userId: number, siteId: number): PersonnelDraftCache | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PersonnelDraftCache;
    if (value.version !== 1 || value.userId !== userId || value.siteId !== siteId || typeof value.synced !== "boolean"
      || value.baseRevision !== null && (!Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0)) return null;
    return { ...value, snapshot: parsePersonnelReportDraftSnapshot(value.snapshot, userId, siteId) };
  } catch { return null; }
}

/** A missing ACK can be reconciled by content, but different revisions never overwrite silently. */
export function reconcilePersonnelDraftCache(local: PersonnelDraftCache | null, server: PersonnelReportDraftBuffer) {
  if (!local || local.synced || personnelDraftContentKey(local.snapshot) === personnelDraftContentKey(server.snapshot)) return { snapshot: server.snapshot, conflict: false };
  return { snapshot: local.snapshot, conflict: !(local.baseRevision === server.revision || local.baseRevision === null && server.revision === 0) };
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type Transport = (method: "GET" | "PUT", body?: { siteId: number; revision: number; snapshot: PersonnelReportDraftSnapshot | null }, keepalive?: boolean) => Promise<PersonnelReportDraftBuffer>;
type Options = { userId: number; siteId: number; storage?: Storage; transport: Transport; onRestore: (snapshot: PersonnelReportDraftSnapshot | null) => void; delay?: number };
export class PersonnelDraftConflict extends Error {
  readonly current: PersonnelReportDraftBuffer;
  constructor(current: PersonnelReportDraftBuffer) { super("Черновик изменён в другой вкладке или на другом устройстве."); this.current = current; }
}

export function createPersonnelDraftAutosave(options: Options) {
  const key = personnelDraftStorageKey(options.userId, options.siteId);
  const listeners = new Set<() => void>();
  let state: PersonnelDraftAutosaveState = { ready: false, protected: false, status: "loading", message: "Загружаем ваш черновик…", lastSavedAt: null };
  let active = false, generation = 0, ready = false, revision: number | null = null;
  let desired: PersonnelReportDraftSnapshot | null = null, desiredKey = personnelDraftContentKey(null), acknowledgedKey: string | null = null, localKey: string | null = null;
  let localCache: PersonnelDraftCache | null = null, conflict: PersonnelReportDraftBuffer | null = null;
  let awaitingRestoreKey: string | null = null, failure = "", storageFailure = "";
  let timer: ReturnType<typeof setTimeout> | undefined, sending: Promise<void> | null = null;
  const publish = (next: Partial<PersonnelDraftAutosaveState>) => {
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
  const restore = (snapshot: PersonnelReportDraftSnapshot | null) => {
    desired = snapshot; desiredKey = personnelDraftContentKey(snapshot); awaitingRestoreKey = desiredKey;
    options.onRestore(snapshot);
  };
  const readServer = async (initial = false) => {
    const token = generation;
    try {
      const server = await options.transport("GET");
      if (!active || token !== generation) return;
      const choice = reconcilePersonnelDraftCache(localCache, server);
      revision = server.revision; acknowledgedKey = personnelDraftContentKey(server.snapshot); conflict = choice.conflict ? server : null;
      failure = "";
      if (initial || personnelDraftContentKey(choice.snapshot) !== desiredKey) restore(choice.snapshot);
      else { desired = choice.snapshot; desiredKey = personnelDraftContentKey(desired); }
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
        if (error instanceof PersonnelDraftConflict) {
          const currentKey = personnelDraftContentKey(error.current.snapshot);
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
      try { localCache = parsePersonnelDraftCache(options.storage?.getItem(key) ?? null, options.userId, options.siteId); } catch { localCache = null; }
      desired = localCache?.snapshot ?? null; desiredKey = personnelDraftContentKey(desired);
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
        const stored = parsePersonnelDraftCache(options.storage?.getItem(key) ?? null, options.userId, options.siteId);
        localKey = stored ? personnelDraftContentKey(stored.snapshot) : null;
        storageFailure = localKey === desiredKey ? "" : "Локальная копия изменена в другой вкладке.";
      } catch { localKey = null; storageFailure = "Не удалось проверить локальную копию черновика."; }
      updateState();
    },
    updateContent(content: PersonnelDraftContent) {
      if (!active || !ready) return;
      const nextKey = personnelDraftContentKey(content);
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
      revision = conflict.revision; acknowledgedKey = personnelDraftContentKey(conflict.snapshot);
      restore(conflict.snapshot); conflict = null; failure = ""; persist(); updateState();
    },
    keepLocal() {
      if (!conflict) return;
      revision = conflict.revision; acknowledgedKey = personnelDraftContentKey(conflict.snapshot); conflict = null; failure = "";
      persist(); updateState(); void flush();
    },
  };
}
