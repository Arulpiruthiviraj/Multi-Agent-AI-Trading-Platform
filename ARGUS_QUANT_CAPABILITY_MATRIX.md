# ARGUS_QUANT_CAPABILITY_MATRIX.md

Evidence of **use**, not file existence. QuantEngine live path is **off** unless `QUANT_ENGINE_ENABLED=true`.

| Capability | Implemented? | Used live (always-on)? | Used by backtest? | QuantEngine? | ChiefTrader? | RiskEngine? | Tested? | OOS validated? |
|------------|--------------|------------------------|-------------------|--------------|--------------|-------------|---------|----------------|
| RSI/MACD/BB/SMA (TechnicalAgent) | Yes | Yes (ideas) | Partial (`run()` technical rules, not identical agent) | Reuses engines | As votes | No | Unit | No |
| ADX/DMI, BOS/CHOCH, StochRSI, CCI, Williams, Keltner, RVOL, CMF, VWAP session | Yes (`quant/indicators`) | Only if Quant enabled | `runStrategyBacktest` | Yes | If Quant idea | No | Unit | **No** (OOS collapse documented) |
| RegimeEngine | Yes | Quant only | Strategy backtest | Yes | Via quantDetail | No | Unit | No |
| MarketContext SPY/QQQ/IWM/sector RS | Yes | Quant only | Strategy backtest | Yes | Via quantDetail | No | Unit | No |
| Breadth | Honest `available:false` | No | No | Reports missing | No | No | N/A | N/A |
| 5 strategies (momentum, pullback, MR, trend, range) | Yes | Quant only | Yes | Yes | If Quant | No | Unit + some WF | **FAIL** on checked combos |
| GroupedScores | Yes | Quant only | Indirect | Yes | Scores in detail | No | Unit | No |
| EV / fractional Kelly | Yes | Live Quant **gates** on EV when sample exists (often 0 trades → refuse) | Strategy backtest reports | Yes | No direct | Caps still RiskEngine | Unit | Insufficient sample |
| Monte Carlo | Yes | No | On-demand API | N/A | No | No | Unit | Scenario only |
| NewsAgent | Yes | Yes | **Not** in BacktestEngine | No | Vote | News veto cluster | Live eval | **44.6%** accuracy |
| Fundamentals/Macro | Yes, provider-gated | When keys exist | No | No | Vote / HOLD 0 | No | Partial | UNTESTABLE historically |
| Options / L2 / pairs / cointegration | No | No | No | No | No | No | — | — |
| Position sizing FIXED_DOLLAR / % equity | Yes | Yes | Shared `PositionSizing` | Indirect | No | **Authoritative** | Unit | N/A (risk, not edge) |
| Argus capital allocation | Yes | Yes | No (sim account) | No | No | Gate | Unit | N/A |
| QuantitativeFeatureEngine snapshot | Yes (facade) | Only if Quant enabled | No (not a strategy) | Yes | Via `featureSnapshot` | No | Unit | No |
| RSI/MACD divergence (named) | Yes (feature) | Quant snapshot only | No | Yes | Recorded, not a vote | No | Unit | No |
| TSI / anchored VWAP / volume profile / options / L2 / pairs / breadth | No | No | No | Honest `NOT_SUPPORTED` | No | No | N/A | N/A |

**Do not add 50 indicators.** Missing live wiring of existing Quant features is the gap, not SMA distance formulas. Quant remains opt-in. OOS still **FAIL**. Readiness percentages are **not** increased by this facade.
