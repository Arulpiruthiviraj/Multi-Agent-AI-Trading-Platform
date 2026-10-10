-- 2026-10-09 (certification mission item 1 - OCT9_PIT_PROVENANCE_ESCAPE): per-Quant-decision
-- point-in-time replay provenance. One row per Quant assessment decision; stores the decision
-- INPUTS (bar evidence + available-at timestamps, quote/bid/ask + observation timestamps, the
-- bounded+redacted StrategyContext, regime, strategy versions, config version, build SHA,
-- lifecycle states at decision time) and the OUTPUT (strategyEvaluations + sha256 fingerprint).
-- Additive only, never rewrites history. Bounded by byte caps + per-decision row cap in code and
-- pruned by sweepDecisionProvenanceRetention (RETENTION_SWEEPERS).
CREATE TABLE `decision_provenance` (
  `id` text PRIMARY KEY NOT NULL,
  `decision_id` text NOT NULL,
  `symbol` text NOT NULL,
  `timeframe` text NOT NULL,
  `decision_time_ms` integer NOT NULL,
  `bar_evidence_json` text,
  `quote_json` text,
  `bid_ask_json` text,
  `current_price` real,
  `price_observed_at_ms` integer,
  `strategy_context_json` text,
  `context_truncated` integer DEFAULT false NOT NULL,
  `regime` text,
  `strategy_versions_json` text,
  `config_version` text,
  `build_sha` text,
  `lifecycle_states_json` text,
  `strategy_id` text,
  `evaluations_json` text,
  `evaluation_fingerprint` text,
  `data_source` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_decision_provenance_decision` ON `decision_provenance` (`decision_id`);
--> statement-breakpoint
CREATE INDEX `idx_decision_provenance_symbol` ON `decision_provenance` (`symbol`, `decision_time_ms`);
