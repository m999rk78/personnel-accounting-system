CREATE TABLE IF NOT EXISTS "equipment_units" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"identity_key" text NOT NULL,
	"organization" text NOT NULL,
	"equipment_type" text NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"registration_number" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "equipment_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"work_date" date NOT NULL,
	"equipment_id" integer NOT NULL,
	"shift_id" integer NOT NULL,
	"zone_id" integer NOT NULL,
	"main_work_type_id" integer NOT NULL,
	"subwork_type_id" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"hours" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);

DO $$ BEGIN
 ALTER TABLE "equipment_units" ADD CONSTRAINT "equipment_units_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entries_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entries_equipment_id_equipment_units_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment_units"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entries_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entries_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entries_main_work_type_id_main_work_types_id_fk" FOREIGN KEY ("main_work_type_id") REFERENCES "public"."main_work_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entries_subwork_type_id_subwork_types_id_fk" FOREIGN KEY ("subwork_type_id") REFERENCES "public"."subwork_types"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "equipment_entries" ADD CONSTRAINT "equipment_entry_hours_range" CHECK ("equipment_entries"."hours" BETWEEN 1 AND 10);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_equipment_units_site_identity" ON "equipment_units" USING btree ("site_id", "identity_key");
CREATE INDEX IF NOT EXISTS "idx_equipment_units_site_active" ON "equipment_units" USING btree ("site_id", "active");
CREATE INDEX IF NOT EXISTS "idx_equipment_entries_site_date" ON "equipment_entries" USING btree ("site_id", "work_date");
CREATE INDEX IF NOT EXISTS "idx_equipment_entries_unit_date" ON "equipment_entries" USING btree ("equipment_id", "work_date");
