-- 06_risk_gate_summary.sql
-- Per-gate pass/fail counts from persisted evaluations (not from riskGateOrder.json).
-- CODE-VERIFIED: risk_gate_results.passed is integer boolean.

SELECT
  gate_name,
  COUNT(*) AS evaluations,
  SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed,
  SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS failed
FROM risk_gate_results
GROUP BY gate_name
ORDER BY MIN(sequence), gate_name;
