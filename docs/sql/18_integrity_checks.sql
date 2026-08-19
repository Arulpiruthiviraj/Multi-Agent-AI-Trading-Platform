-- 18_integrity_checks.sql
-- Read-only integrity probes. No SQL FKs exist — orphans are application-level.
-- CODE-VERIFIED against schema.ts unique indexes and comment-FKs.

-- Fills whose order_id is not in trades
SELECT 'fills_without_trades' AS check_name, f.id, f.order_id
FROM fills f
LEFT JOIN trades t ON t.id = f.order_id
WHERE t.id IS NULL;

-- Trades with a transaction_id that is missing from transactions
SELECT 'trades_without_transaction' AS check_name, t.id, t.transaction_id, t.symbol, t.status
FROM trades t
LEFT JOIN transactions x ON x.id = t.transaction_id
WHERE t.transaction_id IS NOT NULL AND x.id IS NULL;

-- Risk assessments without any gate rows
SELECT 'risk_without_gates' AS check_name, r.trace_id, r.symbol, r.approved
FROM risk_assessments r
LEFT JOIN risk_gate_results g ON g.trace_id = r.trace_id
WHERE g.id IS NULL;

-- Approved consensus with no risk assessment on the same transaction_id
SELECT 'approved_consensus_without_risk_txn' AS check_name, c.transaction_id, c.symbol, c.created_at
FROM consensus_decisions c
LEFT JOIN risk_assessments r ON r.transaction_id = c.transaction_id
WHERE c.approved = 1 AND r.trace_id IS NULL;

-- FILLED trades with no fill rows
SELECT 'filled_trades_without_fills' AS check_name, t.id, t.symbol, t.status, t.broker_order_id
FROM trades t
LEFT JOIN fills f ON f.order_id = t.id
WHERE t.status = 'FILLED' AND f.id IS NULL;

-- Duplicate fill watermarks (unique index should prevent this)
SELECT 'duplicate_fill_watermarks' AS check_name, order_id, cumulative_quantity, COUNT(*) AS n
FROM fills
WHERE cumulative_quantity IS NOT NULL
GROUP BY order_id, cumulative_quantity
HAVING COUNT(*) > 1;

-- Duplicate trades per trace_id (unique index idx_trades_trace_id_unique; NULLs are distinct)
SELECT 'duplicate_trace_id_trades' AS check_name, trace_id, COUNT(*) AS n
FROM trades
WHERE trace_id IS NOT NULL
GROUP BY trace_id
HAVING COUNT(*) > 1;

-- Gate rows with no parent assessment
SELECT 'orphan_gate_results' AS check_name, g.id, g.trace_id, g.gate_name
FROM risk_gate_results g
LEFT JOIN risk_assessments r ON r.trace_id = g.trace_id
WHERE r.trace_id IS NULL
LIMIT 50;

-- Timestamp sanity: filled_at before submitted_at
SELECT 'fill_before_submit' AS check_name, id, symbol, submitted_at, filled_at
FROM trades
WHERE submitted_at IS NOT NULL
  AND filled_at IS NOT NULL
  AND filled_at < submitted_at;
