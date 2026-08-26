# System Overview

This is a navigational summary, not a second source of truth. **`CLAUDE.md`** (repo root) is the
live, authoritative operational spec — numbers, config keys, and gate behavior here must always
be read from there or from `config/*.json`/the real code, never re-copied and allowed to drift.

## Process model

Single Node.js process: Express + Vite (dev) / static files (prod) + raw `ws`. Backend entry
`server.ts`. Port **3000** hardcoded. Bind `127.0.0.1` unless `AUTH_PASSWORD` is set. Full boot
sequence, hooks, and login-screen effect-ordering gotcha: `CLAUDE.md` §1.

## The live decision spine (do not rewrite, do not duplicate)

```
Alpaca WebSocket → MarketDataWorker.emitMarketData()
       │
       ▼
Idea agents (Technical / News / Fundamental / Macro / PortfolioMonitor / Quant / Kronos /
Opportunity Discovery+Screener) — full list, cadences, and honesty caveats: CLAUDE.md §1
       │  TRADE_IDEA_GENERATED (gated by gateTradeIdea / looksLikeListedTicker)
       ▼
ConfluenceCoordinator (default on) — on a qualifying TechnicalAgent signal, calls
QuantSignalAgent/KronosForecastAgent's existing on-demand entry points for the same symbol
(structurally independent — takes only a symbol, no vote to copy). Raises how often a second
agent evaluates the same symbol in-window; never changes ChiefTrader's weights/threshold.
       │
       ▼
ChiefTraderAgent — weighted consensus, optional AI debate, HOLD-veto
       │  CHIEF_APPROVED_IDEA
       ▼
RiskAgent → RiskEngine.evaluateRisk() — 24 fail-closed gates, serialized mutex
       │  RISK_ASSESSMENT_COMPLETED
       ▼
OMS → BrokerManager.getActiveBroker().placeOrder()
       │
       ▼
trades + fills (unique orderId + cumulativeQuantity) → ORDER_EXECUTED
```

Full detail (thread-safety invariants, fill idempotency, P0.1–P0.7 verified safety invariants,
5-layer LIVE arming): `CLAUDE.md` §1.

**Symbol universe feeding the idea agents above:** a curated seed/watch list, plus — when
`ARGUS_BROAD_UNIVERSE_ENABLED=true` — `MarketUniverseScanner.ts`'s real, liquidity/price/spread/
ADV-screened Alpaca tradable-assets funnel, merged in through the same candidate gate. Off by
default; real API cost when on. Neither path emits a trade idea itself. Detail:
`docs/ARGUS_OPPORTUNITY_DISCOVERY.md`.

**Session-aware layer (new, 2026-08-26, Stage 1 only):** `src/server/premarket/SessionLifecycle.ts`
tracks `PRE_MARKET/REGULAR/AFTER_HOURS/CLOSED` plus an application state, wired into
`ArgusCoreBoot.ts`. Observability only today — does not scan, rank, plan, or emit an idea. A
persisted pre-market `TradePlan`, market-open revalidation, and after-close review are designed
but not yet built; see `CLAUDE.md`'s "Adding discovery or position intelligence" section.

## Protected architecture

`ChiefTraderAgent`, `RiskEngine`, `OrderManagementService`, `BrokerManager` + adapters,
reconciliation, the kill-switch system, the trading-state machine, portfolio accounting, order
lifecycle, fill processing, the 24 risk gates, and paper/live safety controls are **extended
through their documented interface only** — never replaced, bypassed, weakened, or duplicated.
Full contract: `ARGUS_ARCHITECTURE_PROTECTION.md`, `ARGUS_ARCHITECTURE_CONTRACT.md`,
`ARGUS_ARCHITECTURE_INVARIANTS.md`.

## Companion processes (all optional, all outside the decision spine)

| Process | Port | Role | Default |
|---|---|---|---|
| Argus Engine (Node/Vite) | 3000 | The trading system — sole writer of `data/argus.db` | Always on |
| Chronos/Kronos (Python) | 8008 | Local time-series forecasting for `KronosForecastAgent` | On unless `ARGUS_SKIP_CHRONOS=true` |
| Ollama | 11434 | Local LLM inference for AI-routed agents | On unless `ARGUS_SKIP_OLLAMA=true` |
| OpenAlice Guardian MCP | 47332 | Read-only external verification, never a trading path | On unless `ARGUS_SKIP_OPENALICE=true` / `ENABLE_OPENALICE=false` |
| IB Gateway / TWS (external app) | 4002 (paper) / 7497 | Broker socket Argus connects *to* — Argus does not launch or own this process | Probed, never auto-launched |
| Java Quant Core (`quant-core-java/`) | 8085 | **Optional, advisory-only** calculation bridge — see `JAVA_QUANT_CORE.md` | Off unless `QUANT_JAVA_CORE_ENABLED=true` |

None of these processes can place an order, hold broker credentials (except the Argus Engine
process itself), or bypass the spine above. Ecosystem startup mechanics:
`docs/operations/DEVOPS_LIFECYCLE.md`.

## Where to go next

| Question | Doc |
|---|---|
| Exact 24-gate rules and current thresholds | `docs/architecture/RISK_ENGINE_24_GATES.md` → `CLAUDE.md` §2 |
| How ChiefTrader reaches consensus | `docs/architecture/MULTI_AGENT_CONSENSUS.md` |
| Java Quant Core scope/boundaries | `docs/architecture/JAVA_QUANT_CORE.md` |
| AI provider routing, model map | `CLAUDE.md` §3 |
| Decision trace schema, `traceId`/`transactionId` | `CLAUDE.md` §4 |
| Operational state, soak floors, pre-flight runbook | `CLAUDE.md` §5 |
| IBKR / broker connection setup | `docs/operations/IBKR_GATEWAY_SETUP.md` |
| `argus.sh` / ecosystem lifecycle | `docs/operations/DEVOPS_LIFECYCLE.md` |
| Daily Goal Campaign | `docs/operations/CAMPAIGN_MANAGEMENT.md` → `ARGUS_CAMPAIGN_TRACKER.md` |
| Operator/developer forensic debugging | `docs/ARGUS_DOCUMENTATION_INDEX.md` |
