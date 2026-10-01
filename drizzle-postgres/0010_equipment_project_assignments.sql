CREATE TABLE IF NOT EXISTS "equipment_project_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"site_id" integer NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);

DO $$ BEGIN
 ALTER TABLE "equipment_project_assignments" ADD CONSTRAINT "equipment_project_assignments_equipment_id_equipment_units_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment_units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_project_assignments" ADD CONSTRAINT "equipment_project_assignments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_equipment_project_assignment_unique" ON "equipment_project_assignments" USING btree ("equipment_id", "site_id");
CREATE INDEX IF NOT EXISTS "idx_equipment_project_assignment_site" ON "equipment_project_assignments" USING btree ("site_id", "active");

INSERT INTO "equipment_project_assignments" ("equipment_id", "site_id", "active")
SELECT "id", "site_id", 1 FROM "equipment_units" WHERE "active" = 1
ON CONFLICT ("equipment_id", "site_id") DO UPDATE SET "active" = 1, "ended_at" = NULL;
