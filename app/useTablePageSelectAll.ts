"use client";

import { useEffect, type RefObject } from "react";
import { shouldUseTablePageSelectAll } from "./tablePageSelectAll";

/** Listen after local controls so their existing keyboard handling takes priority. */
export function useTablePageSelectAll({ rootRef, selectAll, enabled = true }: {
  rootRef: RefObject<HTMLElement | null>;
  selectAll: () => boolean;
  enabled?: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    const selectTable = (event: globalThis.KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !shouldUseTablePageSelectAll(event, root) || !selectAll()) return;
      event.preventDefault();
      event.stopPropagation();
      root.ownerDocument.getSelection()?.removeAllRanges();
      root.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", selectTable);
    return () => document.removeEventListener("keydown", selectTable);
  }, [enabled, rootRef, selectAll]);
}
