CREATE TABLE `config_overrides` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text DEFAULT 'operator' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `config_change_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`setting` text NOT NULL,
	`old_effective` text,
	`new_value` text,
	`source` text NOT NULL,
	`operator` text NOT NULL,
	`restart_required` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_config_change_events_setting` ON `config_change_events` (`setting`,`created_at`);
