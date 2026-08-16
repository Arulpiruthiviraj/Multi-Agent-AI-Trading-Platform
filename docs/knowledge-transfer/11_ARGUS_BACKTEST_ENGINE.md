# 11 — Backtest engine

Files: `BacktestEngine.ts`, `WalkForwardValidator.ts`, `ReplayClock.ts`, `Commissions.ts`, `Slippage.ts`, `BacktestRiskParity.ts`, MonteCarlo / AccountSizeReport under `quant/analysis/`.

## Inputs

Symbol, bars from gateway, settings TP/trail, `tradingSafety` lookback (`backtestLookbackBars` 50; regime min 60), cash, verboseLogging → decision log.

## Reused from live

PositionSizing, strategy `evaluate()`, RegimeEngine, commissions/slippage modules, capital-gate **inequalities**, settings TP/trail.

## NOT reused

RiskEngine (news, hours, freshness, allocation, concentration, …), ChiefTrader, News/Fund/Macro/LLM, OMS, broker, recon, PortfolioMonitor timer (exits **copied as formulas** only).

## Accounting

Long-only strategy mode. Whole shares. SEC/FINRA on **sells**. Dynamic slippage. End-of-run liquidation. Metrics: engine `computeMetrics` (Sharpe, DD, etc. — treat as **implemented in code**, not as a validated edge). Kelly from **this run’s** win rate if sample ≥ 20.

Walk-forward: **does not optimize**. Monte Carlo: scenario, whole-share honesty.

## Look-ahead audit (this pass)

| Channel | Result | Evidence |
|---|---|---|
| ReplayClock future ts | **PASS** | Hard fail |
| Strategy uses current bar | **UNKNOWN** per strategy — tests exist; full PIT news **N/A** (no news in BT) |
| AI prompts | **N/A** — AI not in BT |
| Corporate actions / delist | **FAIL / UNKNOWN** — raw bars, no CRSP |
| Indicator lookback | **PASS if** bars are trailing-only; duplicated TA in `run()` needs care |

## Divergence vs live (sources of inflation that remain)

AI consensus absent; no news veto; no market hours; no allocation/concentration; rate-limit almost never trips on **daily** bars; strategy still has stop-on-**low** vs live monitor on mark; no partial fills; no OMS crash. 2026-08-15 reduced: capital inequalities + no target-on-high.
