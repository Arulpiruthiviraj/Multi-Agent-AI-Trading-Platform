CREATE TABLE `replay_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`config_json` text NOT NULL,
	`dataset_hash` text,
	`configuration_hash` text,
	`replay_hash` text,
	`summary_json` text,
	`execution_environment` text NOT NULL DEFAULT 'REPLAY',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_replay_runs_status` ON `replay_runs` (`status`);
