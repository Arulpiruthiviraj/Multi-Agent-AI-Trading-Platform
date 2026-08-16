# ARGUS Phase 19 — Implementation Report

**Date:** 2026-08-16  
**Rule:** Mathematical alignment and data hygiene. No invented edge. No fabricated OHLC, FinBERT, or LLM tokens. Live path still EventBus → ChiefTrader → RiskEngine → OMS. RiskEngine **gate set and order were not changed**.

## What shipped

### Task 1 — Residual pipeline leaks

| Item | Change | Honesty |
|---|---|---|
| `MarketDataWorker` | Still caches last quote for RiskEngine freshness. `emitMarketData` only when `isLiveIdeaGenerationEnabled()` (`enabled === true` **and** `tradingState === 'TRADING_ENABLED'`). | Autobot-off ticks no longer warm Technical/Kronos idea agents. UI/graph go idle without fabricated ticks. |
| `ChiefTraderAgent.reviewIdea` | Early return when Autobot/trading is off, **before** debate LLM. | Stray entry ideas cannot reach consensus LLM or `CHIEF_APPROVED_IDEA`. |
| Risk-exit exception | `PortfolioMonitor` SELL (`riskExitAgent`) still reviews when Autobot is off. | Capital-preservation exits are not “stray entries.” They still hit RiskEngine/OMS. |
| Capital labels | `tradingSafety.internalPaperDefaultCash` (100000) vs `tradingSafety.defaultMaxTradeSizeDollars` (3000). RiskEngine/TradingEngine fallbacks use the latter. `GET /api/v2/research/capital-labels` returns both. | Paper seed ≠ order-notional cap ≠ `settings.budget` ≠ broker equity. Equity still **null** when missing. |

RiskEngine gates, OMS, and EventBus dispatch architecture were **not** rewritten.

### Task 2 — CORE VectorBT feature translation

SMA-as-CORE is gone for the five CORE ids.

Python `python/argus_research/core_features.py` translates the TS formulas for:

- Wilder ATR / EMA (same recurrence as `TechnicalIndicators.ts`)
- RVOL (`relativeVolume`: last volume / SMA of prior 20)
- Keltner (EMA20 ± 2×ATR10)
- Fractal swings + BOS/CHoCH (`detectMarketStructure`)
- Nearest S/R from swing prices

CLI job `core_feature_parity` (allowlisted). TS `coreParityVectors.ts` is the source-of-truth vector from live engines.

`scripts/assert_core_vectorbt_parity.ts` asserts `compareEngines` **PASS** on identical NEXT_BAR_OPEN qty=1 fills, and when `ARGUS_TEST_ALLOW_VECTORBT=true` asserts Python vs TS vectors with **zero ENGINE_MISMATCH**.

**Not claimed**

- Byte-identical `RegimeEngine` / DMI / MACD / CMF / candlestick port inside VectorBT.
- PnL match vs `BacktestEngine.runStrategyBacktest` (that engine still uses its own same-bar fill path; research execution model remains **NEXT_BAR_OPEN**).
- SMC feature parity (`PROXY_NOT_FEATURE_PARITY`, **UNVALIDATED**).
- A trading edge. CORE status remains **UNTESTED** until REAL_MARKET_DATA + OOS/WFO/paper floors.

### Task 3 — Parquet warehouse pipeline

`ingestAlpacaWarehouse.ts` + `scripts/ingest_research_warehouse.ts`:

- Symbols from `config/markets.json` US benchmarks (SPY/QQQ/IWM/DIA).
- Timeframes: 1Min, 5Min, 15Min, 1Hour, 1Day.
- Alpaca historical REST only if keys exist; empty result if not — **no synthetic bars**.
- `cleanOhlcv` drops invalid OHLC / duplicates.
- `assessDataQuality` GREEN/YELLOW/RED. Python `write_parquet` **refuses** unless `quality === GREEN`.
- Vitest does not spawn Python or hit Alpaca.

This environment may still have **zero** parquet files until the operator runs the ingest script with keys. Absence of a warehouse is **UNAVAILABLE**, not a fake SPY history.

### Task 4 — PIT LLM replay

`PitLlmReplay.reconstructPitDebate`:

- `debateReplayed: true` **only** when a successful `ai_calls` row has **both** `prompt` and `rawResponse` with `createdAt <= asOfMs` **and** a `news_clusters` row for that symbol also `<= asOfMs`.
- Future-dated or missing rows stay `false`. Tokens are never invented.

`PitReplay.evaluatePitAiBuyGate` accepts optional `aiCalls` / `newsClusters` / `asOfMs`. Vote math is still `EvidenceAggregator`. Empty ledger still does not become AI-approved BUY unless `allowTechnicalWhenEmpty`.

## Tests / commands

```
npx tsc --noEmit          # PASS
npx vitest run            # 962 passed / 962 total (148 files)
npx tsx scripts/assert_core_vectorbt_parity.ts
# optional: ARGUS_TEST_ALLOW_VECTORBT=true npx tsx scripts/assert_core_vectorbt_parity.ts
# optional: npx tsx scripts/ingest_research_warehouse.ts
```

## Readiness (unchanged scores)

LIVE **NO-GO**. Trading edge **8**. Feature translation ≠ expectancy. Organic paper still must not be invented.
