CREATE TABLE `quant_forecasts` (
	`forecast_id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`created_at` text NOT NULL,
	`direction` text NOT NULL,
	`horizon_label` text NOT NULL,
	`agent_name` text NOT NULL,
	`strategy_id` text,
	`regime` text,
	`forecast_status` text NOT NULL,
	`sample_size` integer NOT NULL,
	`expected_return` real,
	`expected_return_lower` real,
	`expected_return_upper` real,
	`median_return` real,
	`trimmed_mean_return` real,
	`probability_of_profit` real,
	`probability_of_profit_lower` real,
	`probability_of_profit_upper` real,
	`volatility` real,
	`uncertainty_stdev_return` real,
	`estimated_transaction_cost_bps` real NOT NULL,
	`net_expected_return` real,
	`strategy_count` integer,
	`family_count` integer,
	`effective_independent_count` real,
	`model_version` text NOT NULL,
	`provenance_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_quant_forecasts_symbol` ON `quant_forecasts` (`symbol`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_quant_forecasts_lookup` ON `quant_forecasts` (`symbol`,`agent_name`,`strategy_id`,`direction`,`horizon_label`,`created_at`);
