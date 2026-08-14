PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_text` text NOT NULL,
	`weight` real DEFAULT 1,
	`created_at` integer DEFAULT 1786581595877
);
--> statement-breakpoint
INSERT INTO `__new_memory_rules`("id", "rule_text", "weight", "created_at") SELECT "id", "rule_text", "weight", "created_at" FROM `memory_rules`;--> statement-breakpoint
DROP TABLE `memory_rules`;--> statement-breakpoint
ALTER TABLE `__new_memory_rules` RENAME TO `memory_rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`session_token` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`created_at` integer DEFAULT 1786581595875
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("session_token", "username", "expires_at", "last_seen", "created_at") SELECT "session_token", "username", "expires_at", "last_seen", "created_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
ALTER TABLE `settings` ADD `position_sizing_mode` text DEFAULT 'FIXED_DOLLAR' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `percent_of_equity_pct` real DEFAULT 2;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`created_at` integer DEFAULT 1786581595875
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "password_hash", "created_at") SELECT "id", "email", "password_hash", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;