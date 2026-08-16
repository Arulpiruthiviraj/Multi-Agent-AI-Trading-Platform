# ARGUS_IMPLEMENTATION_PLAN.md

## Phases

| Phase | Status | Live impact |
|---|---|---|
| A Architecture map | `ARGUS_CURRENT_ARCHITECTURE_MAP.md` + comparison specs | None |
| B TradeThesis | `assembleTradeThesis` on Quant ideas | Additive field only |
| C Regime selector | Discount + `regimeStrategyEligibility` | None new |
| D Bull/Bear parser | `parseResearchNote` + `bullBearResearch.json`; ChiefTrader debate when `QUANT_BULL_BEAR_ENABLED=true` | **Off** by default |
| E EV | Already on Quant strategy ideas | Unchanged |
| F Position thesis | Config-driven `ThesisInvalidation` | Same gates; rules in JSON |
| SMC experimental | `smc.ts` + `smcLiquiditySweep.ts` | Off unless `QUANT_SMC_STRATEGY_ENABLED` |
| Daily buy notional | `DailyBuyNotional` + RiskEngine `daily_buy_notional` | Paper unlimited (`maxDailyBuyNotionalDollars: 0`); LIVE uses `restrictedLiveMaxDailyBuyNotionalDollars` |
| Filled-order recon | `FILLED_ORDER_MISSING_LOCALLY` | Observability / pause if dollar impact ≥ existing mismatch floor |
| Cancel UI | Arena Live Broker Feed uses real `t.status` + `POST /api/v2/trading/cancel-order/:id` | Existing OMS path |
| G–L Model tournament, lab UI, paper campaign, restricted live productization | **Not implemented as a productization pass** | — |

## Rollback

- Thesis rules: revert `config/thesisInvalidation.json`.
- TradeThesis: stop attaching `quantDetail.tradeThesis` (field is ignored by approval math).
- SMC: leave `QUANT_SMC_STRATEGY_ENABLED` unset; `ALL_STRATEGIES` stays five.
- Bull/Bear: leave `QUANT_BULL_BEAR_ENABLED` unset; debate skips `routeTask` researchers.
- Daily buy notional: paper stays uncapped while `maxDailyBuyNotionalDollars` is 0.

RiskEngine gained an additive `daily_buy_notional` gate. OMS / broker adapters are unchanged.

## Enablement

Never auto-enable SMC, Bull/Bear, or Quant for LIVE. Path: backtest → walk-forward → OOS → paper → explicit flag. Readiness scores do not rise because files were added.
