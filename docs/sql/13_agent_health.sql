-- 13_agent_health.sql
-- Persistent weight/win-rate stats. Live heartbeats (lastTickAt) are IN-MEMORY only
-- (pipelineAgentHealth.ts) — use GET /api/v1/system/pipeline-agents, not this table.
-- CODE-VERIFIED: agent_performance_stats; agent_confidence_calibration

SELECT
  agent_name,
  total_predictions,
  correct_predictions,
  win_rate,
  average_return,
  profit_factor,
  sharpe_ratio,
  current_weight,
  last_evaluated
FROM agent_performance_stats
ORDER BY agent_name;

SELECT
  agent_name,
  bucket_low,
  bucket_high,
  wins,
  losses,
  calibrated_confidence,
  last_evaluated
FROM agent_confidence_calibration
ORDER BY agent_name, bucket_low;
