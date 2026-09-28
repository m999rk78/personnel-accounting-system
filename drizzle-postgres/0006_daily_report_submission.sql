CREATE TABLE IF NOT EXISTS "placement_report_days" (
	"site_id" integer NOT NULL,
	"work_date" date NOT NULL,
	"submitted_by" integer,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "placement_report_days_site_id_work_date_pk" PRIMARY KEY("site_id", "work_date")
);

DO $$ BEGIN
 ALTER TABLE "placement_report_days" ADD CONSTRAINT "placement_report_days_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "placement_report_days" ADD CONSTRAINT "placement_report_days_submitted_by_app_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

INSERT INTO "placement_report_days" ("site_id", "work_date", "submitted_at")
SELECT "site_id", "work_date", MIN("created_at")
FROM "placement_entries"
WHERE "deleted_at" IS NULL
GROUP BY "site_id", "work_date"
ON CONFLICT ("site_id", "work_date") DO NOTHING;
