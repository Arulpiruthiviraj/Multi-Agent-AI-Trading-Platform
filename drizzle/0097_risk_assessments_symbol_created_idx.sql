-- DEF-5 fix (2026-10-07): risk_assessments is append-only (never pruned) and three
-- observability reports (discoveryLineageReport, MissedOpportunityDetector,
-- consensusPipelineReport) query it by symbol + createdAt range - without this index those
-- are full table scans on a growing table. Additive only, never rewrites history.
CREATE INDEX `idx_risk_assessments_symbol_created` ON `risk_assessments` (`symbol`,`created_at`);
