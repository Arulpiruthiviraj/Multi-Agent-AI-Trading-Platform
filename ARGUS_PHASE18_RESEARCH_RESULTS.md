# ARGUS Phase 18 — research results

**NO EDGE FOUND** for CORE and SMC on real market data.

There is **no** imported `REAL_MARKET_DATA` warehouse in this repository. Golden SMA is `UNIT_FIXTURE` (algorithm check only).

Argus TS replay of `MOMENTUM_BREAKOUT` on the 24-bar golden fixture returns `INSUFFICIENT_SAMPLE` (`regimeMinBars` typically 60). That is correct, not a failed profitable backtest.

VectorBT CORE adapters remain `PROXY_NOT_FEATURE_PARITY`. No ENGINE_MISMATCH was papered over by picking a better PnL.

| Strategy | Feature Parity | Data | Backtest | OOS | WFO | Permutation | MC | Sensitivity | Costs | Paper | Final |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | PROXY_NOT_FEATURE_PARITY | UNAVAILABLE | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED |
| PULLBACK_CONTINUATION | PROXY_NOT_FEATURE_PARITY | UNAVAILABLE | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED |
| MEAN_REVERSION | PROXY_NOT_FEATURE_PARITY | UNAVAILABLE | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED |
| TREND_FOLLOWING | PROXY_NOT_FEATURE_PARITY | UNAVAILABLE | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED |
| RANGE_REVERSION | PROXY_NOT_FEATURE_PARITY | UNAVAILABLE | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED |
| SMC_LIQUIDITY_SWEEP | PROXY_NOT_FEATURE_PARITY | UNAVAILABLE | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNVALIDATED |

Do not import a CSV of synthetic prices and relabel it `REAL_MARKET_DATA`. Provenance is an operator honesty constraint plus code: only `REAL_MARKET_DATA` can leave UNTESTED in `deriveLifecycleStatus`.
