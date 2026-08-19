-- 01_recent_trades.sql
-- Recent OMS trade rows (submission ledger). trades.id is the local order UUID.
-- CODE-VERIFIED columns: src/server/db/schema.ts trades

SELECT
  id,
  symbol,
  side,
  quantity,
  price,
  status,
  timestamp,
  submitted_at,
  accepted_at,
  filled_at,
  trace_id,
  transaction_id,
  broker_order_id,
  request_id,
  execution_environment,
  quant_strategy_id,
  profit_loss,
  reasoning
FROM trades
ORDER BY timestamp DESC
LIMIT 50;
