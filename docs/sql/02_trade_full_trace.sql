-- 02_trade_full_trace.sql
-- Reconstruct one trade. Bind :trade_id (trades.id UUID) or edit the literals.
-- APPLICATION-LEVEL JOINS — no SQL FKs.
-- CODE-VERIFIED columns: schema.ts trades, fills, risk_assessments, risk_gate_results,
-- consensus_decisions, consensus_evidence, transactions, event_traces

-- Usage: replace 'TRADE_UUID_HERE' before running, or:
--   sqlite3 data/argus.db ".param set :trade_id 'YOUR-UUID'" < docs/sql/02_trade_full_trace.sql

SELECT 'TRADE' AS section, t.id, t.symbol, t.side, t.status, t.quantity, t.price,
       t.trace_id, t.transaction_id, t.broker_order_id, t.execution_environment, t.profit_loss
FROM trades t
WHERE t.id = 'TRADE_UUID_HERE';

SELECT 'FILLS' AS section, f.id, f.order_id, f.broker_fill_id, f.quantity, f.price,
       f.filled_at, f.cumulative_quantity
FROM fills f
WHERE f.order_id = 'TRADE_UUID_HERE'
ORDER BY f.id;

SELECT 'TRANSACTION' AS section, x.*
FROM transactions x
JOIN trades t ON t.transaction_id = x.id
WHERE t.id = 'TRADE_UUID_HERE';

SELECT 'CONSENSUS' AS section, c.*
FROM consensus_decisions c
JOIN trades t ON t.transaction_id = c.transaction_id
WHERE t.id = 'TRADE_UUID_HERE';

SELECT 'EVIDENCE' AS section, e.*
FROM consensus_evidence e
JOIN trades t ON t.transaction_id = e.transaction_id
WHERE t.id = 'TRADE_UUID_HERE'
ORDER BY e.agent;

SELECT 'RISK' AS section, r.*
FROM risk_assessments r
JOIN trades t ON t.trace_id = r.trace_id
WHERE t.id = 'TRADE_UUID_HERE';

SELECT 'GATES' AS section, g.sequence, g.gate_name, g.passed, g.detail
FROM risk_gate_results g
JOIN trades t ON t.trace_id = g.trace_id
WHERE t.id = 'TRADE_UUID_HERE'
ORDER BY g.sequence;

SELECT 'EVENTS' AS section, et.event_type, et.timestamp, et.correlation_id, et.transaction_id, et.source
FROM event_traces et
JOIN trades t ON et.correlation_id = t.trace_id OR et.transaction_id = t.transaction_id
WHERE t.id = 'TRADE_UUID_HERE'
ORDER BY et.timestamp;
