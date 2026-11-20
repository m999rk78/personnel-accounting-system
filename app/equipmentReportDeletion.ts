import type { EquipmentReportGridRow } from "./EquipmentReportGrid";
import type { EquipmentReport, EquipmentReportApprovedEntry, EquipmentReportDeleteApprovedRequest } from "./equipmentReportTypes";
import { equipmentDisplayName } from "./equipmentDisplayName.ts";

export type EquipmentReportDeletionPlan = {
  payload: EquipmentReportDeleteApprovedRequest;
  items: { rowKey: string; equipmentName: string; workDate: string; ownerName: string; workName: string; hours: number }[];
};

/** Capture exact published entries, not all records belonging to the same machine. */
export function equipmentReportDeletionPlan(siteId: number, selectedRows: EquipmentReportGridRow[], reports: EquipmentReport[], entries: EquipmentReportApprovedEntry[], editedKeys: Iterable<string>): EquipmentReportDeletionPlan {
  if (!selectedRows.length) throw new Error("Выберите записи для удаления.");
  if (selectedRows.length > 5000) throw new Error("За один раз можно удалить не более 5000 записей. Выберите меньше строк.");
  const edited = new Set(editedKeys);
  const seen = new Set<number>();
  const payload: EquipmentReportDeleteApprovedRequest = { action: "delete-approved-rows", siteId, rows: [] };
  const items: EquipmentReportDeletionPlan["items"] = [];
  for (const row of selectedRows) {
    if (row.status !== "approved" || !(row.removable ?? row.editable)) throw new Error("Можно удалить только доступные вам подтверждённые записи.");
    const report = row.proposalId ? reports.find(item => item.id === row.proposalId) : undefined;
    const source = report?.rows.find(item => row.rowKey === `report-${report.id}-${item.id}`);
    const entry = row.proposalId ? undefined : entries.find(item => row.rowKey === `approved-${item.id}` && !item.orderReportId);
    const ownerKey = row.proposalId ? String(row.proposalId) : entry ? `entry-${entry.id}` : "";
    if (edited.has(ownerKey)) throw new Error("В выбранном отчёте есть несохранённые изменения. Сначала сохраните или отмените их, затем повторите удаление.");
    const entryId = source?.approvedEntryId ?? entry?.id;
    const revision = source?.approvedEntryRevision ?? entry?.revision;
    if ((!source && !entry) || (report && (report.status !== "approved" || !Number.isSafeInteger(report.revision) || report.revision < 1))
      || (source ?? entry)?.siteId !== siteId || (report && report.siteId !== siteId)
      || !Number.isSafeInteger(entryId) || Number(entryId) < 1 || !Number.isSafeInteger(revision) || Number(revision) < 1 || seen.has(entryId!)) {
      throw new Error("Список записей изменился. Обновите отчёты и выберите записи заново.");
    }
    seen.add(entryId!);
    payload.rows.push({ entryId: entryId!, revision: revision!, ...(report ? { reportId: report.id, reportRevision: report.revision } : {}) });
    const original = source ?? entry!;
    items.push({ rowKey: row.rowKey, equipmentName: equipmentDisplayName(original), workDate: original.workDate, ownerName: report?.ownerName ?? entry?.responsibleUserName ?? "Не назначен", workName: original.subworkTypeName || original.mainWorkTypeName, hours: original.hours ?? 0 });
  }
  return { payload, items };
}
