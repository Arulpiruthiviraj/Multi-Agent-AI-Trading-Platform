# ARGUS strategy evidence report (Phase 17)

No strategy has been promoted. Results below are **status**, not performance.

| strategyId | family | VectorBT adapter | lifecycle | invented PnL |
|---|---|---|---|---|
| MOMENTUM_BREAKOUT | CORE | PROXY_NOT_FEATURE_PARITY | UNTESTED | no |
| PULLBACK_CONTINUATION | CORE | PROXY_NOT_FEATURE_PARITY | UNTESTED | no |
| MEAN_REVERSION | CORE | PROXY_NOT_FEATURE_PARITY | UNTESTED | no |
| TREND_FOLLOWING | CORE | PROXY_NOT_FEATURE_PARITY | UNTESTED | no |
| RANGE_REVERSION | CORE | PROXY_NOT_FEATURE_PARITY | UNTESTED | no |
| SMC_LIQUIDITY_SWEEP | EXPERIMENTAL | none | UNVALIDATED | no |
| GOLDEN_SMA | fixture | python_sma / optional VectorBT | measurement only | no (deterministic fixture) |

Golden SMA exists to prove **engine parity and look-ahead rules**, not profitability.

Walk-forward / permutation / cost-stress run on the golden fixture only. Passing a unit test is not OOS validation of CORE strategies.

Paper organic count: only `executionEnvironment=PAPER` FILLED SELL with P&L. Untagged historical rows are **UNKNOWN** and do not count.
