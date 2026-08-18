ALTER TABLE `settings` ADD `strategy_engine_enabled` integer DEFAULT false;
--> statement-breakpoint
ALTER TABLE `settings` ADD `strategy_engine_mode` text DEFAULT 'OFF' NOT NULL;
--> statement-breakpoint
ALTER TABLE `settings` ADD `strategy_engine_active_ids_json` text DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `settings` ADD `strategy_engine_max_active` integer DEFAULT 25;
--> statement-breakpoint
ALTER TABLE `settings` ADD `strategy_engine_min_confidence` real DEFAULT 0.6;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `strategy_engine_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`strategy_name` text NOT NULL,
	`family` text NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`evidence_class` text NOT NULL,
	`side` text NOT NULL,
	`entry_met` integer NOT NULL,
	`confirmation_met` integer,
	`reasons_json` text NOT NULL,
	`price_at_signal` real NOT NULL,
	`timestamp` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_engine_signals_strategy` ON `strategy_engine_signals` (`strategy_id`,`timestamp`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_engine_signals_symbol` ON `strategy_engine_signals` (`symbol`,`timestamp`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `strategy_engine_backtest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`strategy_name` text NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`metrics_json` text NOT NULL,
	`dataset_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_engine_backtest_strategy` ON `strategy_engine_backtest_runs` (`strategy_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `strategy_engine_promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`evidence_ref_table` text,
	`evidence_ref_id` text,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_engine_promotions_strategy` ON `strategy_engine_promotions` (`strategy_id`,`created_at`);
