export type EmptyColumnBounds = { left: number; right: number; pinned: "left" | "right" | null };

/** Lane-local boundaries, including columns outside AG Grid's virtual window. */
export function emptyColumnRegion(widths: readonly number[]) {
  let width = 0;
  const edges = widths.flatMap(value => {
    if (!Number.isFinite(value) || value <= 0) return [];
    width += value;
    return [width];
  });
  return { width, edges };
}

/** Physical, viewport-relative edges; central columns cannot paint over pinned ones. */
export function visibleEmptyColumnEdges(columns: EmptyColumnBounds[], width: number) {
  const leftEdge = Math.max(0, ...columns.filter(column => column.pinned === "left").map(column => column.right));
  const rightEdge = Math.min(width, ...columns.filter(column => column.pinned === "right").map(column => column.left));
  const edges = columns.filter(column => column.pinned || column.right >= leftEdge && column.right <= rightEdge).map(column => column.right);
  if (columns.some(column => column.pinned === "right")) edges.push(rightEdge);
  return [...new Set(edges.map(edge => Math.round(edge * 1000) / 1000)
    .filter(edge => Number.isFinite(edge) && edge > 0 && edge <= width))].sort((left, right) => left - right);
}

/** A single decorative layer, not extra cells or records. */
export function emptyColumnGridBackground(edges: number[], color = "var(--empty-grid-line-color, #dedede)") {
  const positions = [...new Set(edges.filter(edge => Number.isFinite(edge) && edge > 0))].sort((left, right) => left - right);
  if (!positions.length) return "none";
  return `linear-gradient(to right, transparent 0px, ${positions.map(edge => `transparent ${Math.max(0, edge - 1)}px, ${color} ${Math.max(0, edge - 1)}px, ${color} ${edge}px, transparent ${edge}px`).join(", ")}, transparent 100%)`;
}
