-- Day-movers-vs-coverage reconciliation (2026-10-06, local-only, Part B workstream H):
-- per-symbol reconciliation of the EOD benchmark mover cohort against Argus's real
-- discovery/evaluation coverage for that trading date. Written by
-- src/server/reflection/dailyReflection.ts only - diagnostic, never read by the
-- trading spine, never emits TRADE_IDEA_GENERATED, never gates a trade.
-- primary_fate is exactly one of: ACTED_ON | APPROVED_NOT_EXECUTED |
-- CONSENSUS_REJECTED | RISK_REJECTED | STRATEGY_NO_SETUP | EVALUATED |
-- SUBSCRIBED_NOT_EVALUATED | DISCOVERED_FILTERED | DISCOVERED_NOT_PROMOTED |
-- NEVER_SEEN | INSUFFICIENT_EVIDENCE.
-- never_seen_cause is one of: UNIVERSE_COVERAGE | NEWS_SOURCE_COVERAGE |
-- MARKET_MOVER_SOURCE | RANK_CAP | DATA_UNAVAILABLE | SYMBOL_EXTRACTION |
-- PREMARKET_REFRESH_TIMING | OTHER | UNKNOWN (UNKNOWN is honest when no cause
-- has positive evidence - a cause is never invented).
CREATE TABLE mover_coverage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  eod_move_pct REAL,
  primary_fate TEXT NOT NULL,
  secondary_reasons TEXT NOT NULL DEFAULT '[]',
  never_seen_cause TEXT,
  reference_price REAL,
  outcome_windows TEXT,
  filter_reason TEXT,
  filter_premise_correct INTEGER,
  premarket_known_by TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_mover_coverage_date_symbol ON mover_coverage(trading_date, symbol);
--> statement-breakpoint
CREATE INDEX idx_mover_coverage_date ON mover_coverage(trading_date);
--> statement-breakpoint
CREATE INDEX idx_mover_coverage_fate ON mover_coverage(primary_fate);
