import type { PermissionSet } from "../permissionModel";
import type { ProjectAccess, UserRole } from "../roles";
import type { WorkspaceView, WorkspaceDirectoryFocus } from "../appRoutes";
import type { Bitrix24Cooldowns } from "../bitrix24Cooldown";

export type Option = { id: number; name: string; mainWorkTypeId?: number | null; employeeId?: number | null; };

export type Site = Option & { code: string; timezone: string; };

export type Employee = { id: number; sortOrder?: number; bitrix24Id?: string | null; fullName: string; employmentType: string; department: string; position: string; source: string; bitrix24Stage: string; availabilityStatus: string; syncError: string | null; lastSyncedAt?: string | null; siteId: number | null; siteName: string | null; projectCodes?: string | null; bitrixCheckStatus?: "mismatch" | "missing_in_bitrix" | "dismissed_in_bitrix" | null; bitrixCheckDetails?: string | null; bitrixCheckAcknowledged?: number | boolean; };

export type PositionRecord = { id: number; employmentType: string; department: string; position: string; };

export type AppUser = { id: number; fullName: string; email: string; role: UserRole; customRoleId?: number | null; customRoleName?: string | null; assignedSiteId: number | null; projectAccess?: ProjectAccess; projectAccessLimitedToViewer?: boolean; canViewPendingReports?: boolean; status?: "active" | "invited"; };

export type CurrentUser = { id: number; fullName: string; email: string; role: UserRole; customRoleId?: number | null; customRoleName?: string | null; assignedSiteId: number | null; projectAccess?: ProjectAccess; canViewPendingReports?: boolean; permissions: PermissionSet; permissionsCustomized: boolean; };

export type DataSet = {
  projectStats?: { siteId: number; employeeCount: number; foremanCount: number; }[];
  sites: Site[]; employees: Employee[]; reportEmployees: Employee[]; placementEmployees: Employee[]; projectEmployees: Employee[]; positionCatalog: PositionRecord[]; employmentTypes: Option[]; departments: Option[]; positions: Option[]; shifts: Option[]; zones: Option[]; mainWorkTypes: Option[];
  subworkTypes: Option[]; masters: Option[]; users: AppUser[];
  syncStatus?: { id: number; status: string; startedAt: string; completedAt: string | null; summary: string | null; errorText: string | null; } | null;
  bitrix24Cooldowns?: Bitrix24Cooldowns;
};

export type BitrixCheckDifference = { kind: "missing_locally" | "changed" | "outside_scope" | "missing_in_bitrix" | "dismissed_in_bitrix" | "incomplete" | "unknown_stage"; employeeName: string; details: string; bitrix24Id?: string; localEmployeeId?: number; acknowledged?: boolean; suggestedEmployeeIds?: number[]; sourceEmploymentType?: string; sourceDepartment?: string; sourcePosition?: string; sourceProjectKeys?: string[]; };

export type BitrixDifferenceCounts = Partial<Record<BitrixCheckDifference["kind"], number>>;

export type BitrixCheckResult = { status: "ok" | "mismatch"; checkedAt: string; sourceReceived: number; compared: number; matched: number; totalDifferences: number; differenceCounts?: BitrixDifferenceCounts; acknowledgedDifferences?: number; differences: BitrixCheckDifference[]; updatableEmployeeIds?: number[]; autoLinkable: number; needsReview: number; unmatched: number; linked?: number; createdEmployee?: { id: number; name: string; }; updatedEmployee?: { id: number; name: string; }; deletedEmployee?: { id: number; name: string; }; };

export type BitrixEmployeeCreateDraft = { bitrix24Id: string; fullName: string; positionId: string; projectSiteId: string; sourceEmploymentType: string; sourceDepartment: string; sourcePosition: string; sourceProjectKeys: string[]; };

export type View = WorkspaceView;

export type UserDraft = { key: string; id?: number; fullName: string; email: string; role: UserRole; customRoleId?: number | null; customRoleName?: string | null; assignedSiteId: string; projectAccess?: ProjectAccess; canViewPendingReports?: boolean; };

export type EmployeeDraft = { key: string; id?: number; fullName: string; employmentType: string; department: string; position: string; projectSiteId: string; };

export type EmployeeBulkChanges = { employmentType: string; department: string; position: string; projectSiteId: string; };

export type ProjectEmployeeDraft = { key: string; employeeId: string; employeeQuery: string; };

export type PositionDraft = { key: string; id?: number; employmentType: string; department: string; position: string; };

export type DirectoryEntity = "employmentType" | "department" | "position" | "shift" | "zone" | "mainWorkType" | "subworkType" | "master";

export type DirectoryFocus = WorkspaceDirectoryFocus;

export type DirectoryDraft = { key: string; id?: number; entity: DirectoryEntity; name: string; employeeId?: string; };

export type SiteDraft = { key: string; id?: number; name: string; code: string; timezone: string; };

export type WorkspaceUnsavedState = { view: View; focus: DirectoryFocus; settings: boolean; report: boolean; equipment: boolean; workTypes: boolean; };
