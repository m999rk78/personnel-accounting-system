"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { rowScrollOffset, tableRowWindow } from "./tableViewport";

export function useTableViewport(rowCount: number, resetKey: string, ready: boolean, pinnedRow?: number) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ key: resetKey, scrollTop: 0, height: 920, rowHeight: 46 });
  const metrics = useRef({ height: 920, rowHeight: 46 });
  const previousKey = useRef(resetKey);

  const measure = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const row = shell.querySelector<HTMLElement>("[data-virtual-row]");
    const header = shell.querySelector<HTMLElement>("thead");
    const footer = shell.querySelector<HTMLElement>("tfoot");
    const rowHeight = row?.getBoundingClientRect().height || 46;
    const height = Math.max(rowHeight, shell.clientHeight - (header?.offsetHeight ?? 88) - (footer?.offsetHeight ?? 47));
    metrics.current = { rowHeight, height };
    const scrollTop = shell.scrollTop;
    setViewport((current) => {
      const before = tableRowWindow(rowCount, current.scrollTop, current.height, current.rowHeight);
      const after = tableRowWindow(rowCount, scrollTop, height, rowHeight);
      // Horizontal scrolling and small vertical movements do not re-render the table.
      if (current.key === resetKey && current.rowHeight === rowHeight && before.start === after.start && before.end === after.end) return current;
      return { key: resetKey, scrollTop, height, rowHeight };
    });
  }, [resetKey, rowCount]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!ready || !shell) return;
    if (previousKey.current !== resetKey) shell.scrollTop = 0;
    previousKey.current = resetKey;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(shell);
    shell.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      shell.removeEventListener("scroll", schedule);
    };
  }, [measure, ready, resetKey]);

  const ensureRowVisible = useCallback((rowIndex: number) => {
    const shell = shellRef.current;
    if (!shell) return;
    const { height, rowHeight } = metrics.current;
    shell.scrollTop = rowScrollOffset(rowIndex, shell.scrollTop, height, rowHeight);
    measure();
  }, [measure]);

  const range = tableRowWindow(rowCount, viewport.key === resetKey ? viewport.scrollTop : 0, viewport.height, viewport.rowHeight);
  // Never unmount an open editor/anchor: that could lose an unsaved value on scroll.
  if (pinnedRow !== undefined && pinnedRow >= 0 && pinnedRow < rowCount) {
    range.start = Math.min(range.start, pinnedRow);
    range.end = Math.max(range.end, pinnedRow + 1);
    range.top = range.start * viewport.rowHeight;
    range.bottom = (rowCount - range.end) * viewport.rowHeight;
  }
  return { shellRef, ensureRowVisible, ...range };
}
