CREATE TABLE IF NOT EXISTS "user_permissions" (
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "resource" text NOT NULL,
  "can_view" integer NOT NULL DEFAULT 0,
  "can_create" integer NOT NULL DEFAULT 0,
  "can_update" integer NOT NULL DEFAULT 0,
  "can_delete" integer NOT NULL DEFAULT 0,
  "updated_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("user_id", "resource")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_permissions_user" ON "user_permissions" ("user_id");
