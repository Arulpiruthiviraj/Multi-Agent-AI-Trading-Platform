CREATE TABLE `agent_memory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_name` text NOT NULL,
	`decision` text NOT NULL,
	`reasoning` text,
	`confidence` real,
	`result` text
);
--> statement-breakpoint
CREATE TABLE `agent_performance_stats` (
	`agent_name` text PRIMARY KEY NOT NULL,
	`total_predictions` integer DEFAULT 0 NOT NULL,
	`correct_predictions` integer DEFAULT 0 NOT NULL,
	`win_rate` real DEFAULT 0 NOT NULL,
	`average_return` real DEFAULT 0 NOT NULL,
	`profit_factor` real DEFAULT 0 NOT NULL,
	`sharpe_ratio` real DEFAULT 0 NOT NULL,
	`current_weight` real DEFAULT 1 NOT NULL,
	`last_evaluated` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`symbol` text NOT NULL,
	`prediction` text NOT NULL,
	`confidence` real NOT NULL,
	`reasoning` text NOT NULL,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`predicted_ohlc` text,
	`market_structure` text,
	`momentum` text,
	`actual_result` text,
	`mae` real,
	`rmse` real,
	`mape` real,
	`directional_accuracy` real,
	`context_window` integer DEFAULT 8192,
	`max_output` integer DEFAULT 4096,
	`reasoning_support` integer DEFAULT false,
	`vision_support` integer DEFAULT false,
	`tool_calling` integer DEFAULT false,
	`structured_output` integer DEFAULT false,
	`streaming` integer DEFAULT true,
	`pricing_input` real DEFAULT 0,
	`pricing_output` real DEFAULT 0,
	`enabled` integer DEFAULT true
);
--> statement-breakpoint
CREATE TABLE `ai_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_name` text NOT NULL,
	`api_endpoint` text,
	`api_key_encrypted` text,
	`enabled` integer DEFAULT true,
	`priority` integer DEFAULT 1,
	`active` integer DEFAULT true,
	`health` text DEFAULT 'Healthy',
	`latency` real DEFAULT 0,
	`quota` real DEFAULT 0,
	`requests` integer DEFAULT 0,
	`tokens` integer DEFAULT 0,
	`input_tokens` integer DEFAULT 0,
	`output_tokens` integer DEFAULT 0,
	`cost` real DEFAULT 0,
	`success_rate` real DEFAULT 100,
	`last_failure` text,
	`last_success` text
);
--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`predicted_ohlc` text,
	`market_structure` text,
	`momentum` text,
	`actual_result` text,
	`mae` real,
	`rmse` real,
	`mape` real,
	`directional_accuracy` real,
	`agent` text,
	`prompt_tokens` integer DEFAULT 0,
	`completion_tokens` integer DEFAULT 0,
	`latency` real DEFAULT 0,
	`cost` real DEFAULT 0,
	`response_status` text,
	`retry_count` integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `broker_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broker_name` text NOT NULL,
	`api_key_encrypted` text,
	`secret_encrypted` text,
	`paper_mode` integer DEFAULT true,
	`status` text DEFAULT 'Disconnected'
);
--> statement-breakpoint
CREATE TABLE `event_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`correlation_id` text,
	`trade_id` text,
	`timestamp` integer NOT NULL,
	`source` text NOT NULL,
	`destination` text,
	`event_type` text NOT NULL,
	`payload` text,
	`duration_ms` integer,
	`success` integer DEFAULT true,
	`error_info` text
);
--> statement-breakpoint
CREATE TABLE `explainability_reports` (
	`trace_id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`decision` text NOT NULL,
	`report_text` text NOT NULL,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kronos_predictions` (
	`timeframe` text DEFAULT '1m',
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`prediction` text NOT NULL,
	`confidence` integer NOT NULL,
	`forecast_horizon` integer NOT NULL,
	`expected_move` text NOT NULL,
	`volatility` text NOT NULL,
	`support` real NOT NULL,
	`resistance` real NOT NULL,
	`model` text NOT NULL,
	`predicted_ohlc` text,
	`market_structure` text,
	`momentum` text,
	`actual_result` text,
	`mae` real,
	`rmse` real,
	`mape` real,
	`directional_accuracy` real,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `learned_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`cause` text NOT NULL,
	`rule` text NOT NULL,
	`confidence` real NOT NULL,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_text` text NOT NULL,
	`weight` real DEFAULT 1,
	`created_at` integer DEFAULT 1786151862645
);
--> statement-breakpoint
CREATE TABLE `news_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`url` text,
	`source` text NOT NULL,
	`author` text,
	`published_at` text NOT NULL,
	`cluster_id` text,
	`sentiment_score` real,
	`credibility_score` real,
	`relevance_score` real,
	`summary` text,
	`symbols` text
);
--> statement-breakpoint
CREATE TABLE `news_clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`event_type` text,
	`sentiment_score` real,
	`impact_score` real,
	`time_horizon` text,
	`is_archived` integer DEFAULT false,
	`symbols` text
);
--> statement-breakpoint
CREATE TABLE `news_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`api_key_encrypted` text,
	`enabled` integer DEFAULT true,
	`last_fetch` text,
	`health` text DEFAULT 'Healthy',
	`error_count` integer DEFAULT 0,
	`credibility_weight` real DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE `portfolio` (
	`symbol` text PRIMARY KEY NOT NULL,
	`quantity` real NOT NULL,
	`average_price` real NOT NULL,
	`current_price` real,
	`last_updated` text NOT NULL,
	`unrealized_pnl` real,
	`broker_source` text
);
--> statement-breakpoint
CREATE TABLE `prediction_engine_weights` (
	`id` text PRIMARY KEY NOT NULL,
	`win_rate` real DEFAULT 0,
	`accuracy` real DEFAULT 0,
	`average_prediction_error` real DEFAULT 0,
	`precision` real DEFAULT 0,
	`recall` real DEFAULT 0,
	`roi` real DEFAULT 0,
	`sharpe_contribution` real DEFAULT 0,
	`drawdown_contribution` real DEFAULT 0,
	`last_updated` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
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
	`created_at` integer DEFAULT 1786151862644
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real NOT NULL,
	`status` text NOT NULL,
	`timestamp` text NOT NULL,
	`reasoning` text,
	`trace_id` text,
	`profit_loss` real,
	`news_used` integer DEFAULT false,
	`news_sentiment` real,
	`news_confidence` real,
	`news_sources` text,
	`news_reasoning` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_token` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_trading_summary` (
	`date` text PRIMARY KEY NOT NULL,
	`total_trades` integer DEFAULT 0 NOT NULL,
	`total_volume` real DEFAULT 0 NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`unrealized_pnl` real DEFAULT 0 NOT NULL,
	`allocated_amount` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`created_at` integer DEFAULT 1786151862643
);
