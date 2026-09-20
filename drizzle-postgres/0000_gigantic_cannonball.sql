CREATE TABLE "app_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"role" text NOT NULL,
	"assigned_site_id" integer,
	"password_hash" text,
	"password_salt" text,
	"password_iterations" integer,
	"invited_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_project_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"site_id" integer NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"start_date" date,
	"end_date" date,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"bitrix24_id" text,
	"full_name" text NOT NULL,
	"employment_type" text DEFAULT 'ОПР' NOT NULL,
	"department" text DEFAULT 'УСР' NOT NULL,
	"position" text NOT NULL,
	"source" text DEFAULT 'excel' NOT NULL,
	"site_id" integer,
	"active" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employees_bitrix24_id_unique" UNIQUE("bitrix24_id")
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"attempt_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "main_work_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"name" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "masters" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"name" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personnel_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "placement_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"work_date" date NOT NULL,
	"employee_id" integer NOT NULL,
	"shift_id" integer NOT NULL,
	"zone_id" integer NOT NULL,
	"main_work_type_id" integer NOT NULL,
	"subwork_type_id" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"master_id" integer NOT NULL,
	"hours" integer NOT NULL,
	"position_snapshot" text NOT NULL,
	"created_by" text DEFAULT 'demo-user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "position_catalog" (
	"id" serial PRIMARY KEY NOT NULL,
	"employment_type" text NOT NULL,
	"department" text NOT NULL,
	"position" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"name" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "subwork_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"name" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"name" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_assigned_site_id_sites_id_fk" FOREIGN KEY ("assigned_site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_project_assignments" ADD CONSTRAINT "employee_project_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_project_assignments" ADD CONSTRAINT "employee_project_assignments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "main_work_types" ADD CONSTRAINT "main_work_types_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "masters" ADD CONSTRAINT "masters_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entries_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entries_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entries_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entries_main_work_type_id_main_work_types_id_fk" FOREIGN KEY ("main_work_type_id") REFERENCES "public"."main_work_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entries_subwork_type_id_subwork_types_id_fk" FOREIGN KEY ("subwork_type_id") REFERENCES "public"."subwork_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_entries" ADD CONSTRAINT "placement_entries_master_id_masters_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."masters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subwork_types" ADD CONSTRAINT "subwork_types_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_employee_project_assignment_active" ON "employee_project_assignments" USING btree ("employee_id","site_id") WHERE "employee_project_assignments"."active" = 1;--> statement-breakpoint
CREATE INDEX "idx_employee_project_assignment_site" ON "employee_project_assignments" USING btree ("site_id","active");--> statement-breakpoint
CREATE INDEX "idx_login_attempts_key_time" ON "login_attempts" USING btree ("attempt_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_personnel_options_kind_name" ON "personnel_options" USING btree ("kind","name") WHERE "personnel_options"."active" = 1;--> statement-breakpoint
CREATE INDEX "idx_entries_site_date" ON "placement_entries" USING btree ("site_id","work_date");--> statement-breakpoint
CREATE INDEX "idx_entries_employee_date" ON "placement_entries" USING btree ("employee_id","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_position_catalog_values" ON "position_catalog" USING btree ("employment_type","department","position") WHERE "position_catalog"."active" = 1;--> statement-breakpoint
CREATE INDEX "idx_user_invitations_user" ON "user_invitations" USING btree ("user_id","used_at");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user" ON "user_sessions" USING btree ("user_id","revoked_at");