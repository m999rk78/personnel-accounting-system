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

/** A newly added row has no saved identity and can leave a saved draft on its own. */
export function moveUnsavedReportRow<T extends { key: string; reportRowId?: number }>(edits: Record<string, T[]>, sourceKey: string, targetKey: string, rowKey: string, targetRows: T[] = [], savedSourceRows?: T[]): Record<string, T[]> {
  if (!/^[1-9]\d*$/.test(sourceKey) || !edits[sourceKey]) throw new Error("Не найден исходный черновик. Обновите таблицу.");
  const source = edits[sourceKey];
  const matches = source.filter(row => row.key === rowKey);
  if (matches.length !== 1 || matches[0].reportRowId !== undefined || /^(?:report|approved)-/.test(rowKey)) throw new Error("Отдельно можно перенести только новую несохранённую строку.");
  if (sourceKey === targetKey) return edits;
  const destination = edits[targetKey] ?? targetRows;
  if (destination.some(row => row.key === rowKey)) throw new Error("Строка уже присутствует в выбранном черновике. Обновите таблицу.");
  if (destination.length >= 1000) throw new Error("На выбранную дату получится больше 1000 строк. Разделите отчёт.");
  const remaining = source.filter(row => row.key !== rowKey);
  const next = { ...edits, [sourceKey]: remaining, [targetKey]: [matches[0], ...destination] };
  // Avoid saving an untouched source day. Any difference, including input metadata
  // or row order, deliberately keeps its edit and original optimistic revision.
  if (savedSourceRows && JSON.stringify(remaining) === JSON.stringify(savedSourceRows)) delete next[sourceKey];
  return next;
}
