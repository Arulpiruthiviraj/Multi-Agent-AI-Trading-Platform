# ARGUS PHASE NEXT — Multi-model orchestration, capital isolation, observability

**Date:** 2026-08-15  
**Verdict:** This pass makes Argus **more observable and capital-bounded**. It does **not** make Argus profitable, model-accurate, or real-money ready.  
**RESTRICTED-LIVE GO: NO. AUTONOMOUS-LIVE GO: NO.**

Models produce **evidence**. Only RiskEngine-approved OrderManagement may submit to a broker.

---

## What this pass actually did

The existing EventBus pipeline (agents in parallel → ChiefTrader → RiskEngine → OMS → broker) was **preserved**, not replaced with a new sequential orchestrator. Independent agents already run on their own timers/`MARKET_DATA` listeners. Forcing every tick through Chronos → Kronos → OpenAlice → Ollama would be slower, more expensive, and would not make the models more truthful.

### 1. Capital isolation (hard server-side)

- `settings.budget` (Autobot “Allocated Budget Limit”) is now an **Argus authority ceiling**, not a UI hint.
- New gate `argus_capital_allocation` in `RiskEngine` after position sizing.
- Used capital = broker position cost (`qty × averagePrice`) + reserved non-terminal BUY notionals.
- BUY notional must be `<= remaining`. SELL does not consume allocation.
- Broker buying power of $2,000 does **not** authorize a $101 BUY against a $100 allocation.
- Allocation is a **maximum**, not a reason to size more aggressively.

OMS now writes the **intended price** on the PENDING trade row (was `0`), so pending BUYs can reserve capital before the fill.

### 2. Model runtime registry (probe / reuse, optional spawn)

`ModelRuntimeManager` health-checks:

| Id | How started | Default at `npm run dev` |
|----|-------------|---------------------------|
| Ollama `localhost:11434` | Reuse if healthy; spawn `ollama serve` only if `ARGUS_START_LOCAL_MODELS=true` | Probe only |
| Chronos/Kronos `localhost:8008` (`npm run ai:serve`) | Reuse if healthy; spawn only if `ARGUS_START_LOCAL_MODELS=true` **and** `ARGUS_START_CHRONOS=true` | Probe only (loading Chronos on every boot would stall the machine) |
| OpenAlice MCP | Never spawned | `DISABLED` unless `OPENALICE_ENABLED=true` |
| IBKR Gateway | Never spawned (2FA) | `DISABLED` unless `IBKR_GATEWAY_URL` or `ARGUS_PROBE_IBKR=true` |

Failed optional models do **not** block boot. They are logged `FAILED` with a reason/action and shown in the UI. Capabilities listed in the registry are only those the existing code actually uses (no fabricated PATTERN_RECOGNITION, etc.).

### 3. Portfolio surveillance (independent of new entries)

`PortfolioMonitor` already ran every 60s. It now also emits `POSITION_MONITORED` (and `POSITION_RISK_CHANGED` when drawdown is elevated) using **real** entry/current/PnL/quant stop-target/thesis fields. Hard stops still emit a PortfolioManager SELL immediately — they do **not** wait for AI consensus.

This is **not** a full Chronos/Kronos/OpenAlice re-forecast on every position every minute. That would be a new, expensive loop that does not exist today and would fabricate “forecast” nodes if the local service is down.

### 4. Observable events (real, not animated fiction)

Persisted (EventStore) in addition to the existing decision lifecycle:

- `CAPITAL_CHECK`
- `AGENT_DISAGREEMENT` (structured BUY/SELL/HOLD evidence; not a blind average)
- `POSITION_MONITORED` / `POSITION_RISK_CHANGED`
- `MODEL_HEALTH`

DigitalTwinVisualizer lights **Capital Guard** and portfolio nodes only from these WebSocket events.

### 5. Frontend

- `OrchestrationStatus`: model READY/FAILED + broker equity vs Argus used/remaining from `GET /api/v2/orchestration/*`.
- Allocated budget input `min` lowered from 1000 → 1 so a $100 slice is configurable.
- Transaction modal still replays **that trace’s real stages** only.

---

## Files added

- `src/server/engines/CapitalAllocation.ts`
- `src/server/engines/CapitalAllocation.test.ts`
- `src/server/ai/ModelRuntimeManager.ts`
- `src/server/ai/ModelRuntimeManager.test.ts`
- `src/server/routes/v2System.orchestration.test.ts`
- `src/components/OrchestrationStatus.tsx`
- `ARGUS_PHASE_NEXT_ORCHESTRATION_REPORT.md` (this file)

## Files changed

- `src/server/engines/RiskEngine.ts` + `RiskEngine.test.ts`
- `src/server/services/OrderManagement.ts` + `OrderManagement.test.ts`
- `src/server/services/PortfolioMonitor.ts` + `PortfolioMonitor.test.ts`
- `src/server/services/ChiefTraderAgent.ts`
- `src/server/core/EventStore.ts`
- `src/server/routes/v2System.ts`
- `server.ts`
- `src/components/DigitalTwinVisualizer.tsx`
- `src/components/NodeInspectionPanel.tsx`
- `src/App.tsx`

## Existing functionality preserved

- RiskEngine gate ladder (all gates still recorded; first failure still wins).
- ChiefTrader two-agent floor, debate wait, HOLD/AI veto, PortfolioManager risk-exit skip.
- Quant strategies, `BacktestEngine.run()` / `runStrategyBacktest()`, walk-forward — **not modified**.
- Restricted-live caps, emergency stop, daily-loss, drawdown, news veto, OMS idempotency.

Backtest does **not** use the Argus-allocation gate: a backtest already simulates a dedicated account, not a $100 slice of a larger live account. Live/paper RiskEngine does.

---

## Order authorization (no model bypass)

Authoritative live/paper path:

`CHIEF_APPROVED_IDEA` → `RiskEngine.evaluateRisk()` → `RISK_ASSESSMENT_COMPLETED` (`approved` + `maxQuantity > 0`) → `OrderManagement.executeOrder()` → `BrokerManager.getActiveBroker().placeOrder()`.

No agent/model calls `placeOrder`.

**Still present (legacy, not this pipeline):** `GET /api/v1/signals` in `server.ts` can still hit Alpaca REST and `data/portfolio.json`. That path remains a separate, documented hazard. It was not deleted in this pass (would be a behavior change for any UI still calling it). It is **not** the EventBus pipeline.

Manual override `POST /api/v2/trading/execute-override` still goes through RiskEngine.

---

## Tests

Targeted orchestration files: **67/67 passed**.

```
CapitalAllocation.test.ts
RiskEngine.test.ts (incl. $101 reject / $60 then $50 reject)
ModelRuntimeManager.test.ts
OrderManagement.test.ts (PENDING intended price)
PortfolioMonitor.test.ts (POSITION_MONITORED)
v2System.orchestration.test.ts
ChiefTraderAgent.test.ts
```

Capital scenario (server-side):

| Setup | Order | Result |
|-------|-------|--------|
| Broker $2,000, Argus $100, unused | BUY $101 | **REJECT** |
| Same | BUY $60 | **APPROVE** |
| After $60 fill ($40 remaining) | BUY $50 | **REJECT** |

Full `npx vitest run` in this environment: **718 passed, 2 failed, 45 skipped, 8 suites hook-timeout** under default parallel workers. The same timed-out files **pass serially** (`--maxWorkers=1`): TradingEngine, marketDataToRisk, AlertingService, AIFailureCircuitBreaker, orchestration capital route. The failures are 10s `beforeAll`/`beforeEach` hook timeouts under parallel DB+OpenAlice/Kronos probe load from `.env`, not assertion failures in the new capital gate.

Not re-run here as live processes: paper trading session, Chronos GPU load, IBKR Gateway 2FA, Playwright E2E.

---

## What was deliberately not built (honesty)

The prompt asked for a full sequential “every model on every opportunity” DAG, animated fake-or-real Chronos/Kronos/OpenAlice on every news tick, step-speed replay 0.5x–10x of historical DB traces, a complete filtered trading ledger UI, “why Argus traded / did not trade” narrative pages, intelligent trigger policy (breakout vs emergency), and crash-recovery tests for the new manager.

Those are **not** all in this diff:

- Agents already run in parallel; a new blocking DAG would change live latency and still would not authorize trades.
- Visualization does **not** light Chronos/Kronos unless `MODEL_HEALTH` or a real Kronos/Technical event arrives.
- Replay is the existing trace-stage list from **in-session** WebSocket events, not a new 0.5x–10x player over `event_traces` (those rows are already queryable via `GET /api/v2/system/trace/:traceId`).
- “Why not trade” remains RiskEngine `reasoning` + ChiefTrader `NO_CONSENSUS` / disagreement events — no new marketing copy generator.
- Model spawn is **opt-in** so `npm run dev` does not load PyTorch.

---

## Remaining risks / real-money impact

Unchanged NO-GO drivers from Phase 15/16:

- No statistically meaningful closed paper track record.
- NewsAgent / LLM accuracy is not validated by this UI.
- Legacy `/api/v1/signals` still exists.
- No fractional shares; allocation can reject an entire symbol if one share exceeds remaining.
- Chronos/Kronos/OpenAlice/Ollama remaining **FAILED** is expected until those processes are actually running; Argus must stay usable.

**Do not** enable unrestricted live trading because the graph looks alive.

---

## How to operate the new controls

1. Set Autobot allocated budget to the Argus slice (example: `$100`).
2. Optional: `ARGUS_START_LOCAL_MODELS=true` to spawn Ollama if down; add `ARGUS_START_CHRONOS=true` only if you want `npm run ai:serve` at boot.
3. Watch Mission Control Network Topology: model statuses and broker vs Argus remaining.
4. A capital rejection appears as RiskEngine veto + `CAPITAL_CHECK` with `passed: false`.
