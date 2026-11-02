/** Report dates are calendar days, independent of the browser's timezone. */
export function isReportWorkDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/** Moving an unsaved day stays in the existing undo/redo history. */
export function moveUnsavedReportDay<T>(edits: Record<string, T[]>, sourceKey: string, targetKey: string, targetRows: T[] = []): Record<string, T[]> {
  if (sourceKey === targetKey) return edits;
  if (!sourceKey.startsWith("new:") || !isReportWorkDate(sourceKey.slice(4)) || !edits[sourceKey]) throw new Error("Не найден исходный черновик. Обновите таблицу.");
  const source = edits[sourceKey];
  const destination = edits[targetKey] ?? targetRows;
  if (source.length + destination.length > 1000) throw new Error("На выбранную дату получится больше 1000 строк. Разделите отчёт.");
  const next = { ...edits, [targetKey]: [...source, ...destination] };
  delete next[sourceKey];
  return next;
}
