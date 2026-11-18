import { useState } from "react";

const defaultPreferences = { menu: true, personnel: true, equipment: true, settings: true };
type SidebarPreferences = typeof defaultPreferences;
export type SidebarSection = Exclude<keyof SidebarPreferences, "menu">;

function readPreferences(storageKey: string): SidebarPreferences {
  try {
    const saved: Partial<SidebarPreferences> | null = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    return {
      menu: saved?.menu !== false,
      personnel: saved?.personnel !== false,
      equipment: saved?.equipment !== false,
      settings: saved?.settings !== false,
    };
  } catch {
    return defaultPreferences;
  }
}

export function useSidebarPreferences(userId: number) {
  const storageKey = `resource-report:sidebar:${userId}`;
  const [preferences, setPreferences] = useState(() => readPreferences(storageKey));

  function togglePreference(item: keyof SidebarPreferences) {
    const next = { ...preferences, [item]: !preferences[item] };
    setPreferences(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch { /* The sidebar still works when browser storage is unavailable. */ }
  }

  return { preferences, togglePreference };
}
