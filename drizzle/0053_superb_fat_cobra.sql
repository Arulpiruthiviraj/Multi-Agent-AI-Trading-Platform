CREATE TABLE `session_lifecycle_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trading_date` text NOT NULL,
	`market_session` text NOT NULL,
	`app_state` text NOT NULL,
	`premarket_fired_for_date` text,
	`evaluated_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_session_lifecycle_snapshots_date` ON `session_lifecycle_snapshots` (`trading_date`,`evaluated_at`);
