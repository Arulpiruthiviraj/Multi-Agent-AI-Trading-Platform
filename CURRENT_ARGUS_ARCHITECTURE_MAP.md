# CURRENT ARGUS ARCHITECTURE MAP

**Date:** 2026-10-08 · **Branch:** `feat/quant-first-decision-architecture` · **HEAD:** `0294373` (on main `5fede80`)
**Purpose:** Part 1 of the architecture conformance audit — working notes produced BEFORE any fix, per the mission prompt.
**Guiding principle:** Argus is a quantitative trading system that can use AI when AI adds value — not an AI trading bot with quant features.

Reference: `~/workspace/argus-trading-docs/CODEBASE_BRIEF.md` (verified against HEAD `008a98f`; re-verify file:line refs).
Canonical doc: `docs/architecture/ARGUS_ARCHITECTURE.md` (single living reference — same-change rule).
Contracts: `ARGUS_ARCHITECTURE_CONTRACT.md`, `ARGUS_ARCHITECTURE_INVARIANTS.md`, `ARGUS_AI_CHANGE_RULES.md`, `ARGUS_ARCHITECTURE_PROTECTION.md` (root).

---

## 1. What Argus is trying to accomplish

Argus is a multi-agent **quantitative** equity/paper trading system. Its objective is narrow and explicit:
recognize legitimate quantitative setups → process them deterministically → execute PAPER trades only when
validated quant rules say a trade is appropriate → manage exits/protective stops → reconcile → explain itself.
Zero trades is a correct outcome when no setup exists. The system optimizes for correctness, determinism,
bounded resource use, and explainability — NOT trade frequency.

## 2. The one canonical execution spine

```
MARKET DATA ──► Discovery/Universe ──► Strategy Layer ──► ChiefTrader (policy router)
      ▲                                                                    │
      │                                                           ┌────────┴────────┐
      │                                                           v                 v
      │                                              QuantExecutionPolicy    ConsensusPolicy
      │                                              (VALIDATED QUANT)       (AI/NEWS/EXPERIMENTAL)
      │                                                           │                 │
      │                                                           └────────┬────────┘
      │                                                                    v
      │                                                          CHIEF_APPROVED_IDEA
      │                                                                    │
      │                                                                    v
      │                                                              RiskAgent (policy-agnostic)
      │                                                                    │
      │                                                                    v
      │                                                          RiskEngine (26 gates, serialized)
      │                                                                    │
      │                                                                    v
      │                                                          PositionSizing
      │                                                                    │
      │                                                                    v
      │                              OMS (sole placeOrder caller; idempotent; crash-recoverable)
      │                                                                    │
      │                                                                    v
      │                       BrokerManager → broker adapter (Alpaca/IBKR/InternalPaper/HistoricalReplay)
      │                                                                    │
      │                                                                    v
      │                              Fills → Portfolio → Reconciliation → Monitoring/Exits
```

**Protected by static tests:** `src/server/architecture.protection.test.ts` (one caller per entry point;
BrokerManager/OrderManagement/RiskEngine imports allowlisted; `trading_state` written from exactly one place).
`src/server/research/phase21.invariants.test.ts` (RiskEngine catalog = 26 gates; no second OMS `placeOrder` path;
consensus floors 0.75 / min-2). Both GREEN (51 tests) as of 2026-10-08.

## 3. Component ownership map (who decides what)

| Component | Owns | Must NEVER |
|---|---|---|
| MarketDataWorker | tick ingestion, freshness ages, subscriptions, tick validation | fabricate ticks; report stale as fresh; use receipt time for freshness |
| OpportunityDiscovery | which symbols deserve *attention* (watchlist-only) | emit `TRADE_IDEA_GENERATED` |
| OpportunityScreener | cheap tick-return rank → exactly one vote, flag-gated, default OFF | more than one vote per cycle |
| TradePlanBuilder | premarket plan (preparation; emission flag-gated, default OFF) | auto-trade the plan |
| SubscriptionAllocator (in MarketDataWorker) | slot allocation, eviction w/ dwell protection | starve emerging candidates |
| StrategyEngine | deterministic strategy evaluation, trigger gate, ranking | force a weak pick |
| QuantSignalAgent | emission of one idea per eligible cycle, agent `QuantEngine` | self-claim VALIDATED |
| StrategyEmissionEligibility | **runtime** lifecycle authority (UNTESTED→…→VALIDATED/CHAMPION→DEGRADED/RETIRED) | invented by anyone but central authority |
| QuantStrategyAuthorization (NEW, stage 1) | central resolver: registry + producer + lifecycle + paper lock → `AUTHORIZED_QUANT_POLICY` | trust producer claims |
| tradeIdeaProvenance (NEW, stage 1) | fail-closed origin normalization (`QUANT_VALIDATED` → `OTHER`) | treat origin as authorization |
| ChiefTraderAgent | **canonical pre-risk authority; policy router** (stage 1): authorized quant → QuantExecutionPolicy; AI/news/experimental → ConsensusPolicy | fabricate consensusConfidence for quant path |
| QuantExecutionPolicy (NEW, stage 1) | deterministic, AI-independent quant checks; never consults AI | duplicate RiskEngine; import AIRouter/BrokerManager/OMS/RiskEngine/EventBus |
| ConsensusPolicy (legacy path) | AI/news/experimental ideas: 0.75 threshold, min 2 independent agents, disagreement penalties | lower thresholds because providers were down |
| AIRouter | provider registry, routing, failover, cooldowns, cost ledger | let trading logic bypass the router |
| AICallGovernor (NEW, stage 2) | 12-gate event-driven gate for ALL optional AI calls; no tick-driven calls | cross-capability failover cost storms |
| JevDecisionProvider (NEW, stage 2) | structured decisions (news relevance, materiality); fail-closed | compute RSI/EV/R:R/size |
| RiskAgent | policy-agnostic forward of CHIEF_APPROVED_IDEA → RiskEngine | quant- or AI-specific alternate path |
| RiskEngine | 26 mandatory gates (kill switch, daily loss, freshness, capital…) | be optional; be bypassed |
| PositionSizing | qty math, concentration caps, notional caps | hardcoded qty; negative qty |
| OMS (OrderManagement) | canonical order lifecycle, idempotency, crash recovery | a second placeOrder path |
| BrokerManager | broker abstraction, PAPER/LIVE explicit | be called by agents/policies directly |
| FillProcessor (fillLedger) | atomic fill + signed inventory + realized P&L | double-count, guess fill on timeout |
| Portfolio | authoritative fill-ledger position vs broker vs cache | manufacture localQty=0 for unsupported |
| Reconciliation | deterministic broker-vs-ledger-vs-portfolio; no AI | auto-acknowledge, auto-flatten |
| PortfolioMonitor | protective exits as SELL ideas re-entering the spine | bypass RiskEngine/OMS |
| TradingEngine | trading_state ownership, kill switch | second kill switch; second engine |

## 4. Deterministic vs optional-AI classification

**Deterministic (must work with ALL AI down):** market data, discovery ranking, subscription allocation,
strategy evaluation, regime, EV/R:R math, lifecycle authority, quant policy, ChiefTrader routing,
RiskEngine, PositionSizing, OMS, BrokerManager, fills, portfolio, reconciliation, protective exits,
trading state, timers/queues (mechanics), SQLite, backups.

**Optional AI enrichment (must degrade gracefully, never block quant):** Jev structured decisions,
NewsAgent escalation, MacroAgent/FundamentalAgent analysis, ConsensusDebate vote (hard HOLD veto but
never required for quant), Bull/Bear researchers, Kronos forecasts, ReflectionEngine, ExplainabilityAgent.

**Genuinely AI-gated (dies by design when AI is down):** ConsensusDebate itself (skipped, not fabricated);
AI-originated research ideas (fail closed). Net: system goes quiet, never rogue.

## 5. Safety boundaries

- LIVE: 5-layer arming + `authorizeProductionOrder` (P0.1) + `evaluateLiveReadiness() !== LIVE_READY` ⇒ no live trading.
  `PAPER_TRADING_ONLY=true` refuses LIVE arm. Restricted-live ceilings ($5k notional, 3 positions, $1k daily loss).
- `LIVE_NO_GO` current. PAPER only.
- One kill switch (emergency-stop / TRADING_PAUSED / EMERGENCY_STOP).
- Reconciliation: broker is source of truth for remote qty; never auto-flatten; never auto-resume pause.
- Consensus floors 0.75 / min-2 are load-bearing (test-enforced).
- Single SQLite writer; migrations on import; failed migration ⇒ process refuses to start.
- One PAPER engine at a time (claimEnginePid; WS ownership).

## 6. Failure propagation rules (intended)

| Failure | Expected behavior |
|---|---|
| All AI providers down | Validated quant path still trades; AI-originated ideas fail closed; debate skipped (telemetry only) |
| Jev down | No fallback cost storm; optional AI becomes UNAVAILABLE; quant unaffected |
| One provider 503/timeout/429/402 | cooldowns (1–30 min), circuit breaker, no unbounded retry; provider stops receiving traffic |
| Market data stale | data_freshness gate rejects; temporaryDataRescue bounded, never fabricates price |
| Broker unreachable | OMS stays PENDING/UNKNOWN, never guessed FILLED; reconciliation flags mismatch |
| DB migration failure | process refuses to start |
| Disk full | free-space preflight; backup pruning in finally; must not silently destroy runtime |
| Unhandled rejection | crash.log + SYSTEM_ANOMALY (P0.6) |
| Restart | restart-safety evaluation may force TRADING_PAUSED; reconcileStaleOrders re-hydrates PENDING |
| Duplicate engine | refused (pid/WS ownership) |

## 7. Stage-1 & stage-2 changes on this branch (already certified)

- `tradeIdeaProvenance.ts`: fail-closed origin normalization. `QUANT_VALIDATED` is NOT a valid origin.
- `QuantStrategyAuthorization.ts`: central resolver — registry + registered producer + DB lifecycle
  VALIDATED/CHAMPION + paper-only lock → `AUTHORIZED_QUANT_POLICY`.
- `QuantExecutionPolicy.ts`: deterministic, AI-independent; never imports AI/broker/OMS.
- `ChiefTraderAgent.reviewIdea`: policy router; approvals converge on canonical `CHIEF_APPROVED_IDEA`.
- `JevDecisionProvider.ts`: structured decisions, key redaction, fail-closed.
- `AICallGovernor.ts`: 12-gate event-driven gate; no cross-capability failover.
- `AiAdvisoryService.ts`: fire-and-forget advisory, never in decision path.
- Anchor: `src/server/quant/AiOfflineQuantCertification.test.ts` — all-AI-down full round trip (BUY→fill→organic exit→flat).
- 262/262 AI tests green; architecture protection green; phase21 invariants green.

## 8. Open audit surface (Parts 4–13, 21–23, 26–43) — being audited in parallel

Market data clocks · discovery ranking/starvation · subscription allocation stress · premarket plan lifecycle ·
fast-lane bounds · strategy inventory & lifecycle authority · signal-generation defects · EV/R:R math ·
regime formulas · RiskEngine gate count/logic · sizing math · OMS idempotency · broker selection ·
fill idempotency (OKTA) · portfolio semantics · reconciliation determinism · protective exits w/o AI ·
trading state · single-engine ownership · timers · queues · event loop · SQLite · backups/disk ·
observability · why-no-trade explainability · provider resilience · cost storms · AI cache/singleflight.
