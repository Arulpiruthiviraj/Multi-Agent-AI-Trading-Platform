-- 17_no_trade_reasons.sql
-- NO_TRADE / DESK_NO_TRADE style records.
-- Catalog of codes: config/noTradeReasons.json (not a table).
-- Persisted paths: trade_lifecycle_transitions.state/reason; consensus_decisions.reasoning
-- when approved=0; event_traces.event_type = 'DESK_NO_TRADE' (payload JSON).

SELECT
  created_at,
  candidate_id,
  symbol,
  state,
  reason,
  source
FROM trade_lifecycle_transitions
WHERE state LIKE '%NO_TRADE%'
   OR reason LIKE '%NO TRADE%'
   OR reason LIKE '%NO_TRADE%'
ORDER BY created_at DESC
LIMIT 100;

SELECT
  created_at,
  transaction_id,
  symbol,
  side,
  weighted_confidence,
  threshold,
  agreements_count,
  reasoning
FROM consensus_decisions
WHERE approved = 0
ORDER BY created_at DESC
LIMIT 50;

SELECT
  timestamp,
  correlation_id,
  transaction_id,
  source,
  SUBSTR(payload, 1, 400) AS payload_preview
FROM event_traces
WHERE event_type = 'DESK_NO_TRADE'
ORDER BY timestamp DESC
LIMIT 50;
