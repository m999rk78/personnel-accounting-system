ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "bitrix24_stage" text DEFAULT '' NOT NULL;
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "availability_status" text DEFAULT 'on_site' NOT NULL;
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "bitrix24_updated_at" timestamp with time zone;
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp with time zone;
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "sync_error" text;
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "sync_miss_count" integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS "employee_profile_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL REFERENCES "employees"("id"),
	"full_name" text NOT NULL,
	"employment_type" text NOT NULL,
	"department" text NOT NULL,
	"position" text NOT NULL,
	"bitrix24_stage" text DEFAULT '' NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"source" text DEFAULT 'bitrix24' NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_employee_profile_versions_period" ON "employee_profile_versions" USING btree ("employee_id", "valid_from", "valid_to");

CREATE TABLE IF NOT EXISTS "employee_availability_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL REFERENCES "employees"("id"),
	"status" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"source" text DEFAULT 'bitrix24' NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_employee_availability_periods_period" ON "employee_availability_periods" USING btree ("employee_id", "valid_from", "valid_to");

CREATE TABLE IF NOT EXISTS "employee_sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'bitrix24' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"summary" text,
	"error_text" text
);

CREATE TABLE IF NOT EXISTS "employee_sync_issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL REFERENCES "employee_sync_runs"("id"),
	"bitrix24_id" text,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_employee_sync_issues_run" ON "employee_sync_issues" USING btree ("run_id");

ALTER TABLE "placement_entries" ADD COLUMN IF NOT EXISTS "employee_name_snapshot" text DEFAULT '' NOT NULL;
ALTER TABLE "placement_entries" ADD COLUMN IF NOT EXISTS "employment_type_snapshot" text DEFAULT '' NOT NULL;
ALTER TABLE "placement_entries" ADD COLUMN IF NOT EXISTS "department_snapshot" text DEFAULT '' NOT NULL;
ALTER TABLE "placement_entries" ADD COLUMN IF NOT EXISTS "master_name_snapshot" text DEFAULT '' NOT NULL;

UPDATE "placement_entries" pe
SET "employee_name_snapshot" = e."full_name",
    "employment_type_snapshot" = e."employment_type",
    "department_snapshot" = e."department"
FROM "employees" e
WHERE pe."employee_id" = e."id"
  AND (pe."employee_name_snapshot" = '' OR pe."employment_type_snapshot" = '' OR pe."department_snapshot" = '');

UPDATE "placement_entries" pe
SET "master_name_snapshot" = m."name"
FROM "masters" m
WHERE pe."master_id" = m."id" AND pe."master_name_snapshot" = '';
