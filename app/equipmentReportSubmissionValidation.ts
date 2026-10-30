import { equipmentCellErrors, type EquipmentSpreadsheetCatalogs, type EquipmentSpreadsheetDraft } from "./equipmentSpreadsheet.ts";
import { equipmentExcelName } from "./equipmentExcel.ts";
import type { EquipmentReportValidationIssue } from "./equipmentReportTypes.ts";

export type EquipmentSubmissionValidationState = {
  token: string;
  status: "checking" | "valid" | "invalid" | "error";
  issues: EquipmentReportValidationIssue[];
};

type SubmissionGroup = { key: string; workDate: string; drafts: readonly EquipmentSpreadsheetDraft[] };

/** Keep every invalid equipment/date row, including every invalid cell in that row. */
export function equipmentSubmissionCellIssues(groups: readonly SubmissionGroup[], catalogs: EquipmentSpreadsheetCatalogs): EquipmentReportValidationIssue[] {
  return groups.flatMap(group => group.drafts.flatMap((draft, index) => {
    const messages = Object.values(equipmentCellErrors(draft, catalogs, true, group.workDate));
    if (!messages.length) return [];
    const equipmentId = Number(draft.equipmentId);
    const unit = catalogs.units.find(item => item.id === equipmentId);
    return [{
      key: group.key,
      workDate: group.workDate,
      rowNumbers: [index + 1],
      ...(Number.isSafeInteger(equipmentId) && equipmentId > 0 ? { equipmentId } : {}),
      equipmentName: draft.equipmentQuery?.trim() || (unit ? equipmentExcelName(unit) : "Техника не выбрана"),
      code: "INVALID_ROW",
      message: messages.join(" "),
    }];
  }));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  }) ?? "undefined";
}

const protectedCodes = new Set(["HOURS_CONFLICT", "EQUIPMENT_UNAVAILABLE", "REPORT_LOCKED", "REPORT_NOT_FOUND", "SITE_NOT_FOUND", "INVALID_REPORT_ROW", "INVALID_TRANSITION", "REPORT_EXISTS"]);
function protectedIssue(code: string) { return protectedCodes.has(code) || /STALE|FORBIDDEN|UNAUTH|ACCESS/.test(code); }

/** Prefer full local cell messages over duplicate server row errors, retaining all global blockers. */
export function mergeEquipmentSubmissionIssues(local: readonly EquipmentReportValidationIssue[], remote: readonly EquipmentReportValidationIssue[]): EquipmentReportValidationIssue[] {
  const localRows = new Map<string, Set<number>>();
  for (const issue of local) {
    if (!issue.rowNumbers?.length) continue;
    const rows = localRows.get(issue.key) ?? new Set<number>();
    issue.rowNumbers.forEach(number => rows.add(number));
    localRows.set(issue.key, rows);
  }
  const result: EquipmentReportValidationIssue[] = [];
  const seen = new Set<string>();
  for (const [index, issues] of [local, remote].entries()) for (const issue of issues) {
    if (index === 1 && !protectedIssue(issue.code) && issue.rowNumbers?.some(number => localRows.get(issue.key)?.has(number))) continue;
    const identity = stableJson(issue);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(issue);
  }
  return result;
}

/** Array order is meaningful; object property order is not. All supplied row values participate. */
export function equipmentSubmissionToken(siteId: number, payloadReports: unknown): string {
  return stableJson({ siteId, reports: payloadReports });
}

/** A success for an older selection or older rows must never enable sending. */
export function equipmentSubmissionCanSend(token: string, currentState: EquipmentSubmissionValidationState | null | undefined, hasSelection: boolean): boolean {
  return Boolean(hasSelection && token && currentState?.token === token && currentState.status === "valid" && currentState.issues.length === 0);
}
