/** Keep exported filenames readable and valid on macOS, Windows and in browsers. */
export function excelFileName(label: string, context: readonly (string | number | null | undefined)[] = []): string {
  const parts = [label, ...context].filter(value => value !== null && value !== undefined && String(value).trim()).map(value => String(value).normalize("NFC")
    // eslint-disable-next-line no-control-regex -- desktop file names cannot contain control characters.
    .replace(/\.xlsx$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").trim().replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^[._]+|[._]+$/g, "")).filter(Boolean);
  let name = parts.join("_") || "Таблица";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `Таблица_${name}`;
  return `${Array.from(name).slice(0, 180).join("").replace(/[._]+$/g, "")}.xlsx`;
}

export function downloadExcelFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = excelFileName(name);
  document.body.appendChild(link);
  try { link.click(); }
  finally {
    link.remove();
    // Safari may begin reading the object URL after the click handler has returned.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** A grid callback supplies IDs in the exact filtered and sorted display order. */
export function excelRowsInOrder<T extends { id: number }>(rows: readonly T[], ids: readonly number[] | null): T[] {
  if (ids === null) return [...rows];
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
}
