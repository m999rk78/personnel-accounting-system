import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
  fullName: text("full_name").notNull(),
  employmentType: text("employment_type").notNull().default("ОПР"),
  department: text("department").notNull().default("УСР"),
  position: text("position").notNull(),
  source: text("source").notNull().default("excel"),
  siteId: integer("site_id").references(() => sites.id),
  active: integer("active").notNull().default(1),
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
  createdBy: text("created_by").notNull().default("demo-user"),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  deletedAt: auditTimestamp("deleted_at"),
}, (table) => [
  index("idx_entries_site_date").on(table.siteId, table.workDate),
  index("idx_entries_employee_date").on(table.employeeId, table.workDate),
  check("placement_hours_range", sql`${table.hours} BETWEEN 1 AND 10`),
]);
