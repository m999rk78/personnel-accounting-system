"use client";

import { useEffect, type RefObject } from "react";

/** Extend the real native table's columns into decorative empty space only. */
export function useNativeEmptyColumns(rootRef: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    let frame: number | undefined;
    let observedTable: HTMLTableElement | null = null;
    const resize = new ResizeObserver(() => schedule());
    const paint = () => {
      frame = undefined;
      const table = root.querySelector<HTMLTableElement>("table.timesheet-table, table.users-table");
      if (!table) return;
      const headers = [...table.querySelectorAll<HTMLTableCellElement>("thead th")].filter(cell => cell.colSpan === 1 && cell.getBoundingClientRect().width > 0);
      if (table !== observedTable) {
        resize.disconnect();
        resize.observe(root);
        resize.observe(table);
        headers.forEach(cell => resize.observe(cell));
        observedTable = table;
      }
      const pinnedRight = Math.max(-Infinity, ...headers.filter(cell => cell.classList.contains("timesheet-sticky")).map(cell => cell.getBoundingClientRect().right));
      const edges = headers.filter(cell => cell.classList.contains("timesheet-sticky") || cell.getBoundingClientRect().right > pinnedRight + .5).map(cell => cell.getBoundingClientRect().right);
      const users = table.classList.contains("users-table");
      const targets = users ? [table.closest<HTMLElement>(".users-table-wrap") ?? root] : [...table.querySelectorAll<HTMLElement>(".timesheet-fill-row > td, td:has(> .equipment-table-empty)")];
      const color = users ? "#ededf0" : "#e5e5e8";
      for (const target of targets) {
        const rect = target.getBoundingClientRect();
        const boundaries = [...new Set(edges.map(edge => Math.round((edge - rect.left) * 100) / 100))].filter(edge => edge > .5 && edge < rect.width - .5).sort((a, b) => a - b);
        const stops = boundaries.flatMap(edge => [`transparent ${Math.max(0, edge - 1)}px`, `${color} ${Math.max(0, edge - 1)}px`, `${color} ${edge}px`, `transparent ${edge}px`]);
        target.style.setProperty("--native-empty-column-lines", stops.length ? `linear-gradient(to right, transparent 0px, ${stops.join(", ")}, transparent 100%)` : "linear-gradient(transparent, transparent)");
        target.dataset.emptyColumnBoundaries = JSON.stringify(boundaries);
      }
      root.style.setProperty("--native-empty-scroll-left", `${root.scrollLeft}px`);
      root.style.setProperty("--native-empty-viewport-width", `${root.clientWidth}px`);
    };
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };
    const children = new MutationObserver(schedule);
    children.observe(root, { childList: true, subtree: true });
    resize.observe(root);
    root.addEventListener("scroll", schedule, { passive: true, capture: true });
    schedule();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      children.disconnect();
      resize.disconnect();
      root.removeEventListener("scroll", schedule, true);
    };
  }, [rootRef, enabled]);
}
