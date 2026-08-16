# ARGUS Phase 18 — implementation report

## Changed-file inventory (why)

| File | Why |
|---|---|
| `ARGUS_PHASE18_BASELINE_AUDIT.md` | Required pre-change audit |
| `config/strategySpecs.json` | Specs from CORE TS + threshold **keys** |
| `config/researchRejection.json` | Rejection catalog |
| `config/executionModels.json` | NEXT_BAR_OPEN explicit |
| `config/researchSafety.json` | $10k small-account + multiple-testing warn |
| `src/server/research/*` (additive) | Provenance, import, registry, Argus replay, MTF look-ahead, Kelly research label |
| `src/server/research/promotionEngine.ts` | Non-REAL_MARKET_DATA cannot leave UNTESTED |
| `src/server/routes/researchRoutes.ts` | Extra research APIs; still `canPlaceOrders: false` |
| `src/components/ResearchLabPanel.tsx` | Comparison matrix; no fake confidence |
| Reports listed in the spec | Honest UNTESTED / NO EDGE |

**Not rewritten:** RiskEngine, OMS, BrokerManager, ChiefTrader fill path, BacktestEngine.runStrategyBacktest, VectorBT CLI broker isolation.

## What was reused

Phase 17 quality/hash/WFO/permutation/organic paper/promotion booleans. CORE `evaluate()` + `classifyRegime` + indicator feature engines for Argus replay.

## What was not claimed

- VectorBT feature parity for CORE (still PROXY)
- Real SPY/QQQ/IWM warehouse (UNAVAILABLE)
- Any OOS/WFO/paper PASS for CORE
- LIVE or QUANT enablement
