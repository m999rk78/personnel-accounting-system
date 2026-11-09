import { isTableSelectAllShortcut, isTableTextEntryTarget } from "./tableSelectAllShortcut";

function isVisibleTableShortcutElement(element: HTMLElement) {
  if (!element.isConnected || element.closest("[hidden], [inert], [aria-hidden='true']") || !element.getClientRects().length) return false;
  const visibility = element.ownerDocument.defaultView?.getComputedStyle(element).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

/** A page shortcut belongs to the visible table, unless an editor or popup owns it. */
export function shouldUseTablePageSelectAll(event: KeyboardEvent, root: HTMLElement) {
  if (!isTableSelectAllShortcut(event) || !isVisibleTableShortcutElement(root)) return false;
  const document = root.ownerDocument;
  if (isTableTextEntryTarget(document.activeElement)) return false;
  if (event.target instanceof Element) {
    const otherTable = event.target.closest("table, [role='table'], [role='grid'], [role='treegrid'], [role='application'], .ag-root");
    if (otherTable && !root.contains(otherTable) && otherTable !== root) return false;
  }
  return !Array.from(document.querySelectorAll<HTMLElement>("dialog[open], [role='dialog'], [role='alertdialog'], [aria-modal='true'], [role='menu'], [role='listbox'], .ag-popup-child, .ag-filter, .ag-menu, .personnel-filter, .custom-select-menu, .table-context-menu"))
    .some(isVisibleTableShortcutElement);
}
