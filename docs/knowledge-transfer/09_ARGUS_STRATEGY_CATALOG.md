# 09 — Strategy catalog

TechnicalAgent and `BacktestEngine.run()` are **not** these ids. Taxonomy JSON **760 names** = aliases, not 760 `evaluate()` edges.

## CORE (live `evaluateAll` default if Quant on)

| Id | Intent | Live | Paper | Backtest | WF | OOS | Status |
|---|---|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | Breakout | Flag | Same path | findStrategy | WalkForwardValidator | Last scored **failed** combos | UNVALIDATED |
| PULLBACK_CONTINUATION | Pullback | Flag | | Yes long-only | | | UNVALIDATED |
| MEAN_REVERSION | Reversion | Flag | | Yes | | | UNVALIDATED |
| TREND_FOLLOWING | Trend | Flag | | Yes | | | UNVALIDATED |
| RANGE_REVERSION | Range | Flag | | Yes | | | UNVALIDATED |

Off-regime: confidence × `regimeMismatchConfidenceMultiplier` (0.5), never zeroed. Min confidence `minStrategyConfidenceToTrade` 0.6.

Exits **live:** PortfolioMonitor settings TP/trail + thesis/quant stop ideas.  
Exits **strategy backtest:** strategy stop (trail up only) **or** same settings TP/trail on **close** (2026-08-15). No target-on-high.

Sizing: shared PositionSizing; backtest commissions/slippage; live broker.

AI: optional contradiction analyzer — cannot overwrite side/confidence. News: not inside strategy `evaluate()`.

## EXPERIMENTAL (UNVALIDATED; live only if **that** env is `'true'`)

SMC_LIQUIDITY_SWEEP, VWAP_VOLUME_STRUCTURE, OPENING_RANGE_BREAKOUT, VWAP_MEAN_REVERSION, DONCHIAN_CHANNEL_BREAKOUT, MA_CROSSOVER, OSCILLATOR_MOMENTUM, BOLLINGER_VOLATILITY, PREVIOUS_PERIOD_BREAKOUT, CANDLESTICK_REVERSAL, GAP_CONTINUATION, FIBONACCI_PULLBACK, VOLUME_CONFIRMATION, SR_BOUNCE, RELATIVE_STRENGTH_ROTATION.

Backtest via `findStrategy` **without** live flag. Long-only: bearish setups will not open shorts.

**Do not enable live flags to see if they work.**

## Execution matrix (abbreviated)

| Strategy family | Live | Paper | Backtest | QuantEngine | TechnicalAgent | AI | News | Regime | Validation |
|---|---|---|---|---|---|---|---|---|---|
| CORE five | If Quant on | If Quant on | Yes | Yes | No | Optional overlay | No in evaluate | Discount | UNVALIDATED |
| Experimental 15 | Per env | Per env | Yes | If flagged | No | Same | No | Discount | UNVALIDATED |
| TechnicalAgent rules | Yes | Yes | `run()` different | No | Yes | No | No | No | UNVALIDATED |
| /signals mock | Bypass | Fake | No | No | Fake | Fake | Fake | No | BROKEN vs live |
