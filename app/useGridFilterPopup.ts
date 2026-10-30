"use client";

import { useCallback, useEffect, useRef } from "react";

/** Keep Apply/Cancel reachable as an AG filter grows or its conditions expand. */
export function useGridFilterPopup<T extends HTMLElement>() {
  const root = useRef<T>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const attach = useCallback(() => {
    cleanup.current?.();
    const popup = root.current?.closest<HTMLElement>(".ag-filter-menu");
    if (!popup) return;
    popup.style.visibility = "hidden";
    let frame = 0;
    const constrain = () => {
      frame = 0;
      if (!popup.isConnected) return;
      const rect = popup.getBoundingClientRect();
      const top = Math.max(12, Math.min(rect.top, window.innerHeight - rect.height - 12));
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - rect.width - 12));
      if (Math.abs(rect.top - top) > .5) popup.style.top = `${top}px`;
      if (Math.abs(rect.left - left) > .5) popup.style.left = `${left}px`;
      popup.style.visibility = "visible";
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(constrain); };
    const resize = new ResizeObserver(schedule);
    resize.observe(popup);
    // AG Grid may reposition after rendering a new condition or value list.
    const positioning = new MutationObserver(schedule);
    positioning.observe(popup, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", schedule);
    schedule();
    cleanup.current = () => { cancelAnimationFrame(frame); resize.disconnect(); positioning.disconnect(); window.removeEventListener("resize", schedule); };
  }, []);
  useEffect(() => () => cleanup.current?.(), []);
  return { root, attach };
}
