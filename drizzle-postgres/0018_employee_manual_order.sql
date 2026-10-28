ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
WITH "ranked" AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "full_name", "id") AS "position"
  FROM "employees"
)
UPDATE "employees"
SET "sort_order" = "ranked"."position"
FROM "ranked"
WHERE "employees"."id" = "ranked"."id" AND "employees"."sort_order" <= 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employees_active_sort_order" ON "employees" USING btree ("sort_order", "id") WHERE "employees"."active" = 1;
