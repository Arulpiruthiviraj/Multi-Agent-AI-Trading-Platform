-- 05_risk_failures.sql
-- Risk assessments that were not approved. First failing gate is rejection_gate
-- (evaluation order, not catalog-file order).
-- CODE-VERIFIED: risk_assessments in schema.ts; persist-then-emit in RiskEngine.ts

SELECT
  r.created_at,
  r.trace_id,
  r.transaction_id,
  r.symbol,
  r.side,
  r.approved,
  r.max_quantity,
  r.rejection_gate,
  r.account_equity,
  r.buying_power,
  r.reasoning
FROM risk_assessments r
WHERE r.approved = 0
ORDER BY r.created_at DESC
LIMIT 100;
