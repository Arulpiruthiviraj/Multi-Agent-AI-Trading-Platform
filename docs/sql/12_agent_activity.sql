-- 12_agent_activity.sql
-- Recent idea-agent predictions (written by ReflectionEngine on TRADE_IDEA_GENERATED).
-- CODE-VERIFIED: ReflectionEngine.logPrediction -> agent_predictions

SELECT
  timestamp,
  agent_name,
  symbol,
  prediction,
  confidence,
  trace_id,
  provider,
  latency_ms,
  SUBSTR(reasoning, 1, 160) AS reasoning_preview
FROM agent_predictions
ORDER BY timestamp DESC
LIMIT 200;

SELECT
  agent_name,
  COUNT(*) AS ideas,
  AVG(confidence) AS avg_confidence,
  MAX(timestamp) AS last_idea_at
FROM agent_predictions
GROUP BY agent_name
ORDER BY last_idea_at DESC;
