-- 09_closed_positions.sql
-- Closed round-trips are inferred from FILLED SELL trades with profit_loss, not a dedicated
-- closed-positions table. portfolio only holds current holdings.
-- CODE-VERIFIED: trades.profit_loss, trades.status, trades.side

SELECT
  id,
  symbol,
  side,
  quantity,
  price,
  status,
  timestamp,
  filled_at,
  profit_loss,
  execution_environment,
  transaction_id,
  trace_id,
  reasoning
FROM trades
WHERE status = 'FILLED'
  AND side = 'SELL'
ORDER BY COALESCE(filled_at, timestamp) DESC
LIMIT 100;
