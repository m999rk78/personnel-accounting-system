import { createGridPreferences, parseGridPreferences, type GridPreferences, type PreferenceStorage } from "./gridPreferences.ts";

export type PersonnelReportGridPreferences = GridPreferences;
export const personnelReportGridPreferencesKey = (userId: number, siteId: number) => `personnel-report-grid:v1:${userId}:${siteId}`;
export const parsePersonnelReportGridPreferences = parseGridPreferences;

/** Keep existing report keys and actor/project validation while sharing column behavior. */
export function createPersonnelReportGridPreferences({ userId, siteId, storage, enabled = true, ready = true }: {
  userId: number; siteId: number; storage?: PreferenceStorage; enabled?: boolean; ready?: boolean;
}) {
  return createGridPreferences({
    storageKey: personnelReportGridPreferencesKey(userId, siteId),
    active: enabled && Number.isSafeInteger(userId) && userId > 0 && Number.isSafeInteger(siteId) && siteId > 0,
    storage, ready,
  });
}
