CREATE TABLE `quant_backtest_decision_log` (
	`id` text PRIMARY KEY NOT NULL,
	`backtest_run_id` text NOT NULL,
	`symbol` text NOT NULL,
	`timestamp` integer NOT NULL,
	`regime` text,
	`side` text NOT NULL,
	`setup_score` real,
	`confidence` real,
	`conditions_met` text,
	`conditions_failed` text,
	`contradictions` text,
	`sizing_quantity` integer,
	`sizing_gates` text,
	`outcome` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_quant_backtest_decision_log_run` ON `quant_backtest_decision_log` (`backtest_run_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_text` text NOT NULL,
	`weight` real DEFAULT 1,
	`created_at` integer DEFAULT 1786581797130
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
	`created_at` integer DEFAULT 1786581797129
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
	`created_at` integer DEFAULT 1786581797129,
	`trading_state` text DEFAULT 'TRADING_ENABLED' NOT NULL,
	`max_portfolio_drawdown_pct` real DEFAULT 0.15,
	`peak_equity` real,
	`max_open_positions` integer DEFAULT 10,
	`max_orders_per_minute` integer DEFAULT 5,
	`position_sizing_mode` text DEFAULT 'FIXED_DOLLAR' NOT NULL,
	`percent_of_equity_pct` real DEFAULT 2
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "trading_mode", "risk_level", "selected_broker", "selected_ai_provider", "budget", "strategy", "max_trade_size", "daily_loss_limit", "take_profit_pct", "trailing_stop_pct", "min_ai_confidence", "auto_bot_enabled", "adversarial_debate_mode", "onboarding_complete", "created_at", "trading_state", "max_portfolio_drawdown_pct", "peak_equity", "max_open_positions", "max_orders_per_minute", "position_sizing_mode", "percent_of_equity_pct") SELECT "id", "trading_mode", "risk_level", "selected_broker", "selected_ai_provider", "budget", "strategy", "max_trade_size", "daily_loss_limit", "take_profit_pct", "trailing_stop_pct", "min_ai_confidence", "auto_bot_enabled", "adversarial_debate_mode", "onboarding_complete", "created_at", "trading_state", "max_portfolio_drawdown_pct", "peak_equity", "max_open_positions", "max_orders_per_minute", "position_sizing_mode", "percent_of_equity_pct" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`created_at` integer DEFAULT 1786581797128
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "password_hash", "created_at") SELECT "id", "email", "password_hash", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;