# ARGUS_REGRESSION_REPORT.md

## Intent

Prove existing behavior did not change except additive fields and config extraction of an already-used 0.6 strategy-confidence floor.

## What must still pass (same contracts)

- RiskEngine gates and concentration caps remain authoritative.
- ChiefTrader approval threshold, two-agent confirmation, debate HOLD veto, Quant AI disagreement veto — unchanged.
- `QUANT_ENGINE_ENABLED` default off — `start()` still a no-op without the flag.
- Strategy `evaluate()` math unchanged; only eligibility listing + snapshot assembly added.
- `supportingQuantDetail.featureSnapshot` is `null` when QuantEngine did not attach a snapshot (existing ChiefTrader fixture).

## Tests added/extended this pass

- `momentum.test.ts` — bullish/bearish divergence is a feature (`isTradeSignal === false`).
- `QuantitativeFeatureEngine.test.ts` — snapshot + NOT_SUPPORTED.
- `StrategyEngine.test.ts` — `regimeStrategyEligibility`.
- `QuantSignalAgent.test.ts` — `quantDetail.featureSnapshot` present on a real emit.
- `ChiefTraderAgent.test.ts` — `featureSnapshot` null when absent; side/confidence still 0.95.

## Command used

Targeted vitest on the files above (full parallel `npm test` can hook-timeout on DB/OpenAlice/Kronos probes; prefer `--maxWorkers=1` for a full run).

## Not claimed

No live/backtest parity proof from this pass. No OOS improvement. No NewsAgent accuracy change.
