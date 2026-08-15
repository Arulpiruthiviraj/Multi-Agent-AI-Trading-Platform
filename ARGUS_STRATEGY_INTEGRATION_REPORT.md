# ARGUS_STRATEGY_INTEGRATION_REPORT.md

**Date:** 2026-08-15. Additive wiring only. QuantEngine remains **off** unless `QUANT_ENGINE_ENABLED=true`. No new strategies were enabled for live trading.

## What was already true

Five strategies exist (`MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`, `MEAN_REVERSION`, `TREND_FOLLOWING`, `RANGE_REVERSION`). `StrategyEngine.evaluateAll` already **discounts** (does not zero) off-regime confidence via `tradingSafety.regimeMismatchConfidenceMultiplier`. `GroupedScores` already blends correlated oscillators so RSI/StochRSI/CCI/Williams are not four independent votes. `QuantSignalAgent` already refuses a strategy-sourced live idea when there is no live win-rate sample or EV ≤ 0.

## What this pass added (integration, not a new zoo)

| Piece | Role | Does it execute? |
|---|---|---|
| `QuantitativeFeatureEngine.snapshotFromStrategyContext` | Assembles existing StrategyContext + grouped scores + regime eligibility + named RSI/MACD **divergence features** + honest `NOT_SUPPORTED` records | No |
| `regimeStrategyEligibility` | Lists eligible vs ineligible strategies for the current regime | No |
| `detectPriceOscillatorDivergence` | Feature only (`isTradeSignal: false`) | No |
| `quantDetail.featureSnapshot` | Passed through ChiefTrader as `supportingQuantDetail.featureSnapshot` | No — approval math unchanged |
| `minStrategyConfidenceToTrade` in `config/tradingSafety.json` | Same 0.6 floor as before, no longer a module literal | Unchanged behavior |

## Strategy library vs the 10-strategy request

Implemented and backtestable today: the **five** existing modules above.

**Not implemented** (and not turned on): VWAP reversal as a separate module, opening-range breakout, gap, relative-strength-as-strategy, pairs/stat-arb, event/earnings. Session VWAP reclaim/rejection already exist as **features** in `computeVWAPContext`. Opening range / premarket are `available:false` on daily bars.

Label for every strategy that lacks walk-forward OOS success: **UNVALIDATED**.

## Pipeline (unchanged order)

MARKET DATA → existing indicator modules → RegimeEngine → MarketContext → StrategyEngine → GroupedScores → (new) feature snapshot → optional AI contradiction review → ChiefTrader → RiskEngine → sizing → OMS.

## SMC / ICT (additive, UNVALIDATED)

Pattern engines live in `src/server/quant/indicators/smc.ts` (liquidity, wick sweep, displacement, FVG, order block, trap-as-failed-breakout). Existing BOS/CHoCH/HH-HL are reused, not rewritten.

Strategy `SMC_LIQUIDITY_SWEEP` is **experimental**:
- Listed under `GET /api/v2/quant/strategies` → `experimentalStrategies`
- Backtestable via `runStrategyBacktest({ strategyId: 'SMC_LIQUIDITY_SWEEP' })` without enabling live Quant
- **Not** in live `evaluateAll` unless `QUANT_SMC_STRATEGY_ENABLED=true`
- A sweep is `isTradeSignal: false`. Entry scoring requires CHoCH confirmation.
- "Manipulation" / "smart money trap" are **pattern labels**, not claims of intentional manipulation
- Backtest engine is long-only: bearish SMC will not open shorts
- Label: **UNVALIDATED** until walk-forward OOS including commissions and slippage

Weights: `config/smcConfluence.json`.

