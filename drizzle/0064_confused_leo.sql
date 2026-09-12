CREATE TABLE `prediction_outcome_horizons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prediction_id` text NOT NULL,
	`source_table` text NOT NULL,
	`symbol` text NOT NULL,
	`horizon_label` text NOT NULL,
	`horizon_bars` integer NOT NULL,
	`forward_return` real NOT NULL,
	`forward_direction` text NOT NULL,
	`evaluated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_prediction_outcome_horizons_unique` ON `prediction_outcome_horizons` (`prediction_id`,`source_table`,`horizon_label`);--> statement-breakpoint
CREATE INDEX `idx_prediction_outcome_horizons_prediction` ON `prediction_outcome_horizons` (`prediction_id`,`source_table`);
