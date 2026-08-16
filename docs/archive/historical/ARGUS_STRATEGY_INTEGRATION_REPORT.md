# ARGUS_STRATEGY_INTEGRATION_REPORT.md

**Date:** 2026-08-15. Additive wiring only.

QuantEngine remains **off** unless `QUANT_ENGINE_ENABLED=true`. No new strategy is enabled for live trading by default.

## Core strategies (live `evaluateAll` default)

`MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`, `MEAN_REVERSION`, `TREND_FOLLOWING`, `RANGE_REVERSION`.

`StrategyEngine.evaluateAll` **discounts** (does not zero) off-regime confidence via `tradingSafety.regimeMismatchConfidenceMultiplier`. `GroupedScores` blends correlated oscillators so RSI/StochRSI/CCI/Williams are not four independent votes. `QuantSignalAgent` refuses a strategy-sourced live idea when there is no live win-rate sample or EV ≤ 0.

## Integration facade (not a new indicator zoo)

| Piece | Role | Executes orders? |
|---|---|---|
| `QuantitativeFeatureEngine.snapshotFromStrategyContext` | Assembles context + scores + eligibility + divergence + optional SMC + `NOT_SUPPORTED` | No |
| `regimeStrategyEligibility` | Eligible vs ineligible for current regime | No |
| `detectPriceOscillatorDivergence` | Feature (`isTradeSignal: false`) | No |
| `quantDetail.featureSnapshot` | Passed through ChiefTrader | No — approval math unchanged |
| `quantDetail.tradeThesis` | Structured why-buy / NO_TRADE from engines | No |
| `minStrategyConfidenceToTrade` in `tradingSafety.json` | Same 0.6 floor as before | Unchanged |

## Experimental: SMC / ICT

Detection: `src/server/quant/indicators/smc.ts` (reuses BOS/CHoCH/swings). Strategy: `SMC_LIQUIDITY_SWEEP`. Weights: `config/smcConfluence.json`.

- Listed on `GET /api/v2/quant/strategies` → `experimentalStrategies` (`validationStatus: UNVALIDATED`).
- Backtest: `runStrategyBacktest({ strategyId: 'SMC_LIQUIDITY_SWEEP' })` via `findStrategy` **without** the live flag.
- Live `evaluateAll`: only if `QUANT_SMC_STRATEGY_ENABLED=true`.
- Sweep is not a trade. CHoCH confirmation is required for a confirmed reversal score.
- Trap/manipulation labels are **patterns**, not intent.
- Backtest engine is **long-only** — bearish SMC will not open shorts.

**Not implemented as separate live strategies:** VWAP reversal module, ORB, gap, RS-as-strategy, pairs, event/earnings. Session VWAP reclaim/rejection already exist as features. Opening range / premarket are `available:false` on daily bars.

Every strategy without walk-forward OOS success: **UNVALIDATED**.

## Thesis invalidation

`config/thesisInvalidation.json` + `ThesisInvalidation.ts`. Strategy IDs and thresholds are **not** TypeScript literals. PortfolioMonitor still routes exits through RiskEngine.

## Pipeline order (unchanged)

MARKET DATA → indicators → RegimeEngine → MarketContext → StrategyEngine → GroupedScores → feature snapshot / TradeThesis → optional AI contradiction review → ChiefTrader → RiskEngine → sizing → OMS.
