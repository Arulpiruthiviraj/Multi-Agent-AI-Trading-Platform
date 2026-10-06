-- Pre-market focus engine (2026-10-06, local-only): revision snapshots + bounded
-- pre-open data reservations. Both tables are diagnostic/capacity-management only;
-- neither emits trade ideas nor bypasses ChiefTrader / RiskEngine / OMS.
CREATE TABLE trade_plan_revisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  original_plan_id TEXT NOT NULL,
  plan_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  refresh_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  delta_summary_json TEXT,
  reason_for_refresh TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_trade_plan_revisions_plan ON trade_plan_revisions(plan_id, refresh_version);
--> statement-breakpoint
CREATE INDEX idx_trade_plan_revisions_symbol_date ON trade_plan_revisions(symbol, plan_date);
--> statement-breakpoint
CREATE TABLE premarket_data_reservations (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  plan_id TEXT,
  tier TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  release_condition TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  released_at TEXT,
  release_reason TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_premarket_reservations_status ON premarket_data_reservations(status, expires_at);
--> statement-breakpoint
CREATE INDEX idx_premarket_reservations_symbol ON premarket_data_reservations(symbol, status);
