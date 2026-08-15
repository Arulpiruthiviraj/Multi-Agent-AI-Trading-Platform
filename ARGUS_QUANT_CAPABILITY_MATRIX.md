# ARGUS_QUANT_CAPABILITY_MATRIX.md

Evidence of **use**, not file existence. Updated 2026-08-15.

QuantEngine live path is **off** unless `QUANT_ENGINE_ENABLED=true`. SMC is **not** in live `evaluateAll` unless `QUANT_SMC_STRATEGY_ENABLED=true`. Bull/Bear research parser exists but is **not** consumed by ChiefTrader unless `QUANT_BULL_BEAR_ENABLED=true`.

| Capability | Implemented? | Used live (always-on)? | Used by backtest? | QuantEngine? | ChiefTrader? | RiskEngine? | Tested? | OOS validated? |
|------------|--------------|------------------------|-------------------|--------------|--------------|-------------|---------|----------------|
| RSI/MACD/BB/SMA (TechnicalAgent) | Yes | Yes (ideas) | Partial (`run()` technical rules, not identical agent) | Reuses engines | As votes | No | Unit | No |
| ADX/DMI, BOS/CHOCH, StochRSI, CCI, Williams, Keltner, RVOL, CMF, VWAP session | Yes (`quant/indicators`) | Only if Quant enabled | `runStrategyBacktest` | Yes | If Quant idea | No | Unit | **No** (OOS collapse documented) |
| RegimeEngine | Yes | Quant only | Strategy backtest | Yes | Via quantDetail | No | Unit | No |
| MarketContext SPY/QQQ/IWM/sector RS | Yes | Quant only | Strategy backtest | Yes | Via quantDetail | No | Unit | No |
| Breadth | Honest `available:false` | No | No | Reports missing | No | No | N/A | N/A |
| 5 core strategies (momentum, pullback, MR, trend, range) | Yes | Quant only | Yes | Yes | If Quant | No | Unit + some WF | **FAIL** on checked combos |
| SMC_LIQUIDITY_SWEEP | Yes (experimental) | Only if Quant **and** `QUANT_SMC_STRATEGY_ENABLED` | Yes via `findStrategy` | Optional | If that idea wins | No | Unit | **UNVALIDATED** |
| GroupedScores | Yes | Quant only | Indirect | Yes | Scores in detail | No | Unit | No |
| TradeThesis | Yes (`assembleTradeThesis`) | Quant `quantDetail` only | No (not a strategy) | Yes | Field only; math unchanged | No | Unit | N/A |
| Bull/Bear structured notes | Parser + config | **No** (flag off) | No | No | Not wired | No | Unit | No |
| Thesis invalidation | Yes, rules in `config/thesisInvalidation.json` | PortfolioMonitor on Quant trades | N/A (live monitor) | Indirect | Risk-exit idea | Yes (exit still gated) | Unit | N/A |
| EV / fractional Kelly | Yes | Live Quant **gates** on EV when sample exists (often 0 trades → refuse) | Strategy backtest reports | Yes | No direct | Caps still RiskEngine | Unit | Insufficient sample |
| Monte Carlo | Yes | No | On-demand API | N/A | No | No | Unit | Scenario only |
| NewsAgent | Yes | Yes | **Not** in BacktestEngine | No | Vote | News veto cluster | Live eval | **44.6%** accuracy |
| Fundamentals/Macro | Yes, provider-gated | When keys exist | No | No | Vote / HOLD 0 | No | Partial | UNTESTABLE historically |
| Options / L2 / pairs / cointegration | No | No | No | Snapshot `NOT_SUPPORTED` | No | No | — | — |
| Position sizing FIXED_DOLLAR / % equity | Yes | Yes | Shared `PositionSizing` | Indirect | No | **Authoritative** | Unit | N/A (risk, not edge) |
| Argus capital allocation | Yes | Yes | No (sim account) | No | No | Gate | Unit | N/A |
| QuantitativeFeatureEngine snapshot | Yes (facade) | Only if Quant enabled | No (not a strategy) | Yes | Via `featureSnapshot` | No | Unit | No |
| RSI/MACD divergence (named) | Yes (feature) | Quant snapshot only | No | Yes | Recorded, not a vote | No | Unit | No |

Quant remains opt-in. OOS still **FAIL** on checked core combos. Readiness percentages are **not** increased by SMC, TradeThesis, or config extraction.
