# 08 — Quantitative engine

**Off** unless `QUANT_ENGINE_ENABLED=true`. Facade: `QuantitativeFeatureEngine.ts`. Live cycle interval default `quantCycleIntervalMs` 300000.

## Inventory (quant layer)

Trend: SMA, EMA, DMI, ADX (double-smoothed; **distinct** from unused `calculateADX` elsewhere), BOS, CHoCH.  
Momentum: RSI, MACD, StochRSI, ROC, Williams %R, CCI; RSI/MACD **divergence as feature** (`isTradeSignal: false`).  
Vol: ATR%, HV, Bollinger **width%** (not band prices), Keltner.  
Volume: session VWAP, RVOL, OBV, MFI, CMF, A/D.  
S/R: pivots, Fib, opening range (**unavailable on daily bars**), Donchian prior channel.  
Price action: candles, gaps.  
SMC: liquidity, wick sweep, displacement, FVG, order blocks, trap as **pattern** (`isIntentionalManipulation: false`); sweep `isTradeSignal: false`.  
Stats: mean, stdev, z, percentile, vol, correlation, covariance, beta, skew, kurtosis, autocorrelation (`statistics.ts`).  
Regime: `RegimeEngine.ts` BULLISH_TREND / BEARISH_TREND / SIDEWAYS_RANGE. **Not** MarketRegimeAgent.  
EV: R:R, EV in R, fractional Kelly (refuses <20 closed trades; cap 10% capital) — **Quant idea suppress only**, not RiskEngine size.  
Scoring: `GroupedScores.ts` 0–100 blended oscillators.  
Thesis: `assembleTradeThesis.ts`; HOLD → `noTradeReasons.json`.  
Invalidation: rule **types** in TS; IDs/thresholds in `thesisInvalidation.json`.

**NOT_SUPPORTED (never zero-filled):** breadth, options, L2, volume profile, TSI, anchored VWAP, pairs, CAD FX.

**Ichimoku:** **MISSING**.

**TechnicalAgent / BacktestEngine.run():** separate RSI/MACD/BB implementations — **duplicated math family**, not the same module as quant indicators. Live/backtest parity for Quant strategies is `findStrategy` + `runStrategyBacktest`, not TechnicalAgent.

**Correctness:** unit tests exist per indicator family. **Not** a claim of trading edge. SMC **UNVALIDATED**.

Consumers: QuantSignalAgent, scanner APIs, backtest, PortfolioMonitor thesis rules.
