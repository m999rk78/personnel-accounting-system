type ResizePointerOptions = {
  isDragging: () => boolean;
  start: (id: string, event: PointerEvent, handle: HTMLButtonElement) => void;
};
type Point = { x: number; y: number };
const tolerance = 3;

/** Resolve the drawn cell boundary, independent of which neighbouring header
 * wins native hit testing. Keyboard focus stays on the existing separator. */
export function connectTimesheetResizePointer(root: HTMLElement, options: ResizePointerOptions) {
  let pointer: Point | null = null;
  let hovered: HTMLButtonElement | null = null;
  let disposed = false;
  const view = root.ownerDocument.defaultView;

  const clear = () => {
    hovered?.removeAttribute("data-resize-hover");
    hovered = null;
    root.classList.remove("timesheet-column-edge-hover");
  };
  const find = (point: Point) => {
    const bounds = root.getBoundingClientRect();
    if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) return null;
    const candidates = [...root.querySelectorAll<HTMLButtonElement>(".timesheet-column-resize-handle")].flatMap(handle => {
      const id = handle.dataset.columnId;
      const cell = handle.closest<HTMLTableCellElement>("th");
      if (!id || handle.dataset.resizeEdge !== "right" || !cell || !cell.getClientRects().length) return [];
      const rect = cell.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.right <= bounds.left || rect.left >= bounds.right) return [];
      const pin = cell.dataset.timesheetPin === "right" ? "right" : cell.dataset.timesheetPin === "left" ? "left"
        : cell.dataset.timesheetPin === "none" ? null : cell.classList.contains("timesheet-sticky") ? "left" : null;
      return [{ id, handle, rect, pin }];
    });
    const leftEdge = Math.max(bounds.left, ...candidates.filter(candidate => candidate.pin === "left").map(candidate => Math.min(bounds.right, candidate.rect.right)));
    const rightEdge = Math.min(bounds.right, ...candidates.filter(candidate => candidate.pin === "right").map(candidate => Math.max(bounds.left, candidate.rect.left)));
    return candidates.filter(({ rect, pin }) => rect.right >= bounds.left && rect.right <= bounds.right
      && (pin || rect.right >= leftEdge && rect.right <= rightEdge)
      && point.y >= Math.max(bounds.top, rect.top) && point.y <= Math.min(bounds.bottom, rect.bottom)
      && Math.abs(point.x - rect.right) <= tolerance)
      .sort((a, b) => Math.abs(point.x - a.rect.right) - Math.abs(point.x - b.rect.right) || Number(Boolean(b.pin)) - Number(Boolean(a.pin)))[0] ?? null;
  };
  const highlight = (handle: HTMLButtonElement | null) => {
    if (hovered !== handle) { clear(); hovered = handle; }
    if (hovered) {
      if (!hovered.hasAttribute("data-resize-hover")) hovered.setAttribute("data-resize-hover", "true");
      // React may rewrite the shell's selection classes while the same divider
      // stays under a stationary pointer. Restore only this controller's class.
      if (!root.classList.contains("timesheet-column-edge-hover")) root.classList.add("timesheet-column-edge-hover");
    }
  };
  const refresh = () => {
    if (disposed || options.isDragging()) return;
    highlight(pointer ? find(pointer)?.handle ?? null : null);
  };
  const move = (event: PointerEvent) => {
    if (event.isPrimary === false) return;
    pointer = { x: event.clientX, y: event.clientY };
    refresh();
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false || options.isDragging()) return;
    pointer = { x: event.clientX, y: event.clientY };
    const target = find(pointer);
    highlight(target?.handle ?? null);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    options.start(target.id, event, target.handle);
  };
  const leave = (event: PointerEvent) => {
    // Captured leave events from a child do not mean the table was left.
    if (event.target !== root) return;
    pointer = null;
    refresh();
  };
  root.addEventListener("pointermove", move, true);
  root.addEventListener("pointerdown", down, true);
  root.addEventListener("pointerleave", leave, true);
  root.addEventListener("scroll", refresh, { passive: true });
  view?.addEventListener("scroll", refresh, { passive: true });
  view?.addEventListener("resize", refresh);
  return {
    refresh,
    dispose: () => {
      disposed = true;
      root.removeEventListener("pointermove", move, true);
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("pointerleave", leave, true);
      root.removeEventListener("scroll", refresh);
      view?.removeEventListener("scroll", refresh);
      view?.removeEventListener("resize", refresh);
      clear();
      pointer = null;
    },
  };
}
