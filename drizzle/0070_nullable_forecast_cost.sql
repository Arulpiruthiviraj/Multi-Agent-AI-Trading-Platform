-- Preserve all historical forecasts; unknown cost is nullable for new evidence.
CREATE TABLE `quant_forecasts_nullable_cost` (
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
 `estimated_transaction_cost_bps` real,
 `net_expected_return` real,
 `strategy_count` integer,
 `family_count` integer,
 `effective_independent_count` real,
 `model_version` text NOT NULL,
 `provenance_json` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `quant_forecasts_nullable_cost` (`forecast_id`, `symbol`, `created_at`, `direction`, `horizon_label`, `agent_name`, `strategy_id`, `regime`, `forecast_status`, `sample_size`, `expected_return`, `expected_return_lower`, `expected_return_upper`, `median_return`, `trimmed_mean_return`, `probability_of_profit`, `probability_of_profit_lower`, `probability_of_profit_upper`, `volatility`, `uncertainty_stdev_return`, `estimated_transaction_cost_bps`, `net_expected_return`, `strategy_count`, `family_count`, `effective_independent_count`, `model_version`, `provenance_json`) SELECT `forecast_id`, `symbol`, `created_at`, `direction`, `horizon_label`, `agent_name`, `strategy_id`, `regime`, `forecast_status`, `sample_size`, `expected_return`, `expected_return_lower`, `expected_return_upper`, `median_return`, `trimmed_mean_return`, `probability_of_profit`, `probability_of_profit_lower`, `probability_of_profit_upper`, `volatility`, `uncertainty_stdev_return`, `estimated_transaction_cost_bps`, `net_expected_return`, `strategy_count`, `family_count`, `effective_independent_count`, `model_version`, `provenance_json` FROM `quant_forecasts`;
--> statement-breakpoint
DROP TABLE `quant_forecasts`;
--> statement-breakpoint
ALTER TABLE `quant_forecasts_nullable_cost` RENAME TO `quant_forecasts`;
--> statement-breakpoint
CREATE INDEX `idx_quant_forecasts_symbol` ON `quant_forecasts` (`symbol`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_quant_forecasts_lookup` ON `quant_forecasts` (`symbol`,`agent_name`,`strategy_id`,`direction`,`horizon_label`,`created_at`);
