import type { EquipmentImportBatch, EquipmentReportDraftSnapshot } from "./equipmentReportDraftBuffer";
import type { EquipmentReport } from "./equipmentReportTypes";
import { equipmentReportNewDate } from "./equipmentReportSessions.ts";
import { pasteEquipmentCells, type EquipmentCellField, type EquipmentSpreadsheetCatalogs, type EquipmentSpreadsheetDraft } from "./equipmentSpreadsheet.ts";

export type EquipmentDraftContent = Pick<EquipmentReportDraftSnapshot, "edits" | "sessions" | "importBatches">;
export type EquipmentDraftPendingInput = { rowKey: string; field: EquipmentCellField; value: string };

/** Only private working drafts participate in automatic saving, never reviewed records. */
export function equipmentDraftContent(userId: number, siteId: number, today: string, edits: EquipmentDraftContent["edits"], sessions: EquipmentDraftContent["sessions"], reports: EquipmentReport[], importBatches: EquipmentImportBatch[], pending: EquipmentDraftPendingInput | null, catalogs: EquipmentSpreadsheetCatalogs, toDraft: (report: EquipmentReport["rows"][number]) => EquipmentSpreadsheetDraft): EquipmentDraftContent {
  const own = (report: EquipmentReport | undefined) => report && report.ownerUserId === userId && report.siteId === siteId && (report.status === "draft" || report.status === "rejected");
  const known = new Map(reports.map(report => [String(report.id), report]));
  for (const [key, report] of Object.entries(sessions)) known.set(key, report);
  const draftEdits: EquipmentDraftContent["edits"] = {};
  const draftSessions: EquipmentDraftContent["sessions"] = {};
  for (const [key, rows] of Object.entries(edits)) {
    const report = known.get(key);
    if (key.startsWith("new:") && equipmentReportNewDate(key, today)) draftEdits[key] = rows;
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
    if (key) draftEdits[key] = draftEdits[key].map(row => row.key === pending.rowKey ? pasteEquipmentCells(row, { [pending.field]: pending.value }, catalogs) : row);
  }
  const activeBatches = new Set(Object.values(draftEdits).flatMap(rows => rows.flatMap(row => row.importBatchId ? [row.importBatchId] : [])));
  return { edits: draftEdits, sessions: draftSessions, importBatches: importBatches.filter(batch => activeBatches.has(batch.id)) };
}
