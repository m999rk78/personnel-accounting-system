CREATE TABLE IF NOT EXISTS "table_row_orders" (
  "id" text PRIMARY KEY,
  "row_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
