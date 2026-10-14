"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import PersonnelApp from "./PersonnelApp";
import type { PermissionSet } from "./permissionModel";
import type { UserRole } from "./roles";

export type CurrentUser = {
  id: number;
  fullName: string;
  email: string;
  role: UserRole;
  assignedSiteId: number | null;
  permissions: PermissionSet;
  permissionsCustomized: boolean;
};

const subscribeToHydration = () => () => {};
const hydratedInBrowser = () => true;
const hydratingOnServer = () => false;

export default function AuthGate({ initialToday, initialUser }: { initialToday: string; initialUser?: CurrentUser | null }) {
  const [user, setUser] = useState<CurrentUser | null>(initialUser ?? null);
  const [checking, setChecking] = useState(initialUser === undefined);
  const hydrated = useSyncExternalStore(subscribeToHydration, hydratedInBrowser, hydratingOnServer);

  useEffect(() => {
    if (initialUser !== undefined) {
      if (!initialUser) window.location.replace("/login");
      return;
    }
    let active = true;
    void fetch("/api/auth/status", { cache: "no-store" })
      .then(async (response) => response.json() as Promise<{ authenticated: boolean; user: CurrentUser | null }>)
      .then((result) => {
        if (!active) return;
        if (!result.authenticated || !result.user) {
          window.location.replace("/login");
          return;
        }
        setUser(result.user);
        setChecking(false);
      })
      .catch(() => { if (active) window.location.replace("/login"); });
    return () => { active = false; };
  }, [initialUser]);

  // PersonnelApp restores the selected section and period from window.location.
  // Mount it only after hydration so the server HTML and the browser's first
  // render stay identical even when the URL contains date/month parameters.
  if (!hydrated || checking || !user) return <main className="auth-loading"><div className="auth-spinner" /><p>Проверяем доступ…</p></main>;
  return <PersonnelApp initialToday={initialToday} currentUser={user} />;
}
