CREATE TABLE `staged_news_catalysts` (
	`trace_id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`headline` text NOT NULL,
	`source` text NOT NULL,
	`published_at_ms` integer,
	`sentiment` real,
	`credibility` real NOT NULL,
	`catalyst_strength` text NOT NULL,
	`trading_bias` text NOT NULL,
	`contribution` real NOT NULL,
	`reasoning` text NOT NULL,
	`recorded_at` text NOT NULL,
	`expected_horizon` text,
	`reference_price` real,
	`status` text NOT NULL,
	`expires_at_ms` integer,
	`cluster_id` text,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_staged_news_catalysts_symbol` ON `staged_news_catalysts` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_staged_news_catalysts_status` ON `staged_news_catalysts` (`status`);
