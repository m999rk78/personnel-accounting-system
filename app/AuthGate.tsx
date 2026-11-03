"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import PersonnelApp from "./PersonnelApp";
import type { PermissionSet } from "./permissionModel";
import type { ProjectAccess, UserRole } from "./roles";
import { permissionSetsEqual } from "./permissionModel";
import { useProjectToday } from "./useProjectToday";
import { MAINTENANCE_READY_EVENT } from "./maintenanceClient";

export type CurrentUser = {
  id: number;
  fullName: string;
  email: string;
  role: UserRole;
  customRoleId?: number | null;
  customRoleName?: string | null;
  roleTemplate?: PermissionSet;
  assignedSiteId: number | null;
  projectAccess?: ProjectAccess;
  canViewPendingReports?: boolean;
  permissions: PermissionSet;
  permissionsCustomized: boolean;
};

const subscribeToHydration = () => () => {};
const hydratedInBrowser = () => true;
const hydratingOnServer = () => false;

export default function AuthGate({ initialToday, initialUser }: { initialToday: string; initialUser?: CurrentUser | null }) {
  const today = useProjectToday(initialToday);
  const [user, setUser] = useState<CurrentUser | null>(initialUser ?? null);
  const [checking, setChecking] = useState(initialUser === undefined);
  const [authRetry, setAuthRetry] = useState(0);
  const hydrated = useSyncExternalStore(subscribeToHydration, hydratedInBrowser, hydratingOnServer);

  useEffect(() => {
    if (initialUser !== undefined) {
      if (!initialUser) window.location.replace("/login");
      return;
    }
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const response = await fetch("/api/auth/status", { cache: "no-store" });
        if (!active) return;
        if (response.status === 401) { window.location.replace("/login"); return; }
        if (!response.ok) throw new Error("Проверка доступа временно недоступна.");
        const result = await response.json() as { authenticated?: boolean; user?: CurrentUser | null };
        if (!active) return;
        if (result.authenticated === false) { window.location.replace("/login"); return; }
        if (result.authenticated !== true || !result.user) throw new Error("Не удалось проверить доступ.");
        setUser(result.user); setChecking(false);
      } catch {
        // A restart or maintenance response must not discard the current workspace.
        if (active) retry = setTimeout(() => void check(), 5000);
      }
    };
    void check();
    return () => { active = false; if (retry !== undefined) clearTimeout(retry); };
  }, [initialUser, authRetry]);

  useEffect(() => {
    const ready = () => setAuthRetry(value => value + 1);
    window.addEventListener(MAINTENANCE_READY_EVENT, ready);
    return () => window.removeEventListener(MAINTENANCE_READY_EVENT, ready);
  }, []);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    let pending = false;
    let lastChecked = 0;
    const refresh = async () => {
      if (document.visibilityState === "hidden" || pending || Date.now() - lastChecked < 5000) return;
      pending = true;
      lastChecked = Date.now();
      try {
        const response = await fetch("/api/auth/status", { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { window.location.replace("/login"); return; }
        if (!response.ok) return;
        const result = await response.json() as { authenticated: boolean; user: CurrentUser | null };
        if (controller.signal.aborted) return;
        if (!result.authenticated || !result.user) { window.location.replace("/login"); return; }
        const next = result.user;
        setUser(current => current && current.id === next.id && current.role === next.role && current.assignedSiteId === next.assignedSiteId
          && current.customRoleId === next.customRoleId && current.customRoleName === next.customRoleName
          && JSON.stringify(current.roleTemplate) === JSON.stringify(next.roleTemplate)
          && JSON.stringify(current.projectAccess) === JSON.stringify(next.projectAccess) && current.canViewPendingReports === next.canViewPendingReports
          && current.fullName === next.fullName && current.email === next.email && current.permissionsCustomized === next.permissionsCustomized
          && permissionSetsEqual(current.permissions, next.permissions) ? current : next);
      } catch { /* Keep the current screen during a temporary network failure; APIs still authorize each request. */ }
      finally { pending = false; }
    };
    // No extra request on page navigation: refresh only on return to the app or once a minute while visible.
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [user]);

  // PersonnelApp restores the selected section and period from window.location.
  // Mount it only after hydration so the server HTML and the browser's first
  // render stay identical even when the URL contains date/month parameters.
  if (!hydrated || checking || !user) return <main className="auth-loading"><div className="auth-spinner" /><p>Проверяем доступ…</p></main>;
  // Permission changes update controls in place, preserving unfinished drafts.
  // Only an identity/project change starts a separate workspace session.
  const accessKey = JSON.stringify([user.id, user.role, user.customRoleId, user.assignedSiteId, user.projectAccess, user.canViewPendingReports]);
  return <PersonnelApp key={accessKey} initialToday={today} currentUser={user} />;
}
