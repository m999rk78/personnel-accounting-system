"use client";

import { useEffect, type RefObject } from "react";
import type { GridApi } from "ag-grid-community";
import { emptyColumnGridBackground, visibleEmptyColumnEdges, type EmptyColumnBounds } from "./emptyColumnGrid";
import "./gridEmptyRows.css";

/** Decorative grid below the real rows; never inserts rows/cells into AG Grid's model. */
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
    rows.append(columns);
    let frame: number | undefined;
    const paint = () => {
      frame = undefined;
      if (api.isDestroyed()) return;
      const lastIndex = api.getDisplayedRowCount() - 1;
      const last = lastIndex >= 0 ? api.getDisplayedRowAtIndex(lastIndex) : undefined;
      const bottom = last ? (last.rowTop ?? 0) + (last.rowHeight ?? rowHeight) : 0;
      element.style.setProperty("--empty-grid-row-height", `${rowHeight}px`);
      element.style.setProperty("--empty-grid-row-offset", `${bottom % rowHeight}px`);
      const viewportBox = viewport.getBoundingClientRect();
      const rowsBox = rows.getBoundingClientRect();
      const width = viewport.clientWidth;
      const bounds = [...wrapper.querySelectorAll<HTMLElement>(".ag-header-cell[col-id]")]
        .filter(header => header.closest(".ag-root-wrapper") === wrapper)
        .flatMap<EmptyColumnBounds>(header => {
          const box = header.getBoundingClientRect();
          if (!box.width || !box.height) return [];
          const column = api.getColumn(header.getAttribute("col-id")!);
          if (!column) return [];
          const pinned = column.getPinned();
          return [{ left: box.left - viewportBox.left, right: box.right - viewportBox.left, pinned: pinned === "right" ? "right" : pinned === "left" || pinned === true ? "left" : null }];
        });
      const edges = visibleEmptyColumnEdges(bounds, width);
      const height = Math.max(0, rows.clientHeight - bottom);
      columns.hidden = height <= 0;
      columns.style.left = `${viewportBox.left - rowsBox.left}px`;
      columns.style.top = `${bottom}px`;
      columns.style.width = `${width}px`;
      columns.style.height = `${height}px`;
      columns.style.backgroundImage = emptyColumnGridBackground(edges);
      columns.dataset.columnBoundaries = JSON.stringify(edges);
      columns.dataset.emptyColumnBoundaries = JSON.stringify(edges);
    };
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };
    const events = ["modelUpdated", "firstDataRendered", "gridSizeChanged", "columnResized", "displayedColumnsChanged", "bodyScroll"] as const;
    for (const event of events) api.addEventListener(event, schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    resize.observe(rows);
    schedule();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect();
      columns.remove();
      if (!api.isDestroyed()) {
        for (const event of events) api.removeEventListener(event, schedule);
      }
    };
  }, [root, api, rowHeight]);
}
