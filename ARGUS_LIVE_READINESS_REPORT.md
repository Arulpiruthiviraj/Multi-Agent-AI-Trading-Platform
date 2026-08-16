# ARGUS_LIVE_READINESS_REPORT

**Result: LIVE_NO_GO**

Source: `evaluateLiveReadiness()` / `GET /api/v2/live-readiness`.

LIVE still requires independent: operator phrase `ENABLE LIVE TRADING`, broker PAPER vs LIVE agreement (UNKNOWN fail-closed at OMS), real equity, clock, freshness (now UNKNOWN fail), promotion evidence, Canadian routing, manual approval.

Research status **cannot** switch LIVE. Env flags **cannot** switch LIVE.

| Mandatory area | Verdict |
|---|---|
| CORE / OOS / WFO / robustness / paper | FAIL |
| Warehouse GREEN | UNAVAILABLE |
| Zero-cost research | FAIL |
| Canadian | BLOCKED |
| Manual approval | FAIL |
| Software tests inside process | UNAVAILABLE (CI is separate) |

Software tests **1018/1018** are **not** LIVE_READY.
