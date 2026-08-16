# ARGUS_STRATEGY_VALIDATION_REPORT

Execution for promotion research: **NEXT_BAR_OPEN** (`argus-research-execution-v1`).  
`BacktestEngine` SAME_BAR_CLOSE is **not** mixed in.

| ID | Versioning | Status | REAL OOS | WFO | Robustness | Notes |
|---|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | spec 1.0.0 + config hash | UNTESTED | NOT ESTABLISHED | NOT ESTABLISHED | NOT ESTABLISHED | FEATURE_TRANSLATION vs VectorBT |
| PULLBACK_CONTINUATION | 1.0.0 + hash | UNTESTED | NOT ESTABLISHED | NOT ESTABLISHED | NOT ESTABLISHED | |
| MEAN_REVERSION | 1.0.0 + hash | UNTESTED | NOT ESTABLISHED | NOT ESTABLISHED | NOT ESTABLISHED | |
| TREND_FOLLOWING | 1.0.0 + hash | UNTESTED | NOT ESTABLISHED | NOT ESTABLISHED | NOT ESTABLISHED | |
| RANGE_REVERSION | 1.0.0 + hash | UNTESTED | NOT ESTABLISHED | NOT ESTABLISHED | NOT ESTABLISHED | |
| SMC_LIQUIDITY_SWEEP | experimental | UNVALIDATED | — | — | — | PROXY; live flag off |

Golden SMA: **UNIT_FIXTURE**, not a live strategy.  
Quarantined: `WALKFORWARD_CHECK_RESULTS.json` (SAME_BAR, cherry-picked).

**NO EDGE** has been demonstrated on REAL_MARKET_DATA NEXT_BAR_OPEN.
