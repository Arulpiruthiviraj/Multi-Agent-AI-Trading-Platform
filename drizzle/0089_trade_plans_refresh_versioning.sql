-- Pre-market focus engine (2026-10-06, local-only): trade_plans refresh versioning.
-- Additive/nullable columns so existing rows read as version 1 (the 04:00 original),
-- never a fabricated retroactive refresh history.
ALTER TABLE trade_plans ADD COLUMN refresh_version INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE trade_plans ADD COLUMN refreshed_at TEXT;
--> statement-breakpoint
ALTER TABLE trade_plans ADD COLUMN reason_for_refresh TEXT;
--> statement-breakpoint
ALTER TABLE trade_plans ADD COLUMN original_created_at TEXT;
--> statement-breakpoint
ALTER TABLE trade_plans ADD COLUMN score_decomposition_json TEXT;
