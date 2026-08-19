-- 14_reconciliation_events.sql
-- One row per recon cycle. mismatches is JSON. Never auto-flatten (config).
-- CODE-VERIFIED: reconciliation_events, reconciliation_acknowledgements, portfolio_snapshots

SELECT
  id,
  checked_at,
  broker,
  matches,
  worst_impact_dollars,
  action_taken,
  SUBSTR(mismatches, 1, 400) AS mismatches_preview
FROM reconciliation_events
ORDER BY id DESC
LIMIT 50;

SELECT
  id,
  broker,
  broker_order_id,
  symbol,
  side,
  status,
  actor,
  fingerprint,
  acknowledged_at,
  revoked_at
FROM reconciliation_acknowledgements
ORDER BY id DESC
LIMIT 50;
