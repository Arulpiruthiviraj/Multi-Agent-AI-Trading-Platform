-- 07_orders_and_fills.sql
-- OMS trades joined to fill ledger. fills.order_id = trades.id (APPLICATION-LEVEL).
-- Unique (order_id, cumulative_quantity) prevents duplicate fill watermarks (P0.4).

SELECT
  t.id AS trade_id,
  t.symbol,
  t.side,
  t.status,
  t.quantity AS order_qty,
  t.price AS order_price,
  t.broker_order_id,
  t.execution_environment,
  t.filled_at,
  f.id AS fill_row_id,
  f.broker_fill_id,
  f.quantity AS fill_qty,
  f.price AS fill_price,
  f.filled_at AS fill_at,
  f.cumulative_quantity
FROM trades t
LEFT JOIN fills f ON f.order_id = t.id
ORDER BY t.timestamp DESC
LIMIT 100;
