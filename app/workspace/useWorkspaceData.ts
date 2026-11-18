"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createLatestRequest } from "../latestRequest";
import { MAINTENANCE_READY_EVENT } from "../maintenanceClient";
import type { PermissionSet } from "../permissionModel";
import type { WorkspaceView } from "../appRoutes";
import type { DataSet, Site, View } from "./types";
import { emptyDataSet } from "./model";

type RecoverableRead = {
  signal: AbortSignal;
  retry: () => Promise<void>;
  pending: boolean;
  retryOnFailure: boolean;
  recovering: boolean;
};

export function useWorkspaceData({ siteId, workDate, view, effectivePermissions, viewAllowed }: {
  siteId: number; workDate: string; view: View; effectivePermissions: PermissionSet; viewAllowed: (candidate: View) => boolean;
}) {
  const [data, setData] = useState<DataSet | null>(null);
  const [settingsContext, setSettingsContext] = useState<{ siteId: number; view: View; permissions: PermissionSet } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadedSiteId = useRef<number | null>(null);
  const workspaceDataLoaded = useRef(false);
  const adminDataLoaded = useRef<WorkspaceView | null>(null);
  const loadedPermissions = useRef(effectivePermissions);
  const dataRequest = useMemo(() => createLatestRequest(), []);
  const recoverableRead = useRef<RecoverableRead | null>(null);

  useEffect(() => () => dataRequest.cancel(), [dataRequest]);

  const retryRead = useCallback(() => {
    const read = recoverableRead.current;
    if (!read || read.signal.aborted) return;
    if (read.pending) {
      // A healthy response already in flight remains authoritative. If it
      // fails after the ready event, recover once after it settles.
      if (!read.recovering) read.retryOnFailure = true;
      return;
    }
    void read.retry();
    if (recoverableRead.current) recoverableRead.current.recovering = true;
  }, []);

  useEffect(() => {
    window.addEventListener(MAINTENANCE_READY_EVENT, retryRead);
    return () => window.removeEventListener(MAINTENANCE_READY_EVENT, retryRead);
  }, [retryRead]);

  const startRead = useCallback((retry: () => Promise<void>) => {
    const read: RecoverableRead = { signal: dataRequest.start(), retry, pending: true, retryOnFailure: false, recovering: false };
    recoverableRead.current = read;
    setLoading(true);
    setError("");
    return read;
  }, [dataRequest]);

  const finishRead = useCallback((read: RecoverableRead) => {
    if (read.signal.aborted) return;
    read.pending = false;
    setLoading(false);
    if (recoverableRead.current === read && read.retryOnFailure) retryRead();
  }, [retryRead]);

  const loadData = useCallback(async function loadSettings() {
    const read = startRead(loadSettings);
    const { signal } = read;
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=settings&section=${view}`, { cache: "no-store", signal });
      if (signal.aborted) return;
      if (response.status === 401) { recoverableRead.current = null; window.location.replace("/login"); return; }
      const payload = await response.json() as DataSet & { error?: string; };
      if (signal.aborted) return;
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить данные.");
      setData(payload);
      setSettingsContext({ siteId, view, permissions: effectivePermissions });
      loadedSiteId.current = siteId;
      adminDataLoaded.current = view;
      workspaceDataLoaded.current = false;
      recoverableRead.current = null;
    } catch (loadError) {
      if (signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить данные.");
    } finally { finishRead(read); }
  }, [startRead, finishRead, siteId, workDate, view, effectivePermissions]);

  const loadWorkspace = useCallback(async function loadReportCatalog() {
    const read = startRead(loadReportCatalog);
    const { signal } = read;
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=report-catalog`, { cache: "no-store", signal });
      if (signal.aborted) return;
      if (response.status === 401) { recoverableRead.current = null; window.location.replace("/login"); return; }
      const payload = await response.json() as Partial<DataSet> & { sites: Site[]; error?: string; };
      if (signal.aborted) return;
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить рабочее пространство.");
      setData({ ...emptyDataSet(payload.sites), ...payload });
      setSettingsContext(null);
      loadedSiteId.current = siteId;
      adminDataLoaded.current = null;
      workspaceDataLoaded.current = true;
      recoverableRead.current = null;
    } catch (loadError) {
      if (signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить рабочее пространство.");
    } finally { finishRead(read); }
  }, [startRead, finishRead, siteId, workDate]);

  const loadNavigation = useCallback(async function loadProjectNavigation() {
    const read = startRead(loadProjectNavigation);
    const { signal } = read;
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=navigation`, { cache: "no-store", signal });
      if (signal.aborted) return;
      if (response.status === 401) { recoverableRead.current = null; window.location.replace("/login"); return; }
      const payload = await response.json() as Pick<DataSet, "sites"> & { error?: string; };
      if (signal.aborted) return;
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить список проектов.");
      setData(emptyDataSet(payload.sites));
      setSettingsContext(null);
      loadedSiteId.current = siteId;
      adminDataLoaded.current = null;
      workspaceDataLoaded.current = false;
      recoverableRead.current = null;
    } catch (loadError) {
      if (signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить список проектов.");
    } finally { finishRead(read); }
  }, [startRead, finishRead, siteId, workDate]);

  useEffect(() => {
    if (loadedPermissions.current !== effectivePermissions) {
      loadedPermissions.current = effectivePermissions;
      loadedSiteId.current = null;
      adminDataLoaded.current = null;
      workspaceDataLoaded.current = false;
    }
    if (!viewAllowed(view)) return;
    const settingsDataView = view === "employees" || view === "positions" || view === "users" || view === "projects" || view === "projectEmployees" || view === "directories";
    const loader = loadedSiteId.current !== siteId
      ? view === "placement" ? loadWorkspace : settingsDataView ? loadData : loadNavigation
      : settingsDataView && adminDataLoaded.current !== view
        ? loadData
        : view === "placement" && !workspaceDataLoaded.current
          ? loadWorkspace
          : null;
    const task = window.setTimeout(() => { if (loader) void loader(); else setLoading(false); }, 0);
    return () => { window.clearTimeout(task); dataRequest.cancel(); };
  }, [effectivePermissions, dataRequest, siteId, workDate, view, viewAllowed, loadData, loadNavigation, loadWorkspace]);

  const invalidateCatalogs = useCallback(() => { adminDataLoaded.current = null; setSettingsContext(null); }, []);
  return {
    data,
    loading,
    // loading is raised by an effect. Block the first render of a new project,
    // section or permission revision while data still belongs to the old one.
    settingsReady: (view === "employees" || view === "positions" || view === "users" || view === "projects" || view === "projectEmployees" || view === "directories")
      && settingsContext?.siteId === siteId && settingsContext.view === view && settingsContext.permissions === effectivePermissions,
    error,
    setError,
    loadData,
    invalidateCatalogs,
  };
}
