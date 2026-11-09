"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createPersonnelReportGridPreferences } from "./personnelReportGridPreferences";

export function usePersonnelReportGridPreferences({ userId, siteId, enabled = true, ready = true }: {
  userId: number; siteId: number; enabled?: boolean; ready?: boolean;
}) {
  const controller = useMemo(() => {
    let storage: Storage | undefined;
    try { if (typeof window !== "undefined") storage = window.localStorage; } catch { /* Preferences are optional in browsers that block storage. */ }
    return createPersonnelReportGridPreferences({ userId, siteId, enabled, ready: false, storage });
  }, [userId, siteId, enabled]);
  const hasSavedSort = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => { controller.setReady(ready); }, [controller, ready]);
  return useMemo(() => ({ attach: controller.attach, applyDefaultWidths: controller.applyDefaultWidths, onColumnResized: controller.onColumnResized, onSortChanged: controller.onSortChanged, hasSavedSort }), [controller, hasSavedSort]);
}
