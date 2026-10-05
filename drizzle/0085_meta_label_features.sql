CREATE TABLE IF NOT EXISTS meta_label_features (
  id TEXT PRIMARY KEY,
  trace_id TEXT,
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  signal_score REAL,
  signal_confidence REAL,
  regime TEXT,
  decision_price REAL,
  bar_count INTEGER,
  conditions_met TEXT,
  conditions_failed TEXT,
  feature_timestamp TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  evidence_source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_meta_label_features_strategy_source ON meta_label_features (strategy_id, evidence_source);
