CREATE TABLE `prediction_outcomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prediction_id` text NOT NULL,
	`source_table` text NOT NULL,
	`symbol` text NOT NULL,
	`actual_price` real,
	`actual_return` real,
	`actual_direction` text,
	`mfe` real,
	`mae` real,
	`pnl` real,
	`outcome` text NOT NULL,
	`evaluated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_prediction_outcomes_source` ON `prediction_outcomes` (`prediction_id`,`source_table`);
--> statement-breakpoint
ALTER TABLE `kronos_predictions` ADD `trace_id` text;
--> statement-breakpoint
ALTER TABLE `kronos_predictions` ADD `transaction_id` text;
