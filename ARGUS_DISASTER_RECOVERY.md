# ARGUS_DISASTER_RECOVERY

**Not LIVE-certified.** Capabilities that exist vs what is unproven.

## Exists

- SQLite WAL; `GET /api/v2/system/export-db` / import (restart after import).
- Keep `data/.encryption_key` or encrypted keys are lost.
- OMS: unique traceId; crash recovery for PENDING without broker id; inbound unmatched = EXTERNAL_MANUAL.
- Reconciliation mismatch can pause trading (`emergency_stop`).
- Market-data worker reconnect; stale ticks fail RiskEngine `data_freshness`.

## After crash

1. Do not enable Autobot.
2. Integrity-check SQLite (`PRAGMA integrity_check` on the app connection).
3. Run reconciliation.
4. Inspect open broker orders vs `trades`.
5. Resume only if environments agree (PAPER vs PAPER).

## Unproven for LIVE

- Multi-region failover, hot standby, point-in-time restore SLA, broker outage playbook rehearsal against a funded account.
