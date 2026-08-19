-- 03_failed_consensus.sql
-- Consensus evaluations that did not approve (NO_CONSENSUS / approved=0).
-- CODE-VERIFIED: consensus_decisions.approved is integer boolean; transactions.status includes NO_CONSENSUS.

SELECT
  c.created_at,
  c.transaction_id,
  c.symbol,
  c.side,
  c.weighted_confidence,
  c.threshold,
  c.approved,
  c.agreements_count,
  c.disagreements_count,
  c.debate_used,
  c.debate_provider_count,
  c.reasoning,
  x.status AS transaction_status,
  x.final_decision,
  x.outcome
FROM consensus_decisions c
LEFT JOIN transactions x ON x.id = c.transaction_id
WHERE c.approved = 0
   OR x.status = 'NO_CONSENSUS'
ORDER BY c.created_at DESC
LIMIT 100;
