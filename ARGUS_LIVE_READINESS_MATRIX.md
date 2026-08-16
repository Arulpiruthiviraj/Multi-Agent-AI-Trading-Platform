# ARGUS_LIVE_READINESS_MATRIX

Source: `evaluateLiveReadiness()` (`GET /api/v2/live-readiness`).

Overall: **LIVE_NO_GO**

| Category | Gate | Verdict |
|---|---|---|
| SOFTWARE | Order path single OMS | PASS (structure) |
| SOFTWARE | CI in-process (`evaluateLiveReadiness` does not run tsc/vitest) | UNAVAILABLE |
| EXECUTION | OMS | PASS (structure) |
| RISK | 24 gates present | PASS (structure) |
| MARKET DATA | Runtime health certificate | UNAVAILABLE |
| RESEARCH | GREEN warehouse | UNAVAILABLE |
| RESEARCH | Zero-cost promotion | FAIL |
| STRATEGY | CORE | FAIL (UNTESTED) |
| STRATEGY | SMC | FAIL (UNVALIDATED) |
| OOS | REAL NEXT_BAR | FAIL |
| WFO | CORE NEXT_BAR | FAIL |
| ROBUSTNESS | CORE real data | FAIL |
| STATISTICS | Sample | UNAVAILABLE |
| PAPER | Organic | FAIL |
| BROKER | Live confirm + mode | FAIL |
| RECONCILIATION | Standing certificate | UNAVAILABLE |
| SECURITY | Production cert | UNAVAILABLE |
| OBSERVABILITY | | UNAVAILABLE |
| RECOVERY | | UNAVAILABLE |
| OPERATIONS | | UNAVAILABLE |
| LEGAL | Canadian | BLOCKED |
| MANUAL APPROVAL | | FAIL |

PASS in SOFTWARE/RISK/EXECUTION means **the control exists**, not that LIVE is allowed.

Trading edge: **8**. Organic paper: **NOT_ESTABLISHED**. QUANT default: **OFF**.
