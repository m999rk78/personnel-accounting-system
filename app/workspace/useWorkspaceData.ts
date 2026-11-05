"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createLatestRequest } from "../latestRequest";
import type { PermissionSet } from "../permissionModel";
import type { WorkspaceView } from "../appRoutes";
import type { DataSet, Site, View } from "./types";
import { emptyDataSet } from "./model";

export function useWorkspaceData({ siteId, workDate, view, effectivePermissions, viewAllowed }: {
  siteId: number; workDate: string; view: View; effectivePermissions: PermissionSet; viewAllowed: (candidate: View) => boolean;
}) {
  const [data, setData] = useState<DataSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadedSiteId = useRef<number | null>(null);
  const workspaceDataLoaded = useRef(false);
  const adminDataLoaded = useRef<WorkspaceView | null>(null);
  const loadedPermissions = useRef(effectivePermissions);
  const dataRequest = useMemo(() => createLatestRequest(), []);

  useEffect(() => () => dataRequest.cancel(), [dataRequest]);

  const loadData = useCallback(async () => {
    const signal = dataRequest.start();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=settings&section=${view}`, { cache: "no-store", signal });
      if (signal.aborted) return;
      if (response.status === 401) { window.location.replace("/login"); return; }
      const payload = await response.json() as DataSet & { error?: string; };
      if (signal.aborted) return;
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить данные.");
      setData(payload);
      loadedSiteId.current = siteId;
      adminDataLoaded.current = view;
      workspaceDataLoaded.current = false;
    } catch (loadError) {
      if (signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить данные.");
    } finally { if (!signal.aborted) setLoading(false); }
  }, [dataRequest, siteId, workDate, view]);

  const loadWorkspace = useCallback(async () => {
    const signal = dataRequest.start();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=report-catalog`, { cache: "no-store", signal });
      if (signal.aborted) return;
      if (response.status === 401) { window.location.replace("/login"); return; }
      const payload = await response.json() as Partial<DataSet> & { sites: Site[]; error?: string; };
      if (signal.aborted) return;
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить рабочее пространство.");
      setData({ ...emptyDataSet(payload.sites), ...payload });
      loadedSiteId.current = siteId;
      adminDataLoaded.current = null;
      workspaceDataLoaded.current = true;
    } catch (loadError) {
      if (signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить рабочее пространство.");
    } finally { if (!signal.aborted) setLoading(false); }
  }, [dataRequest, siteId, workDate]);

  const loadNavigation = useCallback(async () => {
    const signal = dataRequest.start();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=navigation`, { cache: "no-store", signal });
      if (signal.aborted) return;
      if (response.status === 401) { window.location.replace("/login"); return; }
      const payload = await response.json() as Pick<DataSet, "sites"> & { error?: string; };
      if (signal.aborted) return;
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить список проектов.");
      setData(emptyDataSet(payload.sites));
      loadedSiteId.current = siteId;
      adminDataLoaded.current = null;
      workspaceDataLoaded.current = false;
    } catch (loadError) {
      if (signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить список проектов.");
    } finally { if (!signal.aborted) setLoading(false); }
  }, [dataRequest, siteId, workDate]);

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

  const invalidateCatalogs = useCallback(() => { adminDataLoaded.current = null; }, []);
  return {
    data,
    loading,
    error,
    setError,
    loadData,
    invalidateCatalogs,
  };
}
