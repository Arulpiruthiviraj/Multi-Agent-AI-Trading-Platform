# ARGUS_POSITION_MANAGEMENT_SPEC.md

## Existing

`PortfolioMonitor` uses `settings.takeProfitPct` / `trailingStopPct` (parity with `BacktestEngine.run`). Quant stop/target persisted on trades. `evaluateThesisInvalidation` re-checks live features.

## Config-driven invalidation

Rules: `config/thesisInvalidation.json`. Interpreters: `ThesisInvalidation.ts`. **No strategy-id literals in TypeScript.** Thresholds (RVOL, ADX) and messages live in JSON.

## Exits

Invalidation emits a SELL **idea** through the existing pipeline (ChiefTrader risk-exit path + RiskEngine). AI cannot call `placeOrder`.
