export type ReportColumnSizing = { header: string; min: number; max: number; cellPadding: number };
export type ReportTextMeasure = (text: string, bold?: boolean) => number;

const headerPadding = 52;
const contentText = (value: string | number) => String(value).replace(/\s+/g, " ").trim();

/** Size the full dataset, including content outside the virtualized viewport. */
export function reportColumnWidths<Column extends string>(
  sizing: Readonly<Record<Column, ReportColumnSizing>>,
  values: readonly Readonly<Partial<Record<Column, string | number | null>>>[],
  measure: ReportTextMeasure,
): Record<Column, number> {
  const columns = Object.keys(sizing) as Column[];
  // Repeated names and work labels need one measurement; cap memory for imports.
  const measured = new Map<string, number>();
  const textWidth = (text: string, bold = false) => {
    const key = `${bold ? "header" : "cell"}:${text}`;
    const cached = measured.get(key);
    if (cached !== undefined) return cached;
    const result = measure(text, bold);
    const width = Number.isFinite(result) && result >= 0 ? result : text.length * (bold ? 8 : 7);
    if (measured.size < 512 && text.length <= 512) measured.set(key, width);
    return width;
  };
  const bounded = (column: ReportColumnSizing, width: number) => Math.min(column.max, Math.max(column.min, Math.ceil(width)));
  const widths = Object.fromEntries(columns.map(id => {
    const column = sizing[id];
    return [id, bounded(column, textWidth(column.header, true) + headerPadding)];
  })) as Record<Column, number>;
  for (const row of values) {
    for (const id of columns) {
      const column = sizing[id];
      if (widths[id] >= column.max) continue;
      const value = row[id];
      if (value === undefined || value === null || value === "") continue;
      const text = contentText(value);
      if (text) widths[id] = Math.max(widths[id], bounded(column, textWidth(text) + column.cellPadding));
    }
  }
  return widths;
}
