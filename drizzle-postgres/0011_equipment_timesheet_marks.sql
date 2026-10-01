CREATE TABLE IF NOT EXISTS "equipment_timesheet_marks" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"equipment_id" integer NOT NULL,
	"work_date" date NOT NULL,
	"productive_hours" integer DEFAULT 0 NOT NULL,
	"downtime_hours" integer DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "equipment_timesheet_marks" ADD CONSTRAINT "equipment_timesheet_marks_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_timesheet_marks" ADD CONSTRAINT "equipment_timesheet_marks_equipment_id_equipment_units_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment_units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_timesheet_marks" ADD CONSTRAINT "equipment_timesheet_productive_hours_range" CHECK ("equipment_timesheet_marks"."productive_hours" BETWEEN 0 AND 20);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_timesheet_marks" ADD CONSTRAINT "equipment_timesheet_downtime_hours_range" CHECK ("equipment_timesheet_marks"."downtime_hours" BETWEEN 0 AND 20);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_timesheet_marks" ADD CONSTRAINT "equipment_timesheet_daily_hours_limit" CHECK ("equipment_timesheet_marks"."productive_hours" + "equipment_timesheet_marks"."downtime_hours" <= 20);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_equipment_timesheet_marks_unique_day" ON "equipment_timesheet_marks" USING btree ("site_id", "equipment_id", "work_date");
CREATE INDEX IF NOT EXISTS "idx_equipment_timesheet_marks_month" ON "equipment_timesheet_marks" USING btree ("site_id", "work_date");
