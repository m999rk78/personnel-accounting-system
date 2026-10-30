ALTER TABLE "personnel_report_rows" ADD COLUMN IF NOT EXISTS "created_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "personnel_report_rows" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz;
--> statement-breakpoint
-- Earlier drafts did not record individual row times. Preserve the report's
-- known timestamps for those rows instead of labelling them as newly created.
UPDATE "personnel_report_rows" AS row
SET "created_at" = COALESCE(row."created_at", report."created_at"),
    "updated_at" = COALESCE(row."updated_at", report."updated_at")
FROM "personnel_reports" AS report
WHERE row."report_id" = report."id" AND (row."created_at" IS NULL OR row."updated_at" IS NULL);
--> statement-breakpoint
ALTER TABLE "personnel_report_rows" ALTER COLUMN "created_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "personnel_report_rows" ALTER COLUMN "created_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "personnel_report_rows" ALTER COLUMN "updated_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "personnel_report_rows" ALTER COLUMN "updated_at" SET NOT NULL;
