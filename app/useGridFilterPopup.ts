"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Column, GridApi } from "ag-grid-community";
import { columnFilterVisibility } from "./columnFilterToggle";
import { gridFilterPopupGeometry } from "./gridFilterPopupGeometry";

/** Keep Apply/Cancel reachable as an AG filter grows or its conditions expand. */
export function useGridFilterPopup<T extends HTMLElement>(context?: { api: GridApi; column: Column }) {
  const root = useRef<T>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const api = context?.api, columnId = context?.column.getColId();
  const attach = useCallback(() => {
    cleanup.current?.();
    const popup = root.current?.closest<HTMLElement>(".ag-filter-menu");
    if (!popup) return;
    popup.style.visibility = "hidden";
    const anchor = api && columnId ? columnFilterVisibility(api).getAnchor(columnId) : null;
    const computedHeight = Number.parseFloat(getComputedStyle(popup).maxHeight);
    const preferredHeight = Number.isFinite(computedHeight) ? computedHeight : 700;
    let frame = 0;
    const constrain = () => {
      frame = 0;
      if (!popup.isConnected) return;
      let rect = popup.getBoundingClientRect();
      let top: number, left: number;
      if (anchor?.isConnected) {
        const geometry = () => gridFilterPopupGeometry({ anchor: anchor.getBoundingClientRect(), width: rect.width, height: rect.height, preferredHeight, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
        const maxHeight = `${geometry().maxHeight}px`;
        if (popup.style.position !== "fixed") popup.style.position = "fixed";
        if (popup.style.maxHeight !== maxHeight) popup.style.maxHeight = maxHeight;
        rect = popup.getBoundingClientRect();
        ({ top, left } = geometry());
      } else {
        // Native timesheet headers have their own public postProcessPopup
        // anchor; leave that placement and height intact when already in view.
        top = Math.max(12, Math.min(rect.top, window.innerHeight - rect.height - 12));
        left = Math.max(12, Math.min(rect.left, window.innerWidth - rect.width - 12));
      }
      if (Math.abs(rect.top - top) > .5) popup.style.top = `${top}px`;
      if (Math.abs(rect.left - left) > .5) popup.style.left = `${left}px`;
      if (popup.style.visibility !== "visible") popup.style.visibility = "visible";
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(constrain); };
    const resize = new ResizeObserver(schedule);
    resize.observe(popup);
    if (anchor) resize.observe(anchor);
    // AG Grid may reposition after rendering a new condition or value list.
    const positioning = new MutationObserver(schedule);
    positioning.observe(popup, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", schedule);
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popup.contains(event.target)) schedule(); };
    window.addEventListener("scroll", scroll, true);
    schedule();
    cleanup.current = () => { cancelAnimationFrame(frame); resize.disconnect(); positioning.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", scroll, true); };
  }, [api, columnId]);
  useEffect(() => () => cleanup.current?.(), []);
  return { root, attach };
}
