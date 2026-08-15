# ARGUS_POSITION_MANAGEMENT_SPEC.md

## Existing live monitors

`PortfolioMonitor` uses `settings.takeProfitPct` / `trailingStopPct` (parity with `BacktestEngine.run()`). Quant stop/target can be persisted on trades. After those numeric checks, Quant-originated rows with `quant_invalidation_json` are re-evaluated.

## Config-driven invalidation

| Layer | Where |
|---|---|
| Rule types (how to compare) | `src/server/quant/analysis/ThesisInvalidation.ts` |
| Strategy ids, thresholds, messages | `config/thesisInvalidation.json` |
| Loader | `src/server/config/thesisInvalidation.ts` (unknown types fail boot) |

**No strategy-id literals in ThesisInvalidation.ts.** Adding a strategy to `close_through_structural_level` is a JSON change.

Rule types today: `regime_not_in_applicable`, `rvol_below`, `adx_below`, `false_breakout_through_structural_level`, `choch_against_side`, `close_through_structural_level` (SMC sweep extreme and range boundary), `structure_trend_against_side`.

Missing live data ⇒ that rule does not fire (not a fabricated breach).

## Exits

Invalidation emits a SELL **idea** through ChiefTrader’s risk-exit path, then RiskEngine. AI cannot call `placeOrder`.
