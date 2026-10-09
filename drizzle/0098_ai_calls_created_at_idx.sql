-- 2026-10-08 defect hunt (P2-R3): ai_calls is append-only (one row per AI call, full
-- prompt + raw_response + parsed_response text) and three readers filter
-- WHERE createdAt >= ? / ORDER BY createdAt DESC (tradingSessionReport,
-- providerHealthMatrix, queryTraces) - without this index those are full table scans
-- over a monotonically growing table of large text rows. Additive only, never rewrites history.
CREATE INDEX `idx_ai_calls_created_at` ON `ai_calls` (`created_at`);
