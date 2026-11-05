"use client";

import { useEffect } from "react";

const overlaySelector = [
  "dialog[open]", "[role='dialog']", "[role='alertdialog']", "[role='menu']", "[role='listbox']",
  ".ag-menu", ".ag-popup-editor", ".custom-select-menu", ".personnel-filter",
].join(",");

/** Editors and open popups own the first Escape; selection owns the next one. */
export function isTableSelectionEscape(event: globalThis.KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return false;
  const target = event.target;
  if (target instanceof Element) {
    if (target.closest("textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='searchbox'], [role='combobox'], .ag-cell-inline-editing")) return false;
    const input = target.closest("input");
    if (input && !["checkbox", "radio", "button", "submit", "reset"].includes(input.type)) return false;
  }
  // Portalled filters and calendars may leave focus on their table or trigger.
  // Check them before their own Escape handlers remove them from the document.
  return !Array.from(document.querySelectorAll<HTMLElement>(overlaySelector)).some(element =>
    !element.closest("[aria-hidden='true']") && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
  );
}

export function useTableEscapeSelection({ hasSelection, clearSelection, isEditing }: {
  hasSelection: () => boolean;
  clearSelection: () => void;
  isEditing?: () => boolean;
}) {
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (hasSelection() && !isEditing?.() && isTableSelectionEscape(event)) clearSelection();
    };
    // Capture also covers focused row checkboxes and AG Grid's native handlers.
    // Leave propagation intact so existing editors and menus keep their behavior.
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [hasSelection, clearSelection, isEditing]);
}
