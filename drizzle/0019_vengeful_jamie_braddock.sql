CREATE TABLE `quant_strategy_backtests` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`initial_cash` real,
	`final_equity` real,
	`total_trades` integer,
	`win_rate_pct` real,
	`profit_factor` real,
	`sharpe` real,
	`sortino` real,
	`max_drawdown_pct` real,
	`expectancy` real,
	`avg_win_r` real,
	`avg_loss_r` real,
	`avg_r` real,
	`max_consecutive_losses` integer,
	`regime_breakdown` text,
	`expected_value` text,
	`kelly` text,
	`trade_log` text,
	`equity_curve` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_quant_strategy_backtests_strategy_symbol` ON `quant_strategy_backtests` (`strategy_id`,`symbol`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_text` text NOT NULL,
	`weight` real DEFAULT 1,
	`created_at` integer DEFAULT 1786532749392
);
--> statement-breakpoint
INSERT INTO `__new_memory_rules`("id", "rule_text", "weight", "created_at") SELECT "id", "rule_text", "weight", "created_at" FROM `memory_rules`;--> statement-breakpoint
DROP TABLE `memory_rules`;--> statement-breakpoint
ALTER TABLE `__new_memory_rules` RENAME TO `memory_rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`session_token` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`created_at` integer DEFAULT 1786532749379
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("session_token", "username", "expires_at", "last_seen", "created_at") SELECT "session_token", "username", "expires_at", "last_seen", "created_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trading_mode` text DEFAULT 'Paper' NOT NULL,
	`risk_level` text DEFAULT 'Balanced' NOT NULL,
	`selected_broker` text,
	`selected_ai_provider` text,
	`budget` real DEFAULT 50000,
	`strategy` text DEFAULT 'Momentum Focus',
	`max_trade_size` real DEFAULT 3000,
	`daily_loss_limit` real DEFAULT 5000,
	`take_profit_pct` real DEFAULT 15,
	`trailing_stop_pct` real DEFAULT 5,
	`min_ai_confidence` real DEFAULT 75,
	`auto_bot_enabled` integer DEFAULT false,
	`adversarial_debate_mode` integer DEFAULT true,
	`onboarding_complete` integer DEFAULT false,
	`created_at` integer DEFAULT 1786532749379,
	`trading_state` text DEFAULT 'TRADING_ENABLED' NOT NULL,
	`max_portfolio_drawdown_pct` real DEFAULT 0.15,
	`peak_equity` real,
	`max_open_positions` integer DEFAULT 10,
	`max_orders_per_minute` integer DEFAULT 5
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "trading_mode", "risk_level", "selected_broker", "selected_ai_provider", "budget", "strategy", "max_trade_size", "daily_loss_limit", "take_profit_pct", "trailing_stop_pct", "min_ai_confidence", "auto_bot_enabled", "adversarial_debate_mode", "onboarding_complete", "created_at", "trading_state", "max_portfolio_drawdown_pct", "peak_equity", "max_open_positions", "max_orders_per_minute") SELECT "id", "trading_mode", "risk_level", "selected_broker", "selected_ai_provider", "budget", "strategy", "max_trade_size", "daily_loss_limit", "take_profit_pct", "trailing_stop_pct", "min_ai_confidence", "auto_bot_enabled", "adversarial_debate_mode", "onboarding_complete", "created_at", "trading_state", "max_portfolio_drawdown_pct", "peak_equity", "max_open_positions", "max_orders_per_minute" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`created_at` integer DEFAULT 1786532749379
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "password_hash", "created_at") SELECT "id", "email", "password_hash", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;