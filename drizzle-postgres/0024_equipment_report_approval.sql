ALTER TABLE "equipment_entries" ADD COLUMN IF NOT EXISTS "equipment_name_snapshot" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "equipment_entries" ADD COLUMN IF NOT EXISTS "organization_snapshot" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "equipment_entries" ADD COLUMN IF NOT EXISTS "equipment_type_snapshot" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "equipment_entries" ADD COLUMN IF NOT EXISTS "brand_snapshot" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "equipment_entries" ADD COLUMN IF NOT EXISTS "model_snapshot" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "equipment_entries" ADD COLUMN IF NOT EXISTS "registration_number_snapshot" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "equipment_reports" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id"),
  "work_date" date NOT NULL,
  "owner_user_id" integer NOT NULL REFERENCES "app_users"("id"),
  "status" text DEFAULT 'draft' NOT NULL CHECK ("status" IN ('draft', 'submitted', 'approved', 'rejected')),
  "revision" integer DEFAULT 1 NOT NULL CHECK ("revision" > 0),
  "submitted_at" timestamptz,
  "submitted_by_user_id" integer REFERENCES "app_users"("id"),
  "reviewed_at" timestamptz,
  "reviewed_by_user_id" integer REFERENCES "app_users"("id"),
  "review_comment" text DEFAULT '' NOT NULL,
  "created_by_user_id" integer NOT NULL REFERENCES "app_users"("id"),
  "updated_by_user_id" integer NOT NULL REFERENCES "app_users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_equipment_reports_site_date" ON "equipment_reports" ("site_id", "work_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_equipment_reports_review" ON "equipment_reports" ("site_id", "status", "work_date");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_equipment_reports_active_owner_day" ON "equipment_reports" ("site_id", "work_date", "owner_user_id") WHERE "status" <> 'approved';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "equipment_report_rows" (
  "id" serial PRIMARY KEY NOT NULL,
  "report_id" integer NOT NULL REFERENCES "equipment_reports"("id") ON DELETE CASCADE,
  "row_order" integer NOT NULL,
  "equipment_id" integer REFERENCES "equipment_units"("id"),
  "shift_id" integer REFERENCES "shifts"("id"),
  "zone_id" integer REFERENCES "zones"("id"),
  "main_work_type_id" integer REFERENCES "main_work_types"("id"),
  "subwork_type_id" integer REFERENCES "subwork_types"("id"),
  "hours" integer CHECK ("hours" IS NULL OR "hours" BETWEEN 1 AND 10),
  "note" text DEFAULT '' NOT NULL,
  "equipment_name_snapshot" text DEFAULT '' NOT NULL,
  "organization_snapshot" text DEFAULT '' NOT NULL,
  "equipment_type_snapshot" text DEFAULT '' NOT NULL,
  "brand_snapshot" text DEFAULT '' NOT NULL,
  "model_snapshot" text DEFAULT '' NOT NULL,
  "registration_number_snapshot" text DEFAULT '' NOT NULL,
  "approved_entry_id" integer REFERENCES "equipment_entries"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_equipment_report_rows_order" ON "equipment_report_rows" ("report_id", "row_order");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_equipment_report_rows_approved_entry" ON "equipment_report_rows" ("approved_entry_id");
