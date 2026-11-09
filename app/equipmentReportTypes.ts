export type EquipmentReportStatus = "draft" | "submitted" | "approved" | "rejected";

export type EquipmentReportDraftRow = {
  id?: number;
  approvedEntryRevision?: number | null;
  equipmentId?: number | null;
  shiftId?: number | null;
  zoneId?: number | null;
  mainWorkTypeId?: number | null;
  subworkTypeId?: number | null;
  hours?: number | null;
  note?: string;
};

export type EquipmentReportRow = {
  id: number;
  reportId: number;
  siteId: number;
  workDate: string;
  equipmentId: number | null;
  shiftId: number | null;
  zoneId: number | null;
  mainWorkTypeId: number | null;
  subworkTypeId: number | null;
  hours: number | null;
  note: string;
  equipmentName: string;
  equipmentType: string;
  organization: string;
  brand: string;
  model: string;
  registrationNumber: string;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  approvedEntryId: number | null;
  approvedEntryRevision?: number | null;
  createdAt: string;
  updatedAt: string;
  rowOrder: number;
};

export type EquipmentReport = {
  id: number;
  siteId: number;
  workDate: string;
  ownerUserId: number;
  ownerName: string;
  status: EquipmentReportStatus;
  revision: number;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: number | null;
  reviewedByName: string | null;
  reviewComment: string;
  createdAt: string;
  updatedAt: string;
  rows: EquipmentReportRow[];
};

export type EquipmentReportApprovedEntry = Omit<EquipmentReportRow, "reportId" | "approvedEntryId"> & {
  orderRowId?: number | null;
  orderReportId?: number | null;
  equipmentId: number;
  shiftId: number;
  zoneId: number;
  mainWorkTypeId: number;
  subworkTypeId: number;
  hours: number;
  revision: number;
  responsibleUserId: number | null;
  responsibleUserName: string | null;
};

export type EquipmentReportData = {
  reports: EquipmentReport[];
  entries: EquipmentReportApprovedEntry[];
  canReview: boolean;
  availabilityMarks: EquipmentReportAvailabilityMark[];
  from: string | null;
  to: string | null;
};

export type EquipmentReportSaveRequest = {
  action: "save";
  siteId: number;
  workDate: string;
  reportId?: number;
  revision?: number;
  rows: EquipmentReportDraftRow[];
  importEquipmentOrder?: number[];
};

export type EquipmentReportDateRequest = {
  action: "change-date";
  reportId: number;
  revision: number;
  workDate: string;
};

export type EquipmentReportEntryDateRequest = {
  action: "change-entry-date";
  entryId: number;
  revision: number;
  siteId: number;
  workDate: string;
};

export type EquipmentReportTransitionRequest = {
  action: "submit" | "approve" | "reject" | "reopen";
  reportId: number;
  revision: number;
  comment?: string;
};

export type EquipmentReportEntrySaveRequest = {
  action: "save-approved-entry";
  entryId: number;
  revision: number;
  siteId: number;
  workDate: string;
  row: EquipmentReportDraftRow;
};

export type EquipmentReportRowValidationIssue = {
  rowNumbers?: number[];
  equipmentId?: number;
  equipmentName?: string;
  code: string;
  message: string;
  usedHours?: number;
  requestedHours?: number;
  availableHours?: number;
};

export type EquipmentReportValidationIssue = EquipmentReportRowValidationIssue & {
  key: string;
  workDate: string;
};

export type EquipmentReportValidationTarget = {
  key: string;
  workDate: string;
  reportId?: number;
  revision?: number;
  rows: EquipmentReportDraftRow[];
};

export type EquipmentReportValidationRequest = {
  action: "validate-submissions";
  siteId: number;
  reports: EquipmentReportValidationTarget[];
};

export type EquipmentReportValidationResult = { issues: EquipmentReportValidationIssue[] };

export type EquipmentReportRequest = EquipmentReportSaveRequest | EquipmentReportTransitionRequest | EquipmentReportEntrySaveRequest | EquipmentReportValidationRequest | EquipmentReportDateRequest | EquipmentReportEntryDateRequest;

export type EquipmentReportAvailabilityMark = { equipmentId: number; workDate: string; productiveHours: number; downtimeHours: number; note: string };
