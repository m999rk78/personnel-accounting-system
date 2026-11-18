"use client";

import { useEffect, useRef, useState } from "react";
import type { GridApi } from "ag-grid-community";
import { createGridNavigationFilter, type GridNavigationFilter } from "./gridNavigationFilter";

export type { GridNavigationFilter } from "./gridNavigationFilter";

export function useGridNavigationFilter<T>({ api, navigationFilter }: { api: GridApi<T> | null; navigationFilter?: GridNavigationFilter }) {
  const latest = useRef(navigationFilter);
  const controller = useRef<ReturnType<typeof createGridNavigationFilter<T>> | null>(null);
  const [state, setState] = useState({ key: "", pending: false, error: "" });
  useEffect(() => {
    latest.current = navigationFilter;
    controller.current?.update(navigationFilter);
  }, [navigationFilter]);
  useEffect(() => {
    if (!api || api.isDestroyed()) return;
    const current = createGridNavigationFilter(api, (key, status) => {
      setState(previous => previous.key === key && previous.pending === status.pending && previous.error === status.error ? previous : { key, ...status });
    });
    controller.current = current;
    current.update(latest.current);
    return () => { current.destroy(); if (controller.current === current) controller.current = null; };
  }, [api]);
  const key = navigationFilter ? JSON.stringify([navigationFilter.columnId, navigationFilter.value]) : "";
  return key === state.key ? { pending: state.pending, error: state.error } : { pending: Boolean(navigationFilter), error: "" };
}
