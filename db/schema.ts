import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sites = sqliteTable("sites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  timezone: text("timezone").notNull().default("Europe/Moscow"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const appUsers = sqliteTable("app_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().default(""),
  role: text("role").notNull(),
  assignedSiteId: integer("assigned_site_id").references(() => sites.id),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  passwordIterations: integer("password_iterations"),
  invitedAt: text("invited_at"),
  activatedAt: text("activated_at"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const userInvitations = sqliteTable("user_invitations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => appUsers.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_user_invitations_user").on(table.userId, table.usedAt)]);

export const userSessions = sqliteTable("user_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => appUsers.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revokedAt: text("revoked_at"),
}, (table) => [index("idx_user_sessions_user").on(table.userId, table.revokedAt)]);

export const loginAttempts = sqliteTable("login_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  attemptKey: text("attempt_key").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_login_attempts_key_time").on(table.attemptKey, table.createdAt)]);

export const employees = sqliteTable("employees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bitrix24Id: text("bitrix24_id").unique(),
  fullName: text("full_name").notNull(),
  employmentType: text("employment_type").notNull().default("ОПР"),
  department: text("department").notNull().default("УСР"),
  position: text("position").notNull(),
  source: text("source").notNull().default("excel"),
  siteId: integer("site_id").references(() => sites.id),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const employeeProjectAssignments = sqliteTable("employee_project_assignments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  siteId: integer("site_id").notNull().references(() => sites.id),
  source: text("source").notNull().default("manual"),
  startDate: text("start_date"),
  endDate: text("end_date"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [
  uniqueIndex("idx_employee_project_assignment_active").on(table.employeeId, table.siteId).where(sql`${table.active} = 1`),
  index("idx_employee_project_assignment_site").on(table.siteId, table.active),
]);

export const positionCatalog = sqliteTable("position_catalog", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  employmentType: text("employment_type").notNull(),
  department: text("department").notNull(),
  position: text("position").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [
  uniqueIndex("idx_position_catalog_values").on(table.employmentType, table.department, table.position).where(sql`${table.active} = 1`),
]);

export const personnelOptions = sqliteTable("personnel_options", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [
  uniqueIndex("idx_personnel_options_kind_name").on(table.kind, table.name).where(sql`${table.active} = 1`),
]);

export const shifts = sqliteTable("shifts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: integer("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const zones = sqliteTable("zones", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: integer("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const mainWorkTypes = sqliteTable("main_work_types", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: integer("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const subworkTypes = sqliteTable("subwork_types", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: integer("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const masters = sqliteTable("masters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: integer("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const placementEntries = sqliteTable("placement_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: integer("site_id").notNull().references(() => sites.id),
  workDate: text("work_date").notNull(),
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
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  deletedAt: text("deleted_at"),
});
