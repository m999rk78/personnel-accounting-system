ALTER TABLE "equipment_entries" ADD COLUMN IF NOT EXISTS "responsible_user_id" integer;
ALTER TABLE "equipment_entries" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "equipment_entries" ADD COLUMN IF NOT EXISTS "created_by_user_id" integer;
ALTER TABLE "equipment_entries" ADD COLUMN IF NOT EXISTS "updated_by_user_id" integer;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entries_responsible_user_id_app_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entries_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entries_updated_by_user_id_app_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entry_revision_positive" CHECK ("equipment_entries"."revision" > 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_equipment_entries_responsible_site_date"
ON "equipment_entries" USING btree ("responsible_user_id", "site_id", "work_date")
WHERE "equipment_entries"."responsible_user_id" IS NOT NULL AND "equipment_entries"."deleted_at" IS NULL;

CREATE TABLE IF NOT EXISTS "equipment_report_days" (
  "site_id" integer NOT NULL,
  "work_date" date NOT NULL,
  "submitted_by" integer,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "equipment_report_days_site_id_work_date_pk" PRIMARY KEY("site_id", "work_date")
);

CREATE TABLE IF NOT EXISTS "equipment_report_contributions" (
  "site_id" integer NOT NULL,
  "work_date" date NOT NULL,
  "foreman_id" integer NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "submitted_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "equipment_report_contributions_site_id_work_date_foreman_id_pk" PRIMARY KEY("site_id", "work_date", "foreman_id"),
  CONSTRAINT "equipment_report_contribution_status" CHECK ("equipment_report_contributions"."status" IN ('draft', 'submitted')),
  CONSTRAINT "equipment_report_contribution_revision_positive" CHECK ("equipment_report_contributions"."revision" > 0)
);

DO $$ BEGIN
 ALTER TABLE "equipment_report_days" ADD CONSTRAINT "equipment_report_days_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_report_days" ADD CONSTRAINT "equipment_report_days_submitted_by_app_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_report_contributions" ADD CONSTRAINT "equipment_report_contributions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_report_contributions" ADD CONSTRAINT "equipment_report_contributions_foreman_id_app_users_id_fk" FOREIGN KEY ("foreman_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_equipment_report_contributions_site_date_status"
ON "equipment_report_contributions" USING btree ("site_id", "work_date", "status");
CREATE INDEX IF NOT EXISTS "idx_equipment_report_contributions_foreman_date"
ON "equipment_report_contributions" USING btree ("foreman_id", "work_date");

UPDATE "equipment_entries" AS "entry"
SET "responsible_user_id" = "user"."id",
    "created_by_user_id" = COALESCE("entry"."created_by_user_id", "user"."id"),
    "updated_by_user_id" = COALESCE("entry"."updated_by_user_id", "user"."id")
FROM "app_users" AS "user"
WHERE "entry"."responsible_user_id" IS NULL
  AND "user"."role" = 'foreman'
  AND "user"."active" = 1
  AND "user"."assigned_site_id" = "entry"."site_id"
  AND "user"."full_name" = "entry"."created_by";
