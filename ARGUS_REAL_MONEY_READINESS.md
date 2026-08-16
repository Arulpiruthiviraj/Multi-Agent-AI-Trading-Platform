# ARGUS real-money readiness (Phase 17)

**Date:** 2026-08-16  
**LIVE:** **NO-GO**  
**PAPER:** **CONDITIONAL GO** (Autobot-off still blocks new BUY)

Scores move only when evidence closes a gap. VectorBT installation does **not** raise Quant or Edge.

## Scorecard

| Area | Score | Evidence |
|---|---|---|
| Software | 78 | `npx tsc --noEmit` exit 0. Vitest **932/932**. Research tests added. UI still largely untested. |
| Execution | 55 | Same EventBus → ChiefTrader → RiskEngine → OMS path. VectorBT has `canPlaceOrders: false`. |
| Risk | 72 | No new kill switch. No RiskEngine bypass. Promotion cannot skip RISK_GATE_PASS. |
| AI | 40 | LLM vs empirical probability split (`MODEL_ESTIMATE` / `EMPIRICALLY_VALIDATED` / `UNAVAILABLE`). PIT replay still unavailable. |
| Quant | 48 | Research harness exists; CORE still UNTESTED; SMC UNVALIDATED; QUANT still default off. |
| Paper validation | 28 | Organic filter tightened conceptually; sample still insufficient. |
| Trading edge | **8** | See `ARGUS_TRADING_EDGE_REPORT.md`. |
| Canadian | 35 | Live Canadian execution still blocked. |
| Observability | 58 | Research Lab + VectorBT status. Event-memory remains 410. |
| Data | 40 | Canonical fixture + quality engine. No production Parquet warehouse yet. |
| Research | 45 | Allowlisted CLI, WFO/permutation/cost on golden only. Not a validated book. |
| Broker | 55 | Equity still fail-closed (`null`, never `\|\| 10000`). |
| Operational recovery | 50 | Unchanged Phase 16 startup health; VectorBT listed NOT_CONFIGURED on the registry (no Python spawn on every poll). |

## LIVE

**NO-GO.** Failed gates: essentially all items on `ARGUS_LIVE_CANDIDATE_CHECKLIST.md`.
