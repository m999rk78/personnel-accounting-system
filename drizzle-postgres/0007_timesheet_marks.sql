CREATE TABLE IF NOT EXISTS "timesheet_marks" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	"work_date" date NOT NULL,
	"hours" integer,
	"code" text,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "timesheet_marks" ALTER COLUMN "work_date" TYPE date USING "work_date"::date;
ALTER TABLE "timesheet_marks" ALTER COLUMN "created_at" DROP DEFAULT;
ALTER TABLE "timesheet_marks" ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at"::timestamp with time zone;
ALTER TABLE "timesheet_marks" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "timesheet_marks" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "timesheet_marks" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at"::timestamp with time zone;
ALTER TABLE "timesheet_marks" ALTER COLUMN "updated_at" SET DEFAULT now();

DO $$ BEGIN
 ALTER TABLE "timesheet_marks" ADD CONSTRAINT "timesheet_hours_range" CHECK ("timesheet_marks"."hours" IS NULL OR "timesheet_marks"."hours" BETWEEN 1 AND 10);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "timesheet_marks" ADD CONSTRAINT "timesheet_value_required" CHECK (("timesheet_marks"."hours" IS NOT NULL AND "timesheet_marks"."code" IS NULL) OR ("timesheet_marks"."hours" IS NULL AND "timesheet_marks"."code" IS NOT NULL));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_timesheet_marks_unique_day" ON "timesheet_marks" USING btree ("site_id", "employee_id", "work_date");
CREATE INDEX IF NOT EXISTS "idx_timesheet_marks_month" ON "timesheet_marks" USING btree ("site_id", "work_date");
