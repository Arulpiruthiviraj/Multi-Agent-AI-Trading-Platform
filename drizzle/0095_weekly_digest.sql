-- Weekly reflection digest (2026-10-06, workstream K, local-only): persists the
-- multi-day blind-spot pattern rollup computed by src/server/reflection/weeklyDigest.ts.
-- A pattern enters the digest ONLY after recurring on >= 2 distinct trading days in the
-- week (configurable via the aggregator's minOccurrences) - a one-day anomaly is never
-- promoted to an architecture-level conclusion. Diagnostic only: nothing here feeds the
-- live trading pipeline. Additive table; no existing tables touched.
CREATE TABLE IF NOT EXISTS `weekly_reflection_digest` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `week_start` text NOT NULL,
  `pattern_key` text NOT NULL,
  `occurrences` integer NOT NULL,
  `symbols` text NOT NULL,
  `first_seen` text NOT NULL,
  `last_seen` text NOT NULL,
  `created_at` text NOT NULL,
  CONSTRAINT `weekly_reflection_digest_week_pattern_unique` UNIQUE(`week_start`, `pattern_key`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weekly_reflection_digest_week` ON `weekly_reflection_digest` (`week_start`);
