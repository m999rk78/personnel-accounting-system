import type { PersonnelReportDraftSnapshot } from "./personnelReportDraftBuffer";
import type { PersonnelReport } from "./personnelReportTypes";
import { personnelReportNewDate } from "./personnelReportSessions.ts";
import { pastePersonnelCells, type PersonnelCellField, type PersonnelImportBatch, type PersonnelSpreadsheetCatalogs, type PersonnelSpreadsheetDraft } from "./personnelSpreadsheet.ts";

export type PersonnelDraftContent = Pick<PersonnelReportDraftSnapshot, "edits" | "sessions" | "importBatches">;
export type PersonnelDraftPendingInput = { rowKey: string; field: PersonnelCellField; value: string };

/** Only private working drafts participate in automatic saving, never reviewed records. */
export function personnelDraftContent(userId: number, siteId: number, today: string, edits: PersonnelDraftContent["edits"], sessions: PersonnelDraftContent["sessions"], reports: PersonnelReport[], importBatches: PersonnelImportBatch[], pending: PersonnelDraftPendingInput | null, catalogs: PersonnelSpreadsheetCatalogs, toDraft: (report: PersonnelReport["rows"][number]) => PersonnelSpreadsheetDraft): PersonnelDraftContent {
  const own = (report: PersonnelReport | undefined) => report && report.ownerUserId === userId && report.siteId === siteId && (report.status === "draft" || report.status === "rejected");
  const known = new Map(reports.map(report => [String(report.id), report]));
  for (const [key, report] of Object.entries(sessions)) known.set(key, report);
  const draftEdits: PersonnelDraftContent["edits"] = {};
  const draftSessions: PersonnelDraftContent["sessions"] = {};
  for (const [key, rows] of Object.entries(edits)) {
    const report = known.get(key);
    if (key.startsWith("new:") && personnelReportNewDate(key, today)) draftEdits[key] = rows;
    else if (own(report)) { draftEdits[key] = rows; draftSessions[key] = report!; }
  }
  if (pending) {
    let key = Object.keys(draftEdits).find(key => draftEdits[key].some(row => row.key === pending.rowKey));
    if (!key) {
      const report = [...known.values()].find(report => own(report) && report.rows.some(row => `report-${report.id}-${row.id}` === pending.rowKey));
      if (report) {
        key = String(report.id);
        draftEdits[key] = report.rows.map(toDraft);
        draftSessions[key] = report;
      }
    }
    if (key) draftEdits[key] = draftEdits[key].map(row => row.key === pending.rowKey ? pastePersonnelCells(row, { [pending.field]: pending.value }, catalogs) : row);
  }
  const activeBatches = new Set(Object.values(draftEdits).flatMap(rows => rows.flatMap(row => row.importBatchId ? [row.importBatchId] : [])));
  return { edits: draftEdits, sessions: draftSessions, importBatches: importBatches.filter(batch => activeBatches.has(batch.id)) };
}
