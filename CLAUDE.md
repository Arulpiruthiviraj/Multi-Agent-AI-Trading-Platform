# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server (tsx server.ts, port 3000 - hardcoded in server.ts,
                      # not read from the PORT env var despite the Environment Setup section below)
npm run build        # Vite SPA build + esbuild server bundle → dist/
npm run start        # Run production build (dist/server.cjs)
npm run clean        # Remove dist/ and server.js
npm run lint         # tsc --noEmit
npm test             # vitest run - unit tests for RiskEngine gates, OrderManagement
                      # idempotency/fill-polling, ChiefTraderAgent consensus math, and the
                      # broker adapter contract (capabilities vs. actual placeOrder() behavior)
```

Test coverage is intentionally narrow: the safety-critical decision path (risk gates, order
execution, consensus approval, broker capability claims), not the UI or the AI-provider
integrations. Everything else is still manual-testing only.

**Do not run `npm run db:migrate`** — that script targets a path (`database/migrate.ts`) that does not exist and will fail. Migrations run automatically when `src/server/db/index.ts` is first imported (i.e., on every `npm run dev` / `npm run start`).

## Environment Setup

Copy `.env.example` to `.env`. The `.env.example` lists the main variables; `FINNHUB_API_KEY` is also read by `FinnhubNewsProvider.ts` but is absent from `.env.example` — add it manually if needed.

Key variables:
- `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` — required for real market data and paper/live execution
- `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `MISTRAL_API_KEY` — AI provider(s)
- `ALPHAVANTAGE_API_KEY` / `POLYGON_API_KEY` / `FMP_API_KEY` — market data providers
- `APP_PASSWORD` — enables authentication (disabled by default without it)
- `AUTH_SESSION_SECRET` — required alongside `APP_PASSWORD` in any real deployment
- `ENCRYPTION_SECRET` — AES key for encrypting stored API keys; auto-generated to `data/.encryption_key` if absent
- `PAPER_TRADING_ONLY` — set to `true` to force paper mode in the legacy `/api/v1/signals` endpoint and `AlpacaBroker`
- `PORT` — not actually read; `server.ts` hardcodes port `3000` regardless of this env var

## Architecture

### Process Model

Single Node.js process: Express + Vite dev middleware (in dev) or static file serving (in prod), plus a raw `ws` WebSocket server. The SPA is `src/App.tsx` (~11K lines, single file). The backend entry point is `server.ts` (~3050 lines) — routes, business logic, and the legacy simulation endpoint are all mixed in this file.

### Two Separate Execution Paths

**1. Real agent pipeline (EventBus-driven)**

```
Alpaca WebSocket → eventBus.emit('MARKET_DATA', {symbol, price, volume, timestamp})
    ↓
Independent agents (each on their own timer or MARKET_DATA listener):
  TechnicalAgent       → real RSI/MACD/Bollinger math
  NewsEngine           → real RSS + paid news APIs
  FundamentalAgent     → AlphaVantage + AIRouter (60s timer, 3 hardcoded symbols)
  MacroAgent           → AlphaVantage + AIRouter (75s timer, 3 hardcoded symbols)
  PortfolioMonitor     → real, 60s timer, hardcoded ±5%/-3% exit thresholds
    ↓ eventBus.emit('TRADE_IDEA_GENERATED', {traceId, symbol, side, confidence, reasoning, agent, currentPrice?})
ChiefTraderAgent
  → weights from agent_performance_stats (synced from DB every 10s)
  → optional multi-provider AI debate via AIRouter.routeConsensus (60s per-symbol cooldown)
  → approves if weighted confidence > 0.75
    ↓ eventBus.emit('CHIEF_APPROVED_IDEA', ...)
RiskAgent → RiskEngine.evaluateRisk()
  → refuses if no live price
  → circuit breakers: daily-loss, 3-consecutive-loss, 30% single-symbol concentration
  → real 14-period Wilder ATR sizing (flags 5% fallback if < 15 bars of history)
  → high-impact news veto (news_clusters.impactScore, 4-hour window)
    ↓ eventBus.emit('RISK_ASSESSMENT_COMPLETED', ...)
OrderManagementService → BrokerManager.getActiveBroker().placeOrder(...)
    ↓ db.insert(trades) + eventBus.emit('ORDER_EXECUTED', ...)
    ↓ WebSocket wildcard broadcast → React frontend
```

**2. Legacy simulation endpoint (`GET /api/v1/signals` in `server.ts`)**

Fabricates 9 hardcoded agent objects, votes by count, calls Alpaca REST API directly, writes to `data/portfolio.json`. Bypasses `RiskEngine`, `BrokerManager`, and the `trades` table entirely. Some frontend panels still call this endpoint.

**These two paths do not share state.** The real pipeline's trades go to SQLite; the legacy endpoint's trades go to `data/portfolio.json`.

### EventBus

`src/server/core/EventBus.ts` — Node `EventEmitter` singleton, no in-memory replay beyond `EventStore.ts`'s capped ring buffer, but decision-lifecycle events are durably persisted to the `event_traces` table (see `GET /api/v1/event-traces?correlationId=`). Real market data ticks emit both `MARKET_DATA` and `MARKET_DATA_UPDATED` (via `emitMarketData()`). All events also emit to the wildcard `*` listener used for WebSocket broadcasting.

### AIRouter

`src/server/ai/AIRouter.ts` — singleton, call `AIRouter.getInstance()`. All LLM calls must go through this; never call providers directly. Supports Gemini, OpenAI, DeepSeek, Nvidia, and OpenAI-compatible endpoints (Ollama's local models are reachable this way at `http://localhost:11434/v1`). Handles failover, health tracking, EMA latency scoring, and per-agent routing overrides (`AIRouter.setAgentRoute()` / `GET|POST /api/v1/config/routing`). `estimateCost()` uses real published per-provider pricing; local/Ollama providers cost `$0`.

### Local AI Stack (optional)

Argus can call models running entirely on your own machine instead of a paid cloud LLM — see `docs/LOCAL_AI_SETUP.md`, `npm run setup:ai`. `KronosForecastAgent`/`KronosInference.ts` call a persistent local service (`npm run ai:serve`, `scripts/local_ai_service.py`) that loads `amazon/chronos-t5-mini` via the real `chronos-forecasting` package for genuine numerical price forecasting — this used to be a permanently-throwing stub; it's real now, but requires that service to be running (`KronosModelManager` polls its `/health` every 30s and reports `Warning: Kronos unavailable` honestly if it isn't, same convention as everywhere else). Ollama (`llama3.2`, `0xroyce/plutus`, a locally-built `fingpt`) is checked non-blockingly at boot and logs `[LocalAI] ...`.

### Database

`better-sqlite3` + `Drizzle ORM`, WAL mode. DB file: `data/argus.db` (not tracked in git — see Backup & Restore below). Schema: `src/server/db/schema.ts` (25 tables). Migration files: `drizzle/`. Import `db` from `src/server/db/index.ts` — do not open a second `better-sqlite3` connection to this file from a separate process; on this stack a competing connection has been observed to report a false `SQLITE_CORRUPT` while the app's own connection stays perfectly healthy (verified via `PRAGMA integrity_check` through the live connection).

Key tables: `settings`, `trades`, `portfolio`, `aiProviders`, `aiModels`, `aiUsage`, `learnedRules`, `agentPerformanceStats`, `agentPredictions`, `eventTraces`, `news_articles`, `news_clusters`, `memoryRules`, `agentRoutingOverrides`, `ohlcvBars`, `backtestRuns`.

#### Backup & Restore

- `GET /api/v1/system/export-db` — checkpoints the WAL then downloads `data/argus.db`.
- `POST /api/v1/system/import-db` (raw `application/octet-stream` body) — checkpoints, overwrites `data/argus.db`, requires a restart afterward to take effect.
- Both require an authenticated session when `AUTH_PASSWORD` is set.
- Manual/offline alternative: stop the process, copy `data/argus.db` (and `data/.encryption_key` — losing it makes every encrypted API key in the DB unrecoverable), restore by copying back and restarting.

### Broker Layer

`src/brokers/BrokerManager.ts` — singleton, call `BrokerManager.getInstance()`. Default broker on startup: `InternalPaperBroker` (in-memory, real simulated fills). `AlpacaBroker` is real (paper or live). `InteractiveBrokersAdapter` is a real Client Portal Web API client but requires a human to complete browser 2FA login roughly every 24h (`requiresManualReauth: true`) and cannot place orders on Canadian-exchange equities (IIROC restriction, not a technical gap). `QuestradeBroker` and `CoinbaseBroker` are non-functional stubs — `placeOrder()` throws `Not implemented`.

**Known startup gap**: `BrokerManager.initialize()` is never called from `startServer()`. The default broker is set at `BrokerManager` instantiation time, not via the initialization path.

### Encryption

`src/server/core/EncryptionService.ts` — AES-256-CBC. Uses `ENCRYPTION_SECRET` env var if set; otherwise generates a random key once and saves it to `data/.encryption_key`. All broker and AI provider API keys stored in the DB are encrypted through this service.

### Reflection / Learning Loop

`ReflectionEngine` (60s timer) scores agent predictions against actual price movement, updates `agent_performance_stats.currentWeight`, and writes LLM-generated rule text to `learned_rules`. The weight updates feed back into `ChiefTraderAgent` consensus. The rule *text* in `learned_rules` is loaded into `tradingEngine.state.memoryRules` at boot but is never injected into any agent's actual prompts — the learning loop is write-only for rule text.

### Routes

- `server.ts` — the bulk of routes, all under `/api/v1/`
- `src/server/routes/configRoutes.ts` — mounted at `/api/v1/config`
- `src/server/routes/v2System.ts` — mounted at `/api/v2`

## Known Broken/Non-Functional Components

These are broken by design or by bug — do not describe them as working:

- **~9 frontend chart panels** (win-rate, drawdown, benchmark, heatmap, etc.) — static arrays in `App.tsx`, not backed by real data.
- **`PortfolioMonitor` exit thresholds** — `settings.takeProfitPct` / `settings.trailingStopPct` are never read; hardcoded ±5%/-3% is used.
- **`AdvancedQuantEngines` / `MarketRegimeAgent`** — real math/LLM, but their output events are never consumed by any decision.
- **`archive/python-platform/`** — a disconnected Python/FastAPI reimplementation, moved out of the repo root since the running Node app never imported or called it.

## Adding a New Agent

1. Emit `TRADE_IDEA_GENERATED` with `{traceId, symbol, side, confidence (0–1), reasoning, agent, currentPrice}`.
2. `ChiefTraderAgent` already listens for this event and will pick it up automatically.
3. Add a row to `agentPerformanceStats` with an initial `currentWeight` so the consensus weighting is applied.
4. Do not call `AIRouter` directly from new agents without going through `AIRouter.getInstance().routeTask(agentType, prompt, traceId)`.
