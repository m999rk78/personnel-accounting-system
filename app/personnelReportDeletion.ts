import type { PersonnelReportGridRow } from "./PersonnelReportGrid";
import type { PersonnelReport, PersonnelReportApprovedEntry, PersonnelReportDeleteApprovedRequest } from "./personnelReportTypes";

export type PersonnelReportDeletionPlan = {
  payload: PersonnelReportDeleteApprovedRequest;
  items: { rowKey: string; employeeName: string; workDate: string; ownerName: string; workName: string; hours: number }[];
};

/** Freeze exact published records and their versions, independently of employee identity. */
export function personnelReportDeletionPlan(siteId: number, selectedRows: PersonnelReportGridRow[], reports: PersonnelReport[], entries: PersonnelReportApprovedEntry[], editedKeys: Iterable<string>): PersonnelReportDeletionPlan {
  if (!selectedRows.length) throw new Error("Выберите записи для удаления.");
  if (selectedRows.length > 5000) throw new Error("За один раз можно удалить не более 5000 записей. Выберите меньше строк.");
  const edited = new Set(editedKeys);
  const seen = new Set<number>();
  const payload: PersonnelReportDeleteApprovedRequest = { action: "delete-approved-rows", siteId, rows: [] };
  const items: PersonnelReportDeletionPlan["items"] = [];
  for (const row of selectedRows) {
    if (row.status !== "approved" || !(row.removable ?? row.editable)) throw new Error("Можно удалить только доступные вам подтверждённые записи.");
    const report = row.proposalId ? reports.find(item => item.id === row.proposalId) : undefined;
    const source = report?.rows.find(item => row.rowKey === `report-${report.id}-${item.id}`);
    const entry = row.proposalId ? undefined : entries.find(item => row.rowKey === `approved-${item.id}` && !item.orderReportId);
    const ownerKey = row.proposalId ? String(row.proposalId) : entry ? `entry-${entry.id}` : "";
    if (edited.has(ownerKey)) throw new Error("В выбранном отчёте есть несохранённые изменения. Сначала сохраните или отмените их, затем повторите удаление.");
    const entryId = source?.approvedEntryId ?? entry?.id;
    const revision = source?.approvedEntryRevision ?? entry?.revision;
    if ((!source && !entry) || (report && report.status !== "approved") || (report ?? entry)?.siteId !== siteId || !entryId || !Number.isSafeInteger(revision) || Number(revision) < 1 || seen.has(entryId)) {
      throw new Error("Список записей изменился. Обновите отчёты и выберите записи заново.");
    }
    seen.add(entryId);
    payload.rows.push({ entryId, revision: revision!, ...(report ? { reportId: report.id, reportRevision: report.revision } : {}) });
    const original = source ?? entry!;
    items.push({ rowKey: row.rowKey, employeeName: original.employeeName, workDate: original.workDate, ownerName: report?.ownerName ?? entry?.responsibleUserName ?? "Не назначен", workName: original.subworkTypeName || original.mainWorkTypeName, hours: original.hours ?? 0 });
  }
  return { payload, items };
}
