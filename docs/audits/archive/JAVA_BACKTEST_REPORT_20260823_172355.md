# Java Quant Core Backtest Report

Generated: 2026-08-23T21:23:55.164111200Z

**Strategy: `RsiThresholdStrategy` (demonstration only — NOT one of the 5 CORE strategies; see its own header comment on why).**

Range requested: 2018-01-01T00:00:00Z to 2027-01-01T00:00:00Z · timeframe: `1Day`

## Honest scale disclosure

The originally requested benchmark (1,000,000 1-minute bars across 50 tickers, <5s, <100MB peak heap) was **NOT run** — this environment's real historical warehouse (`data/argus.db`'s `ohlcv_bars` table, verified by direct query 2026-08-21) does not contain that much data. Real inventory found: **27,438** `1Day` bars across 31 symbols, **19,620** `1Min` bars (far fewer symbols/days), **177** `5Min` bars. The benchmark below is measured against what genuinely exists, not a fabricated projection to the originally requested scale.

## Measured performance (real, this run)

| Metric | Value |
|---|---:|
| Symbols processed | 9 |
| Total bars processed | 19539 |
| Wall-clock duration | 0.074 s |
| Throughput | 264848 bars/sec |
| Concurrency model | Java 26 virtual thread per symbol |

## Per-symbol results

| Symbol | Bars | Trades | Net P&L | Win Rate | Profit Factor | Max Drawdown % |
|---|---:|---:|---:|---:|---:|---:|
| QQQ | 2171 | 14 | 1181.04 | 42.9% | 1.38 | 1.4% |
| MSFT | 2171 | 15 | 2748.00 | 40.0% | 1.95 | 1.5% |
| NVDA | 2171 | 29 | -8665.42 | 10.3% | 0.39 | 10.5% |
| AAPL | 2171 | 26 | 2771.62 | 38.5% | 1.40 | 3.8% |
| TSLA | 2171 | 53 | -4747.50 | 15.1% | 0.83 | 11.9% |
| XLK | 2171 | 17 | -1212.26 | 23.5% | 0.72 | 2.8% |
| AMD | 2171 | 18 | 7390.36 | 33.3% | 2.24 | 2.6% |
| SPY | 2171 | 19 | 3088.42 | 42.1% | 1.72 | 1.8% |
| IWM | 2171 | 30 | -286.97 | 26.7% | 0.96 | 3.2% |

**Combined net P&L across all symbols: 2267.31**

This is a demonstration strategy on daily bars with real commission/slippage friction modeled — it is NOT a claim of trading edge, CORE-strategy performance, or anything promotable per CLAUDE.md's own standards (NEXT_BAR_OPEN/OOS/WFO/paper soak requirements). It exists to prove the Phase 4 engine infrastructure works.

## Daily Goal Campaign policy simulation (target = $100.0/day)

**Known simplification**: TRAIL_STOPS_ONLY's real distinguishing behavior (tightening the trailing stop on still-open positions) isn't modeled by this already-closed-trade simulation — see CampaignPolicySimulator.java's own header comment. It will show identical numbers to LOCK_AND_IDLE below.

| Policy | Total P&L | Days target reached | Total days |
|---|---:|---:|---:|
| CONTINUE | 2267.31 | 51 | 168 |
| LOCK_AND_IDLE | -3671.87 | 51 | 168 |
| TRAIL_STOPS_ONLY | -3671.87 | 51 | 168 |

## What this report is NOT

- Not a claim of predictive edge (CLAUDE.md's own standard: organic closed PAPER FILLED SELL P&L, not a backtest, establishes edge).
- Not the 5 CORE strategies (MOMENTUM_BREAKOUT/PULLBACK_CONTINUATION/MEAN_REVERSION/TREND_FOLLOWING/RANGE_REVERSION) — those need the still-unported feature pipeline (RegimeEngine/trend/volume/priceAction/supportResistance/MarketContext).
- Not a TS-vs-Java parity comparison for this specific run (that requires running the real `src/server/engines/backtest/BacktestEngine.ts` against the identical symbols/dates and diffing trade-by-trade — not done in this pass; tracked as follow-up, not silently assumed to match).
