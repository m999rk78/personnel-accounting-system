import { personnelCellErrors, type PersonnelSpreadsheetCatalogs, type PersonnelSpreadsheetDraft } from "./personnelSpreadsheet.ts";
import type { PersonnelReportValidationIssue } from "./personnelReportTypes.ts";

export type PersonnelSubmissionValidationState = {
  token: string;
  status: "checking" | "valid" | "invalid" | "error";
  issues: PersonnelReportValidationIssue[];
};

type SubmissionGroup = { key: string; workDate: string; drafts: readonly PersonnelSpreadsheetDraft[] };

/** Keep every invalid employee/date row, including every invalid cell in that row. */
export function personnelSubmissionCellIssues(groups: readonly SubmissionGroup[], catalogs: PersonnelSpreadsheetCatalogs): PersonnelReportValidationIssue[] {
  return groups.flatMap(group => group.drafts.flatMap((draft, index) => {
    const messages = Object.values(personnelCellErrors(draft, catalogs, true));
    if (!messages.length) return [];
    const employeeId = Number(draft.employeeId);
    const employee = catalogs.employees.find(item => item.id === employeeId);
    return [{
      key: group.key,
      workDate: group.workDate,
      rowNumbers: [index + 1],
      ...(Number.isSafeInteger(employeeId) && employeeId > 0 ? { employeeId } : {}),
      employeeName: draft.employeeQuery.trim() || employee?.fullName.trim() || "Сотрудник не выбран",
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

const protectedCodes = new Set(["HOURS_CONFLICT", "REPORT_LOCKED", "REPORT_NOT_FOUND", "SITE_NOT_FOUND", "INVALID_REPORT_ROW", "INVALID_TRANSITION", "REPORT_EXISTS"]);
function protectedIssue(code: string) { return protectedCodes.has(code) || /STALE|FORBIDDEN|UNAUTH|ACCESS/.test(code); }

/** Prefer full local cell messages over duplicate server row errors, retaining all global blockers. */
export function mergePersonnelSubmissionIssues(local: readonly PersonnelReportValidationIssue[], remote: readonly PersonnelReportValidationIssue[]): PersonnelReportValidationIssue[] {
  const localRows = new Map<string, Set<number>>();
  for (const issue of local) {
    if (!issue.rowNumbers?.length) continue;
    const rows = localRows.get(issue.key) ?? new Set<number>();
    issue.rowNumbers.forEach(number => rows.add(number));
    localRows.set(issue.key, rows);
  }
  const result: PersonnelReportValidationIssue[] = [];
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
export function personnelSubmissionToken(siteId: number, payloadReports: unknown): string {
  return stableJson({ siteId, reports: payloadReports });
}

/** A success for an older selection or older rows must never enable sending. */
export function personnelSubmissionCanSend(token: string, currentState: PersonnelSubmissionValidationState | null | undefined, hasSelection: boolean): boolean {
  return Boolean(hasSelection && token && currentState?.token === token && currentState.status === "valid" && currentState.issues.length === 0);
}
