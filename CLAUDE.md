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
npm test             # vitest run - 94 test files / 667+ tests: RiskEngine gates + concurrency
                      # (incl. the shared PositionSizing.ts sizing math, its FIXED_DOLLAR/
                      # PERCENT_OF_EQUITY sizing modes), OrderManagement idempotency/fill-polling/
                      # partial-fills/cancellation, ChiefTraderAgent consensus + Beta-Binomial
                      # confidence calibration + real supportingQuantDetail wiring, backtester
                      # parity (Commissions.ts/Slippage.ts/ReplayClock look-ahead-bias guard,
                      # settings-driven exit thresholds) plus the additive quant layer's own
                      # per-strategy/per-regime backtest, WalkForwardValidator (run()-backed and
                      # quant-strategy-backed), the analysis layer (FailureClassification/
                      # MonteCarlo/AccountSizeReport), broker adapter contracts, the
                      # budget-vs-buying-power start gate (TradingEngine.toggle()), and the full
                      # src/server/quant/ module (indicators/regime/market-context/strategies/
                      # scoring/risk/AI-contradiction). This count drifts fast - trust
                      # `npx vitest run`'s own output over this comment if they disagree.
npx playwright test  # real browser-driven E2E (playwright.config.ts) - currently 1 spec,
                      # e2e/moduleToggleParity.spec.ts. Spins up its own isolated dev server +
                      # temp SQLite DB (never data/argus.db). GOTCHA: a fresh DB force-opens TWO
                      # separate onboarding modals with no persisted dismissal by default - the
                      # Setup Wizard (settings.onboardingComplete, DB-gated) AND a "guided tour"
                      # prompt (AppWalkthrough.tsx, gated by localStorage["argus_tour_seen"] only
                      # - NOT the DB). e2e/globalSetup.ts seeds the former; the spec's own
                      # page.addInitScript() seeds the latter. Both are needed - seeding only one
                      # still blocks every test behind the other.
```

Real coverage now spans the safety-critical decision path (risk gates, order execution,
consensus approval, broker capability claims), backtester/live parity, and one real E2E browser
flow. UI components (`App.tsx`) have no test coverage beyond that one E2E spec and TypeScript's
own compile check - see `FINAL_ANALYSIS.md` (Section 25.3) for the current, actively-maintained
count of which frontend tabs/widgets are real vs. fabricated. Do not trust an older count from
memory - that document is the living source of truth and gets updated as fixes land.

**Do not run `npm run db:migrate`** — that script targets a path (`database/migrate.ts`) that does not exist and will fail. Migrations run automatically when `src/server/db/index.ts` is first imported (i.e., on every `npm run dev` / `npm run start`).

## Environment Setup

Copy `.env.example` to `.env`. The `.env.example` lists the main variables; `FINNHUB_API_KEY` is also read by `FinnhubNewsProvider.ts` but is absent from `.env.example` — add it manually if needed.

Key variables:
- `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` — required for real market data and paper/live execution
- `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `MISTRAL_API_KEY` — AI provider(s)
- `ALPHAVANTAGE_API_KEY` / `POLYGON_API_KEY` / `FMP_API_KEY` — market data providers
- `AUTH_USERNAME` / `AUTH_PASSWORD` — enables authentication (no-auth mode when `AUTH_PASSWORD` is unset; refuses to boot unauthenticated when `NODE_ENV=production`)
- `AUTH_SESSION_SECRET` — required alongside `AUTH_PASSWORD` in any real deployment
- `ENCRYPTION_SECRET` — AES key for encrypting stored API keys; auto-generated to `data/.encryption_key` if absent
- `PAPER_TRADING_ONLY` — set to `true` to force paper mode in the legacy `/api/v1/signals` endpoint and `AlpacaBroker`
- `PORT` — not actually read; `server.ts` hardcodes port `3000` regardless of this env var
- `OPENALICE_ENABLED` / `OPENALICE_MCP_URL` — optional external verification integration, disabled unless both are set (see External Verification below)

## Architecture

### Process Model

Single Node.js process: Express + Vite dev middleware (in dev) or static file serving (in prod), plus a raw `ws` WebSocket server. The SPA is `src/App.tsx` (~11K lines, single file). The backend entry point is `server.ts` (~3050 lines) — routes, business logic, and the legacy simulation endpoint are all mixed in this file.

**Real gotcha in `App.tsx`'s structure, cost a real production bug this session**: the Login screen is a conditional `if (!isAuthenticated) return <Login/>` *inside* the same top-level `App()` function component, appearing textually after most of the component's `useEffect` hooks. Because React hooks always execute during render regardless of a later conditional return in the same function body, EVERY `useEffect` declared above that line runs on mount and starts any interval it sets up - even while the Login screen is the only thing actually rendered. Several fetch-on-mount effects (`fetchState()`'s 9-endpoint `Promise.all` + its 6s interval, `/api/v1/autobot`, `/api/v1/webhooks`) used to fire unauthenticated requests continuously from the login screen, flooding the network with 401s. Fixed by gating each on `isAuthenticated` (hoisted to near the top of the component so effects declared before its original declaration point can depend on it too - `isAuthenticated`'s `useState` call itself has no ordering dependency on anything else, so this hoist is safe). **When adding any new `useEffect` that fetches or opens a connection, gate it on `isAuthenticated` (or place it structurally after the point where an unauthenticated user can never reach it) - the login-screen early-return does not do this for you.**

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
  PortfolioMonitor     → real, 60s timer, exit thresholds from settings.takeProfitPct/trailingStopPct
  QuantSignalAgent     → deterministic regime/strategy engine, off by default (see below)
    ↓ eventBus.emit('TRADE_IDEA_GENERATED', {traceId, symbol, side, confidence, reasoning, agent, currentPrice?})
ChiefTraderAgent
  → weights from agent_performance_stats (synced from DB every 10s)
  → optional multi-provider AI debate via AIRouter.routeConsensus (60s per-symbol cooldown)
  → approves if weighted confidence > 0.75
    ↓ eventBus.emit('CHIEF_APPROVED_IDEA', ...)
RiskAgent → RiskEngine.evaluateRisk()
  → refuses if no live price
  → 11 real gates, checked in order (all recorded even after the first failure, for a full audit
    trail): emergency-stop, daily-loss (80% kill-switch), 3-consecutive-loss, portfolio-drawdown
    (15% from peak equity), order-rate-limit (5/min), market-hours + stale-data (>5min),
    high-impact news veto (news_clusters.impactScore, 4-hour window, direction-blind - a bullish
    article vetoes a SELL exactly like a BUY), price-validity, position-sizing caps (below),
    sell-position-exists
  → position sizing: 20% single-symbol / 40% sector / 50% correlated-exposure (>0.7 real 90-day
    return correlation) concentration caps, sized against a flat 5% stop-loss risk-per-share
    assumption (`STOP_LOSS_ASSUMPTION_PCT` in `PositionSizing.ts`) - **not** ATR-based; a real
    fractional-Kelly/expected-value module exists (`quant/risk/ExpectedValue.ts`, see Additive
    Quant Decision Layer below) but nothing in this live path calls it yet
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

`better-sqlite3` + `Drizzle ORM`, WAL mode. DB file: `data/argus.db` (not tracked in git — see Backup & Restore below). Schema: `src/server/db/schema.ts` (27 tables). Migration files: `drizzle/`. Import `db` from `src/server/db/index.ts` — do not open a second `better-sqlite3` connection to this file from a separate process; on this stack a competing connection has been observed to report a false `SQLITE_CORRUPT` while the app's own connection stays perfectly healthy (verified via `PRAGMA integrity_check` through the live connection).

Key tables: `settings`, `trades`, `portfolio`, `aiProviders`, `aiModels`, `aiUsage`, `learnedRules`, `agentPerformanceStats`, `agentPredictions`, `eventTraces`, `news_articles`, `news_clusters`, `memoryRules`, `agentRoutingOverrides`, `ohlcvBars`, `backtestRuns`, `escalationDecisions`, `openaliceVerifications`, `quant_assessments`, `quant_strategy_backtests`.

#### Backup & Restore

- `GET /api/v1/system/export-db` — checkpoints the WAL then downloads `data/argus.db`.
- `POST /api/v1/system/import-db` (raw `application/octet-stream` body) — checkpoints, overwrites `data/argus.db`, requires a restart afterward to take effect.
- Both require an authenticated session when `AUTH_PASSWORD` is set.
- Manual/offline alternative: stop the process, copy `data/argus.db` (and `data/.encryption_key` — losing it makes every encrypted API key in the DB unrecoverable), restore by copying back and restarting.

### Broker Layer

`src/brokers/BrokerManager.ts` — singleton, call `BrokerManager.getInstance()`. `BrokerManager.getInstance().initialize()` IS called from `server.ts` (`startServer()`) — it resolves the active broker from `brokerConnections`/`settings.selectedBroker` and authenticates it before the server starts serving. Default broker if none is selected: `InternalPaperBroker` (in-memory, real simulated fills, $100k default cash).

- **`AlpacaBroker`** — real, paper or live, the only broker that runs fully unattended.
- **`InteractiveBrokersAdapter`** — real Client Portal (CP) Web API client. Requires a locally-running Gateway process and a human to complete browser 2FA roughly every 24h (`requiresManualReauth: true`); cannot place orders on Canadian-exchange equities (IIROC Dealer Member Rule 3200A.1(b)(i), a regulatory restriction, not a technical gap). **Real gotcha, cost real debugging time to find**: the CP Gateway's own WAF returns a blanket 403 "Access Denied" for any request with no `User-Agent` header — Node's `https.request` sends none by default (unlike curl/browsers), so this can look completely broken (session "unauthenticated") when checked programmatically while curl against the exact same endpoint works fine. The adapter's `request()` method sets one explicitly now; if a future rewrite drops it, this will silently break again. Also: IBKR account IDs prefixed `U` are live/real-money; `DU`-prefixed accounts are paper - the adapter has no independent capability gate on this, it trusts whatever account the Gateway session is logged into.
- **`CoinbaseBroker`** — real, not a stub. CDP-JWT-authenticated, real order placement (crypto spot only), gated behind live-mode confirmation - `placeOrder()` explicitly refuses in paper mode since Coinbase has no sandbox/paper environment to place a paper order against.
- **`QuestradeBroker`** — real read-only access (real OAuth2 account/balance/position/order-history), but `placeOrder()`/`modifyOrder()` permanently throw: Questrade's own API restricts order execution to approved partner developers, a regulatory/business restriction no amount of code here can work around. `BrokerManager` refuses to let it become the active (order-placing) broker regardless of configuration.

### Encryption

`src/server/core/EncryptionService.ts` — AES-256-CBC. Uses `ENCRYPTION_SECRET` env var if set; otherwise generates a random key once and saves it to `data/.encryption_key`. All broker and AI provider API keys stored in the DB are encrypted through this service.

### AutoBot Start Gate (TradingEngine)

`TradingEngine.toggle()` is now `async` (was sync) - it checks the allocated `budget` against the
active broker's real `portfolio().buyingPower`/`cash` on the enable (`enabled:false → true`)
transition only, and rejects with a clear error (not a silent no-op) if the budget exceeds what's
really available. Every caller must `await` it - `autobotRoutes.ts`'s `POST /autobot/toggle` and
`configRoutes.ts`'s `POST /settings` both do. The frontend's "Allocated Budget Limit" input
(Mission Control tab) shows a live "Available: $X" readout next to it (red/green against
`portfolioData.buying_power`/`cash`) and surfaces the backend rejection via `autoBotStartError`
state - previously `toggleAutoBot()` silently discarded `{ok:false, error}` responses entirely.
This balance is only ever fetched into `portfolioData` on the existing polling cadence, not a
dedicated continuous feed - there is no separate "daily capital allowance" concept anywhere in
this codebase (see Known Broken/Non-Functional Components).

### Reflection / Learning Loop

`ReflectionEngine` (60s timer) scores agent predictions against actual price movement, updates `agent_performance_stats.currentWeight`, and writes LLM-generated rule text to `learned_rules`. The weight updates feed back into `ChiefTraderAgent` consensus. The rule *text* in `learned_rules` is loaded into `tradingEngine.state.memoryRules` at boot but is never injected into any agent's actual prompts — the learning loop is write-only for rule text.

### Additive Quant Decision Layer (optional)

`src/server/quant/` — a deterministic technical/regime/strategy engine, entirely additive on top of the pre-existing agents (`RSIEngine`/`MACDEngine`/`TechnicalIndicators`/`PositionSizing`/`BacktestEngine` are reused, never duplicated). Off by default (`QUANT_ENGINE_ENABLED=true`, `QUANT_ENGINE_INTERVAL_MS` optional) — zero behavior change for anyone who hasn't opted in. See `QUANT_LAYER_ANALYSIS.md` for the full architecture rationale, gap analysis against the original 10-phase request, and file-by-file plan this was built from.

- **`quant/indicators/`** — trend (SMA/EMA/DMI/ADX/market-structure BOS/CHoCH), momentum (Stochastic RSI/ROC/Momentum/Williams %R/CCI — real RSI/MACD/OBV/MFI/Fibonacci are reused via `RSIEngine`/`MACDEngine`/`TechnicalIndicators`, not reimplemented), volatility (ATR%/historical vol/percentile/Bollinger width/Keltner), volume (RVOL/session VWAP+slope+reclaim-rejection/CMF/A-D), support/resistance (pivots/swings/premarket/opening-range/Fibonacci).
- **`quant/statistics.ts`** — rolling mean/stddev/z-score/percentile/returns/volatility, correlation/covariance/beta, skewness/kurtosis/autocorrelation. Distinct from `PositionSizing.returnCorrelation`/`AgentSynergy.pearsonCorrelation` (both untouched) — this is the general-purpose version those two narrower implementations could, but don't yet, delegate to.
- **`quant/RegimeEngine.ts`** — `classifyRegime(bars)`: BULLISH_TREND/BEARISH_TREND/SIDEWAYS_RANGE from multiple independent real signals (never a single indicator), with dead-zones and a minimum-real-votes guard against forcing a directional call out of noise. Distinct from `MarketRegimeAgent.ts` (LLM-guessed, not price-derived) and `AdvancedQuantEngines.ts` (real ATR/ADX/VWAP telemetry, never consumed) — neither is modified.
- **`quant/MarketContext.ts`** — SPY/QQQ/IWM/sector-ETF regime + relative strength vs. each, using the same `HistoricalDataGateway`/`ohlcv_bars` source everything else uses. Breadth metrics honestly report `available:false` — no real market-breadth data source exists in this codebase.
- **`quant/strategies/`** — 5 real strategies (Momentum Breakout, Pullback Continuation, Mean Reversion, Trend Following, Range Reversion), each a pure `evaluate(ctx)` returning `{side, setupScore, confidence, conditionsMet/Failed, contradictions, invalidationConditions, stop, target}`. `StrategyEngine.evaluateAll()` discounts (never zeroes) a strategy's confidence when the current regime doesn't match its own `applicableRegimes`.
- **`quant/scoring/GroupedScores.ts`** — the "probabilistic decision layer": grouped 0-100 scores (trend/momentum/volatility/volume/vwap/market/sector/relativeStrength/priceStructure/overall) for a candidate side. Correlated oscillators (RSI/StochRSI/CCI/Williams %R) are blended into one reading, never counted as independent votes — see the file's own header for the exact reasoning.
- **`quant/risk/ExpectedValue.ts`** — real risk/reward ratio, expected value (in R), and fractional Kelly. Kelly refuses below 20 real closed trades backing the win-rate estimate, and its suggested fraction is hard-capped at 10% of capital regardless of what the raw formula computes — never a replacement for `RiskEngine`'s own hard caps.
- **`quant/ai/QuantContradictionAnalyzer.ts`** — the one real AI integration point in this layer: qualitative contradiction/scenario review over the deterministic output above, via the same `AIRouter.routeTask()` every other agent uses. Never returns (or lets a caller derive) a new side/confidence — a real AI disagreement is recorded (`disagreementNote`) alongside the deterministic value, never used to overwrite it.
- **`QuantSignalAgent.ts`** (`src/server/services/`) — the real agent wiring all of the above into the existing pipeline: a 5-minute timer over real daily bars, emitting `TRADE_IDEA_GENERATED` as `agent:'QuantEngine'` (a weight for that exact name already existed in `ChiefTraderAgent`'s `agentWeights`) with an additive `quantDetail` field carrying the full structured assessment. `ChiefTraderAgent`'s approval event gains a matching additive `supportingQuantDetail` field (selected strategy, regime, setup scores, contradictions, invalidation conditions, proposed entry/stop/target, expected holding period, AI review) whenever QuantEngine contributed evidence — `RiskEngine` is never bypassed by any of this.
- **`BacktestEngine.runStrategyBacktest()`** — a separate entry point from the existing `run()` (untouched) for backtesting one named strategy against one symbol, long-only (matches this codebase's real no-short-selling broker capability), with real regime-segmented results, a real backtest-derived EV/Kelly readout (never an assumed win probability), a real buy-and-hold benchmark comparison (traded symbol + SPY, from bars already loaded), and a real per-losing-trade failure classification (`quant/analysis/FailureClassification.ts` — only categories genuinely derivable from this engine's own telemetry, e.g. BAD_REGIME/SIGNAL_CONFLICT/STOP_LOSS_HIT/SLIPPAGE_DRAG; categories needing live AI/news/RiskEngine involvement are explicitly left unimplemented rather than faked).
- **`WalkForwardValidator.ts`** — rolling train/test window splitter reporting real in-sample-vs-out-of-sample performance. Supports both the original `run()`-backed mode (`symbols`) and a `runStrategyBacktest()`-backed mode (`strategyId`+`symbol`) for the quant strategies above. `testDays` must exceed the underlying backtest's own minimum-bar requirement (`LOOKBACK`=50 for `run()`, `REGIME_MIN_BARS`=60 for `runStrategyBacktest()`) or every window throws. `POST /api/v1/backtest/walk-forward`.
- **`quant/analysis/MonteCarlo.ts`** — seeded, deterministic bootstrap resampling over a real completed backtest's closed-trade R-multiples. Always labeled `scenarioAnalysis:true`, never a prediction; refuses `statisticallyJustified` below the same 20-trade threshold `ExpectedValue.ts`'s Kelly uses. `POST /api/v2/quant/strategy-backtests/:id/monte-carlo`.
- **`quant/analysis/AccountSizeReport.ts`** — real whole-share capital-utilization scenarios across account sizes ($100-$100k by default); honestly reports "TRADE NOT POSSIBLE - WHOLE SHARE CONSTRAINT" rather than assuming fractional shares (no broker adapter in this codebase supports them). Included in `runStrategyBacktest()`'s live return value.
- **Position sizing modes** (`PositionSizing.ts`) — `settings.positionSizingMode`: `FIXED_DOLLAR` (default, unchanged behavior — `settings.maxTradeSize` as a flat dollar cap) or `PERCENT_OF_EQUITY` (`settings.percentOfEquityPct`, scales the order-notional cap with current equity). Every other cap (risk-based, buying-power, concentration, correlation) applies unchanged under either mode.
- **Observability**: `GET /api/v2/quant/strategies`, `GET /api/v2/quant/assessments/:symbol`, `GET|POST /api/v2/quant/strategy-backtests`, `GET /api/v2/quant/strategy-backtests/:id` (now also returns `failureBreakdown`/`benchmarkComparison`), `GET /api/v2/quant/strategy-backtests/:id/decision-log` (only populated when that run was triggered with `verboseLogging:true`), `POST /api/v2/quant/strategy-backtests/:id/monte-carlo` — the Scanner tab's "Quant Decision Layer" panel (`QuantSignalsPanel.tsx`) reads the first four. See `BACKTEST_QUANT_HARDENING_ANALYSIS.md` for the full E1-E7 hardening pass this paragraph documents.

### External Verification (OpenAlice, optional)

`src/server/integrations/openalice/` — an optional, off-by-default integration with [OpenAlice](https://github.com/TraderAlice/OpenAlice), a separate, independent AI research system, reached only over MCP (`@modelcontextprotocol/sdk`, already a real dependency, previously unused). Read-only and non-blocking by design: `OpenAliceAdapter` files an OpenAlice `issue_create` request and returns immediately; `OpenAliceVerificationService` polls OpenAlice's inbox (`inbox_read`, matched via `origin.issueId`) every 30s in the background and emits `OPENALICE_VERIFICATION_REQUESTED` / `_COMPLETED` / `_TIMED_OUT` once a real reply (or timeout, after 24h) arrives — this can take minutes to hours, since OpenAlice has no synchronous "give me a verdict now" tool. Results are persisted to `openaliceVerifications` and only ever inform *future* decisions; nothing here can alter or block a trade that already executed, and OpenAlice is never given credentials or an edge into `BrokerManager`/`RiskEngine`.

`ChiefTraderAgent` fires a verification request (fire-and-forget, after its own approval) only when `shouldTriggerOpenAliceVerification()` (`EscalationPolicy.ts`) says the approval is worth a second opinion — confidence in the uncertain band `[0.75, 0.85]`, or any agent disagreement recorded by `EvidenceAggregator`. Disabled unless both `OPENALICE_ENABLED=true` and `OPENALICE_MCP_URL` are set; `IntegrityValidator`'s `openalice_reachable` check reports `UNKNOWN` (not a failure) when disabled. **Not live-verified against a real running OpenAlice instance** — no instance exists in this environment; the request-building, inbox-parsing, and trigger logic are unit-tested against a mocked adapter instead. See `OPENALICE_INTEGRATION_AUDIT.md` for the full architecture rationale (independence scoring, failure-state matrix, why Phases 5-7 — paper-trading evaluation, statistical evaluation, adaptive signal — are deliberately not implemented yet).

### Routes

- `server.ts` — the bulk of routes, all under `/api/v1/`
- `src/server/routes/configRoutes.ts` — mounted at `/api/v1/config`
- `src/server/routes/v2System.ts` — mounted at `/api/v2`, includes `POST /trading/execute-override` (real manual consensus-bypass order, still routed through the full real RiskEngine gate ladder - never calls `OrderManagementService` directly), `GET /market/sentiment-trend` (real daily-averaged `news_articles.sentimentScore`, **-1 to +1 scale, not 0-100** - it's an easy scale to get wrong, ask why before assuming any 0-100 UI element is honest), and `GET /trading/execution-quality` (real order submit-to-fill latency; deliberately has no slippage field - neither `trades` nor `risk_assessments` persists the price a proposal was evaluated against, so there's no real number to report there yet)

## Known Broken/Non-Functional Components

These are broken by design or by bug — do not describe them as working. **This list is not
exhaustive and drifts fast; `FINAL_ANALYSIS.md` is the actively-maintained, section-numbered audit
of exactly which of the 20 frontend tabs/individual widgets are real vs. fabricated as of its most
recent pass (currently Section 25) - check there before asserting a UI element's status, don't
assume this list is current.** Order Book (L2) depth heatmap in Trading Arena is a confirmed
permanent case, not just "not yet wired": no L2 market-data source exists anywhere in this
codebase (Alpaca's IEX feed is top-of-book only), so it now renders an honest
"L2 Depth Data Unavailable" state rather than a fake ladder - real L2 support would need a new
paid-tier data-provider integration, not just backend wiring.

- ~~**`PortfolioMonitor` exit thresholds** — `settings.takeProfitPct` / `settings.trailingStopPct` are never read~~ — **fixed** (BACKTEST_QUANT_HARDENING_ANALYSIS.md E2A): both `PortfolioMonitor.ts` and `BacktestEngine.run()` now read the same `settings.takeProfitPct`/`trailingStopPct` row, closing the live/backtest exit-assumption mismatch.
- **`AdvancedQuantEngines` / `MarketRegimeAgent`** — real math/LLM, but their output events are never consumed by any decision. Distinct from, and unrelated to, the newer `src/server/quant/`/`QuantSignalAgent.ts` layer (see "Additive Quant Decision Layer" above) - that one's output *is* consumed by `ChiefTraderAgent`, when enabled.
- **`archive/python-platform/`** — a disconnected Python/FastAPI reimplementation, moved out of the repo root since the running Node app never imported or called it.
- **Position sizing capital cap is a flat dollar amount, not %-of-equity** — `settings.maxTradeSize` (`PositionSizing.ts`'s `maxSharesByCapital`) caps every trade at the same dollar figure (default $3,000) regardless of account size; on a large account this becomes the binding constraint far below the real 20% single-symbol cap, silently capping total returns without silently capping risk.
- **No fractional/notional share support anywhere in the broker layer** — `PositionSizing.ts` always does `Math.floor(dollars / price)`, and `AlpacaBroker.placeOrder()` only ever sends `qty` (never Alpaca's real `notional` order parameter). Any account with less capital than one share's price of its target symbol cannot trade that symbol at all.
- **No daily capital-deployment cap** — `settings.dailyLossLimit` is a loss-triggered kill-switch, not a cap on total dollars *deployed* per day; nothing in `RiskEngine.ts`'s gate list limits cumulative daily buy notional independent of whether those trades are winning.

## Adding a New Agent

1. Emit `TRADE_IDEA_GENERATED` with `{traceId, symbol, side, confidence (0–1), reasoning, agent, currentPrice}`.
2. `ChiefTraderAgent` already listens for this event and will pick it up automatically.
3. Add a row to `agentPerformanceStats` with an initial `currentWeight` so the consensus weighting is applied.
4. Do not call `AIRouter` directly from new agents without going through `AIRouter.getInstance().routeTask(agentType, prompt, traceId)`.
