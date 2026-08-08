PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_text` text NOT NULL,
	`weight` real DEFAULT 1,
	`created_at` integer DEFAULT 1786153897643
);
--> statement-breakpoint
INSERT INTO `__new_memory_rules`("id", "rule_text", "weight", "created_at") SELECT "id", "rule_text", "weight", "created_at" FROM `memory_rules`;--> statement-breakpoint
DROP TABLE `memory_rules`;--> statement-breakpoint
ALTER TABLE `__new_memory_rules` RENAME TO `memory_rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
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
	`created_at` integer DEFAULT 1786153897641
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "trading_mode", "risk_level", "selected_broker", "selected_ai_provider", "budget", "strategy", "max_trade_size", "daily_loss_limit", "take_profit_pct", "trailing_stop_pct", "min_ai_confidence", "auto_bot_enabled", "adversarial_debate_mode", "created_at") SELECT "id", "trading_mode", "risk_level", "selected_broker", "selected_ai_provider", "budget", "strategy", "max_trade_size", "daily_loss_limit", "take_profit_pct", "trailing_stop_pct", "min_ai_confidence", "auto_bot_enabled", "adversarial_debate_mode", "created_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`created_at` integer DEFAULT 1786153897639
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "password_hash", "created_at") SELECT "id", "email", "password_hash", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `provider_id` text;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `capabilities` text;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `priority` integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `latency_score` real DEFAULT 0;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `error_rate` real DEFAULT 0;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `token_usage` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `estimated_cost` real DEFAULT 0;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `last_used_at` text;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `last_health_check` text;--> statement-breakpoint
ALTER TABLE `ai_providers` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `ai_providers` ADD `created_at` text;--> statement-breakpoint
ALTER TABLE `ai_providers` ADD `updated_at` text;