# ARGUS readiness (do not inflate)

Levels are **not** auto-promoted.

| Level | Meaning | Status (2026-08-19) |
|---|---|---|
| 1 BOOTS | Process can start | CONDITIONAL (operator must run it) |
| 2 PIPELINE RUNS | EventBus spine exists | CODE-VERIFIED |
| 3 SUPERVISED PAPER | Human watches recon / Autobot / RTH | CONDITIONAL GO if process up + paper keys; **not** unattended |
| 4 AUTONOMOUS PAPER | Unattended discovery→fill→sell soak | **NO-GO** |
| 5 LONG SOAK | Organic closed PAPER FILLED SELL P&L floors | **NO-GO** (organic P&L 0) |
| 6 LIVE | `evaluateLiveReadiness() === LIVE_READY` | **NO-GO** |

Machine LIVE gates: `GET /api/v2/live-readiness`. Do not treat new flags or markdown as LIVE_READY.
