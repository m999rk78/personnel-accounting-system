ALTER TABLE "placement_entries" ADD COLUMN IF NOT EXISTS "responsible_user_id" integer;
ALTER TABLE "placement_entries" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "placement_entries" ADD COLUMN IF NOT EXISTS "created_by_user_id" integer;
ALTER TABLE "placement_entries" ADD COLUMN IF NOT EXISTS "updated_by_user_id" integer;

DO $$ BEGIN
 ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entries_responsible_user_id_app_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entries_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entries_updated_by_user_id_app_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entry_revision_positive" CHECK ("placement_entries"."revision" > 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_entries_responsible_site_date"
ON "placement_entries" USING btree ("responsible_user_id", "site_id", "work_date")
WHERE "placement_entries"."responsible_user_id" IS NOT NULL AND "placement_entries"."deleted_at" IS NULL;

CREATE TABLE IF NOT EXISTS "placement_report_contributions" (
	"site_id" integer NOT NULL,
	"work_date" date NOT NULL,
	"foreman_id" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "placement_report_contributions_site_id_work_date_foreman_id_pk" PRIMARY KEY("site_id", "work_date", "foreman_id"),
	CONSTRAINT "placement_report_contribution_status" CHECK ("placement_report_contributions"."status" IN ('draft', 'submitted')),
	CONSTRAINT "placement_report_contribution_revision_positive" CHECK ("placement_report_contributions"."revision" > 0)
);

DO $$ BEGIN
 ALTER TABLE "placement_report_contributions" ADD CONSTRAINT "placement_report_contributions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "placement_report_contributions" ADD CONSTRAINT "placement_report_contributions_foreman_id_app_users_id_fk" FOREIGN KEY ("foreman_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_report_contributions_site_date_status"
ON "placement_report_contributions" USING btree ("site_id", "work_date", "status");
CREATE INDEX IF NOT EXISTS "idx_report_contributions_foreman_date"
ON "placement_report_contributions" USING btree ("foreman_id", "work_date");

UPDATE "placement_entries" AS "entry"
SET "responsible_user_id" = "report"."submitted_by"
FROM "placement_report_days" AS "report"
INNER JOIN "app_users" AS "submitter"
	ON "submitter"."id" = "report"."submitted_by"
	AND "submitter"."role" = 'foreman'
WHERE "entry"."site_id" = "report"."site_id"
	AND "entry"."work_date" = "report"."work_date"
	AND "entry"."responsible_user_id" IS NULL;

INSERT INTO "placement_report_contributions" (
	"site_id",
	"work_date",
	"foreman_id",
	"status",
	"revision",
	"submitted_at",
	"updated_at"
)
SELECT
	"report"."site_id",
	"report"."work_date",
	"report"."submitted_by",
	'submitted',
	1,
	"report"."submitted_at",
	"report"."submitted_at"
FROM "placement_report_days" AS "report"
INNER JOIN "app_users" AS "submitter"
	ON "submitter"."id" = "report"."submitted_by"
	AND "submitter"."role" = 'foreman'
ON CONFLICT ("site_id", "work_date", "foreman_id") DO NOTHING;
