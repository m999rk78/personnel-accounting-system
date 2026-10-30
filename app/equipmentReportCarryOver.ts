import type { EquipmentReport, EquipmentReportApprovedEntry, EquipmentReportRow } from "./equipmentReportTypes";
import type { EquipmentSpreadsheetCatalogs, EquipmentSpreadsheetDraft } from "./equipmentSpreadsheet";
import { equipmentExcelName } from "./equipmentExcel.ts";
import { isEquipmentUnavailable } from "./equipmentAvailability.ts";
import { compatibleSubworkId } from "./workTypeHierarchy.ts";

export function equipmentReportYesterday(today: string): string {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** The equipment list belongs to one foreman and project. Today's saved work always wins. */
export function equipmentReportCrewSource(reports: EquipmentReport[], siteId: number, userId: number, today: string, entries: EquipmentReportApprovedEntry[] = []) {
  const own = reports.filter(report => report.siteId === siteId && report.ownerUserId === userId);
  const ownEntries = entries.filter(entry => entry.siteId === siteId && entry.responsibleUserId === userId);
  if (own.some(report => report.workDate === today)) return null;
  if (ownEntries.some(entry => entry.workDate === today)) return null;
  const yesterday = equipmentReportYesterday(today);
  const source = own.filter(report => report.workDate === yesterday && report.rows.length > 0);
  const sourceRows = source.flatMap(report => report.rows);
  const published = new Set(sourceRows.flatMap(row => row.approvedEntryId ? [row.approvedEntryId] : []));
  const legacy: EquipmentReportRow[] = ownEntries.filter(entry => entry.workDate === yesterday && !published.has(entry.id)).map(entry => ({ ...entry, reportId: 0, approvedEntryId: entry.id }));
  if (!sourceRows.length && !legacy.length) return null;
  return { workDate: yesterday, rows: [...sourceRows, ...legacy] };
}

/** Keep yesterday's separate tasks; removed or unavailable units are skipped and retired options left blank. */
export function buildEquipmentReportCrew(rows: EquipmentReportRow[], catalogs: EquipmentSpreadsheetCatalogs, createKey: () => string, time: string) {
  const units = new Map(catalogs.units.map(unit => [unit.id, unit]));
  const option = (options: { id: number }[], id: number | null) => id && options.some(item => item.id === id) ? String(id) : "";
  const drafts = rows.flatMap((row): EquipmentSpreadsheetDraft[] => {
    const unit = row.equipmentId && units.get(row.equipmentId);
    if (!unit || catalogs.dailyTimesheetMarks?.some(mark => mark.equipmentId === unit.id && mark.workDate === catalogs.workDate && isEquipmentUnavailable(mark))) return [];
    return [{ key: createKey(), createdAt: time, updatedAt: time, carriedFromPreviousDay: true,
      equipmentId: String(unit.id), equipmentQuery: equipmentExcelName(unit),
      shiftId: option(catalogs.shifts, row.shiftId), zoneId: option(catalogs.zones, row.zoneId),
      mainWorkTypeId: option(catalogs.mainWorkTypes, row.mainWorkTypeId), subworkTypeId: compatibleSubworkId(catalogs.subworkTypes, option(catalogs.mainWorkTypes, row.mainWorkTypeId), row.subworkTypeId),
      hours: row.hours == null ? "" : String(row.hours), note: row.note,
    }];
  });
  return { drafts, skipped: rows.length - drafts.length };
}
