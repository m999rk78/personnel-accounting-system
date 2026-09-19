CREATE TABLE `position_catalog` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employment_type` text NOT NULL,
	`department` text NOT NULL,
	`position` text NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_position_catalog_values` ON `position_catalog` (`employment_type`,`department`,`position`) WHERE "position_catalog"."active" = 1;--> statement-breakpoint
ALTER TABLE `employees` ADD `site_id` integer REFERENCES sites(id);