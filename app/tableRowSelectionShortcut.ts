import { isTableTextEntryTarget } from "./tableSelectAllShortcut";

type RowSelectionKey = {
  key: string;
  code?: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
};

export function isTableRowSelectionBlocked(target?: EventTarget | null) {
  if (isTableTextEntryTarget(target)) return true;
  if (typeof document === "undefined") return false;
  return Array.from(document.querySelectorAll<HTMLElement>(".ag-popup-editor, .ag-cell-inline-editing, .timesheet-cell-inline-editor, .ag-menu, .custom-select-menu, [role='menu'], [role='listbox'], dialog[open], [role='dialog'], [role='alertdialog']"))
    .some(element => {
      if (element.closest("[hidden], [aria-hidden='true']") || !element.getClientRects().length || getComputedStyle(element).visibility === "hidden") return false;
      // A preview table inside a dialog owns its own row shortcuts.
      return !element.matches("dialog, [role='dialog'], [role='alertdialog']") || !(target instanceof Node && element.contains(target));
    });
}

/** Whole-row selection is a copy/edit range, independent of action checkboxes. */
export function tableRowSelectionIntent(event: RowSelectionKey): "row" | "up" | "down" | null {
  if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing
    || event.defaultPrevented || isTableRowSelectionBlocked(event.target)) return null;
  if (event.code === "Space" || event.key === " " || event.key === "Spacebar") return "row";
  if (event.key === "ArrowUp") return "up";
  if (event.key === "ArrowDown") return "down";
  return null;
}

/** Ctrl+Space selects columns; Option+Space avoids the macOS input-source shortcut. */
export function tableColumnSelectionIntent(event: RowSelectionKey): "column" | "left" | "right" | null {
  if (event.metaKey || event.isComposing || event.defaultPrevented || isTableRowSelectionBlocked(event.target)) return null;
  const space = event.code === "Space" || event.key === " " || event.key === "Spacebar" || event.key === "\u00a0";
  if (!event.shiftKey && space && (event.ctrlKey && !event.altKey || event.altKey && !event.ctrlKey)) return "column";
  if (event.shiftKey && !event.ctrlKey && !event.altKey) {
    if (event.key === "ArrowLeft") return "left";
    if (event.key === "ArrowRight") return "right";
  }
  return null;
}
