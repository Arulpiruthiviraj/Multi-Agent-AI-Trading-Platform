# ARGUS Phase 18 — strategy parity report

## Argus TypeScript (source of truth)

CORE strategies consume **already-computed** features (`StrategyContext`), not SMA crossovers:

- MOMENTUM_BREAKOUT: BOS + RVOL + ATR expansion + VWAP + regime + sector + RS vs SPY + ROC
- PULLBACK_CONTINUATION: structure + SMA20 pullback + healthy RSI + reversal candle + contracted volume
- MEAN_REVERSION: range + RSI/StochRSI extremes + Keltner + reversal candle
- TREND_FOLLOWING: regime strength + MA stack + DMI/ADX + MACD + CMF; **no fixed target**
- RANGE_REVERSION: consolidating range + nearest S/R + RSI 40/60 + no volume spike

Specs: `config/strategySpecs.json`. Threshold **values** from `config/quantThresholds.json` via `loadStrategySpec()`.

Research replay: `replayArgusStrategy()` calls `findStrategy().evaluate()` with the same indicator modules as `BacktestEngine.runStrategyBacktest`, but:

- does **not** call HistoricalDataGateway / Alpaca
- market context is **UNAVAILABLE** (not zeros)
- fill model documented as **NEXT_BAR_OPEN** (BacktestEngine uses current-bar price — labeled difference)
- `canPlaceOrders: false`

## VectorBT

Still **PROXY_NOT_FEATURE_PARITY**. A VectorBT SMA/RSI port would **not** be MOMENTUM_BREAKOUT. Claiming match would be ENGINE_MISMATCH.

SMC remains UNVALIDATED.
