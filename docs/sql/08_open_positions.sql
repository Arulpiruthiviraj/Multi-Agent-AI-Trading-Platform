-- 08_open_positions.sql
-- Local portfolio table is current-state, recon-hydrated (not OMS-inserted).
-- CODE-VERIFIED: schema.ts portfolio; PortfolioReconciliation writes this table.

SELECT
  symbol,
  quantity,
  average_price,
  current_price,
  unrealized_pnl,
  broker_source,
  currency,
  last_updated
FROM portfolio
WHERE quantity IS NOT NULL
  AND quantity != 0
ORDER BY symbol;
