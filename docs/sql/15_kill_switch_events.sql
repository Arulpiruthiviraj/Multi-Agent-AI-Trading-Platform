-- 15_kill_switch_events.sql
-- Kill-switch / trading-state transitions. Actor is username or 'system'.
-- CODE-VERIFIED: kill_switch_events in schema.ts

SELECT
  id,
  created_at,
  from_state,
  to_state,
  actor,
  reason,
  cancelled_order_ids
FROM kill_switch_events
ORDER BY id DESC
LIMIT 50;
