# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server (tsx server.ts, port 5000)
npm run build        # Vite SPA build + esbuild server bundle → dist/
npm run start        # Run production build (dist/server.cjs)
npm run clean        # Remove dist/ and server.js
```

**No test suite exists.** `npm test` is undefined. There is no test runner configured. Manual testing only.

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
- `PORT` — defaults to `5000`

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

`src/server/core/EventBus.ts` — Node `EventEmitter` singleton, no persistence, no replay. Subscribe with `eventBus.on('EVENT_NAME', handler)`. The only real market-data event is `MARKET_DATA` (not `MARKET_DATA_UPDATED` — this mismatch is why `KronosForecastAgent` never fires). All events also emit to the wildcard `*` listener used for WebSocket broadcasting.

### AIRouter

`src/server/ai/AIRouter.ts` — singleton, call `AIRouter.getInstance()`. All LLM calls must go through this; never call providers directly. Supports Gemini, OpenAI, DeepSeek, Nvidia, and OpenAI-compatible endpoints. Handles failover, health tracking, and EMA latency scoring. Cost tracking is implemented but always returns `$0` — `estimateCost()` is not implemented in any provider.

### Database

`better-sqlite3` + `Drizzle ORM`. DB file: `data/argus.db`. Schema: `src/server/db/schema.ts` (20 tables). Migration files: `drizzle/`. Import `db` from `src/server/db/index.ts` — do not open a second `better-sqlite3` connection.

Key tables: `settings`, `trades`, `portfolio`, `aiProviders`, `aiModels`, `aiUsage`, `learnedRules`, `agentPerformanceStats`, `agentPredictions`, `eventTraces`, `news_items`, `news_clusters`, `memoryRules`.

### Broker Layer

`src/brokers/BrokerManager.ts` — singleton, call `BrokerManager.getInstance()`. Default broker on startup: `InternalPaperBroker` (in-memory, real simulated fills). `AlpacaBroker` is real (paper or live). `QuestradeBroker`, `InteractiveBrokersAdapter`, `CoinbaseBroker` are non-functional stubs — `placeOrder()` throws `Not implemented`.

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

- **Kronos** (`src/server/engines/kronos/`) — `KronosInference.ts` unconditionally throws; `KronosForecastAgent` listens for `MARKET_DATA_UPDATED` which nothing emits. Cannot produce output under any configuration.
- **Backtesting** (`GET /api/v1/backtest`, `POST /api/v2/system/backtest`) — both return hardcoded numbers regardless of input.
- **AI cost tracking** — every provider's `estimateCost()` returns `0`; all logged costs are `$0`.
- **~9 frontend chart panels** (win-rate, drawdown, benchmark, heatmap, etc.) — static arrays in `App.tsx`, not backed by real data.
- **`PortfolioMonitor` exit thresholds** — `settings.takeProfitPct` / `settings.trailingStopPct` are never read; hardcoded ±5%/-3% is used.
- **`AdvancedQuantEngines` / `MarketRegimeAgent`** — real math/LLM, but their output events are never consumed by any decision.
- **`python-platform/`** — a disconnected Python/FastAPI reimplementation. The running Node app does not import or call it.

## Adding a New Agent

1. Emit `TRADE_IDEA_GENERATED` with `{traceId, symbol, side, confidence (0–1), reasoning, agent, currentPrice}`.
2. `ChiefTraderAgent` already listens for this event and will pick it up automatically.
3. Add a row to `agentPerformanceStats` with an initial `currentWeight` so the consensus weighting is applied.
4. Do not call `AIRouter` directly from new agents without going through `AIRouter.getInstance().routeTask(agentType, prompt, traceId)`.
