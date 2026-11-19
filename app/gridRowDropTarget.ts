import type { RowDragEvent } from "ag-grid-community";
import type { RowMove } from "./tableRowOrder";

/** Resolve the row currently under the pointer, including after virtual scrolling.
 * AG's last drag event can still refer to a row which has since moved away.
 */
export function resolveGridRowDropTarget<TData, TMove extends RowMove>(root: HTMLElement, event: RowDragEvent<TData>, getMove: (event: RowDragEvent<TData>) => TMove | null): {
  row: HTMLElement; operation: TMove & { placement: "before" | "after" }; rowNumber: number;
} | null {
  if (!root.isConnected || event.api.isDestroyed() || event.node.id == null || event.api.getRowNode(event.node.id) !== event.node) return null;
  const grid = root.querySelector<HTMLElement>(".ag-root");
  const viewport = root.querySelector<HTMLElement>(".ag-body-viewport, .ag-grid-viewport");
  if (!grid || !viewport) return null;
  const pointer = event.event as MouseEvent | TouchEvent;
  const point = "touches" in pointer ? pointer.touches[0] ?? pointer.changedTouches[0] : pointer;
  if (!point || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return null;
  const outer = root.getBoundingClientRect();
  const body = viewport.getBoundingClientRect();
  const { clientX: x, clientY: y } = point;
  if (x < Math.max(outer.left, body.left) || x >= Math.min(outer.right, body.right)
    || y < Math.max(outer.top, body.top) || y >= Math.min(outer.bottom, body.bottom)) return null;
  for (const row of root.querySelectorAll<HTMLElement>(".ag-row[row-index]")) {
    // A master/detail table contains independent nested grids and pinned rows.
    if (row.closest(".ag-root") !== grid) continue;
    const index = row.getAttribute("row-index");
    if (index === null || !/^\d+$/.test(index)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0 || y < rect.top || y >= rect.bottom) continue;
    const node = event.api.getDisplayedRowAtIndex(Number(index));
    if (!node?.data || node.rowPinned || node.detail || node.rowTop == null) continue;
    const operation = getMove({ ...event, overNode: node, overIndex: Number(index), y: node.rowTop + y - rect.top });
    if (!operation || operation.placement !== "before" && operation.placement !== "after") return null;
    return { row, operation: { ...operation, placement: operation.placement }, rowNumber: Number(index) + 1 };
  }
  return null;
}
