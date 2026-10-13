-- 2026-10-13 (Oct 13 audit: 97% of post-open Quant evaluations hit the 8 s intraday deadline and the
-- time was never attributable). Append-only per-request telemetry for historical-bar requests (cache,
-- coalescing, IBKR queue wait vs provider service time, Alpaca pacing vs service time, terminal status) plus a
-- bounded availability registry keyed by symbol/provider/timeframe/session. Written asynchronously in small
-- batches (INSERT/UPSERT only; no scans) and pruned by the retention sweeper. Additive; no existing table changes.
CREATE TABLE `historical_request_telemetry` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `request_id` text NOT NULL,
  `trace_id` text,
  `symbol` text NOT NULL,
  `provider` text NOT NULL,
  `timeframe` text NOT NULL,
  `window_start_ms` integer NOT NULL,
  `window_end_ms` integer NOT NULL,
  `as_of_ms` integer NOT NULL,
  `role` text NOT NULL,
  `cache_hit` integer DEFAULT false NOT NULL,
  `cache_bar_count` integer,
  `cache_latest_bar_ms` integer,
  `cache_coverage` real,
  `ibkr_queue_wait_ms` real,
  `ibkr_service_ms` real,
  `alpaca_queue_wait_ms` real,
  `alpaca_service_ms` real,
  `coalesce_wait_ms` real,
  `cache_normalization_ms` real,
  `total_ms` real NOT NULL,
  `bars_returned` integer,
  `valid_bars` integer,
  `terminal_status` text NOT NULL,
  `reason` text,
  `fell_back` integer DEFAULT false NOT NULL,
  `process_epoch` text,
  `build_sha` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hist_req_telemetry_created` ON `historical_request_telemetry` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_hist_req_telemetry_symbol` ON `historical_request_telemetry` (`symbol`,`created_at`);
--> statement-breakpoint
CREATE TABLE `intraday_data_availability` (
  `symbol` text NOT NULL,
  `provider` text NOT NULL,
  `timeframe` text NOT NULL,
  `session_date` text NOT NULL,
  `status` text NOT NULL,
  `last_bar_ms` integer,
  `bar_count` integer,
  `expected_bar_count` integer,
  `coverage` real,
  `last_checked_ms` integer NOT NULL,
  `last_success_ms` integer,
  `last_failure_ms` integer,
  `consecutive_failures` integer DEFAULT 0 NOT NULL,
  `last_reason` text,
  `last_request_total_ms` real,
  `build_sha` text,
  `updated_at` text NOT NULL,
  PRIMARY KEY(`symbol`, `provider`, `timeframe`, `session_date`)
);
--> statement-breakpoint
CREATE INDEX `idx_intraday_availability_updated` ON `intraday_data_availability` (`updated_at`);
