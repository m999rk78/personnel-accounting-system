import { type UserRole } from "../../roles";

export type EntryPayload = {
  id?: number;
  revision?: number;
  responsibleUserId?: number | null;
  siteId?: number;
  workDate?: string;
  employeeId?: number;
  shiftId?: number;
  zoneId?: number;
  mainWorkTypeId?: number;
  subworkTypeId?: number;
  note?: string;
  masterId?: number;
  hours?: number;
};

export type ReportFinalizationPayload = {
  siteId?: number;
  workDate?: string;
  revision?: number;
};

export type ExistingPlacementEntry = {
  id: number;
  siteId: number;
  workDate: string;
  employeeId: number;
  responsibleUserId: number | null;
  revision: number;
  masterId: number;
  hours: number;
  positionSnapshot: string;
  employeeNameSnapshot: string;
  employmentTypeSnapshot: string;
  departmentSnapshot: string;
  masterNameSnapshot: string;
};

export type UserPayload = {
  action?: "create-user" | "update-user" | "create-employee" | "reorder-employees" | "create-bitrix24-employee" | "update-bitrix24-employee" | "update-selected-bitrix24-employees" | "delete-bitrix24-employee" | "acknowledge-bitrix24-difference" | "acknowledge-selected-bitrix24-differences" | "update-employee" | "import-employees" | "import-project-employees" | "import-project-directory" | "inspect-bitrix24" | "link-bitrix24-employees" | "sync-bitrix24" | "create-position" | "update-position" | "import-positions" | "create-site" | "update-site" | "create-directory" | "update-directory" | "save-directory-items" | "assign-employee-project" | "assign-site";
  userId?: number;
  employeeId?: number;
  employeeIds?: number[];
  names?: string[];
  bitrix24Id?: string;
  positionId?: number;
  directoryId?: number;
  mainWorkTypeId?: number | null;
  entity?: DirectoryEntity;
  fullName?: string;
  email?: string;
  role?: UserRole;
  customRoleId?: number | null;
  assignedSiteId?: number | null;
  projectAccess?: unknown;
  canViewPendingReports?: unknown;
  employmentType?: string;
  department?: string;
  position?: string;
  name?: string;
  code?: string;
  timezone?: string;
  projectSiteId?: number | null;
  employees?: Array<{ fullName?: string; employmentType?: string; department?: string; position?: string; projectCode?: string }>;
  positions?: Array<{ employmentType?: string; department?: string; position?: string }>;
  directories?: Array<{ directoryId?: number; name?: string; employeeId?: number; mainWorkTypeId?: number | null }>;
  links?: Array<{ bitrix24Id?: string; employeeId?: number }>;
};

export type DirectoryEntity = "employmentType" | "department" | "position" | "shift" | "zone" | "mainWorkType" | "subworkType" | "master";
