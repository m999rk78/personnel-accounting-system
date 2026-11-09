import { moveRowBlock, orderRowsByIds, type RowMove, type RowOrderId } from "./tableRowOrder.ts";

export const personnelReportOrderScope = "personnel-report-rows";
export const personnelReportOrderId = (row: { workDate: string; rowKey: string; orderKey?: string }) => `${row.workDate}/${row.orderKey ?? row.rowKey}`;
const tokenPattern = /^\d{4}-\d{2}-\d{2}\/(?:approved-[1-9]\d*|report-[1-9]\d*-[1-9]\d*|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i;
export const isPersonnelReportOrderId = (id: unknown): id is string => typeof id === "string" && tokenPattern.test(id) && Number.isFinite(Date.parse(`${id.slice(0, 10)}T00:00:00Z`)) && new Date(`${id.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === id.slice(0, 10);
export const isUnsavedPersonnelReportOrderId = (id: string) => isPersonnelReportOrderId(id) && !/\/(?:approved|report)-/.test(id);

/** Yesterday's personal display order is also the starting order of the new crew. */
export function orderPersonnelReportCrewRows<T extends { id: number; reportId: number; workDate: string }>(rows: readonly T[], order: readonly RowOrderId[]): T[] {
  return orderRowsByIds(rows, order, row => `${row.workDate}/${row.reportId > 0 ? `report-${row.reportId}-${row.id}` : `approved-${row.id}`}`);
}

/** Saving turns a local draft UUID into a database row ID without losing its position. */
export function remapPersonnelReportOrder(order: readonly string[], aliases: Record<string, string>, allowed: ReadonlySet<string>): string[] {
  for (const [oldId, newId] of Object.entries(aliases)) {
    if (!isUnsavedPersonnelReportOrderId(oldId) || !isPersonnelReportOrderId(newId) || !allowed.has(newId) || oldId.slice(0, 10) !== newId.slice(0, 10)) throw new Error("Не удалось сопоставить сохранённые строки отчёта.");
  }
  return [...new Set(order.map(id => aliases[id] ?? id))];
}

/** A report row is a record, not a person. Moves never cross a report date. */
export function movePersonnelReportRows(order: readonly string[], move: RowMove<string>): string[] {
  const date = move.movingIds[0]?.slice(0, 10);
  if (!date || move.movingIds.some(id => id.slice(0, 10) !== date)) throw new Error("Выберите для переноса строки одной даты.");
  if (move.targetId && move.targetId.slice(0, 10) !== date) throw new Error("Строки можно перемещать только внутри одной даты отчёта.");
  const dayRows = order.filter(id => id.slice(0, 10) === date);
  const next = moveRowBlock(dayRows, { ...move, displayedIds: move.displayedIds?.filter(id => id.slice(0, 10) === date) });
  let index = 0;
  const result = order.map(id => id.slice(0, 10) === date ? next[index++] : id);
  groupPersonnelReportDates(result, id => id.slice(0, 10));
  return result;
}

/** Column sorting applies inside each day; dates always stay together. */
export function groupPersonnelReportDates<T>(rows: T[], getDate: (row: T) => string, direction: "asc" | "desc" = "desc") {
  rows.sort((left, right) => getDate(left).localeCompare(getDate(right)) * (direction === "asc" ? 1 : -1));
}
