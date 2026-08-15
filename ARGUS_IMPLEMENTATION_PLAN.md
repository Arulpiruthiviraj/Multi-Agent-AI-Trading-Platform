# ARGUS_IMPLEMENTATION_PLAN.md

## Phases (only A–D started)

| Phase | Status | Live impact |
|---|---|---|
| A Architecture map | This folder of ARGUS_* specs | None |
| B TradeThesis | Assembled on Quant ideas | Additive field only |
| C Regime selector | Already discount + eligibility list | None new |
| D Bull/Bear parser | Config + parser; **not** ChiefTrader | Off |
| E EV | Already on Quant strategy ideas | Unchanged |
| F Position thesis | Config-driven invalidation | Same gates, configurable rules |
| G–L Model tournament, lab UI, paper, restricted live | **Not this pass** | — |

## Rollback

Revert `config/thesisInvalidation.json` / thesis module / `quantDetail.tradeThesis`. No RiskEngine/OMS/Broker diffs intended.

## Enablement

Never auto-enable SMC, Bull/Bear, or Quant for LIVE. Path: backtest → WF → OOS → paper → explicit flag.
