import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const auditTimestamp = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const sites = pgTable("sites", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  timezone: text("timezone").notNull().default("Europe/Moscow"),
  active: integer("active").notNull().default(1),
});

export const appUsers = pgTable("app_users", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().default(""),
  role: text("role").notNull(),
  assignedSiteId: integer("assigned_site_id").references(() => sites.id),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  passwordIterations: integer("password_iterations"),
  invitedAt: auditTimestamp("invited_at"),
  activatedAt: auditTimestamp("activated_at"),
  active: integer("active").notNull().default(1),
});

export const userInvitations = pgTable("user_invitations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsers.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: auditTimestamp("expires_at").notNull(),
  usedAt: auditTimestamp("used_at"),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
}, (table) => [index("idx_user_invitations_user").on(table.userId, table.usedAt)]);

export const userSessions = pgTable("user_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsers.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: auditTimestamp("expires_at").notNull(),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  revokedAt: auditTimestamp("revoked_at"),
}, (table) => [index("idx_user_sessions_user").on(table.userId, table.revokedAt)]);

export const loginAttempts = pgTable("login_attempts", {
  id: serial("id").primaryKey(),
  attemptKey: text("attempt_key").notNull(),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
}, (table) => [index("idx_login_attempts_key_time").on(table.attemptKey, table.createdAt)]);

export const employees = pgTable("employees", {
  id: serial("id").primaryKey(),
  bitrix24Id: text("bitrix24_id").unique(),
  bitrix24Stage: text("bitrix24_stage").notNull().default(""),
  availabilityStatus: text("availability_status").notNull().default("on_site"),
  bitrix24UpdatedAt: auditTimestamp("bitrix24_updated_at"),
  lastSyncedAt: auditTimestamp("last_synced_at"),
  syncError: text("sync_error"),
  syncMissCount: integer("sync_miss_count").notNull().default(0),
  fullName: text("full_name").notNull(),
  employmentType: text("employment_type").notNull().default("ОПР"),
  department: text("department").notNull().default("УСР"),
  position: text("position").notNull(),
  source: text("source").notNull().default("excel"),
  siteId: integer("site_id").references(() => sites.id),
  active: integer("active").notNull().default(1),
});

export const employeeProfileVersions = pgTable("employee_profile_versions", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  fullName: text("full_name").notNull(),
  employmentType: text("employment_type").notNull(),
  department: text("department").notNull(),
  position: text("position").notNull(),
  bitrix24Stage: text("bitrix24_stage").notNull().default(""),
  validFrom: auditTimestamp("valid_from").notNull(),
  validTo: auditTimestamp("valid_to"),
  source: text("source").notNull().default("bitrix24"),
}, (table) => [
  index("idx_employee_profile_versions_period").on(table.employeeId, table.validFrom, table.validTo),
]);

export const employeeAvailabilityPeriods = pgTable("employee_availability_periods", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  status: text("status").notNull(),
  validFrom: auditTimestamp("valid_from").notNull(),
  validTo: auditTimestamp("valid_to"),
  source: text("source").notNull().default("bitrix24"),
}, (table) => [
  index("idx_employee_availability_periods_period").on(table.employeeId, table.validFrom, table.validTo),
]);

export const employeeSyncRuns = pgTable("employee_sync_runs", {
  id: serial("id").primaryKey(),
  source: text("source").notNull().default("bitrix24"),
  status: text("status").notNull().default("running"),
  startedAt: auditTimestamp("started_at").notNull().defaultNow(),
  completedAt: auditTimestamp("completed_at"),
  summary: text("summary"),
  errorText: text("error_text"),
});

export const employeeSyncIssues = pgTable("employee_sync_issues", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => employeeSyncRuns.id),
  bitrix24Id: text("bitrix24_id"),
  code: text("code").notNull(),
  message: text("message").notNull(),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
}, (table) => [index("idx_employee_sync_issues_run").on(table.runId)]);

export const bitrix24ActionLimits = pgTable("bitrix24_action_limits", {
  actionKey: text("action_key").primaryKey(),
  lastStartedAt: auditTimestamp("last_started_at").notNull(),
});

export const employeeProjectAssignments = pgTable("employee_project_assignments", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  siteId: integer("site_id").notNull().references(() => sites.id),
  source: text("source").notNull().default("manual"),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  active: integer("active").notNull().default(1),
}, (table) => [
  uniqueIndex("idx_employee_project_assignment_active").on(table.employeeId, table.siteId).where(sql`${table.active} = 1`),
  index("idx_employee_project_assignment_site").on(table.siteId, table.active),
]);

export const positionCatalog = pgTable("position_catalog", {
  id: serial("id").primaryKey(),
  employmentType: text("employment_type").notNull(),
  department: text("department").notNull(),
  position: text("position").notNull(),
  active: integer("active").notNull().default(1),
}, (table) => [
  uniqueIndex("idx_position_catalog_values").on(table.employmentType, table.department, table.position).where(sql`${table.active} = 1`),
]);

export const personnelOptions = pgTable("personnel_options", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  active: integer("active").notNull().default(1),
}, (table) => [
  uniqueIndex("idx_personnel_options_kind_name").on(table.kind, table.name).where(sql`${table.active} = 1`),
]);

export const shifts = pgTable("shifts", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(),
  active: integer("active").notNull().default(1),
});

export const zones = pgTable("zones", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(),
  active: integer("active").notNull().default(1),
});

export const mainWorkTypes = pgTable("main_work_types", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(),
  active: integer("active").notNull().default(1),
});

export const subworkTypes = pgTable("subwork_types", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(),
  active: integer("active").notNull().default(1),
});

export const masters = pgTable("masters", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(),
  active: integer("active").notNull().default(1),
});

export const placementEntries = pgTable("placement_entries", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id").notNull().references(() => sites.id),
  workDate: date("work_date", { mode: "string" }).notNull(),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  shiftId: integer("shift_id").notNull().references(() => shifts.id),
  zoneId: integer("zone_id").notNull().references(() => zones.id),
  mainWorkTypeId: integer("main_work_type_id").notNull().references(() => mainWorkTypes.id),
  subworkTypeId: integer("subwork_type_id").notNull().references(() => subworkTypes.id),
  note: text("note").notNull().default(""),
  masterId: integer("master_id").notNull().references(() => masters.id),
  hours: integer("hours").notNull(),
  positionSnapshot: text("position_snapshot").notNull(),
  employeeNameSnapshot: text("employee_name_snapshot").notNull().default(""),
  employmentTypeSnapshot: text("employment_type_snapshot").notNull().default(""),
  departmentSnapshot: text("department_snapshot").notNull().default(""),
  masterNameSnapshot: text("master_name_snapshot").notNull().default(""),
  createdBy: text("created_by").notNull().default("demo-user"),
  responsibleUserId: integer("responsible_user_id").references(() => appUsers.id),
  revision: integer("revision").notNull().default(1),
  createdByUserId: integer("created_by_user_id").references(() => appUsers.id),
  updatedByUserId: integer("updated_by_user_id").references(() => appUsers.id),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  deletedAt: auditTimestamp("deleted_at"),
}, (table) => [
  index("idx_entries_site_date").on(table.siteId, table.workDate),
  index("idx_entries_active_site_date").on(table.siteId, table.workDate).where(sql`${table.deletedAt} IS NULL`),
  index("idx_entries_employee_date").on(table.employeeId, table.workDate),
  index("idx_entries_responsible_site_date").on(table.responsibleUserId, table.siteId, table.workDate).where(sql`${table.responsibleUserId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
  check("placement_hours_range", sql`${table.hours} BETWEEN 1 AND 10`),
  check("placement_entry_revision_positive", sql`${table.revision} > 0`),
]);

export const placementReportDays = pgTable("placement_report_days", {
  siteId: integer("site_id").notNull().references(() => sites.id),
  workDate: date("work_date", { mode: "string" }).notNull(),
  submittedBy: integer("submitted_by").references(() => appUsers.id),
  submittedAt: auditTimestamp("submitted_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.siteId, table.workDate] }),
]);

export const placementReportContributions = pgTable("placement_report_contributions", {
  siteId: integer("site_id").notNull().references(() => sites.id),
  workDate: date("work_date", { mode: "string" }).notNull(),
  foremanId: integer("foreman_id").notNull().references(() => appUsers.id),
  status: text("status").notNull().default("draft"),
  revision: integer("revision").notNull().default(1),
  submittedAt: auditTimestamp("submitted_at"),
  updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.siteId, table.workDate, table.foremanId] }),
  index("idx_report_contributions_site_date_status").on(table.siteId, table.workDate, table.status),
  index("idx_report_contributions_foreman_date").on(table.foremanId, table.workDate),
  check("placement_report_contribution_status", sql`${table.status} IN ('draft', 'submitted')`),
  check("placement_report_contribution_revision_positive", sql`${table.revision} > 0`),
]);

export const timesheetMarks = pgTable("timesheet_marks", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id").notNull(),
  employeeId: integer("employee_id").notNull(),
  workDate: date("work_date", { mode: "string" }).notNull(),
  hours: integer("hours"),
  code: text("code"),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull(),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_timesheet_marks_unique_day").on(table.siteId, table.employeeId, table.workDate),
  index("idx_timesheet_marks_month").on(table.siteId, table.workDate),
  check("timesheet_hours_range", sql`${table.hours} IS NULL OR ${table.hours} BETWEEN 1 AND 10`),
  check("timesheet_value_required", sql`(${table.hours} IS NOT NULL AND ${table.code} IS NULL) OR (${table.hours} IS NULL AND ${table.code} IS NOT NULL)`),
]);

export const equipmentUnits = pgTable("equipment_units", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id").notNull().references(() => sites.id),
  identityKey: text("identity_key").notNull(),
  organization: text("organization").notNull(),
  equipmentType: text("equipment_type").notNull(),
  brand: text("brand").notNull().default(""),
  model: text("model").notNull(),
  registrationNumber: text("registration_number").notNull().default(""),
  note: text("note").notNull().default(""),
  active: integer("active").notNull().default(1),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_equipment_units_site_identity").on(table.siteId, table.identityKey),
  index("idx_equipment_units_site_active").on(table.siteId, table.active),
]);

export const equipmentProjectAssignments = pgTable("equipment_project_assignments", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipmentUnits.id),
  siteId: integer("site_id").notNull().references(() => sites.id),
  active: integer("active").notNull().default(1),
  assignedAt: auditTimestamp("assigned_at").notNull().defaultNow(),
  endedAt: auditTimestamp("ended_at"),
}, (table) => [
  uniqueIndex("idx_equipment_project_assignment_unique").on(table.equipmentId, table.siteId),
  index("idx_equipment_project_assignment_site").on(table.siteId, table.active),
]);

export const equipmentEntries = pgTable("equipment_entries", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id").notNull().references(() => sites.id),
  workDate: date("work_date", { mode: "string" }).notNull(),
  equipmentId: integer("equipment_id").notNull().references(() => equipmentUnits.id),
  shiftId: integer("shift_id").notNull().references(() => shifts.id),
  zoneId: integer("zone_id").notNull().references(() => zones.id),
  mainWorkTypeId: integer("main_work_type_id").notNull().references(() => mainWorkTypes.id),
  subworkTypeId: integer("subwork_type_id").notNull().references(() => subworkTypes.id),
  note: text("note").notNull().default(""),
  hours: integer("hours").notNull(),
  createdBy: text("created_by").notNull(),
  responsibleUserId: integer("responsible_user_id").references(() => appUsers.id),
  revision: integer("revision").notNull().default(1),
  createdByUserId: integer("created_by_user_id").references(() => appUsers.id),
  updatedByUserId: integer("updated_by_user_id").references(() => appUsers.id),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  deletedAt: auditTimestamp("deleted_at"),
}, (table) => [
  index("idx_equipment_entries_site_date").on(table.siteId, table.workDate),
  index("idx_equipment_entries_unit_date").on(table.equipmentId, table.workDate),
  index("idx_equipment_entries_responsible_site_date").on(table.responsibleUserId, table.siteId, table.workDate).where(sql`${table.responsibleUserId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
  check("equipment_entry_hours_range", sql`${table.hours} BETWEEN 1 AND 10`),
  check("equipment_entry_revision_positive", sql`${table.revision} > 0`),
]);

export const equipmentReportDays = pgTable("equipment_report_days", {
  siteId: integer("site_id").notNull().references(() => sites.id),
  workDate: date("work_date", { mode: "string" }).notNull(),
  submittedBy: integer("submitted_by").references(() => appUsers.id),
  submittedAt: auditTimestamp("submitted_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.siteId, table.workDate] }),
]);

export const equipmentReportContributions = pgTable("equipment_report_contributions", {
  siteId: integer("site_id").notNull().references(() => sites.id),
  workDate: date("work_date", { mode: "string" }).notNull(),
  foremanId: integer("foreman_id").notNull().references(() => appUsers.id),
  status: text("status").notNull().default("draft"),
  revision: integer("revision").notNull().default(1),
  submittedAt: auditTimestamp("submitted_at"),
  updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.siteId, table.workDate, table.foremanId] }),
  index("idx_equipment_report_contributions_site_date_status").on(table.siteId, table.workDate, table.status),
  index("idx_equipment_report_contributions_foreman_date").on(table.foremanId, table.workDate),
  check("equipment_report_contribution_status", sql`${table.status} IN ('draft', 'submitted')`),
  check("equipment_report_contribution_revision_positive", sql`${table.revision} > 0`),
]);

export const equipmentTimesheetMarks = pgTable("equipment_timesheet_marks", {
  id: serial("id").primaryKey(),
  siteId: integer("site_id").notNull().references(() => sites.id),
  equipmentId: integer("equipment_id").notNull().references(() => equipmentUnits.id),
  workDate: date("work_date", { mode: "string" }).notNull(),
  productiveHours: integer("productive_hours").notNull().default(0),
  downtimeHours: integer("downtime_hours").notNull().default(0),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull(),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_equipment_timesheet_marks_unique_day").on(table.siteId, table.equipmentId, table.workDate),
  index("idx_equipment_timesheet_marks_month").on(table.siteId, table.workDate),
  check("equipment_timesheet_productive_hours_range", sql`${table.productiveHours} BETWEEN 0 AND 20`),
  check("equipment_timesheet_downtime_hours_range", sql`${table.downtimeHours} BETWEEN 0 AND 20`),
  check("equipment_timesheet_daily_hours_limit", sql`${table.productiveHours} + ${table.downtimeHours} <= 20`),
]);
