"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createGridPreferences } from "./gridPreferences";

export function useCatalogGridPreferences({ userId, scopeKey, siteId, ready = true }: { userId?: number; scopeKey: string; siteId?: number; ready?: boolean }) {
  const controller = useMemo(() => {
    let storage: Storage | undefined;
    try { if (typeof window !== "undefined") storage = window.localStorage; } catch { /* Table preferences are optional. */ }
    return createGridPreferences({ storageKey: `catalog-grid:v1:${userId}:${encodeURIComponent(scopeKey)}:${siteId ?? "global"}`, active: Number.isSafeInteger(userId) && (userId ?? 0) > 0 && Boolean(scopeKey) && (siteId === undefined || Number.isSafeInteger(siteId) && siteId > 0), ready: false, storage });
  }, [userId, scopeKey, siteId]);
  const hasSavedSort = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => { controller.setReady(ready); }, [controller, ready]);
  return useMemo(() => ({ attach: controller.attach, applyDefaultWidths: controller.applyDefaultWidths, onColumnResized: controller.onColumnResized, onSortChanged: controller.onSortChanged, hasSavedSort }), [controller, hasSavedSort]);
}
