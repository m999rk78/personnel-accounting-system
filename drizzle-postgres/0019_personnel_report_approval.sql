CREATE TABLE IF NOT EXISTS "personnel_reports" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id"),
  "work_date" date NOT NULL,
  "owner_user_id" integer NOT NULL REFERENCES "app_users"("id"),
  "status" text DEFAULT 'draft' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "submitted_at" timestamptz,
  "submitted_by_user_id" integer REFERENCES "app_users"("id"),
  "reviewed_at" timestamptz,
  "reviewed_by_user_id" integer REFERENCES "app_users"("id"),
  "review_comment" text DEFAULT '' NOT NULL,
  "created_by_user_id" integer NOT NULL REFERENCES "app_users"("id"),
  "updated_by_user_id" integer NOT NULL REFERENCES "app_users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "personnel_report_status" CHECK ("status" IN ('draft', 'submitted', 'approved', 'rejected')),
  CONSTRAINT "personnel_report_revision_positive" CHECK ("revision" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_personnel_reports_site_date" ON "personnel_reports" ("site_id", "work_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_personnel_reports_review" ON "personnel_reports" ("site_id", "status", "work_date");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_personnel_reports_active_owner_day" ON "personnel_reports" ("site_id", "work_date", "owner_user_id") WHERE "status" <> 'approved';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "personnel_report_rows" (
  "id" serial PRIMARY KEY NOT NULL,
  "report_id" integer NOT NULL REFERENCES "personnel_reports"("id") ON DELETE CASCADE,
  "row_order" integer NOT NULL,
  "employee_id" integer REFERENCES "employees"("id"),
  "shift_id" integer REFERENCES "shifts"("id"),
  "zone_id" integer REFERENCES "zones"("id"),
  "main_work_type_id" integer REFERENCES "main_work_types"("id"),
  "subwork_type_id" integer REFERENCES "subwork_types"("id"),
  "master_id" integer REFERENCES "masters"("id"),
  "hours" integer,
  "note" text DEFAULT '' NOT NULL,
  "position_snapshot" text DEFAULT '' NOT NULL,
  "employee_name_snapshot" text DEFAULT '' NOT NULL,
  "employment_type_snapshot" text DEFAULT '' NOT NULL,
  "department_snapshot" text DEFAULT '' NOT NULL,
  "master_name_snapshot" text DEFAULT '' NOT NULL,
  "approved_entry_id" integer REFERENCES "placement_entries"("id"),
  CONSTRAINT "personnel_report_row_hours" CHECK ("hours" IS NULL OR "hours" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_personnel_report_rows_order" ON "personnel_report_rows" ("report_id", "row_order");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_personnel_report_rows_approved_entry" ON "personnel_report_rows" ("approved_entry_id");
