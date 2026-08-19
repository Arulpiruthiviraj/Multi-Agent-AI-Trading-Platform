-- 16_duplicate_evidence.sql
-- After coalesceEvidenceByAgent, a transaction should have at most one row per agent.
-- Rows here indicate a persistence bug or a pre-coalesce dump.
-- CODE-VERIFIED: consensus_evidence.agent + transaction_id

SELECT
  transaction_id,
  agent,
  COUNT(*) AS rows_for_agent,
  GROUP_CONCAT(side) AS sides,
  GROUP_CONCAT(id) AS evidence_ids
FROM consensus_evidence
GROUP BY transaction_id, agent
HAVING COUNT(*) > 1
ORDER BY rows_for_agent DESC, transaction_id;
