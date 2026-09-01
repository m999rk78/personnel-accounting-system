import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sites = sqliteTable("sites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  timezone: text("timezone").notNull().default("Europe/Istanbul"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const employees = sqliteTable("employees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bitrix24Id: text("bitrix24_id").unique(),
  fullName: text("full_name").notNull(),
  position: text("position").notNull(),
  source: text("source").notNull().default("excel"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

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
