type SelectAllKeyEvent = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
};

/** Text editors, search fields and popup choices retain their own select-all. */
export function isTableTextEntryTarget(target: EventTarget | null | undefined) {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target.closest("textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='searchbox'], [role='combobox'], .ag-cell-inline-editing, .ag-popup-editor, .ag-filter, .ag-menu, .custom-select-menu, .table-context-menu, [role='menu'], [role='listbox'], .report-date-calendar, .timesheet-month-picker-popover")) return true;
  const input = target.closest("input");
  return Boolean(input && !["checkbox", "radio", "button", "submit", "reset"].includes((input as HTMLInputElement).type));
}

/** Physical KeyA also works while the active keyboard layout is Russian. */
export function isTableSelectAllShortcut(event: SelectAllKeyEvent) {
  return !event.defaultPrevented && !event.altKey && !event.shiftKey && !event.isComposing
    && (event.ctrlKey || event.metaKey)
    && (event.code === "KeyA" || event.key.toLocaleLowerCase("en-US") === "a")
    && !isTableTextEntryTarget(event.target);
}
