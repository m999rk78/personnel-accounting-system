import type { GridOptions, MultiRowSelectionOptions } from "ag-grid-community";

/** Reordering is independent of deletion; supply local checkboxes when bulk mutation selection is absent. */
export function gridRowSelection<TData>({ supplied, canSelect, canReorder, isOrderable }: {
  supplied: GridOptions<TData>["rowSelection"];
  canSelect: boolean;
  canReorder: boolean;
  isOrderable: (row: TData) => boolean;
}): GridOptions<TData>["rowSelection"] {
  if (!canSelect) return undefined;
  if (supplied) return supplied;
  if (!canReorder) return undefined;
  const selection: MultiRowSelectionOptions<TData> = {
    mode: "multiRow", checkboxes: true, headerCheckbox: true, selectAll: "filtered", enableClickSelection: false, hideDisabledCheckboxes: true,
    isRowSelectable: node => Boolean(node.data && isOrderable(node.data)),
  };
  return selection;
}
