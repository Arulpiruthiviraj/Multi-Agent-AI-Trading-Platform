# ARGUS blocker register (living)

Status is code-verified as of 2026-08-16. Do not treat this file as LIVE_READY.

| ID | Sev | Category | Status | Evidence |
|---|---|---|---|---|
| B-SAMEBAR-PROMO | P0 | Research / promotion | **FIXED this session** | SAME_BAR results cannot set lifecycle past UNTESTED; API stamps `promotable:false` |
| B-INGEST-PARTIAL | P0 | Research warehouse | **FIXED this session** | Incomplete Alpaca fetch → RED / FETCH_* / UNKNOWN provenance |
| B-WAREHOUSE-GREEN | P1 | Research | OPEN / EXTERNAL | No GREEN parquet on disk in this environment |
| B-ORGANIC-PAPER | P1 | Paper | OPEN / EXTERNAL | 0 qualifying closed organic paper trades |
| B-OOS-WFO-ROBUST | P1 | Strategy validation | OPEN / EXTERNAL | CORE still UNTESTED |
| B-CA-LIVE | P0 | Compliance | BLOCKED | Canadian automated live routing not available |
| B-LIVE-HUMAN | P0 | Safety | OPEN (by design) | LIVE requires human confirmation phrase; this mission must not enable LIVE |
| B-IBKR-2FA | P1 | Broker | OPEN | Manual reauth |
| B-QUESTRADE-PLACE | P1 | Broker | BLOCKED | placeOrder throws |
| B-COINBASE-PAPER | P1 | Broker | BLOCKED | paper placeOrder refuses |
| B-AI-CALIBRATION | P2 | AI | OPEN | LLM confidence is not P(win) |
| B-SPA-TESTS | P2 | QA | OPEN | App.tsx almost untested |
| B-SOAK | P1 | Operations | OPEN | 30-day unattended UNAVAILABLE |
