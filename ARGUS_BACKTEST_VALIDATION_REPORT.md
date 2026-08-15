# ARGUS_BACKTEST_VALIDATION_REPORT.md

Evidence only. Adding a feature snapshot **does not** validate a strategy.

## What already works

- `BacktestEngine.runStrategyBacktest()` runs the five quant strategies on historical OHLCV with commissions, slippage, ReplayClock look-ahead guards, regime segmentation, EV/Kelly reporting, buy-and-hold benchmarks, and failure classification.
- `WalkForwardValidator` supports `run()` and `runStrategyBacktest()` modes.
- Monte Carlo (`quant/analysis/MonteCarlo.ts`) is scenario analysis; `statisticallyJustified` refuses below 20 trades.

This pass **did not** add new strategies to the backtester and **did not** re-run the full 2018–2025 grid.

## Out-of-sample evidence (unchanged, still binding)

From `WALKFORWARD_CHECK_RESULTS.json` / `ARGUS_STRATEGY_VALIDATION_REPORT.md` / `ARGUS_PHASE16_READINESS_REPORT.md`:

- Two highest in-sample QuantEngine combinations: walk-forward OOS average test-window return about **+0.04% (MSFT)** and **+0.28% (AMD)** with **79–89% IS→OOS degradation**.
- Verdict: **FAIL / UNVALIDATED**. In-sample profit is not promotion evidence.

## What the backtester still does not do

| Gap | Status |
|---|---|
| NewsAgent / LLM decisions in historical replay | UNAVAILABLE — no point-in-time news/LLM corpus; `aiReplayAvailability.ts` refuses to fabricate |
| Corporate actions | Not a first-class backtest input |
| Options / L2 / breadth | No data — cannot backtest |
| Live/backtest parity for QuantEngine exits | Documented remaining gap (thesis invalidation was added live; full parity still not claimed) |
| Organic paper closed trades in this environment | **Zero** — live EV gate therefore usually refuses strategy ideas |

## Promotion rule (unchanged)

DEVELOPMENT → BACKTEST → WALK FORWARD → OOS → PAPER → RESTRICTED LIVE → AUTONOMOUS LIVE.

Unit tests passing ≠ OOS validation. This pass stays at DEVELOPMENT/integration for the feature facade.
