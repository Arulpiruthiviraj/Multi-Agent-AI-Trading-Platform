-- 2026-10-13: consensus_evidence was looked up by transaction_id (decision drill-down / provenance / execution-quality) with a
-- full table SCAN (306k rows, 13-14 s per lookup observed as SLOW_SQL_STATEMENT in the repaired build's first hour). Additive index.
CREATE INDEX IF NOT EXISTS `idx_consensus_evidence_transaction_id` ON `consensus_evidence` (`transaction_id`);
