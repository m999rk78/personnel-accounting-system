"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { parsePersonnelReportDraftSnapshot, type PersonnelReportDraftBuffer, type PersonnelReportDraftSnapshot } from "./personnelReportDraftBuffer";
import { createPersonnelDraftAutosave, personnelDraftStorageKey, PersonnelDraftConflict, type PersonnelDraftContent } from "./personnelDraftAutosave";
export type { PersonnelDraftContent } from "./personnelDraftAutosave";

const disabledState = { ready: true, protected: true, status: "saved" as const, message: "", lastSavedAt: null };
export function usePersonnelReportDraftAutosave({ userId, siteId, enabled, content, onRestore }: {
  userId: number; siteId: number; enabled: boolean; content: PersonnelDraftContent;
  onRestore: (snapshot: PersonnelReportDraftSnapshot | null) => void;
}) {
  const restoreRef = useRef(onRestore);
  useLayoutEffect(() => { restoreRef.current = onRestore; }, [onRestore]);
  const controller = useMemo(() => {
    let storage: Storage | undefined;
    try { if (typeof window !== "undefined") storage = window.localStorage; } catch { /* Server saving still works when browser storage is unavailable. */ }
    return createPersonnelDraftAutosave({ userId, siteId, storage, onRestore: snapshot => restoreRef.current(snapshot),
      transport: async (method, body, keepalive) => {
        const response = await fetch(`/api/personnel-report-draft?siteId=${siteId}`, method === "GET" ? { cache: "no-store" } : {
          method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: keepalive && new TextEncoder().encode(JSON.stringify(body)).byteLength < 60_000,
        });
        const value = await response.json() as PersonnelReportDraftBuffer & { error?: string; code?: string; details?: PersonnelReportDraftBuffer };
        const parse = (buffer: PersonnelReportDraftBuffer): PersonnelReportDraftBuffer => {
          if (!Number.isSafeInteger(buffer.revision) || buffer.revision < 0) throw new Error("Некорректная версия черновика.");
          return { revision: buffer.revision, snapshot: parsePersonnelReportDraftSnapshot(buffer.snapshot, userId, siteId) };
        };
        if (response.status === 409 && value.code === "DRAFT_BUFFER_CONFLICT" && value.details) throw new PersonnelDraftConflict(parse(value.details));
        if (!response.ok) throw new Error(value.error ?? "Не удалось сохранить черновик.");
        return parse(value);
      },
    });
  }, [userId, siteId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    if (!enabled) return;
    controller.activate();
    const save = () => { void controller.flush(true); };
    const resume = () => controller.retry();
    const storageChange = (event: StorageEvent) => { if (event.key === null || event.key === personnelDraftStorageKey(userId, siteId)) controller.refreshLocalProtection(); };
    const visibility = () => { if (document.visibilityState === "hidden") save(); };
    window.addEventListener("pagehide", save); window.addEventListener("online", resume); window.addEventListener("storage", storageChange); document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", save); window.removeEventListener("online", resume); window.removeEventListener("storage", storageChange); document.removeEventListener("visibilitychange", visibility);
      controller.deactivate();
    };
  }, [controller, enabled, userId, siteId]);
  useLayoutEffect(() => { if (enabled && state.ready) controller.updateContent(content); }, [content, controller, enabled, state.ready]);
  return { ...(enabled ? state : disabledState), retry: controller.retry, acceptServer: controller.acceptServer, keepLocal: controller.keepLocal };
}
