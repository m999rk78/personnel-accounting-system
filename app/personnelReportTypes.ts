export type PersonnelReportStatus = "draft" | "submitted" | "approved" | "rejected";

export type PersonnelReportDraftRow = {
  id?: number;
  approvedEntryRevision?: number | null;
  employeeId?: number | null;
  shiftId?: number | null;
  zoneId?: number | null;
  mainWorkTypeId?: number | null;
  subworkTypeId?: number | null;
  masterId?: number | null;
  hours?: number | null;
  note?: string;
};

export type PersonnelReportRow = {
  id: number;
  reportId: number;
  siteId: number;
  workDate: string;
  employeeId: number | null;
  shiftId: number | null;
  zoneId: number | null;
  mainWorkTypeId: number | null;
  subworkTypeId: number | null;
  masterId: number | null;
  hours: number | null;
  note: string;
  employeeName: string;
  employmentType: string;
  department: string;
  positionSnapshot: string;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  masterName: string;
  approvedEntryId: number | null;
  approvedEntryRevision?: number | null;
  createdAt: string;
  updatedAt: string;
  rowOrder: number;
};

export type PersonnelReport = {
  id: number;
  siteId: number;
  workDate: string;
  ownerUserId: number;
  ownerName: string;
  status: PersonnelReportStatus;
  revision: number;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: number | null;
  reviewedByName: string | null;
  reviewComment: string;
  createdAt: string;
  updatedAt: string;
  rows: PersonnelReportRow[];
};

export type PersonnelReportApprovedEntry = Omit<PersonnelReportRow, "reportId" | "approvedEntryId"> & {
  orderRowId?: number | null;
  orderReportId?: number | null;
  employeeId: number;
  shiftId: number;
  zoneId: number;
  mainWorkTypeId: number;
  subworkTypeId: number;
  masterId: number;
  hours: number;
  revision: number;
  responsibleUserId: number | null;
  responsibleUserName: string | null;
};

export type PersonnelReportData = {
  reports: PersonnelReport[];
  entries: PersonnelReportApprovedEntry[];
  canReview: boolean;
  from: string | null;
  to: string | null;
};

export type PersonnelReportSaveRequest = {
  action: "save";
  siteId: number;
  workDate: string;
  reportId?: number;
  revision?: number;
  rows: PersonnelReportDraftRow[];
  importEmployeeOrder?: number[];
};

export type PersonnelReportTransitionRequest = {
  action: "submit" | "approve" | "reject" | "reopen";
  reportId: number;
  revision: number;
  comment?: string;
};

export type PersonnelReportEntrySaveRequest = {
  action: "save-approved-entry";
  entryId: number;
  revision: number;
  siteId: number;
  workDate: string;
  row: PersonnelReportDraftRow;
};

export type PersonnelReportDeleteApprovedRequest = {
  action: "delete-approved-rows";
  siteId: number;
  rows: Array<{
    entryId: number;
    revision: number;
    reportId?: number;
    reportRevision?: number;
  }>;
};

export type PersonnelReportDateRequest = {
  action: "change-date";
  reportId: number;
  revision: number;
  workDate: string;
};

export type PersonnelReportEntryDateRequest = {
  action: "change-entry-date";
  entryId: number;
  revision: number;
  siteId: number;
  workDate: string;
};

export type PersonnelReportRowValidationIssue = {
  rowNumbers?: number[];
  employeeId?: number;
  employeeName?: string;
  code: string;
  message: string;
  usedHours?: number;
  requestedHours?: number;
  availableHours?: number;
};

export type PersonnelReportValidationIssue = PersonnelReportRowValidationIssue & {
  key: string;
  workDate: string;
};

export type PersonnelReportValidationTarget = {
  key: string;
  workDate: string;
  reportId?: number;
  revision?: number;
  rows: PersonnelReportDraftRow[];
};

export type PersonnelReportValidationRequest = {
  action: "validate-submissions";
  siteId: number;
  reports: PersonnelReportValidationTarget[];
};

export type PersonnelReportValidationResult = { issues: PersonnelReportValidationIssue[] };

export type PersonnelReportRequest = PersonnelReportSaveRequest | PersonnelReportTransitionRequest | PersonnelReportEntrySaveRequest | PersonnelReportValidationRequest | PersonnelReportDateRequest | PersonnelReportEntryDateRequest | PersonnelReportDeleteApprovedRequest;
