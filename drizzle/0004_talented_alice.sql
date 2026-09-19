CREATE TABLE `personnel_options` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
