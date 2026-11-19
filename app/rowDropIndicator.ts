export type RowDropPlacement = "before" | "after";
type Bounds = { left: number; right: number; top: number; bottom: number };
type RowDropTarget = { row: HTMLElement; placement: RowDropPlacement; count: number; rowNumber: number };

/** Preview and drop must use the same half of the target row. */
export function rowDropPlacement(clientY: number, rect: { top: number; height: number }): RowDropPlacement {
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

export function rowDropIndicatorGeometry(row: Pick<Bounds, "top" | "bottom">, bounds: Bounds, placement: RowDropPlacement) {
  const y = placement === "before" ? row.top : row.bottom;
  if (![y, bounds.left, bounds.right, bounds.top, bounds.bottom].every(Number.isFinite)
    || bounds.right - bounds.left < 20 || bounds.bottom <= bounds.top || y < bounds.top - 1 || y > bounds.bottom + 1) return null;
  const labelBelow = placement === "before" ? y - bounds.top < 30 : bounds.bottom - y >= 30;
  return { left: bounds.left + 3, top: Math.max(bounds.top, Math.min(bounds.bottom, y)), width: bounds.right - bounds.left - 6, labelBelow };
}

/** A single non-interactive overlay also spans pinned columns and sticky cells. */
export function createRowDropIndicator(owner: HTMLElement) {
  const doc = owner.ownerDocument;
  const view = doc.defaultView;
  const line = doc.createElement("div");
  line.className = "table-row-drop-indicator";
  line.hidden = true;
  line.setAttribute("role", "status");
  line.setAttribute("aria-live", "polite");
  const label = doc.createElement("span");
  label.className = "table-row-drop-label";
  line.append(label);
  doc.body.append(line);
  let target: RowDropTarget | null = null;
  let identity: string | null = null;
  let frame: number | null = null;
  let destroyed = false;
  const rowIdentity = (row: HTMLElement) => row.getAttribute("row-id") ?? row.getAttribute("data-row-drop-id");
  const clear = () => { target = null; line.hidden = true; label.textContent = ""; };
  const paint = () => {
    frame = null;
    if (!view || destroyed || !target) return;
    if (!owner.isConnected || !target.row.isConnected || !owner.contains(target.row) || rowIdentity(target.row) !== identity) { clear(); return; }
    const outer = owner.getBoundingClientRect();
    const viewport = owner.querySelector<HTMLElement>(".ag-grid-viewport, .ag-body-viewport");
    const body = viewport?.getBoundingClientRect() ?? outer;
    const bounds = { left: Math.max(0, outer.left), right: Math.min(view.innerWidth, outer.right), top: Math.max(0, outer.top, body.top), bottom: Math.min(view.innerHeight, outer.bottom, body.bottom) };
    // Native headings/footers are sticky; never show a drop line through them.
    if (!viewport) {
      const head = owner.querySelector("thead")?.getBoundingClientRect();
      const foot = owner.querySelector("tfoot")?.getBoundingClientRect();
      if (head && head.bottom > bounds.top && head.top < bounds.bottom) bounds.top = Math.min(bounds.bottom, head.bottom);
      if (foot && foot.top < bounds.bottom && foot.bottom > bounds.top) bounds.bottom = Math.max(bounds.top, foot.top);
    } else if (viewport.matches(".ag-grid-viewport")) {
      bounds.top += owner.querySelector<HTMLElement>(".ag-grid-pinned-top-rows")?.offsetHeight ?? 0;
      bounds.bottom -= owner.querySelector<HTMLElement>(".ag-grid-pinned-bottom-rows")?.offsetHeight ?? 0;
    }
    const geometry = rowDropIndicatorGeometry(target.row.getBoundingClientRect(), bounds, target.placement);
    if (!geometry) { line.hidden = true; return; }
    line.style.left = `${geometry.left}px`;
    line.style.top = `${geometry.top}px`;
    line.style.width = `${geometry.width}px`;
    line.dataset.placement = target.placement;
    line.dataset.labelSide = geometry.labelBelow ? "below" : "above";
    const text = `${target.placement === "before" ? "Перед строкой" : "После строки"} ${target.rowNumber} · строк: ${target.count}`;
    if (label.textContent !== text) label.textContent = text;
    line.hidden = false;
  };
  const schedule = () => { if (target && view && frame === null) frame = view.requestAnimationFrame(paint); };
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
  doc.addEventListener("scroll", schedule, true);
  doc.addEventListener("keydown", escape, true);
  doc.addEventListener("dragend", clear, true);
  view?.addEventListener("resize", schedule);
  view?.addEventListener("blur", clear);
  return {
    show(next: RowDropTarget) {
      if (destroyed) return;
      if (frame !== null) { view?.cancelAnimationFrame(frame); frame = null; }
      target = next;
      identity = rowIdentity(next.row);
      paint();
    },
    clear,
    destroy() {
      if (destroyed) return;
      destroyed = true; clear();
      if (frame !== null) view?.cancelAnimationFrame(frame);
      doc.removeEventListener("scroll", schedule, true);
      doc.removeEventListener("keydown", escape, true);
      doc.removeEventListener("dragend", clear, true);
      view?.removeEventListener("resize", schedule);
      view?.removeEventListener("blur", clear);
      line.remove();
    },
  };
}
