import { isUnsavedPersonnelReportOrderId, personnelReportOrderScope } from "./personnelReportRowOrder.ts";
import { isUnsavedEquipmentReportOrderId, equipmentReportOrderScope } from "./equipmentReportRowOrder.ts";
import type { RowOrderId } from "./tableRowOrder";

/** Canonical saved IDs must not push freshly prepended local report rows down.
 * An unsaved row already ranked by a manual move keeps that saved position. */
export function prependUnrankedReportDrafts<T>(rows: T[], ids: readonly RowOrderId[], getId: (row: T) => RowOrderId | undefined, scope: string | null) {
  const isUnsaved = scope === personnelReportOrderScope ? isUnsavedPersonnelReportOrderId
    : scope === equipmentReportOrderScope ? isUnsavedEquipmentReportOrderId : null;
  if (!isUnsaved) return rows;
  const known = new Set(ids);
  const fresh = new Set(rows.flatMap(row => {
    const id = getId(row);
    return typeof id === "string" && !known.has(id) && isUnsaved(id) ? [id] : [];
  }));
  if (!fresh.size) return rows;
  return [...rows.filter(row => fresh.has(String(getId(row)))), ...rows.filter(row => !fresh.has(String(getId(row))))];
}
