"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import PersonnelApp from "./PersonnelApp";
import type { PermissionSet } from "./permissionModel";
import { isUserRole, type ProjectAccess, type UserRole } from "./roles";
import { PERMISSION_ACTIONS, PERMISSION_RESOURCES, permissionSetsEqual } from "./permissionModel";
import { useProjectToday } from "./useProjectToday";
import { MAINTENANCE_READY_EVENT } from "./maintenanceClient";
import { AUTH_MUTATION_END_EVENT, AUTH_MUTATION_START_EVENT, isAuthMutationInProgress } from "./authClientCoordination";

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

function isPermissionPayload(value: unknown): value is PermissionSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return PERMISSION_RESOURCES.every(resource => {
    const permission = (value as Record<string, unknown>)[resource];
    return permission && typeof permission === "object" && !Array.isArray(permission)
      && PERMISSION_ACTIONS.every(action => typeof (permission as Record<string, unknown>)[action] === "boolean");
  });
}

function isCurrentUserPayload(value: unknown): value is CurrentUser {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CurrentUser>;
  const positiveId = (id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  return positiveId(candidate.id) && typeof candidate.fullName === "string" && typeof candidate.email === "string"
    && isUserRole(candidate.role) && (candidate.assignedSiteId === null || positiveId(candidate.assignedSiteId))
    && typeof candidate.permissionsCustomized === "boolean" && isPermissionPayload(candidate.permissions)
    && (candidate.customRoleId === undefined || candidate.customRoleId === null || positiveId(candidate.customRoleId))
    && (candidate.customRoleName === undefined || candidate.customRoleName === null || typeof candidate.customRoleName === "string")
    && (candidate.roleTemplate === undefined || isPermissionPayload(candidate.roleTemplate))
    && (candidate.canViewPendingReports === undefined || typeof candidate.canViewPendingReports === "boolean")
    && (candidate.projectAccess === undefined || candidate.projectAccess !== null && typeof candidate.projectAccess === "object"
      && ["all", "selected"].includes(candidate.projectAccess.mode) && Array.isArray(candidate.projectAccess.siteIds) && candidate.projectAccess.siteIds.every(positiveId));
}

export default function AuthGate({ initialToday, initialUser }: { initialToday: string; initialUser?: CurrentUser | null }) {
  const today = useProjectToday(initialToday);
  const [user, setUser] = useState<CurrentUser | null>(initialUser ?? null);
  const [checking, setChecking] = useState(initialUser === undefined);
  const [authRetry, setAuthRetry] = useState(0);
  const hydrated = useSyncExternalStore(subscribeToHydration, hydratedInBrowser, hydratingOnServer);
  const authenticated = user !== null;

  useEffect(() => {
    if (initialUser !== undefined) {
      if (!initialUser) window.location.replace("/login");
      return;
    }
    let active = true;
    let completed = false;
    let paused = isAuthMutationInProgress();
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (!active || completed || paused || controller && !controller.signal.aborted) return;
      if (retry !== undefined) { clearTimeout(retry); retry = undefined; }
      const requestController = new AbortController();
      controller = requestController;
      try {
        const response = await fetch("/api/auth/status", { cache: "no-store", signal: requestController.signal });
        if (!active || requestController.signal.aborted) return;
        if (response.status === 401) { window.location.replace("/login"); return; }
        if (!response.ok) throw new Error("Проверка доступа временно недоступна.");
        const result = await response.json() as { authenticated?: unknown; user?: unknown } | null;
        if (!active || requestController.signal.aborted) return;
        if (result?.authenticated === false) { window.location.replace("/login"); return; }
        if (result?.authenticated !== true || !isCurrentUserPayload(result.user)) throw new Error("Не удалось проверить доступ.");
        completed = true;
        setUser(result.user); setChecking(false);
      } catch {
        // A restart or maintenance response must not discard the current workspace.
        if (active && !paused && !requestController.signal.aborted) retry = setTimeout(() => void check(), 5000);
      } finally {
        if (controller === requestController) controller = null;
      }
    };
    const pause = () => {
      paused = true;
      controller?.abort();
      if (retry !== undefined) { clearTimeout(retry); retry = undefined; }
    };
    const resume = () => { paused = false; void check(); };
    window.addEventListener(AUTH_MUTATION_START_EVENT, pause);
    window.addEventListener(AUTH_MUTATION_END_EVENT, resume);
    void check();
    return () => {
      active = false; controller?.abort();
      if (retry !== undefined) clearTimeout(retry);
      window.removeEventListener(AUTH_MUTATION_START_EVENT, pause);
      window.removeEventListener(AUTH_MUTATION_END_EVENT, resume);
    };
  }, [initialUser, authRetry]);

  useEffect(() => {
    const ready = () => setAuthRetry(value => value + 1);
    window.addEventListener(MAINTENANCE_READY_EVENT, ready);
    return () => window.removeEventListener(MAINTENANCE_READY_EVENT, ready);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    let paused = isAuthMutationInProgress();
    let pending: AbortController | null = null;
    let lastChecked = 0;
    const refresh = async () => {
      if (!active || paused || document.visibilityState === "hidden" || pending || Date.now() - lastChecked < 5000) return;
      const controller = new AbortController();
      pending = controller;
      lastChecked = Date.now();
      try {
        const response = await fetch("/api/auth/status", { cache: "no-store", signal: controller.signal });
        if (!active || controller.signal.aborted) return;
        if (response.status === 401) { window.location.replace("/login"); return; }
        if (!response.ok) return;
        const result = await response.json() as { authenticated?: unknown; user?: unknown } | null;
        if (!active || controller.signal.aborted) return;
        if (result?.authenticated === false) { window.location.replace("/login"); return; }
        // A malformed response is inconclusive, just like a temporary network failure.
        // Only the server's explicit denial ends the current workspace session.
        if (result?.authenticated !== true || !isCurrentUserPayload(result.user)) return;
        const next = result.user;
        setUser(current => current && current.id === next.id && current.role === next.role && current.assignedSiteId === next.assignedSiteId
          && current.customRoleId === next.customRoleId && current.customRoleName === next.customRoleName
          && JSON.stringify(current.roleTemplate) === JSON.stringify(next.roleTemplate)
          && JSON.stringify(current.projectAccess) === JSON.stringify(next.projectAccess) && current.canViewPendingReports === next.canViewPendingReports
          && current.fullName === next.fullName && current.email === next.email && current.permissionsCustomized === next.permissionsCustomized
          && permissionSetsEqual(current.permissions, next.permissions) ? current : next);
      } catch { /* Keep the current screen during a temporary network failure; APIs still authorize each request. */ }
      finally { if (pending === controller) pending = null; }
    };
    const pause = () => { paused = true; pending?.abort(); pending = null; };
    const resume = () => { paused = false; lastChecked = 0; void refresh(); };
    window.addEventListener(AUTH_MUTATION_START_EVENT, pause);
    window.addEventListener(AUTH_MUTATION_END_EVENT, resume);
    // Check server-rendered sessions immediately, including near their expiry.
    // Keep one refresh lifecycle while authenticated so permission updates do not poll again.
    void refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      active = false; pending?.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener(AUTH_MUTATION_START_EVENT, pause); window.removeEventListener(AUTH_MUTATION_END_EVENT, resume);
    };
  }, [authenticated]);

  // PersonnelApp restores the selected section and period from window.location.
  // Mount it only after hydration so the server HTML and the browser's first
  // render stay identical even when the URL contains date/month parameters.
  if (!hydrated || checking || !user) return <main className="auth-loading"><div className="auth-spinner" /><p>Проверяем доступ…</p></main>;
  // Permission changes update controls in place, preserving unfinished drafts.
  // Only an identity/project change starts a separate workspace session.
  const accessKey = JSON.stringify([user.id, user.role, user.customRoleId, user.assignedSiteId, user.projectAccess, user.canViewPendingReports]);
  return <PersonnelApp key={accessKey} initialToday={today} currentUser={user} />;
}
