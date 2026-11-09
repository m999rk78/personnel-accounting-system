"use client";

import { useEffect, type RefObject } from "react";
import type { GridApi } from "ag-grid-community";
import { emptyColumnGridBackground, emptyColumnRegion } from "./emptyColumnGrid";
import "./gridEmptyRows.css";

/** Decorative backgrounds only; no extra records, model rows or spreadsheet cells. */
export function useEmptyGridRows<T>(root: RefObject<HTMLElement | null>, api: GridApi<T> | null, rowHeight: number) {
  useEffect(() => {
    const element = root.current;
    if (!element || !api || api.isDestroyed()) return;
    const wrapper = element.querySelector<HTMLElement>(".ag-root-wrapper");
    const viewport = wrapper?.querySelector<HTMLElement>(".ag-grid-viewport");
    const rows = wrapper?.querySelector<HTMLElement>(".ag-grid-scrolling-rows");
    if (!wrapper || !viewport || !rows) return;
    const columns = document.createElement("div");
    columns.className = "ag-empty-grid-columns";
    columns.setAttribute("aria-hidden", "true");
    columns.setAttribute("role", "presentation");
    const regions = (["left", "center", "right"] as const).map(side => {
      const surface = document.createElement("div");
      surface.className = `ag-empty-grid-region ag-empty-grid-region-${side}`;
      columns.append(surface);
      return surface;
    });
    rows.append(columns);
    let frame: number | undefined;
    let disposed = false;
    const paint = () => {
      frame = undefined;
      if (disposed || api.isDestroyed()) return;
      const lastIndex = api.getDisplayedRowCount() - 1;
      const last = lastIndex >= 0 ? api.getDisplayedRowAtIndex(lastIndex) : undefined;
      const bottom = last ? (last.rowTop ?? 0) + (last.rowHeight ?? rowHeight) : 0;
      element.style.setProperty("--empty-grid-row-height", `${rowHeight}px`);
      element.style.setProperty("--empty-grid-row-offset", `${bottom % rowHeight}px`);
      const lanes = [api.getDisplayedLeftColumns(), api.getDisplayedCenterColumns(), api.getDisplayedRightColumns()];
      lanes.forEach((lane, index) => {
        const { width, edges } = emptyColumnRegion(lane.map(column => column.getActualWidth()));
        const surface = regions[index];
        surface.hidden = width <= 0;
        surface.style.width = `${width}px`;
        surface.style.setProperty("--empty-grid-column-background", emptyColumnGridBackground(edges));
        surface.dataset.columnBoundaries = JSON.stringify(edges);
      });
      const height = Math.max(0, rows.clientHeight - bottom);
      columns.hidden = height <= 0;
      columns.style.top = `${bottom}px`;
      columns.style.height = `${height}px`;
    };
    const schedule = () => {
      if (disposed || api.isDestroyed() || frame !== undefined) return;
      frame = requestAnimationFrame(paint);
    };
    // Browser scrolling moves the center and sticks the pinned backgrounds in
    // the same native pass as real cells. Never chase scrollLeft in a later RAF.
    const events = ["modelUpdated", "firstDataRendered", "gridSizeChanged", "columnResized", "columnVisible", "columnMoved", "columnPinned", "displayedColumnsChanged"] as const;
    for (const event of events) api.addEventListener(event, schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    resize.observe(rows);
    schedule();
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect();
      columns.remove();
      if (!api.isDestroyed()) for (const event of events) api.removeEventListener(event, schedule);
    };
  }, [root, api, rowHeight]);
}
