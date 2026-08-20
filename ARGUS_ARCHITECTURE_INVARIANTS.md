# ARGUS Architecture Invariants

**Instruction to AI agents:** Extend ARGUS around the protected architecture. Never replace the architecture with a shortcut implementation. Binding contract: `ARGUS_ARCHITECTURE_CONTRACT.md`. Change rules: `ARGUS_AI_CHANGE_RULES.md`.

This is the contract. Code + tests beat this file. Adding markdown does not raise LIVE readiness.

## A. Protected execution spine

```
MARKET DATA → CANDIDATE / IDEA AGENTS → TRADE_IDEA_GENERATED
  → ChiefTrader (consensus / debate)
  → RiskEngine (24 gates, persist-then-emit)
  → PositionSizing
  → OMS (sole production placeOrder)
  → BrokerManager / adapter
  → ORDER → FILL → PORTFOLIO → RECONCILIATION
  → continuous position monitoring (SELL ideas re-enter the same spine)
```

Do not add a second `placeOrder` caller. Do not emit `CHIEF_APPROVED_IDEA` from discovery, scanners, or exit intel.

## B. Protected safety boundaries

Do not remove, weaken, or bypass: `PAPER_TRADING_ONLY`, LIVE arming, emergency stop / `TRADING_PAUSED` / `EMERGENCY_STOP`, reconciliation (no auto-flatten, no auto-resume), RiskEngine gates, position sizing, broker safety, ChiefTrader approval, `consensusApprovalThreshold` 0.75, `minIndependentAgreeingAgents` 2, OMS safeguards, fill uniqueness, kill-switch, fail-closed trading, audit/trace logging, idea/AI rate limits.

Do not “fix” a blocked trade by lowering thresholds so that trades occur.

## C. Components that may be extended

- `src/server/continuous/` — watchlist subscribe, candidate lifecycle, optional `OpportunityScreener` `emitTradeIdea` (one vote)
- `src/server/multiAsset/` — classification / safety filters (stricter for pennies, not weaker)
- New idea agents that only `emitTradeIdea`
- Config JSON under `config/` (fail boot on missing required keys)
- Observability / traces / operator UI

## D. Components that must not be bypassed

`ChiefTraderAgent`, `RiskEngine`, `PositionSizing`, `OrderManagementService`, `BrokerManager`, reconciliation, kill-switch / trading-state machine, 24 gates, 5-layer LIVE arming.

`OpportunityDiscovery` must not `emitTradeIdea`. `ExitIntelligenceEngine` must not import EventBus / OMS / brokers. PortfolioMonitor SELL still goes `emitTradeIdea` → (risk-exit may skip debate) → RiskEngine → OMS.

## E. Event-flow contracts

Canonical names: `config/eventNames.json`. Ideas: `eventBus.emitTradeIdea` → `TRADE_IDEA_GENERATED` after `gateTradeIdea` + `applyAssetIdeaGate`. Storm defense: `IDEA_RATE_LIMITED`, `AI_RATE_LIMITED`. Discovery subscribe: `WATCHLIST_SUBSCRIBE_REQUESTED`. Do not invent a parallel order event.

## F. Database invariants

Single writer: import `db` from `src/server/db/index.ts` only. Do not duplicate `trades` / `fills` / `risk_assessments`. Fills unique `(order_id, cumulative_quantity)`. Candidate lifecycle is **in-memory** until a real table is required. Schema catalog: `docs/ARGUS_DATABASE_ARCHITECTURE.md` and `src/server/db/schema.ts`.

## G. Reconciliation invariants

Broker is source of truth for remote qty. Never auto-flatten. Never auto-resume pause. Operator ack for `FILLED_ORDER_MISSING_LOCALLY`.

## H. Order / fill invariants

OMS is the sole production `.placeOrder(` caller. Broker timeout stays PENDING / UNKNOWN, never invent FILLED. No fake fills from tests or scanners.

## I. Paper / live separation

`LIVE_NO_GO` unless `evaluateLiveReadiness() === LIVE_READY` **and** operator LIVE arm. `PAPER_TRADING_ONLY=true` refuses LIVE arm. Restricted-live file ceilings are not UI knobs. Do not enable LIVE to prove a feature.

## J. Required tests for architectural changes

- `src/server/architecture.protection.test.ts`
- `src/server/research/phase21.invariants.test.ts` (OMS sole `placeOrder`)
- Overlay: `src/server/continuous/continuousIntelligence.test.ts`
- Rate limit: `src/server/core/pipelineRateLimit.test.ts`

A change that adds a second broker-order path, a `CHIEF_APPROVED_IDEA` emitter outside the allowlist, or a discovery `placeOrder` **must fail CI**.
