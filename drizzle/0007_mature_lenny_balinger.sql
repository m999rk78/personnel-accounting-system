CREATE TABLE `employee_project_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`site_id` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`start_date` text,
	`end_date` text,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_employee_project_assignment_active` ON `employee_project_assignments` (`employee_id`,`site_id`) WHERE "employee_project_assignments"."active" = 1;--> statement-breakpoint
CREATE INDEX `idx_employee_project_assignment_site` ON `employee_project_assignments` (`site_id`,`active`);
