"use client";

import { useLayoutEffect } from "react";
import { attachSelectionRowDrag, type SelectionRowDragParams } from "./selectionRowDrag";

/** Keep AG Grid's checkbox (including Space, Shift and select-all), using it as the drag handle too. */
export function SelectionRowDragRenderer({ eGridCell, node, api, registerRowDragger, canDrag }: SelectionRowDragParams) {
  useLayoutEffect(() => {
    const params = { eGridCell, node, api, registerRowDragger, canDrag };
    let cleanup = attachSelectionRowDrag(params);
    if (cleanup) return cleanup;
    // The native checkbox can be mounted after the React value renderer when
    // a previously read-only grid gains a selection column. Do not miss it.
    const observer = new MutationObserver(() => {
      cleanup = attachSelectionRowDrag(params);
      if (cleanup) observer.disconnect();
    });
    observer.observe(eGridCell, { childList: true, subtree: true });
    return () => { observer.disconnect(); cleanup?.(); };
  }, [eGridCell, node, api, registerRowDragger, canDrag]);
  return null;
}
