// Keep the DOM proportional to the viewport, not to the number of people in a project.
export function tableRowWindow(rowCount: number, scrollTop: number, viewportHeight: number, rowHeight = 46, overscan = 8) {
  const count = Math.max(0, Math.floor(rowCount));
  const height = Math.max(1, rowHeight);
  const visibleCount = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / height));
  const first = Math.min(Math.max(0, count - visibleCount), Math.max(0, Math.floor(scrollTop / height)));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visibleCount + overscan);
  return { start, end, top: start * height, bottom: (count - end) * height };
}

export function rowScrollOffset(rowIndex: number, scrollTop: number, viewportHeight: number, rowHeight: number) {
  const top = rowIndex * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return scrollTop;
}
