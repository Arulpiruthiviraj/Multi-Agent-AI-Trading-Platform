-- 10_realized_pnl.sql
-- Realized P&L from FILLED SELL trades. Also show daily_trading_summary if populated.
-- CODE-VERIFIED: trades.profit_loss; daily_trading_summary.realized_pnl
-- UNVERIFIED whether daily_trading_summary is always kept in sync with trades — inspect both.

SELECT
  symbol,
  COUNT(*) AS filled_sells,
  SUM(CASE WHEN profit_loss IS NOT NULL THEN profit_loss ELSE 0 END) AS sum_profit_loss,
  SUM(CASE WHEN profit_loss IS NULL THEN 1 ELSE 0 END) AS sells_missing_pnl
FROM trades
WHERE status = 'FILLED'
  AND side = 'SELL'
GROUP BY symbol
ORDER BY sum_profit_loss DESC;

SELECT
  date,
  total_trades,
  total_volume,
  realized_pnl,
  unrealized_pnl,
  allocated_amount,
  updated_at
FROM daily_trading_summary
ORDER BY date DESC
LIMIT 30;
