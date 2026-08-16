# ARGUS Phase 17.1 — repository audit

**Date:** 2026-08-16  
**Rule:** Read-only inventory. No code was required to exist before this file; implementation follows in later 17.x sections of this engagement.

## Execution architecture (must not be replaced)

Live/paper fills remain:

`TRADE_IDEA_GENERATED` → ChiefTrader → RiskAgent → RiskEngine → OMS → BrokerManager → Broker

There is no VectorBT, Python, or Rust import on that path today.

## Existing quantitative stack

| Asset | Location | Notes |
|---|---|---|
| CORE strategies (5) | `src/server/quant/strategies/` | MOMENTUM_BREAKOUT, PULLBACK_CONTINUATION, MEAN_REVERSION, TREND_FOLLOWING, RANGE_REVERSION |
| Experimental | SMC_LIQUIDITY_SWEEP | UNVALIDATED; live flag off |
| Argus backtest | `BacktestEngine.ts` `run()` / `runStrategyBacktest()` | Long-only; PIT AI gate; not VectorBT |
| Walk-forward | `WalkForwardValidator.ts` | Fixed rules; no param optimize on test |
| Monte Carlo | `quant/analysis/MonteCarlo.ts` | Bootstrap on real R-multiples; scenario analysis |
| Expected value | `quant/risk/ExpectedValue.ts` | Quant refuse path; RiskEngine does not Kelly-size |
| Paper report | `PaperTradingValidation.ts` | `minTradesForPaperValidation` = 30 |
| OHLCV store | SQLite `ohlcv_bars` | Not Parquet |
| Python (live app) | `scripts/local_ai_service.py`, `requirements-ai.txt` | Chronos/torch — **no vectorbt** |
| Archive Python | `archive/python-platform/` | Disconnected; Node never imports it |
| VectorBT | **absent** | No package, no adapter, no research API |
| Custom Rust backtester | **absent** | Correct — use official `vectorbt[rust]` only |
| Event-memory | `server.ts` 410 `EVENT_MEMORY_QUARANTINED` | Phase 16 already closed theater |
| Canadian live | blocked | Phase 16 `GET /api/v2/markets/canada` |

## Paper / organic trades

This audit did **not** query `data/argus.db` for organic closed sells. Do not invent a count. Paper validation readiness remains sample-limited until FILLED SELL P&L rows exist from the real pipeline.

## Phase 16 baseline scores (do not inflate)

Software 78 · Execution 55 · Risk 72 · AI 40 · Quant 48 · Paper 28 · **Edge 8** · Canadian 35 · Observability 58  
LIVE **NO-GO** · PAPER **CONDITIONAL GO**

Installing VectorBT later is **infrastructure**, not an edge.

## Gaps Phase 17 must close without creating a second broker

1. Research subprocess with allowlisted jobs only (no arbitrary Python).
2. Canonical OHLCV + quality GREEN/YELLOW/RED before backtest.
3. Dataset hash / reproducibility metadata.
4. Golden SMA fixture for Argus vs VectorBT vs (optional) Rust parity.
5. Promotion engine that **cannot** set VALIDATED/LIVE_CANDIDATE from a config knob.
6. Organic paper counting that excludes unit-test / replay / rejected rows.
7. CORE VectorBT adapters must be labeled **proxies** until feature-engine parity exists (BOS/RVOL/VWAP context is not SMA).
8. Research Lab UI that shows UNAVAILABLE honestly.

## Absolute: VectorBT ↛ Broker
