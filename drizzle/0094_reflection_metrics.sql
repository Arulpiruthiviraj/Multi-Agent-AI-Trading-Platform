-- Post-market reflection metrics (2026-10-06, local-only, workstream I): per-session
-- outcome-audit scorecard for the discovery-filter / risk-rejection / pre-market
-- effectiveness audits in src/server/reflection/outcomeAudits.ts. One row per trading
-- date; written by callOutcomeAudits(), never by the trading path. Diagnostic only -
-- these numbers describe what happened, they never gate a trade or loosen a filter.
CREATE TABLE reflection_session_metrics (
  trading_date TEXT PRIMARY KEY,
  movers_total INTEGER,
  movers_seen INTEGER,
  focus_recall REAL,
  primary_data_readiness REAL,
  catalyst_coverage REAL,
  never_seen_rate REAL,
  discovery_filter_rate REAL,
  evaluation_rate REAL,
  valid_trigger_rate REAL,
  consensus_approval_rate REAL,
  primary_precision REAL,
  created_at TEXT NOT NULL
);
