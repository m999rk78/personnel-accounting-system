CREATE TABLE IF NOT EXISTS "bitrix24_employee_check_states" (
  "employee_id" integer PRIMARY KEY REFERENCES "employees"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "details" text NOT NULL DEFAULT '',
  "fingerprint" text NOT NULL,
  "checked_at" timestamptz NOT NULL,
  "acknowledged_at" timestamptz,
  "acknowledged_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  CONSTRAINT "bitrix24_employee_check_status_valid" CHECK ("status" IN ('mismatch', 'missing_in_bitrix', 'dismissed_in_bitrix'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bitrix24_employee_check_status"
ON "bitrix24_employee_check_states" ("status", "acknowledged_at");
