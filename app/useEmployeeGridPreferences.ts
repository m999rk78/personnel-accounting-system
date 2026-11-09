"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createGridPreferences, type PreferenceStorage } from "./gridPreferences.ts";

/** The general employee directory is shared across projects, but preferences belong to one actor. */
export const employeeGridPreferencesKey = (userId: number) => `employees-grid:v1:${userId}`;

export function createEmployeeGridPreferences({ userId, enabled = true, ready = true, storage }: {
  userId: number; enabled?: boolean; ready?: boolean; storage?: PreferenceStorage;
}) {
  return createGridPreferences({
    storageKey: employeeGridPreferencesKey(userId),
    active: enabled && Number.isSafeInteger(userId) && userId > 0,
    ready, storage,
  });
}

export function useEmployeeGridPreferences({ userId, enabled = true, ready = true }: {
  userId: number; enabled?: boolean; ready?: boolean;
}) {
  const controller = useMemo(() => {
    let storage: Storage | undefined;
    try { if (typeof window !== "undefined") storage = window.localStorage; } catch { /* Preferences are optional when browser storage is blocked. */ }
    return createEmployeeGridPreferences({ userId, enabled, ready: false, storage });
  }, [userId, enabled]);
  const hasSavedSort = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => { controller.setReady(ready); }, [controller, ready]);
  return useMemo(() => ({ attach: controller.attach, applyDefaultWidths: controller.applyDefaultWidths, onColumnResized: controller.onColumnResized, onSortChanged: controller.onSortChanged, hasSavedSort }), [controller, hasSavedSort]);
}
