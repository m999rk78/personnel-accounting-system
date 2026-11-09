import type { EquipmentReport, EquipmentReportRow } from "./equipmentReportTypes";
import type { EquipmentImportBatch, EquipmentSpreadsheetDraft } from "./equipmentSpreadsheet";
export type { EquipmentImportBatch } from "./equipmentSpreadsheet";

export type EquipmentReportDraftSnapshot = {
  version: 1;
  userId: number;
  siteId: number;
  savedAt: string;
  edits: Record<string, EquipmentSpreadsheetDraft[]>;
  sessions: Record<string, EquipmentReport>;
  importBatches: EquipmentImportBatch[];
};

export type EquipmentReportDraftBuffer = { revision: number; snapshot: EquipmentReportDraftSnapshot | null };
export const MAX_EQUIPMENT_DRAFT_BYTES = 8 * 1024 * 1024;

export class EquipmentReportDraftBufferError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, status = 400, code = "INVALID_DRAFT_BUFFER", details?: unknown) {
    super(message);
    this.name = "EquipmentReportDraftBufferError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const text = (value: unknown): value is string => typeof value === "string";
const time = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const nullableId = (value: unknown) => value === null || positiveId(value);
const rowFields = ["equipmentId", "equipmentQuery", "shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId", "hours", "note"] as const;
const editableFields = new Set(["equipment", "shift", "zone", "mainWork", "subwork", "hours", "note"]);
const referenceFields = new Set(["equipmentId", "shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId"]);

function date(value: unknown): value is string {
  if (!text(value) || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function draft(value: unknown): value is EquipmentSpreadsheetDraft {
  if (!record(value) || !text(value.key) || !value.key || value.key.length > 200 || !rowFields.every(field => text(value[field]))) return false;
  if (value.reportRowId !== undefined && !positiveId(value.reportRowId)) return false;
  if (value.importBatchId !== undefined && !text(value.importBatchId)) return false;
  for (const field of ["lockedEquipment", "carriedFromPreviousDay"]) if (value[field] !== undefined && typeof value[field] !== "boolean") return false;
  for (const field of ["createdAt", "updatedAt"]) if (value[field] !== undefined && !time(value[field])) return false;
  if (value.inputValues !== undefined && (!record(value.inputValues) || !Object.entries(value.inputValues).every(([field, value]) => editableFields.has(field) && text(value)))) return false;
  if (value.referenceIds !== undefined && (!record(value.referenceIds) || !Object.entries(value.referenceIds).every(([field, value]) => referenceFields.has(field) && nullableId(value)))) return false;
  return true;
}

function reportRow(value: unknown, report: Record<string, unknown>): value is EquipmentReportRow {
  if (!record(value) || !positiveId(value.id) || value.reportId !== report.id || value.siteId !== report.siteId || value.workDate !== report.workDate) return false;
  if (!["equipmentId", "shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId", "approvedEntryId"].every(field => nullableId(value[field]))) return false;
  if (value.approvedEntryRevision !== undefined && !nullableId(value.approvedEntryRevision)) return false;
  if (value.hours !== null && (!Number.isInteger(value.hours) || Number(value.hours) < 1 || Number(value.hours) > 10)) return false;
  if (!["note", "equipmentName", "equipmentType", "organization", "brand", "model", "registrationNumber", "shiftName", "zoneName", "mainWorkTypeName", "subworkTypeName"].every(field => text(value[field]))) return false;
  return time(value.createdAt) && time(value.updatedAt) && Number.isSafeInteger(value.rowOrder) && Number(value.rowOrder) >= 0;
}

function ownSession(value: unknown, key: string, userId: number, siteId: number): value is EquipmentReport {
  if (!record(value) || !positiveId(value.id) || String(value.id) !== key || value.ownerUserId !== userId || value.siteId !== siteId || !date(value.workDate)) return false;
  if (value.status !== "draft" && value.status !== "rejected") return false;
  if (!positiveId(value.revision) || !text(value.ownerName) || !text(value.reviewComment) || !time(value.createdAt) || !time(value.updatedAt)) return false;
  if (!nullableId(value.reviewedByUserId) || value.reviewedByName !== null && !text(value.reviewedByName)) return false;
  for (const field of ["submittedAt", "reviewedAt"]) if (value[field] !== null && !time(value[field])) return false;
  return Array.isArray(value.rows) && value.rows.length <= 1000 && value.rows.every(row => reportRow(row, value));
}

/** Validate recovery data without requiring complete or currently valid cell values. */
export function parseEquipmentReportDraftSnapshot(value: unknown, userId: number, siteId: number): EquipmentReportDraftSnapshot | null {
  if (value === null) return null;
  const invalid = () => { throw new EquipmentReportDraftBufferError("Не удалось прочитать сохранённый черновик. Исходные данные не изменены."); };
  if (!record(value) || value.version !== 1 || value.userId !== userId || value.siteId !== siteId || !positiveId(userId) || !positiveId(siteId) || !time(value.savedAt)) return invalid();
  if (!record(value.edits) || !record(value.sessions) || !Array.isArray(value.importBatches)) return invalid();
  const groups = Object.entries(value.edits);
  if (groups.length > 5000 || value.importBatches.length > 5000) return invalid();
  const keys = new Set<string>();
  for (const [key, rows] of groups) {
    if (!Array.isArray(rows) || rows.length > 1000 || !rows.every(draft)) return invalid();
    if (key.startsWith("new:")) {
      if (!date(key.slice(4))) return invalid();
    } else if (!/^[1-9]\d*$/.test(key) || !ownSession(value.sessions[key], key, userId, siteId)) return invalid();
    for (const row of rows) {
      if (keys.has(row.key)) return invalid();
      keys.add(row.key);
    }
  }
  for (const [key, session] of Object.entries(value.sessions)) if (!Object.hasOwn(value.edits, key) || !ownSession(session, key, userId, siteId)) return invalid();
  for (const batch of value.importBatches) {
    if (!record(batch) || !text(batch.id) || !batch.id || !Array.isArray(batch.rows) || batch.rows.length > 100_000 || !batch.rows.every(row => record(row) && text(row.key) && text(row.equipmentId))) return invalid();
  }
  return value as EquipmentReportDraftSnapshot;
}
