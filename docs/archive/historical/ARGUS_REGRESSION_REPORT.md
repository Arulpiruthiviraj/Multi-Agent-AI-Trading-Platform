# ARGUS_REGRESSION_REPORT.md

## Intent

Prove existing behavior did not change except additive fields and config extraction (strategy-confidence floor, thesis-invalidation rules).

## Contracts that must still hold

- RiskEngine gates and concentration caps remain authoritative.
- ChiefTrader approval threshold, two-agent confirmation, debate HOLD veto, Quant AI disagreement veto — unchanged.
- `QUANT_ENGINE_ENABLED` default off — `start()` still a no-op without the flag.
- `evaluateAll()` still returns **five** strategies unless `QUANT_SMC_STRATEGY_ENABLED=true`.
- `supportingQuantDetail.featureSnapshot` is `null` when QuantEngine did not attach a snapshot.
- Thesis invalidation still fires on the same *kinds* of breaches; strategy ids now come from JSON.

## Tests covering the additive surface

- `momentum.test.ts` — divergence is a feature (`isTradeSignal === false`).
- `QuantitativeFeatureEngine.test.ts` — snapshot + NOT_SUPPORTED.
- `StrategyEngine.test.ts` — eligibility listing; still 5 live evaluations by default.
- `smc.test.ts` / `smcLiquiditySweep.test.ts` — sweep is not a trade; SMC not in default evaluateAll.
- `ThesisInvalidation.test.ts` — thresholds from `thesisInvalidation.json`.
- `assembleTradeThesis.test.ts` / `parseResearchNote.test.ts`.
- `QuantSignalAgent.test.ts` — `featureSnapshot` + `tradeThesis.numericEvidenceSource === 'quant_engines'`.
- `ChiefTraderAgent.test.ts` — approval math unchanged.

Prefer `npx vitest run <paths> --maxWorkers=1` (full parallel `npm test` can hook-timeout on DB/OpenAlice/Kronos probes).

## Not claimed

No OOS improvement. No NewsAgent accuracy change. LIVE still **NO-GO**.
