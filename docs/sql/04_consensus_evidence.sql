-- 04_consensus_evidence.sql
-- Per-agent votes for a transaction. Replace ARG-YYYY-MM-DD-NNNNNN.
-- CODE-VERIFIED: consensus_evidence columns in schema.ts

SELECT
  e.id,
  e.transaction_id,
  e.source_trace_id,
  e.agent,
  e.side,
  e.confidence,
  e.weight,
  e.agreed,
  e.current_price,
  e.reasoning
FROM consensus_evidence e
WHERE e.transaction_id = 'ARG-YYYY-MM-DD-NNNNNN'
ORDER BY e.weight DESC, e.agent;
