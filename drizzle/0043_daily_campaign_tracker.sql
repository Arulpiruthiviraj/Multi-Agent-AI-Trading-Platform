ALTER TABLE `settings` ADD `campaign_enabled` integer DEFAULT false;
--> statement-breakpoint
ALTER TABLE `settings` ADD `daily_target_amount` real DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `settings` ADD `daily_target_type` text DEFAULT 'DOLLAR' NOT NULL;
--> statement-breakpoint
ALTER TABLE `settings` ADD `target_achieved_action` text DEFAULT 'CONTINUE' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `daily_strategy_performance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trading_date` text NOT NULL,
	`quant_strategy_id` text NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`unrealized_pnl` real DEFAULT 0 NOT NULL,
	`trades_count` integer DEFAULT 0 NOT NULL,
	`wins_count` integer DEFAULT 0 NOT NULL,
	`losses_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_daily_strategy_performance_date_strategy` ON `daily_strategy_performance` (`trading_date`,`quant_strategy_id`);
