import type { AuthUser } from "./auth";
import { canAccessProject, canViewPendingReportsFor } from "./roles.ts";
export { canViewPendingReportsFor };
import { hasReportStatusPermission } from "./permissionModel.ts";
export { hasReportStatusPermission };
import type { EquipmentReportDraftRow, EquipmentReportRowValidationIssue, EquipmentReportStatus, EquipmentReportTransitionRequest } from "./equipmentReportTypes";

export class EquipmentReportError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, status = 400, code = "INVALID_REPORT", details?: unknown) {
    super(message);
    this.name = "EquipmentReportError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Actor = Pick<AuthUser, "id" | "role" | "assignedSiteId" | "permissions"> & Partial<Pick<AuthUser, "projectAccess" | "canViewPendingReports">>;
type ReportIdentity = { siteId: number; ownerUserId: number; status: EquipmentReportStatus; revision: number };

/** The old daily endpoint published rows immediately, bypassing review. */
export function isLegacyEquipmentReportMutation(action: unknown) {
  return typeof action === "string" && ["save-entry", "delete-entry", "import-entries", "submit-daily-report"].includes(action);
}

export function validEquipmentReportDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function canReviewEquipmentReport(user: Actor) {
  return hasReportStatusPermission(user.permissions, "equipment_report", "submitted", "update") || hasReportStatusPermission(user.permissions, "equipment_report", "approved", "update");
}

export function assertEquipmentReportSiteAccess(user: Actor, siteId: number) {
  if (!user.permissions.equipment_report?.view || !canAccessProject(user, siteId)) {
    throw new EquipmentReportError("Нет доступа к отчётам этого проекта.", 403, "REPORT_FORBIDDEN");
  }
}

export function assertEquipmentReportOwner(user: Actor, report: Pick<ReportIdentity, "siteId" | "ownerUserId" | "status">) {
  assertEquipmentReportSiteAccess(user, report.siteId);
  if (!hasReportStatusPermission(user.permissions, "equipment_report", report.status, "view")) throw new EquipmentReportError("Нет доступа к отчётам в этом статусе.", 403, "REPORT_FORBIDDEN");
  if (user.role === "foreman" && report.ownerUserId !== user.id) throw new EquipmentReportError("Прораб может изменять только свои отчёты.", 403, "REPORT_FORBIDDEN");
  if (report.ownerUserId !== user.id && (report.status === "draft" || report.status === "rejected")) {
    throw new EquipmentReportError("Черновик доступен только его автору.", 403, "REPORT_FORBIDDEN");
  }
}

export function assertEquipmentReportRevision(actual: number, expected: unknown) {
  if (!Number.isInteger(expected) || Number(expected) < 1) {
    throw new EquipmentReportError("Не указана версия отчёта. Обновите таблицу.", 409, "STALE_REPORT");
  }
  if (actual !== expected) {
    throw new EquipmentReportError("Отчёт уже изменён в другой вкладке. Обновите таблицу и повторите действие.", 409, "STALE_REPORT", { expectedRevision: expected, actualRevision: actual });
  }
}

export function assertCanSaveEquipmentReport(user: Actor, report?: ReportIdentity) {
  if (!report) {
    if (!hasReportStatusPermission(user.permissions, "equipment_report", "draft", "create")) throw new EquipmentReportError("Нет права создавать черновики отчётов.", 403, "REPORT_FORBIDDEN");
    return;
  }
  assertEquipmentReportOwner(user, report);
  if (!user.permissions.equipment_report?.update) throw new EquipmentReportError("Нет права редактировать отчёты.", 403, "REPORT_FORBIDDEN");
  if (!hasReportStatusPermission(user.permissions, "equipment_report", report.status, "update")) throw new EquipmentReportError("Нет права редактировать отчёты в этом статусе.", 403, "REPORT_FORBIDDEN");
}

export function nextEquipmentReportStatus(user: Actor, report: ReportIdentity, action: EquipmentReportTransitionRequest["action"], comment = ""): EquipmentReportStatus {
  assertEquipmentReportOwner(user, report);
  if (!user.permissions.equipment_report?.update) throw new EquipmentReportError("Нет права изменять отчёты.", 403, "REPORT_FORBIDDEN");
  if ((action === "approve" || action === "reject") && !canReviewEquipmentReport(user)) {
    throw new EquipmentReportError("Нет права проверять отчёты.", 403, "REVIEW_FORBIDDEN");
  }
  if (!hasReportStatusPermission(user.permissions, "equipment_report", report.status, action === "reopen" ? "view" : "update")) throw new EquipmentReportError("Нет права изменять отчёты в этом статусе.", 403, "REPORT_FORBIDDEN");
  if (action === "submit" && (report.status === "draft" || report.status === "rejected")) {
    if (!hasReportStatusPermission(user.permissions, "equipment_report", "submitted", "view")) throw new EquipmentReportError("Нет доступа к отправке отчётов на проверку.", 403, "REPORT_FORBIDDEN");
    return "submitted";
  }
  if (action === "approve" && report.status === "submitted") {
    if (!hasReportStatusPermission(user.permissions, "equipment_report", "approved", "create")) throw new EquipmentReportError("Нет права подтверждать отчёты.", 403, "REPORT_FORBIDDEN");
    return "approved";
  }
  if (action === "reject" && report.status === "submitted") {
    if (!comment.trim()) throw new EquipmentReportError("Укажите причину возврата отчёта.");
    return "rejected";
  }
  if (action === "reopen" && report.status === "submitted") {
    if (!hasReportStatusPermission(user.permissions, "equipment_report", "draft", "update")) throw new EquipmentReportError("Нет права возвращать отчёт в черновик.", 403, "REPORT_FORBIDDEN");
    if (report.ownerUserId !== user.id) throw new EquipmentReportError("Снять с проверки можно только свой отчёт.", 403, "REPORT_FORBIDDEN");
    return "draft";
  }
  throw new EquipmentReportError("Состояние отчёта уже изменилось. Обновите таблицу.", 409, "INVALID_TRANSITION");
}

const ID_FIELDS = ["equipmentId", "shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId"] as const;

export type NormalizedEquipmentReportRow = Record<typeof ID_FIELDS[number], number | null> & { id?: number; approvedEntryRevision?: number | null; hours: number | null; note: string };
export type CompleteEquipmentReportRow = Record<typeof ID_FIELDS[number], number> & { hours: number; note: string };

/** Inspect all cells; invalid input remains an issue rather than hiding later rows. */
export function inspectEquipmentReportRows(input: unknown, required = true): { rows: NormalizedEquipmentReportRow[]; issues: EquipmentReportRowValidationIssue[] } {
  if (!Array.isArray(input) || input.length > 1000) throw new EquipmentReportError("За один раз можно сохранить не более 1000 строк.");
  const issues: EquipmentReportRowValidationIssue[] = [];
  if (required && !input.length) issues.push({ code: "EMPTY_REPORT", message: "Добавьте хотя бы одну заполненную строку перед отправкой." });
  const rows = input.map((value, index) => {
    const result: NormalizedEquipmentReportRow = { equipmentId: null, shiftId: null, zoneId: null, mainWorkTypeId: null, subworkTypeId: null, hours: null, note: "" };
    const add = (code: string, message: string) => issues.push({ rowNumbers: [index + 1], ...(result.equipmentId ? { equipmentId: result.equipmentId } : {}), code, message: `Строка ${index + 1}: ${message}` });
    if (!value || typeof value !== "object" || Array.isArray(value)) { add("INVALID_ROW", "некорректные данные."); return result; }
    const row = value as EquipmentReportDraftRow;
    if (row.id !== undefined) {
      if (!Number.isSafeInteger(row.id) || row.id < 1) add("INVALID_REPORT_ROW", "некорректный идентификатор строки.");
      else result.id = row.id;
    }
    if (row.approvedEntryRevision != null) {
      if (!Number.isSafeInteger(row.approvedEntryRevision) || row.approvedEntryRevision < 1) add("STALE_REPORT", "некорректная версия подтверждённой записи.");
      else result.approvedEntryRevision = row.approvedEntryRevision;
    }
    const missing: string[] = [];
    const labels = { equipmentId: "технику", shiftId: "смену", zoneId: "зону", mainWorkTypeId: "вид работы", subworkTypeId: "подвид работы", hours: "часы" };
    for (const field of [...ID_FIELDS, "hours"] as const) {
      const raw = row[field];
      if (raw === undefined || raw === null) { if (required) missing.push(labels[field]); }
      else if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > (field === "hours" ? 10 : 2_147_483_647)) {
        add("INVALID_ROW_VALUE", field === "hours" ? "количество часов должно быть от 1 до 10." : `некорректное значение поля «${labels[field]}».`);
      } else result[field] = raw;
    }
    if (missing.length) add("INCOMPLETE_ROW", `заполните ${missing.join(", ")}.`);
    if (row.note !== undefined && typeof row.note !== "string") add("INVALID_ROW_VALUE", "некорректное примечание.");
    else {
      result.note = row.note?.trim() ?? "";
      if (result.note.length > 4000) add("INVALID_ROW_VALUE", "примечание длиннее 4000 символов.");
    }
    return result;
  });
  return { rows, issues };
}

export function normalizeEquipmentReportRows(input: unknown): NormalizedEquipmentReportRow[] {
  const { rows, issues } = inspectEquipmentReportRows(input, false);
  if (issues.length) throw new EquipmentReportError(issues[0].message, issues[0].code === "STALE_REPORT" ? 409 : 400, issues[0].code, { issues });
  return rows;
}

export function equipmentReportRowChanged(previous: NormalizedEquipmentReportRow, next: NormalizedEquipmentReportRow) {
  return ([...ID_FIELDS, "hours", "note"] as const).some((field) => previous[field] !== next[field]);
}

export function completeEquipmentReportRows(rows: NormalizedEquipmentReportRow[]): CompleteEquipmentReportRow[] {
  if (!rows.length) throw new EquipmentReportError("Добавьте хотя бы одну заполненную строку перед отправкой.");
  return rows.map((row, index) => {
    if ([...ID_FIELDS, "hours"].some((field) => row[field as keyof NormalizedEquipmentReportRow] === null)) {
      throw new EquipmentReportError(`Строка ${index + 1}: заполните технику, смену, зону, работы и часы.`);
    }
    return row as CompleteEquipmentReportRow;
  });
}

// Only approved equipment_entries are counted here. Other drafts and submitted
// reports neither reserve hours nor appear in the timesheet.
export function collectEquipmentReportHourIssues(rows: Pick<CompleteEquipmentReportRow, "equipmentId" | "hours">[], approvedHours: ReadonlyMap<number, number>, equipmentNames: ReadonlyMap<number, string> = new Map()): EquipmentReportRowValidationIssue[] {
  const proposed = new Map<number, { hours: number; rowNumbers: number[] }>();
  rows.forEach((row, index) => {
    const current = proposed.get(row.equipmentId) ?? { hours: 0, rowNumbers: [] };
    current.hours += row.hours; current.rowNumbers.push(index + 1);
    proposed.set(row.equipmentId, current);
  });
  return [...proposed].flatMap(([equipmentId, proposal]) => {
    const usedHours = Number(approvedHours.get(equipmentId) ?? 0);
    if (usedHours + proposal.hours <= 20) return [];
    const equipmentName = equipmentNames.get(equipmentId) ?? "";
    return [{ rowNumbers: proposal.rowNumbers, equipmentId, equipmentName, code: "HOURS_CONFLICT", usedHours, requestedHours: proposal.hours, availableHours: Math.max(0, 20 - usedHours),
      message: `У техники${equipmentName ? ` «${equipmentName}»` : ""} подтверждено ${usedHours} ч., в отправляемых строках ${proposal.hours} ч. Всего ${usedHours + proposal.hours} ч. при лимите 20 ч.` }];
  });
}

export function assertEquipmentReportHours(rows: CompleteEquipmentReportRow[], approvedHours: ReadonlyMap<number, number>, equipmentNames: ReadonlyMap<number, string> = new Map()) {
  const issues = collectEquipmentReportHourIssues(rows, approvedHours, equipmentNames);
  if (issues.length) throw new EquipmentReportError(issues.map(issue => issue.message).join("\n"), 409, "HOURS_CONFLICT", { ...issues[0], issues });
}
