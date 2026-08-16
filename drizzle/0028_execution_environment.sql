ALTER TABLE `trades` ADD `execution_environment` text;
--> statement-breakpoint
CREATE TABLE `diagnostic_trade_archive` (
	`id` text PRIMARY KEY NOT NULL,
	`archived_at` text NOT NULL,
	`original_status` text NOT NULL,
	`trace_id` text,
	`symbol` text,
	`snapshot_json` text NOT NULL
);
