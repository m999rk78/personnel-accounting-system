CREATE INDEX IF NOT EXISTS "idx_employees_active_name"
ON "employees" USING btree ("full_name", "id")
WHERE "employees"."active" = 1;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_project_assignment_site_employee_active"
ON "employee_project_assignments" USING btree ("site_id", "employee_id")
WHERE "employee_project_assignments"."active" = 1;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_entries_opr_site_date_employee"
ON "placement_entries" USING btree ("site_id", "work_date", "employee_id")
WHERE "placement_entries"."deleted_at" IS NULL
  AND upper(trim("placement_entries"."employment_type_snapshot")) = 'ОПР';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_equipment_units_active_sort"
ON "equipment_units" USING btree ("equipment_type", "model", "registration_number", "id")
WHERE "equipment_units"."active" = 1;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_equipment_project_assignment_site_equipment_active"
ON "equipment_project_assignments" USING btree ("site_id", "equipment_id")
WHERE "equipment_project_assignments"."active" = 1;
