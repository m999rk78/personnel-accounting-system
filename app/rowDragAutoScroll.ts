export type RowDragPoint = { clientX: number; clientY: number };
export type RowDragScrollBounds = {
  left: number; right: number; top: number; bottom: number;
  contentTop: number; contentBottom: number;
  /** AG Grid already scrolls inside its own 20px body edge. */
  existingEdge?: number;
};

const EDGE_SIZE = 96;
const OUTSIDE_MARGIN = 32;

/** Pixels per second; include sticky headings in the upper activation area. */
export function rowDragScrollSpeed(point: RowDragPoint, bounds: RowDragScrollBounds): number {
  const { clientX: x, clientY: y } = point;
  if (![x, y, bounds.left, bounds.right, bounds.top, bounds.bottom, bounds.contentTop, bounds.contentBottom].every(Number.isFinite)
    || bounds.right <= bounds.left || bounds.bottom <= bounds.top
    || x < bounds.left - OUTSIDE_MARGIN || x > bounds.right + OUTSIDE_MARGIN
    || y < bounds.top - OUTSIDE_MARGIN || y > bounds.bottom + OUTSIDE_MARGIN) return 0;
  const top = Math.max(bounds.top, Math.min(bounds.bottom, bounds.contentTop));
  const bottom = Math.max(top, Math.min(bounds.bottom, bounds.contentBottom));
  const edge = Math.min(EDGE_SIZE, (bottom - top) / 3);
  if (edge <= 0) return 0;
  // Extend AG Grid's area without running a second scroll loop on its old edge.
  if (bounds.existingEdge && y >= top && y <= bottom
    && (y < top + bounds.existingEdge || y > bottom - bounds.existingEdge)) return 0;
  const direction = y < top + edge ? -1 : y > bottom - edge ? 1 : 0;
  if (!direction) return 0;
  const depth = Math.min(1, Math.max(0, direction < 0 ? (top + edge - y) / edge : (y - bottom + edge) / edge));
  return direction * (100 + 620 * depth * depth);
}

export function rowDragPoint(event: MouseEvent | TouchEvent): RowDragPoint | null {
  const point = "touches" in event ? event.touches[0] ?? event.changedTouches[0] : event;
  return point ? { clientX: point.clientX, clientY: point.clientY } : null;
}

type ScrollViewport = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;
type ScrollRuntime = {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
};

/** One frame loop per gesture. It keeps scrolling when the pointer stops moving. */
export function createRowDragAutoScroll({ viewport, bounds, runtime }: {
  viewport: ScrollViewport;
  bounds: () => RowDragScrollBounds | null;
  runtime: ScrollRuntime;
}) {
  let active = true;
  let point: RowDragPoint | null = null;
  let frame: number | null = null;
  let previousTime: number | null = null;
  const speed = () => {
    const area = bounds();
    return point && area ? rowDragScrollSpeed(point, area) : 0;
  };
  const canScroll = (velocity: number) => velocity < 0 ? viewport.scrollTop > 0 : velocity > 0 && viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight;
  const tick = (time: number) => {
    frame = null;
    if (!active) return;
    const velocity = speed();
    if (!canScroll(velocity)) { previousTime = null; return; }
    const elapsed = previousTime === null ? 16 : Math.min(32, Math.max(0, time - previousTime));
    previousTime = time;
    viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, viewport.scrollTop + velocity * elapsed / 1000));
    frame = runtime.requestFrame(tick);
  };
  return {
    update(next: RowDragPoint) {
      if (!active) return;
      point = next;
      if (frame === null && canScroll(speed())) frame = runtime.requestFrame(tick);
    },
    pause() {
      if (frame !== null) runtime.cancelFrame(frame);
      frame = null; point = null; previousTime = null;
    },
    stop() {
      active = false;
      if (frame !== null) runtime.cancelFrame(frame);
      frame = null; point = null; previousTime = null;
    },
  };
}

/** Attach only after an allowed row gesture starts, never for file/cell dragging. */
export function startRowDragAutoScroll(root: HTMLElement, initialPoint: RowDragPoint, mode: "native" | "grid", onStop?: () => void) {
  const viewport = mode === "grid" ? root.querySelector<HTMLElement>(".ag-grid-viewport, .ag-body-viewport") : root;
  const view = root.ownerDocument.defaultView;
  if (!viewport || !view) return null;
  const document = root.ownerDocument;
  const controller = createRowDragAutoScroll({
    viewport,
    runtime: { requestFrame: callback => view.requestAnimationFrame(callback), cancelFrame: id => view.cancelAnimationFrame(id) },
    bounds: () => {
      if (!root.isConnected || !viewport.isConnected) return null;
      const outer = root.getBoundingClientRect();
      const body = viewport.getBoundingClientRect();
      const gridHeader = mode === "grid" && viewport.matches(".ag-grid-viewport") ? root.querySelector<HTMLElement>(".ag-grid-pinned-top-rows")?.offsetHeight ?? 0 : 0;
      const gridFooter = mode === "grid" ? root.querySelector<HTMLElement>(".ag-grid-pinned-bottom-rows")?.offsetHeight ?? 0 : 0;
      return {
        left: Math.max(0, outer.left), right: Math.min(view.innerWidth, outer.right),
        top: Math.max(0, outer.top), bottom: Math.min(view.innerHeight, outer.bottom),
        contentTop: body.top + (mode === "native" ? viewport.querySelector<HTMLElement>("thead")?.offsetHeight ?? 0 : gridHeader),
        contentBottom: body.top + viewport.clientHeight - (mode === "native" ? viewport.querySelector<HTMLElement>("tfoot")?.offsetHeight ?? 0 : gridFooter),
        existingEdge: mode === "grid" ? 20 : undefined,
      };
    },
  });
  const move = (event: MouseEvent | TouchEvent) => {
    const point = rowDragPoint(event);
    if (point) controller.update(point);
  };
  const dragOver = (event: DragEvent) => {
    controller.update(event);
    // Sticky headings are not tbody drop targets, but must remain a scroll area.
    if (mode === "native" && root.contains(event.target as Node)) event.preventDefault();
  };
  const leaveDocument = (event: DragEvent) => {
    if (!event.relatedTarget && (event.clientX <= 0 || event.clientX >= view.innerWidth || event.clientY <= 0 || event.clientY >= view.innerHeight)) controller.pause();
  };
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape") stop(); };
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.stop();
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("touchmove", move, true);
    document.removeEventListener("dragover", dragOver, true);
    document.removeEventListener("dragleave", leaveDocument, true);
    document.removeEventListener("mouseup", stop, true);
    document.removeEventListener("touchend", stop, true);
    document.removeEventListener("touchcancel", stop, true);
    document.removeEventListener("drop", stop, true);
    document.removeEventListener("dragend", stop, true);
    document.removeEventListener("keydown", escape, true);
    view.removeEventListener("blur", stop);
    // Browsers may run microtasks between native event listeners. A new task
    // lets React's delegated onDrop read its snapshot before it is discarded.
    if (onStop) view.setTimeout(onStop, 0);
  };
  document.addEventListener("mousemove", move, true);
  document.addEventListener("touchmove", move, { capture: true, passive: true });
  document.addEventListener("dragover", dragOver, true);
  document.addEventListener("dragleave", leaveDocument, true);
  // HTML5 drag ends with drop/dragend. A browser may deliver mouseup before
  // its final dragover; stopping there would make the native drop invalid.
  if (mode === "grid") {
    document.addEventListener("mouseup", stop, true);
    document.addEventListener("touchend", stop, true);
    document.addEventListener("touchcancel", stop, true);
  }
  document.addEventListener("drop", stop, true);
  document.addEventListener("dragend", stop, true);
  document.addEventListener("keydown", escape, true);
  view.addEventListener("blur", stop);
  controller.update(initialPoint);
  return { update: controller.update, stop };
}
