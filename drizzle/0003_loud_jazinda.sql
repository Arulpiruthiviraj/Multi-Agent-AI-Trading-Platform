CREATE TABLE `backtest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`status` text NOT NULL,
	`symbols` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`timeframe` text NOT NULL,
	`initial_cash` real NOT NULL,
	`final_equity` real,
	`total_trades` integer DEFAULT 0,
	`win_rate` real,
	`profit_factor` real,
	`sharpe_ratio` real,
	`sortino_ratio` real,
	`max_drawdown_pct` real,
	`cagr` real,
	`expectancy` real,
	`error_message` text,
	`equity_curve` text,
	`trade_log` text
);
--> statement-breakpoint
CREATE TABLE `ohlcv_bars` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`timestamp` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real NOT NULL,
	`source` text DEFAULT 'alpaca' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ohlcv_symbol_tf_time` ON `ohlcv_bars` (`symbol`,`timeframe`,`timestamp`);
