import type { PersonnelReport, PersonnelReportApprovedEntry, PersonnelReportRow } from "./personnelReportTypes";
import type { PersonnelSpreadsheetCatalogs, PersonnelSpreadsheetDraft } from "./personnelSpreadsheet";
import { compatibleSubworkId } from "./workTypeHierarchy.ts";

export function personnelReportYesterday(today: string): string {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** The crew belongs to one foreman and project. Today's saved work always wins. */
export function personnelReportCrewSource(reports: PersonnelReport[], siteId: number, userId: number, today: string, entries: PersonnelReportApprovedEntry[] = []) {
  const own = reports.filter(report => report.siteId === siteId && report.ownerUserId === userId);
  const ownEntries = entries.filter(entry => entry.siteId === siteId && entry.responsibleUserId === userId);
  if (own.some(report => report.workDate === today)) return null;
  if (ownEntries.some(entry => entry.workDate === today)) return null;
  const yesterday = personnelReportYesterday(today);
  const source = own.filter(report => report.workDate === yesterday && report.rows.length > 0);
  const sourceRows = source.flatMap(report => report.rows);
  const published = new Set(sourceRows.flatMap(row => row.approvedEntryId ? [row.approvedEntryId] : []));
  const legacy: PersonnelReportRow[] = ownEntries.filter(entry => entry.workDate === yesterday && !published.has(entry.id)).map(entry => ({ ...entry, reportId: 0, approvedEntryId: entry.id }));
  if (!sourceRows.length && !legacy.length) return null;
  return { workDate: yesterday, rows: [...sourceRows, ...legacy] };
}

/** Keep yesterday's separate tasks; removed people are skipped and retired options left blank. */
export function buildPersonnelReportCrew(rows: PersonnelReportRow[], catalogs: PersonnelSpreadsheetCatalogs, createKey: () => string, time: string) {
  const employees = new Map(catalogs.employees.map(employee => [employee.id, employee]));
  const option = (options: { id: number }[], id: number | null) => id && options.some(item => item.id === id) ? String(id) : "";
  const drafts = rows.flatMap((row): PersonnelSpreadsheetDraft[] => {
    const employee = row.employeeId && employees.get(row.employeeId);
    if (!employee) return [];
    return [{ key: createKey(), createdAt: time, updatedAt: time, carriedFromPreviousDay: true,
      employeeId: String(employee.id), employeeQuery: employee.fullName,
      shiftId: option(catalogs.shifts, row.shiftId), zoneId: option(catalogs.zones, row.zoneId),
      mainWorkTypeId: option(catalogs.mainWorkTypes, row.mainWorkTypeId), subworkTypeId: compatibleSubworkId(catalogs.subworkTypes, option(catalogs.mainWorkTypes, row.mainWorkTypeId), row.subworkTypeId),
      masterId: option(catalogs.masters, row.masterId), hours: row.hours == null ? "" : String(row.hours), note: row.note,
    }];
  });
  return { drafts, skipped: rows.length - drafts.length };
}
