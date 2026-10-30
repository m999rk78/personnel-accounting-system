ALTER TABLE masters ADD COLUMN IF NOT EXISTS employee_id integer REFERENCES employees(id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_masters_project_employee ON masters(site_id, employee_id) WHERE employee_id IS NOT NULL;
