# ARGUS Phase 18 — baseline audit (code is source of truth)

**Date:** 2026-08-16  
**Rule:** Inspected existing files before adding Phase 18 code. Do not rewrite EventBus → ChiefTrader → RiskEngine → OMS. Do not raise edge/quant/paper scores because more research files exist.

## Current architecture (unchanged fill path)

`TRADE_IDEA_GENERATED` → ChiefTrader → RiskAgent → RiskEngine → OMS → BrokerManager → Broker

Research (Phase 17): `src/server/research/*` + `python/argus_research/cli.py` + `/api/v2/research/*`  
`canPlaceOrders: false`. VectorBT CLI has no broker imports. Vitest skips Python spawn.

## What already exists (reuse)

| Capability | File | Status |
|---|---|---|
| CORE five `evaluate()` | `src/server/quant/strategies/*.ts` | Real feature consumers (BOS, RVOL, Keltner, SMA stack, S/R) |
| Thresholds | `config/quantThresholds.json` via `quantThresholds.ts` | Authoritative numbers |
| Feature engines | `indicators/trend.ts` momentum volume volatility priceAction supportResistance + `RegimeEngine.ts` | Used live and in `BacktestEngine.runStrategyBacktest` |
| Argus strategy backtest | `BacktestEngine.runStrategyBacktest` | Long-only; PIT slice; needs ≥60 bars + HistoricalDataGateway (Alpaca/SQLite) |
| VectorBT | `VectorBTService.ts` + CLI | Golden SMA only; CORE returns `PROXY_NOT_FEATURE_PARITY` |
| Data quality | `dataQuality.ts` | GREEN/YELLOW/RED |
| Dataset hash | `datasetHash.ts` | sha256 |
| WFO / permutation / sensitivity / cost | `walkForward.ts` `robustness.ts` | **Golden SMA fixture only** |
| Monte Carlo | `quant/analysis/MonteCarlo.ts` | Scenario analysis on R-multiples |
| Promotion | `promotionEngine.ts` | Evidence-derived; empty → UNTESTED |
| Organic paper | `organicPaper.ts` | PAPER FILLED SELL only |
| Parquet sidecar | `parquetStore.ts` | Opt-in; no warehouse of real bars |
| Small account | `smallAccount.ts` | 100/500/1000/5000 |
| Research Lab UI | `ResearchLabPanel.tsx` | Capability + promotion, no fake Sharpe |

## Missing (Phase 18 must add without fabricating edge)

1. **Data provenance** (`REAL_MARKET_DATA` vs `UNIT_FIXTURE` / synthetic). Golden SMA must not count as `BACKTEST_PASS`.
2. **Import** CSV/JSON (Parquet sidecar; SQLite ohlcv read labeled UNKNOWN unless tagged). No Alpaca download in tests.
3. **Dataset registry** in-process + `data/research/*.meta.json`.
4. **Machine-readable strategy specs** sourced from CORE files + `quantThresholds.json`.
5. **Argus TS replay** that calls the **same** `findStrategy().evaluate()` + feature engines, with `UNAVAILABLE` market context unless benchmarks are in the dataset. No OMS.
6. **NEXT_BAR_OPEN** execution model explicit (BacktestEngine currently sizes off current bar price — document the difference).
7. **MTF availability timestamps** (reject unclosed higher-TF features).
8. **Rejection catalog** (NO_DATA, LOOKAHEAD_DETECTED, ENGINE_MISMATCH, …).
9. **Multiple-testing warning** on large grids.
10. **CORE VectorBT feature parity** — **not achievable as SMA**. Remain `PROXY_NOT_FEATURE_PARITY` until a VectorBT port uses the same BOS/RVOL/Keltner/etc. features. Claiming parity without that would be ENGINE_MISMATCH theater.
11. **Real historical SPY/QQQ/IWM warehouse** — **absent**. Results for CORE on real data = `UNAVAILABLE` / `UNTESTED` until a user imports REAL_MARKET_DATA.

## Risks

- Using golden SMA or generated trending bars to mark CORE `OOS_PASS` would cheat.
- Calling `historicalDataGateway.ensureBars` in Vitest can hit network/Alpaca — Phase 18 replay must not do that.
- Mixing BacktestEngine same-bar fill with research next-open fill without labeling.

## Proposed implementation (additive)

Extend `src/server/research/` + `config/strategySpecs.json` + `config/researchRejection.json` + `config/executionModels.json`. Mount extra routes on existing `researchRoutes.ts`. Expand Research Lab. Reports state **NO EDGE / UNTESTED**.

## Test plan

Provenance blocks promotion; import CSV UNIT_FIXTURE; lookahead MTF; Argus replay INSUFFICIENT_SAMPLE on 24-bar golden; CORE VectorBT still proxy; forbidden keys; empty evidence UNTESTED; tsc + vitest.
