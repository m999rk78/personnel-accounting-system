CREATE TABLE `app_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`full_name` text NOT NULL,
	`role` text NOT NULL,
	`assigned_site_id` integer,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`assigned_site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
