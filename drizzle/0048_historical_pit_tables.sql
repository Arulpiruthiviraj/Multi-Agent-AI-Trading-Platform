CREATE TABLE `historical_fundamental_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`filing_date_ms` integer NOT NULL,
	`pe_ratio` real,
	`pb_ratio` real,
	`roe` real,
	`debt_to_equity` real,
	`source` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_historical_fundamental_symbol` ON `historical_fundamental_snapshots` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_historical_fundamental_filing_date` ON `historical_fundamental_snapshots` (`filing_date_ms`);--> statement-breakpoint
CREATE TABLE `historical_macro_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`release_date_ms` integer NOT NULL,
	`metric` text NOT NULL,
	`actual` real,
	`forecast` real,
	`previous` real,
	`impact` text,
	`source` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_historical_macro_release_date` ON `historical_macro_releases` (`release_date_ms`);--> statement-breakpoint
CREATE INDEX `idx_historical_macro_event_id` ON `historical_macro_releases` (`event_id`);--> statement-breakpoint
CREATE TABLE `historical_news_archive` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`published_at_ms` integer NOT NULL,
	`headline` text NOT NULL,
	`summary` text,
	`sentiment_score` real,
	`source` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_historical_news_archive_symbol` ON `historical_news_archive` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_historical_news_archive_published` ON `historical_news_archive` (`published_at_ms`);
