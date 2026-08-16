# ARGUS_FINAL_ADVERSARIAL_AUDIT

Assumption: Argus is unsafe until attacks fail closed.

| Attack | Expected | Status |
|---|---|---|
| Duplicate same traceId | Unique constraint / OMS skip | Covered by OMS tests |
| Autobot OFF new BUY | `autobot_enabled` / idea gate | Covered |
| Stale/missing price | `data_freshness` / `price_validity` | Covered |
| Missing broker equity | `invalid_account_equity` | Covered |
| Market clock failure with Alpaca keys | fail-closed closed | Covered |
| Emergency stop | `emergency_stop` | Covered |
| Reconciliation mismatch | pause → emergency_stop | Covered |
| UI placeOrder | no BrokerManager in App | File-scan |
| Python/VectorBT placeOrder | forbidden | File-scan / CLI |
| LLM placeOrder | no path | Architecture |
| Experimental SMC live without env | not in evaluateAll | Tested |
| LIVE without confirmation phrase | TradingEngine / setLiveMode reject | Covered |
| LIVE + paperMode true | OMS reject UNKNOWN env | **Added this increment** |
| Research promotion → LIVE | emptyEvidence / readiness engine NO-GO | Covered |
| Unapproved CORE as VALIDATED | UNTESTED without REAL data | Covered |

**Residual:** funded-account chaos (real Alpaca 500s, Gateway 2FA expiry) is not fully exercised in this environment. Treat as **UNAVAILABLE** for LIVE certification.

**Outcome: LIVE_NO_GO.** Attacks above must keep failing closed. Do not interpret this table as LIVE_READY.
