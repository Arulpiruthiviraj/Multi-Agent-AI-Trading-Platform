# AI Context Guide — Argus Autonomous Trading Terminal

**Purpose**: Master current-state reference for AI agents (Claude, GPT, Gemini, etc.) working on this codebase. Every claim in this document was verified directly against source on **2026-08-08** — file paths and line numbers are cited so you can re-verify anything before relying on it. Status legend used throughout: ✅ fully implemented · 🟡 partially implemented · 🟠 prototype/cosmetic · 🔴 broken · ⚪ mocked/simulated · 🔵 planned, not implemented.

**If you are about to describe a feature as "working" in a commit message, PR, or new doc, verify it against the code first.** This repository has a documented history (see `CODE_AUDIT_REPORT.md`, `FINAL_ANALYSIS.md`) of prior agents writing confident documentation that described intended behavior rather than shipped behavior. Kronos, in particular, has been described as "fully implemented" in multiple prior doc revisions while its inference method unconditionally throws.

---

## 🎯 Quick Overview

Argus is a single Node.js process (Express + a raw `ws` WebSocket server, no Socket.IO) plus a React 19 SPA. It runs:
- A real technical-indicator agent driven by real Alpaca tick data (when keyed)
- Real RSS news ingestion (always on, no key needed) plus 4 real paid news APIs (key-gated)
- A real weighted multi-agent consensus (`ChiefTraderAgent`) with an optional real multi-provider AI debate
- A real risk engine with ATR sizing and circuit breakers computed from real trade history
- Real order execution against Alpaca (paper or live) or an in-memory paper simulator; **three other broker adapters (Questrade, Interactive Brokers, Coinbase) are 100% non-functional stubs**
- A Kronos "foundation model" forecasting subsystem that **cannot produce a result under any configuration** (§9)
- Real SQLite persistence via Drizzle, migrations in sync with the schema

There is also a **second, older, parallel execution path**: `GET /api/v1/signals` in `server.ts`, which fabricates 9 hardcoded agent signals, votes by counting, and calls Alpaca's REST API directly with its own separate ledger (`data/portfolio.json`). It bypasses `RiskEngine`, `BrokerManager`, and the `trades` table entirely. Some older frontend panels still call it. When you see "the trading pipeline" referenced elsewhere in this doc set, it means the real EventBus-driven pipeline unless explicitly stated otherwise.

A **separate, fully disconnected Python/FastAPI reimplementation** lives under `python-platform/`. Nothing in the Node application imports or calls it. Do not assume changes there affect the running app.

---

## 📁 Project Structure (verified)

```
Multi-Agent-AI-Trading-Platform/
├── server.ts                    # Main backend entry point (~3,050 lines; routing + business logic + legacy sim mixed together)
├── src/
│   ├── App.tsx                  # Main React application (~11,000 lines, single file)
│   ├── main.tsx                 # React entry point, wraps App in WebSocketProvider
│   ├── components/               # 50+ UI components
│   ├── server/
│   │   ├── ai/
│   │   │   ├── AIRouter.ts      # Provider-agnostic routing, failover, health/EMA tracking
│   │   │   └── providers/       # GeminiProvider, OpenAIProvider, DeepSeekProvider, NvidiaProvider, OpenAICompatibleProvider
│   │   ├── broker/               # BrokerEngine.ts, BrokerPlugin.ts (thin, mostly superseded by src/brokers/)
│   │   ├── core/
│   │   │   ├── EventBus.ts      # Node EventEmitter singleton, ~20 event names
│   │   │   ├── EventStore.ts    # Separate in-memory recentEvents/tradeTraces (NOT the event_traces DB table, which has no writer)
│   │   │   ├── EncryptionService.ts
│   │   │   └── SystemBootstrap.ts
│   │   ├── db/
│   │   │   ├── index.ts         # better-sqlite3 + Drizzle; runs migrations automatically on import; exports `dbPath`
│   │   │   ├── schema.ts        # 20 tables — see DATABASE_SCHEMA.md for the verified list
│   │   │   └── seedModels.ts    # Seeds 6 decorative rows into ai_models (not read by AIRouter's actual routing)
│   │   ├── engines/
│   │   │   ├── TradingEngine.ts # Settings mirror + event log; NOT a loop despite the name
│   │   │   ├── RiskEngine.ts    # Real ATR sizing + circuit breakers
│   │   │   ├── AdvancedQuantEngines.ts  # Real math, output never consumed by any decision (§7)
│   │   │   ├── kronos/          # Broken — see KRONOS.md
│   │   │   └── forecasting/IForecastEngine.ts
│   │   ├── news/                 # Real ingestion pipeline — see below
│   │   ├── routes/
│   │   │   ├── configRoutes.ts  # Mounted at /api/v1/config
│   │   │   └── v2System.ts      # Mounted at /api/v2
│   │   └── services/            # Agents: TechnicalAgent, RiskAgent, FundamentalAgent, MacroAgent,
│   │                             #   PortfolioMonitor, MarketRegimeAgent, ExplainabilityAgent, ChiefTraderAgent,
│   │                             #   ReflectionEngine, KronosForecastAgent, OrderManagement, MarketDataWorker, ...
│   ├── brokers/                  # AlpacaBroker (real), InternalPaperBroker (real sim), QuestradeBroker/InteractiveBrokersAdapter/CoinbaseBroker (stubs)
│   ├── marketdata/
│   └── context/WebSocketContext.tsx
├── python-platform/               # Disconnected Python/FastAPI reimplementation — not called by the Node app
├── drizzle/                       # Migrations, verified in sync with schema.ts
└── *.md                           # Documentation (this file is the master reference)
```

---

## 🏗️ Core Architecture (as implemented, not as designed)

### Real trading pipeline

```
Market Data (Alpaca WebSocket, real if keyed — two independent WS clients exist, see "Known startup issues" below)
         ↓
eventBus.emit('MARKET_DATA', {symbol, price, volume, timestamp})     ← the ONLY real market-data event name
         ↓
┌─────────────────────────────────────────────┐
│  Independent, timer/event-driven agents      │
│  TechnicalAgent      → real math, on MARKET_DATA
│  NewsEngine          → real RSS/API fetch, own 10s timer
│  FundamentalAgent    → AlphaVantage+AIRouter, own 60s timer, 3 hardcoded symbols
│  MacroAgent          → AlphaVantage+AIRouter, own 75s timer, 3 hardcoded symbols
│  PortfolioMonitor    → real, own 60s timer, hardcoded ±5%/-3% thresholds
│  KronosForecastAgent → BROKEN, listens for an event nobody emits (§ KRONOS.md)
│  AdvancedQuantEngines → real math, output never reaches a decision
│  MarketRegimeAgent   → LLM guess (not fed live data), output never reaches a decision
└─────────────────────────────────────────────┘
         ↓  eventBus.emit('TRADE_IDEA_GENERATED', {traceId, symbol, side, confidence (0-1 scale!), reasoning, agent, currentPrice?})
ChiefTraderAgent.evaluateConsensus()
  - weighted by agent_performance_stats.currentWeight (synced from DB every 10s)
  - optional multi-provider AI debate via AIRouter.routeConsensus (60s per-symbol cooldown)
  - approval threshold: weighted confidence > 0.75
         ↓  eventBus.emit('CHIEF_APPROVED_IDEA', {traceId, symbol, side, confidence, reasoning, agentsContext, currentPrice?})
RiskAgent.assessRisk() → RiskEngine.evaluateRisk()
  - refuses without a live price (no fabricated fallback)
  - daily-loss / consecutive-loss / concentration circuit breakers from real `trades` history
  - real ATR (or flagged 5% fallback) for stop distance and position sizing
         ↓  eventBus.emit('RISK_ASSESSMENT_COMPLETED', {traceId, symbol, side, approved, maxQuantity, currentPrice?, stopLossPrice?, atr?, usedFallbackStop?, reasoning})
OrderManagementService.executeOrder()
  - BrokerManager.getActiveBroker().placeOrder(...)   ← real Alpaca call, real sim fill, or throws (Questrade/IBKR/Coinbase)
  - computes realized profitLoss for SELL fills against the portfolio table's cost basis
         ↓  eventBus.emit('ORDER_EXECUTED', {traceId, id, symbol, side, quantity, price, status, profitLoss?})
db.insert(trades, {...})
         ↓
WebSocket wildcard broadcast → React (see "What the frontend actually consumes" below)
```

### Reflection / "learning" loop

`ReflectionEngine` (60s timer) scores agents against real subsequent price movement, updates `agent_performance_stats` (which **does** feed back into `ChiefTraderAgent`'s consensus weights — real influence), and asks an LLM to write one sentence into `learned_rules` after losses. **That rule text is loaded into `tradingEngine.state.memoryRules` at boot but is never injected into any agent's prompt.** The "self-improving system" described in older docs is write-only for the rule *text*; only the numeric weight adjustment closes the loop.

---

## 🔑 Key Components — verified status

### 1. `AIRouter` (`src/server/ai/AIRouter.ts`)
- **Real**: loads providers from `ai_providers`, sorts by priority → health → success-rate → latency, sequential failover on error, logs every call to `ai_usage`, EMA-based health/success tracking, per-provider try/catch around initialization (a bad decrypt on one provider record no longer aborts the whole boot).
- **Fake**: every provider's `estimateCost()` returns `0` — cost tracking is entirely fictional, always `$0`, regardless of real spend. `GeminiProvider.chat()` also hardcodes `tokens: 0`.
- **Bug**: `GeminiProvider`/`OpenAIProvider`/`DeepSeekProvider` all ignore `options.model` and use a hardcoded model string; only `NvidiaProvider`/`OpenAICompatibleProvider` respect a requested model override.
- **Bug**: `OpenAIProvider.initialize()` and `DeepSeekProvider.initialize()` both fall back to `process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY` in the same order — if only one of those two env vars is set, the *other* provider will still "authenticate" and call the wrong vendor's API with the wrong key.
- The `ai_models` table (seeded by `seedModels.ts`, includes a nonexistent `"Claude"` provider) is **decorative** — `AIRouter` never reads it; provider instantiation is driven solely by `ai_providers` rows.
- `configRoutes.ts`'s `/providers` POST handler has a no-op bug: `AIRouter.getInstance().registerProvider(provider, provider)` registers a string where an `AIProvider` instance is expected. A newly saved provider is not actually usable until a full server restart.

### 2. `TradingEngine` (`src/server/engines/TradingEngine.ts`)
- **Not a loop.** It's a singleton holding `settings` mirrored from the DB plus an in-memory event log (`history`, `equityHistory`, `learningJournal`, etc. — all reset on restart, never persisted beyond `settings` and `memory_rules`).
- Listens on `ORDER_EXECUTED` to update `spent` and (as of this doc's audit pass) `currentDailyLoss` with a day-rollover reset — this is a **UI-display mirror only**; `RiskEngine`'s actual daily-loss circuit breaker recomputes independently from the `trades` table, not from this in-memory field.

### 3. `EventBus` (`src/server/core/EventBus.ts`)
- Real Node `EventEmitter` subclass. `emit(event, ...args)` also re-emits as `emit('*', event, ...args)` for wildcard listeners (used by the WebSocket broadcast).
- **Known event-name mismatches** (confirmed by repo-wide search — treat any doc or code comment referencing these as wrong until fixed):
  - `KronosForecastAgent` listens for `'MARKET_DATA_UPDATED'`. The only real emitter (`EventBus.emitMarketData()`) emits `'MARKET_DATA'`. This event never fires for Kronos.
  - `EventStore.ts` and `SystemMetricsWorker.ts` both listen for `'NEW_RULE_LEARNED'`. `ReflectionEngine`'s real emitter (`eventBus.emitLearningEvent()`) fires `'LEARNED_NEW_RULE'`. Neither listener ever receives it.

### 4. `RiskEngine` (`src/server/engines/RiskEngine.ts`) — see [RISK_ENGINE.md](./RISK_ENGINE.md) for full detail
- Real 14-period Wilder ATR from a live 1-minute OHLC bar aggregator (`MarketDataWorker.getBars()`, built from real trade prints) — flat 5% fallback, explicitly flagged, if fewer than 15 bars exist yet.
- Real daily-loss and 3-consecutive-loss circuit breakers, recomputed from `trades.profitLoss` on every call (not from any in-memory counter).
- Real 30% single-symbol concentration cap against the broker's actual portfolio.
- Real high-impact-news veto against `news_clusters.impactScore` (a prior bug queried the wrong table/column, `news_articles`, which has no `impactScore` — fixed).
- Refuses to size a trade with no live price rather than falling back to a hardcoded price.

### 5. Kronos Forecasting Engine (`src/server/engines/kronos/`) — see [KRONOS.md](./KRONOS.md)
- 🔴 **Cannot produce a result under any configuration.** `KronosInference.predict()`'s entire body is `throw new Error('KRONOS_UNAVAILABLE: ...')`. `KronosModelManager` reports a fabricated "Ready" status with hardcoded fake GPU/memory stats. The trigger agent listens for an event that's never emitted (see EventBus mismatches above). There is no Python inference process anywhere in this repository for it to connect to even if the above were fixed.

---

## 🗄️ Database Schema (SQLite via Drizzle) — see [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) for the full verified table list

Quick orientation on the tables most relevant to agent work:
- **`settings`** — single row, trading mode/risk level/budget/broker+provider selection.
- **`ai_providers`** — real provider registry, encrypted keys, health metrics (used by `AIRouter`).
- **`ai_models`** — decorative, not read by routing logic.
- **`ai_usage`** — real per-call log; `cost` column is always `0` (§ AIRouter above).
- **`trades`** — real execution log, including `profitLoss` for SELL fills (added this audit pass — used by `RiskEngine`'s circuit breakers).
- **`portfolio`** — local mirror of broker positions, kept in sync by `PortfolioReconciliationWorker` every 5 minutes.
- **`learned_rules` / `memory_rules`** — real writes from `ReflectionEngine`/user input; **never read back into agent prompts** (see "Reflection / learning loop" above).
- **`agent_performance_stats`** — real, and its `currentWeight` genuinely feeds `ChiefTraderAgent`'s consensus math.
- **`news_articles` / `news_clusters`** — real, written by the real news pipeline.
- **`kronos_predictions`** — schema exists, correctly wired to receive data, but **never populated** because nothing upstream can ever produce a successful prediction.
- **`event_traces`** — schema exists, **no writer anywhere in the codebase**. Don't confuse this with `EventStore.ts`'s separate in-memory `recentEvents`/`tradeTraces`, which is what actually backs the `/api/v2/system/trace/:traceId` and `/api/v2/system/events` endpoints.

---

## 🔌 API Endpoints (verified against `server.ts`/`configRoutes.ts`/`v2System.ts`)

See [API_REFERENCE.md](./API_REFERENCE.md) for the complete, corrected list. Highlights:
- Real config CRUD lives under `/api/v1/config/*` (not `/api/config/*` as older docs claimed).
- `/api/v1/autobot/state`, `/api/v1/autobot/toggle` are real and unauthenticated-by-default (no config-completeness check before `enabled:true` is accepted).
- `/api/v1/backtest` and `POST /api/v2/system/backtest` both return **hardcoded** results regardless of input.
- **These frontend-called routes do not exist on the backend and will 404**: `/api/v1/portfolio/liquidate`, `/api/v1/portfolio/rebalance`, `/api/v1/risk/:vetoId/review`, `/api/v1/scheduler`, `/api/v1/secrets`, `/api/v1/secrets/test`, `/api/v1/settings/toggle-live`.
- There is no `/api/kronos/*` or `/api/market/*` route prefix in this codebase (a prior doc revision invented these). The real Kronos status route is `GET /api/v1/kronos/status`.

---

## 🎨 Frontend Architecture

- **`App.tsx`** — single ~11,000-line component tree with 60+ `useState` hooks, ~38 `fetch()` call sites, and exactly **2** of the ~15 WebSocket event types actually subscribed to (`AUTOBOT_STATE_UPDATED`, `TRADE_IDEA_GENERATED`) via `useWebSocket().subscribe()`. Most broadcast events (risk decisions, order executions, calculation results, Kronos events, system metrics) reach the browser but are never read by any component.
- **~9 chart panels are backed by static, hardcoded arrays** defined at module scope near the top of `App.tsx` (win-rate, drawdown, backtest curve, benchmark, token consumption, heatmap, risk decomposition, latency, swarm transcripts) — confirmed rendered, not dead code, just never replaced with real data.
- **Setup Wizard** (`SetupWizard.tsx`) — its completion state is a plain `useState(false)` in `App.tsx` with no `localStorage`/cookie/backend persistence. It reappears on every refresh and has **zero enforcement power**: `SystemBootstrap.start()` and every worker run unconditionally regardless of whether the wizard ever completed.
- **Styling**: Tailwind CSS v4, dark theme, `#0A0F16`/`#1A1F2B` backgrounds, `indigo`/`emerald`/`amber`/`rose` accents, heavy `font-mono`/`uppercase`/`tracking-widest` — this part of prior docs is accurate.

---

## 🔐 Security & Configuration — see AI_CONTEXT §19 equivalent in the original audit; summarized here

- API keys are encrypted at rest with AES-256-CBC (`EncryptionService.ts`); the key comes from `ENCRYPTION_SECRET` or a randomly generated key persisted to `data/.encryption_key` with a startup warning if unset.
- **Auth is off by default.** `APP_PASSWORD` unset ⇒ every `/api/*` route is open, including trade execution. When `APP_PASSWORD` is set, sessions are real HMAC-SHA256-signed cookies with `timingSafeEqual` comparison and real `/api/v1/auth/login|logout|status` endpoints.
- **The WebSocket (`/ws`) has no authentication at all**, regardless of `APP_PASSWORD` — anyone who can reach the port can see the full live event stream.
- `AUTH_SESSION_SECRET` defaults to the literal string `"default_dev_secret_do_not_use_in_prod"` if `APP_PASSWORD` is set but this isn't — a console warning fires in that case.

Environment variables actually read by the code (cross-check against `.env.example`, which is missing `FINNHUB_API_KEY`):
```bash
GEMINI_API_KEY=
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
ALPACA_API_KEY=
ALPACA_SECRET_KEY=
ALPHAVANTAGE_API_KEY=
POLYGON_API_KEY=
FMP_API_KEY=
FINNHUB_API_KEY=       # used by FinnhubNewsProvider.ts, NOT in .env.example — add manually
ENCRYPTION_SECRET=
APP_PASSWORD=
AUTH_SESSION_SECRET=
AUTH_SESSION_TTL_HOURS=
PORT=                  # defaults to 5000
PAPER_TRADING_ONLY=
```

---

## 🚀 Running the Project

```bash
npm install
npm run dev          # tsx server.ts + Vite middleware, hot reload
```

```bash
npm run build        # Vite build + esbuild bundle to dist/server.cjs
npm start             # node dist/server.cjs
```

`npm run db:migrate` (`tsx database/migrate.ts`) is **broken** — that path doesn't exist in this repo. Migrations already run automatically on every `db/index.ts` import; there is nothing to run manually.

`npm run lint` is a no-op placeholder (`tsx --eval "console.log('Skipping standard TSC compile for rapid deployment')"`) — it does not typecheck or lint anything. Run `npx tsc --noEmit` yourself if you want real type-checking (as of this audit pass, that returns 0 errors in application code; 2 pre-existing errors remain in the untracked, unwired `src/server/backtesting/LookaheadGuard.ts`).

---

## 🧪 Testing & Debugging

- **There is no test suite.** No Jest/Vitest config, no `*.test.ts(x)` files, no `"test"` script in `package.json`.
- **WebSocket debugging**: connect to `ws://localhost:5000/ws` (no auth required, regardless of `APP_PASSWORD`) and watch the wildcard-forwarded event stream.
- **Two independent Alpaca WebSocket clients exist** (`server.ts`'s `initializeAlpacaWebSocket()` and `MarketDataWorker.connectAlpaca()`), both authenticating and subscribing to the same symbols with no coordination — a known inefficiency, not a feature.
- **`BrokerManager.initialize()` is never called from `server.ts`'s startup sequence.** On a fresh boot, `BrokerManager.getActiveBroker()` returns the bare `InternalPaperBroker` placeholder from its private constructor, regardless of what's configured in `broker_connections`. If you're debugging "why isn't my configured broker active," check this first.

---

## 🤖 Agent Guidelines — read [AGENTS.md](./AGENTS.md) for the full current set

The most important corrections to prior guidance:
1. **This system does execute real orders** (via Alpaca, when keyed) — it is not "purely mocked" as an older revision of `AGENTS.md` claimed. Treat any code path that can reach `OrderManagementService.executeOrder()` as live-execution-capable and review changes accordingly.
2. **Do not describe Kronos, Questrade, InteractiveBrokers, or Coinbase as working** in any new documentation or commit message unless you have personally fixed and re-verified them against this audit's findings.
3. **Preserve the EventBus/AIRouter abstraction boundaries** — don't call broker/LLM APIs directly from a new agent; route through `BrokerManager`/`AIRouter`.
4. **Before claiming a fix "closes the loop," check whether the read side actually exists.** The reflection/learning system is the canonical example of a write path that looks complete but has no corresponding read path.

---

## 📚 Key Documentation Files (all corrected 2026-08-08)

- **README.md** — project overview, honest status table
- **ARCHITECTURE.md** / **SYSTEM_DESIGN.md** — component architecture
- **DATA_FLOW.md** / **EVENTBUS.md** — real event flow and the two known name mismatches
- **KRONOS.md** — why it's broken
- **RISK_ENGINE.md** — what's actually computed
- **BROKER_ENGINE.md** — which brokers work
- **DATABASE_SCHEMA.md** — real 20-table schema
- **API_REFERENCE.md** — real routes
- **FRONTEND_GUIDE.md** — real vs. mocked UI
- **AGENTS.md** / **AI_AGENTS.md** / **AI_ROUTER.md** — agent/AI routing guidance
- **DOCUMENTATION_INDEX.md** — full index

---

**Last audited**: 2026-08-08, source-level (every claim checked against code, not against prior docs)
**Version**: reflects the codebase as of this date; re-audit before trusting specific line numbers after further changes
**Maintainer note**: if you update code that this document describes, update this document in the same change — a stale AI_CONTEXT.md is worse than none, because agents trust it by design.
