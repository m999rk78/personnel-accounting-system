"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { GridApi, PostProcessPopupParams } from "ag-grid-community";
import { columnFilterVisibility } from "./columnFilterToggle";
import { registerTableFilterEscape } from "./tableFilterEscape";

const filterSelector = ".ag-filter-menu";
const nestedPicker = ".custom-select-menu, .ag-select-list, .ag-menu-list";
const expandedPicker = ".custom-select-toggle[aria-expanded='true'], .ag-picker-field-wrapper[aria-expanded='true']";

/** AG's native Escape only works while its popup owns focus. Handle the same
 * Cancel action from an external header/another focus target as well. */
export function useGridFilterEscape<T>({ api, getRoot }: { api: GridApi<T> | null; getRoot: () => HTMLElement | null }) {
  const active = useRef<{ popup: HTMLElement; close: () => void } | null>(null);
  const root = useRef(getRoot);
  useLayoutEffect(() => { root.current = getRoot; }, [getRoot]);
  useEffect(() => {
    if (!api || api.isDestroyed()) return;
    return registerTableFilterEscape({
      root: () => api.isDestroyed() ? null : root.current(),
      hasFilters: () => Object.keys(api.getFilterModel()).length > 0,
      isEditing: () => api.getEditingCells().length > 0,
      reset: () => api.setFilterModel(null),
    });
  }, [api]);
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat) return;
      const current = active.current;
      if (!current?.popup.isConnected) return;
      const target = event.target instanceof Element ? event.target : null;
      const targetFilter = target?.closest(filterSelector);
      const topFilter = Array.from(document.querySelectorAll<HTMLElement>(filterSelector)).at(-1);
      if ((targetFilter ?? topFilter) !== current.popup) return;
      // An open child list or another focused overlay gets its own Escape first.
      if (target?.closest(nestedPicker) || current.popup.querySelector(expandedPicker)) return;
      if (!targetFilter && target?.closest("dialog[open], [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], .ag-popup-editor, .ag-cell-inline-editing")) return;
      event.preventDefault();
      event.stopPropagation();
      active.current = null;
      current.close();
    }
    document.addEventListener("keydown", handleEscape, true);
    return () => { document.removeEventListener("keydown", handleEscape, true); active.current = null; };
  }, []);

  return useCallback(({ api, column, ePopup, eventSource }: PostProcessPopupParams<T>, trigger?: HTMLElement) => {
    if (!ePopup.matches(filterSelector) || !column || active.current?.popup === ePopup) return;
    const columnId = column.getColId();
    active.current = { popup: ePopup, close: () => {
      if (api.isDestroyed()) return;
      const anchor = trigger ?? columnFilterVisibility(api).getAnchor(columnId) ?? eventSource;
      // Checklist changes are applied immediately. Only filters with
      // Apply/Cancel need to discard pending values and sort changes.
      if (!ePopup.querySelector(".grid-checklist-filter-heading")) api.doFilterAction({ colId: columnId, action: "cancel" });
      if (ePopup.isConnected) api.hideColumnFilter();
      if (anchor?.isConnected) anchor.focus({ preventScroll: true });
    } };
  }, []);
}
