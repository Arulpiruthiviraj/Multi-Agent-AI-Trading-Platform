CREATE TABLE `postmarket_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`trading_date` text NOT NULL,
	`generated_at` text NOT NULL,
	`argus_commit` text,
	`total_symbols_touched` integer NOT NULL,
	`by_classification_json` text NOT NULL,
	`findings_json` text NOT NULL,
	`status` text NOT NULL,
	`error_message` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `postmarket_reports_trading_date_unique` ON `postmarket_reports` (`trading_date`);--> statement-breakpoint
CREATE INDEX `idx_postmarket_reports_trading_date` ON `postmarket_reports` (`trading_date`);
