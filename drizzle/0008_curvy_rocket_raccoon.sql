CREATE TABLE `user_invitations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_invitations_token_hash_unique` ON `user_invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_user_invitations_user` ON `user_invitations` (`user_id`,`used_at`);--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_sessions_token_hash_unique` ON `user_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_user_sessions_user` ON `user_sessions` (`user_id`,`revoked_at`);--> statement-breakpoint
ALTER TABLE `app_users` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `app_users` ADD `password_salt` text;--> statement-breakpoint
ALTER TABLE `app_users` ADD `password_iterations` integer;--> statement-breakpoint
ALTER TABLE `app_users` ADD `invited_at` text;--> statement-breakpoint
ALTER TABLE `app_users` ADD `activated_at` text;