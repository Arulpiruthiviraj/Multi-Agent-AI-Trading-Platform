CREATE TABLE `daily_learning_archive` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trading_date` text NOT NULL,
	`source_type` text NOT NULL,
	`schema_version` integer NOT NULL,
	`window_start_ms` integer NOT NULL,
	`window_end_ms` integer NOT NULL,
	`source_row_count` integer NOT NULL,
	`summary_json` text NOT NULL,
	`summary_checksum` text NOT NULL,
	`source_checksum` text,
	`compaction_status` text NOT NULL,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`verified_at` integer,
	`raw_purged_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_daily_learning_archive_date_source` ON `daily_learning_archive` (`trading_date`,`source_type`);--> statement-breakpoint
CREATE INDEX `idx_daily_learning_archive_status` ON `daily_learning_archive` (`compaction_status`);