# Argus - ARCHITECTURE

High-level architecture of Argus as actually implemented, verified against source on 2026-08-08. For file-level detail see [AI_CONTEXT.md](./AI_CONTEXT.md); for the risk/broker/Kronos subsystems specifically see their dedicated docs.

## Overview

Argus is a single Node.js process (Express + a raw `ws` WebSocket server) plus a React 19 SPA. Background workers publish "trade ideas" onto an in-process `EventEmitter` (`EventBus`); a consensus class weighs them; a risk engine sizes/vetoes against a broker's real portfolio; an order-management service submits to whichever broker is active. All of this coexists with a second, older, parallel simulation path (`GET /api/v1/signals` in `server.ts`) that bypasses the real pipeline entirely — see [AI_CONTEXT.md](./AI_CONTEXT.md) for why both exist.

## Core Principles (design intent — see notes on actual adherence)

1. **Self-Documenting Code**: most modules carry a header comment declaring inputs/outputs/dependencies. In practice, many of these headers are identical boilerplate copy-pasted across dozens of files and don't describe the specific module — don't rely on a module's header comment as evidence of its behavior.
2. **Provider Agnostic**: real. All AI calls do route through `AIRouter` (`src/server/ai/AIRouter.ts`). What's *not* real: cost-aware routing, since every provider's cost tracking returns `$0` regardless of actual spend.
3. **Event-Driven**: real for the agents that are actually wired up. Two confirmed event-name mismatches mean some listeners never fire — see [EVENTBUS.md](./EVENTBUS.md).

For specific implementation details, see [AI_CONTEXT.md](./AI_CONTEXT.md) and the per-subsystem docs. The `/skills/system_skills/argus-*` directory also contains implementation notes for Claude Code specifically; treat those the same way as the rest of this doc set — verify against source before trusting a specific claim.

## Autonomous Trading Bot Framework

The system runs a distributed set of independent agents, each on its own timer or event trigger — not a single "loop":

- **TechnicalAgent** (`src/server/services/TechnicalAgent.ts`) — ✅ real RSI/MACD/Bollinger Bands math, triggered by real `MARKET_DATA` ticks (requires Alpaca keys).
- **NewsEngine** (`src/server/news/NewsEngine.ts`) — ✅ real, runs every 10s. RSS ingestion (Yahoo/CNBC/WSJ) needs no key; AlphaVantage/Finnhub/Polygon/FMP need their respective keys. AI scoring depends on a working `AIRouter` provider.
- **MacroAgent / FundamentalAgent** — 🟡 real but limited to 3 hardcoded symbols each, dual-gated on AlphaVantage + an AI provider key.
- **KronosEngine** — 🔴 **broken**. See [KRONOS.md](./KRONOS.md) — the inference call unconditionally throws and the trigger agent listens for an event nobody emits.
- **RiskAgent / RiskEngine** — ✅ real ATR-based sizing and circuit breakers computed from real trade history and real broker portfolio state. See [RISK_ENGINE.md](./RISK_ENGINE.md).
- **ChiefTraderAgent** — ✅ real weighted consensus across all contributing agents' ideas, with an optional real multi-provider AI debate step.
- **AdvancedQuantEngines / MarketRegimeAgent** — 🟠 real computation, but their output is never consumed by `ChiefTraderAgent` or `RiskEngine` — it only reaches the frontend over the WebSocket wildcard broadcast, if anything consumes it there (mostly nothing does, per [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md)).

## EventBus Implementation

The system communicates asynchronously over `EventBus` (`src/server/core/EventBus.ts`), a Node `EventEmitter` subclass with no persistence and no replay — anything emitted while a WebSocket client is disconnected is lost for that client. Real market ticks emit `MARKET_DATA` (not `MARKET_DATA_UPDATED` — see the note in [EVENTBUS.md](./EVENTBUS.md) about that specific, confirmed mismatch), which prompts `TechnicalAgent`/`AdvancedQuantEngines` to react; `ChiefTraderAgent` evaluates `TRADE_IDEA_GENERATED`; `RiskEngine` evaluates `CHIEF_APPROVED_IDEA`. Full event list and known mismatches in [EVENTBUS.md](./EVENTBUS.md).

## Database & Persistence

SQLite via Drizzle ORM (`data/argus.db`, `better-sqlite3`, 20 tables, migrations verified in sync with `schema.ts`). Real, actively-used tables include `kronos_predictions` (schema-ready but never populated, since Kronos can't produce a result) and `prediction_engine_weights` (schema exists; the table `ChiefTraderAgent` actually reads for dynamic weights is `agent_performance_stats`, written by `ReflectionEngine`). See [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) for the full verified table list, including which tables have no writer at all.

## Known architectural gaps (not design intent — actual defects)

- `BrokerManager.initialize()` — the method that reads `broker_connections` from the DB and activates the configured broker — is never called anywhere in `server.ts`'s startup sequence. See [BROKER_ENGINE.md](./BROKER_ENGINE.md).
- Two independent Alpaca WebSocket clients run simultaneously (`server.ts` and `MarketDataWorker.ts`), uncoordinated.
- The legacy `/api/v1/signals` simulation path and the real EventBus pipeline are both live in the same process, with separate ledgers.
