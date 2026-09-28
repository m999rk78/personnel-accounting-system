CREATE TABLE IF NOT EXISTS "bitrix24_action_limits" (
	"action_key" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone NOT NULL
);

INSERT INTO "bitrix24_action_limits" ("action_key", "last_started_at")
SELECT 'sync-bitrix24', MAX("started_at")
FROM "employee_sync_runs"
WHERE "source" = 'bitrix24'
HAVING COUNT(*) > 0
ON CONFLICT ("action_key") DO NOTHING;
