-- 11_unresolved_ideas.sql
-- Ideas that never became an approved order.
-- 1) agent_predictions with no matching consensus_evidence.source_trace_id
-- 2) consensus_decisions approved=0
-- 3) transactions still OPEN / NO_CONSENSUS / RISK_REJECTED
-- CODE-VERIFIED tables. MARKET_DATA ticks are NOT in SQLite (EventStore NO_PERSIST).

SELECT
  p.timestamp,
  p.id AS prediction_id,
  p.agent_name,
  p.symbol,
  p.prediction,
  p.confidence,
  p.trace_id,
  e.transaction_id AS evidence_txn
FROM agent_predictions p
LEFT JOIN consensus_evidence e ON e.source_trace_id = p.trace_id
WHERE e.id IS NULL
ORDER BY p.timestamp DESC
LIMIT 100;

SELECT id, symbol, status, final_decision, outcome, opened_at
FROM transactions
WHERE status IN ('OPEN', 'NO_CONSENSUS', 'RISK_REJECTED', 'ORDER_REJECTED')
ORDER BY opened_at DESC
LIMIT 100;
