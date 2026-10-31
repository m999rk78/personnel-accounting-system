CREATE TABLE IF NOT EXISTS "user_project_access" (
  "user_id" integer PRIMARY KEY REFERENCES "app_users"("id") ON DELETE CASCADE,
  "all_projects" integer NOT NULL DEFAULT 0 CHECK ("all_projects" IN (0, 1)),
  "can_view_pending_reports" integer NOT NULL DEFAULT 0 CHECK ("can_view_pending_reports" IN (0, 1)),
  "updated_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_project_access_sites" (
  "user_id" integer NOT NULL REFERENCES "user_project_access"("user_id") ON DELETE CASCADE,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  PRIMARY KEY ("user_id", "site_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_project_access_sites_site" ON "user_project_access_sites"("site_id", "user_id");
--> statement-breakpoint
INSERT INTO "user_project_access" ("user_id", "all_projects", "can_view_pending_reports")
SELECT "id", 1, 1 FROM "app_users" WHERE "role" = 'admin' ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
UPDATE "app_users" SET "role" = 'engineer' WHERE "role" = 'admin';
