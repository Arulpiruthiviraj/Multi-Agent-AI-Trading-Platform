-- Pre-market focus engine (2026-10-06, local-only): the ~09:15 focus report.
-- One row per trading date per refresh version. Tiers mean "deserves attention",
-- never "actionable": this table never emits trade ideas.
CREATE TABLE premarket_focus_reports (
  id TEXT PRIMARY KEY,
  plan_date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  refresh_version INTEGER NOT NULL,
  primary_json TEXT NOT NULL,
  secondary_json TEXT NOT NULL,
  watch_json TEXT NOT NULL,
  rejected_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  metrics_json TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_premarket_focus_reports_date_version ON premarket_focus_reports(plan_date, refresh_version);
