# ARGUS_IMPLEMENTATION_PLAN.md

## Phases

| Phase | Status | Live impact |
|---|---|---|
| A Architecture map | `ARGUS_CURRENT_ARCHITECTURE_MAP.md` + comparison specs | None |
| B TradeThesis | `assembleTradeThesis` on Quant ideas | Additive field only |
| C Regime selector | Discount + `regimeStrategyEligibility` | None new |
| D Bull/Bear parser | `parseResearchNote` + `bullBearResearch.json` | **Off** (`QUANT_BULL_BEAR_ENABLED`) |
| E EV | Already on Quant strategy ideas | Unchanged |
| F Position thesis | Config-driven `ThesisInvalidation` | Same gates; rules in JSON |
| SMC experimental | `smc.ts` + `smcLiquiditySweep.ts` | Off unless `QUANT_SMC_STRATEGY_ENABLED` |
| G–L Model tournament, lab UI, paper campaign, restricted live | **Not implemented as a productization pass** | — |

## Rollback

- Thesis rules: revert `config/thesisInvalidation.json`.
- TradeThesis: stop attaching `quantDetail.tradeThesis` (field is ignored by approval math).
- SMC: leave `QUANT_SMC_STRATEGY_ENABLED` unset; `ALL_STRATEGIES` stays five.
- Bull/Bear: leave env unset; ChiefTrader does not import the parser today.

No intended RiskEngine / OMS / Broker diffs for these additive pieces.

## Enablement

Never auto-enable SMC, Bull/Bear, or Quant for LIVE. Path: backtest → walk-forward → OOS → paper → explicit flag. Readiness scores do not rise because files were added.
