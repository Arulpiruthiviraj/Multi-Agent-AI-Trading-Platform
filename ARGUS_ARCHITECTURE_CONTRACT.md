# ARGUS Architecture Contract

**Status:** Binding. Code + tests beat this file. Adding markdown does not raise LIVE readiness or prove edge.

**Companion files:** `CLAUDE.md`, `ARGUS_ARCHITECTURE_PROTECTION.md`, `ARGUS_ARCHITECTURE_INVARIANTS.md`, `ARGUS_AI_CHANGE_RULES.md`, `src/server/architecture.protection.test.ts`, `src/server/research/phase21.invariants.test.ts`.

If a requested change conflicts with this contract: **stop**, document the conflict, and do not implement a bypass.

---

## 1. Immutable core architecture

Argus is a single Node.js process: Express + Vite SPA + `ws` + SQLite. The live decision path is:

```
MARKET DATA
    ↓
DISCOVERY / UNIVERSE (watchlist subscribe and/or one-vote ideas)
    ↓
CANDIDATE SELECTION
    ↓
SPECIALIZED AGENTS (Technical, Kronos, Quant, Fundamental, Macro, News/Catalyst)
    ↓
CHIEF TRADER / CONSENSUS
    ↓
RISK ENGINE (24 gates, persist-then-emit)
    ↓
POSITION SIZING
    ↓
OMS (sole production placeOrder)
    ↓
BROKER ADAPTER
    ↓
FILL
    ↓
PORTFOLIO / RECONCILIATION
```

SELL / EXIT uses the same spine after PortfolioMonitor / position intelligence emits `TRADE_IDEA_GENERATED`.

Do not replace this spine with a shortcut implementation.

---

## 2. Protected execution spine

Protected (extend through documented interfaces only): `ChiefTraderAgent`, `RiskEngine`, `PositionSizing`, `OrderManagementService`, `BrokerManager` + adapters, reconciliation, kill-switch / trading-state machine, 24 risk gates, 5-layer LIVE arming.

A new `placeOrder` caller, a new `CHIEF_APPROVED_IDEA` emitter outside the reviewed allowlist, or a discovery/scanner OMS path **must fail CI**.

---

## 3. Protected reconciliation behavior

Broker is source of truth for remote quantity. Never auto-flatten unexplained mismatches. Never auto-resume `TRADING_PAUSED`. Operator ack for `FILLED_ORDER_MISSING_LOCALLY`. Interrupted-session recovery may hold **new BUY ideas** until `RECONCILIATION_MATCH`; it must not unpause a kill-switch pause.

---

## 4. Protected risk gates

All 24 gates in `config/riskGateOrder.json` stay recorded. Do not skip, reorder for convenience, or let AI override the first failure. `price_validity` and `data_freshness` remain fail-closed.

---

## 5. Protected consensus requirements

Reviewed JSON (`config/tradingSafety.json`):

- `consensusApprovalThreshold` = **0.75**
- `minIndependentAgreeingAgents` = **2**

Do not lower these to increase trade count. Duplicate same-agent ticks are not independent votes. Stale in-memory votes (`consensusIdeaMaxAgeMs`) must not manufacture a council. `ConsensusDebate` is not an independent confirming agent. Risk-exit `PortfolioManager` SELL may skip debate/min-agents; it **must not** skip RiskEngine/OMS.

---

## 6. Protected paper / live separation

`PAPER_TRADING_ONLY=true` refuses LIVE arm. `evaluateLiveReadiness() !== LIVE_READY` remains LIVE_NO_GO. Do not enable LIVE to prove a feature. Restricted-live file ceilings are not UI knobs.

---

## 7. Protected broker abstraction

All orders go `OMS → BrokerManager.getActiveBroker()`. Discovery, scanners, idea agents, and UI must not call Alpaca (or any broker) order APIs. Sibling engines never receive Argus broker credentials.

---

## 8. Protected OMS boundary

OMS is the sole production `.placeOrder(` caller. Broker timeout stays PENDING / UNKNOWN, never invented FILLED. Whole-share MARKET is current product behavior. Penny/micro MARKET remains unfit until a **reviewed OMS LIMIT** change (`marketOrdersFitPennyAndMicro`). Do not invent LIMIT orders as a drive-by.

---

## 9. Protected kill switch

`emergency-stop` / `TRADING_PAUSED` / `EMERGENCY_STOP` already exist. Do not add a second kill switch. Autobot off blocks new BUY; SELL/exits still require `TRADING_ENABLED`. Process drain may pause trading; that is not auto-resume on next boot.

---

## 10. Protected BUY loop

```
MARKET DATA → UNIVERSE DISCOVERY → CANDIDATE RANK / WATCH
  → AGENT ANALYSIS → MULTI-AGENT CONSENSUS → RISK → SIZE → OMS → BROKER
```

`OpportunityDiscovery` expands the watchlist only (`WATCHLIST_SUBSCRIBE_REQUESTED`). It never emits `TRADE_IDEA_GENERATED` and never places orders. Optional `OpportunityScreener` may emit **one vote** when `ARGUS_OPPORTUNITY_IDEAS_ENABLED=true`. Storm defense: `maxTradeIdeasPerMinute`, `maxAiCallsPerMinute`, per-symbol screener cooldown, bounded subscriptions.

After a dirty OS kill, **new entry ideas** stay held until `RECONCILIATION_MATCH`. That hold must not stop tick caching or inventory SELL.

---

## 11. Protected SELL loop

```
PORTFOLIO → POSITION INTELLIGENCE / PortfolioMonitor
  → EXIT / SELL ANALYSIS → CHIEF TRADER → RISK → OMS → BROKER
```

The SELL loop must operate even if discovery is idle or AI is exhausted. AI failure must not force unsafe selling. `ExitIntelligenceEngine` is a pure evaluator; TRAIL / PARTIAL remain telemetry until REDUCE is a live OMS action. TAKE_PROFIT / EXIT / EMERGENCY_EXIT already emit risk-exit SELL into the spine.

---

## 12. Protected discovery / execution separation

Discovery is not execution. Watching a symbol is not a trade. A shortlist is not ChiefTrader approval. Penny watch is not a penny BUY. `applyAssetIdeaGate` still blocks unfit BUY ideas.

---

## 13. Protected AI failure behavior

All LLM calls go through `AIRouter`. Failures fail-closed to HOLD / confidence 0 / no `CHIEF_APPROVED_IDEA`. Do not make AI mandatory for deterministic Technical math. Do not retry a fully dead provider set on every agent tick (short-circuit + cooldown). Rate-limit AI (`maxAiCallsPerMinute`). Do not remove AI to “make trading simpler.”

---

## 14. Protected restart recovery

```
BOOT → LOAD DIRTY/CLEAN MARKER → INIT BROKER → INIT TRADING ENGINE
  → RECONCILE → VERIFY LOCAL/REMOTE POSITIONS AND OPEN ORDERS
  → RELEASE ENTRY HOLD ONLY AFTER RECONCILIATION_MATCH
```

Do not blindly restore Autobot into unreconciled BUY flow. Do not skip OMS `clientOrderId` crash recovery. Do not auto-resume pause. Clean SIGTERM/SIGINT drain must persist a clean marker.

---

## 15. Application layer, headless runtime, and engine daemon (Phase B–D)

The authoritative trading spine lives in **Argus Core** (`ArgusCoreBoot`, existing singletons). **ArgusApplication** / **ArgusRuntime** are the control facade for Autobot enable/disable and kill-switch transitions from adapters. **ArgusEngineRuntime** is a daemon wrapper around that facade — not a second engine.

| Adapter | Role |
|---|---|
| Express `/api/*` | HTTP control + read APIs (engine process) |
| WebSocket `/ws` | EventBus fan-out (optional; `WS_ENABLED=false` skips it) |
| Vite/static SPA | Presentation (optional when `ARGUS_HEADLESS=true` / `ARGUS_ENGINE=true`) |
| `scripts/argus-engine.ts` | Dedicated daemon entry — same core, no React/Vite |
| `scripts/argus-cli.ts` | Thin HTTP client — never imports OMS/RiskEngine/BrokerManager |

**Invariant:** `POST /api/v2/system/toggle` and all Autobot lifecycle controls must route through `TradingEngine.toggle()`, not direct `SystemBootstrap.start/stop`. Browser, CLI, or WebSocket disconnect must not stop the engine.

See `ARGUS_HEADLESS_ARCHITECTURE.md`, `ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`.

---

## Architectural conflicts (do not silently “solve”)

| Desire | Contract |
|---|---|
| Penny names fill via current MARKET OMS | **Conflict.** `marketOrdersFitPennyAndMicro: false`. Watch + idea-gate BLOCK is allowed. Fake fills are not. |
| Market-wide 5000-name IEX tape | **Conflict.** Alpaca IEX is a bounded subscription feed. Expand `watchUniverseSymbols` / `pennyWatchSymbols` under caps. |
| Lower 0.75 or min-2 so trades occur | **Forbidden.** |
| Discovery `placeOrder` | **Forbidden.** |
