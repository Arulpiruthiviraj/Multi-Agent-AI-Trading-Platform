# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

Argus is a Node.js multi-agent trading terminal (Express + Vite SPA + `ws`). The **live decision path** is EventBus → agents → ChiefTrader → RiskEngine → OMS → BrokerManager. Do not rewrite that path. New work is additive, modular, feature-flagged, tested, and backward compatible.

## Ground truth (do not inflate)

| Document | Use for |
|---|---|
| `ARGUS_REAL_MONEY_READINESS.md` | Readiness scores. LIVE is **NO-GO**. Adding files does not raise scores. |
| `FINAL_ANALYSIS.md` (Section 25.3 / tab matrix) | Which UI tabs/widgets are real vs fabricated. Do not trust memory. |
| `ARGUS_CURRENT_ARCHITECTURE_MAP.md` | Current wiring snapshot. |
| `QUANT_LAYER_ANALYSIS.md` | Original additive quant design. |

NewsAgent live accuracy in the last scored pass: **44.6% on 242 predictions**. Walk-forward OOS for checked quant combos **failed**. This environment has had **zero organic closed paper trades** in that same pass. Historical AI replay of past years is **UNAVAILABLE** without point-in-time news/LLM logs — do not fabricate a 2022 debate.

TradingAgents (https://github.com/TauricResearch/TradingAgents, Apache-2.0) is **inspiration only**. Vendor **zero** of that source. Argus stays system of record.

## Hard working rules

- Do **not** bypass RiskEngine, BrokerManager, or OMS. AI interprets quant evidence; it does not replace it or invent prices/EV.
- Do **not** add a second kill switch. `emergency-stop` / `TRADING_PAUSED` already exist.
- `settings.budget` is Argus **allocation**, not broker equity. Enforced by `CapitalAllocation` + RiskEngine gate `argus_capital_allocation`.
- Do **not** hardcode operational/safety thresholds or **strategy-id literals** in TypeScript. Put numbers and strategy membership in `config/*.json`. Tests must derive expected values from the same config production loads.
- Quant live cycle is **off** unless `QUANT_ENGINE_ENABLED=true`. SMC in live `evaluateAll()` only if `QUANT_SMC_STRATEGY_ENABLED=true`.
- Do not describe unused agents (`MarketRegimeAgent`, `AdvancedQuantEngines`) as if they vote on trades.

## Commands

```bash
npm run dev          # scripts/devWithOpenAlice.ts → tsx server.ts (port 3000 hardcoded).
                     # Also starts OpenAlice Guardian if OPENALICE_ENABLED=true, and IBKR
                     # Client Portal Gateway if IBKR_GATEWAY_PATH is set. Neither flag:
                     # identical to tsx server.ts.
npm run dev:server-only  # tsx server.ts only (no companion processes)
npm run build        # Vite SPA + esbuild server bundle → dist/server.cjs
npm run start        # node dist/server.cjs
npm run clean        # Remove dist/ and server.js
npm run lint         # tsc --noEmit
npm test             # vitest run — count drifts; trust the runner output, not this comment
npm run test:e2e     # playwright test
npx playwright test  # currently 1 spec: e2e/moduleToggleParity.spec.ts
npm run security:scan-writes  # scripts/scan_unallowlisted_writes.ts
```

E2E spins up an isolated dev server + temp SQLite DB (never `data/argus.db`). A fresh DB opens **two** onboarding surfaces: Setup Wizard (`settings.onboardingComplete`, DB-gated) and the guided tour (`AppWalkthrough.tsx`, `localStorage["argus_tour_seen"]` only). `e2e/globalSetup.ts` seeds the former; the spec's `page.addInitScript()` seeds the latter. Seeding only one still blocks every test behind the other.

**Do not run `npm run db:migrate`** — `database/migrate.ts` does not exist. Migrations run when `src/server/db/index.ts` is first imported (`npm run dev` / `npm run start`).

UI components (`App.tsx`) have almost no unit tests. Real coverage is the safety-critical backend path plus that one E2E spec.

## Environment Setup

Copy `.env.example` to `.env`. `FINNHUB_API_KEY` is listed there and read by `FinnhubNewsProvider.ts`.

Key variables:

- `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` — real market data and paper/live execution
- `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `MISTRAL_API_KEY` / `NVIDIA_API_KEY` / `DEEPSEEK_API_KEY` / others in `.env.example` — AI keys. Router-native providers today: Gemini, OpenAI, DeepSeek, Nvidia, OpenAI-compatible (Ollama at `http://localhost:11434/v1`). Extra env keys may exist for future/compatible endpoints; do not assume every listed key has a dedicated provider class.
- `ALPHAVANTAGE_API_KEY` / `POLYGON_API_KEY` / `FMP_API_KEY` / `FRED_API_KEY` — market/news data
- `AUTH_USERNAME` / `AUTH_PASSWORD` — auth on when `AUTH_PASSWORD` is set; no-auth when unset; production refuses to boot unauthenticated
- `AUTH_SESSION_SECRET` — required with `AUTH_PASSWORD` in any real deployment
- `ENCRYPTION_SECRET` — AES key for stored API keys; else generated to `data/.encryption_key`
- `PAPER_TRADING_ONLY` — force paper on legacy `/api/v1/signals` and `AlpacaBroker`
- `PORT` — **not read**; `server.ts` hardcodes `3000`
- `OPENALICE_ENABLED` / `OPENALICE_MCP_URL` — optional MCP verification (both required)
- `QUANT_ENGINE_ENABLED` / `QUANT_ENGINE_INTERVAL_MS` — additive Quant agent (default off; interval default 300000 from `tradingSafety.quantCycleIntervalMs` if unset)
- `QUANT_SMC_STRATEGY_ENABLED` — include `SMC_LIQUIDITY_SWEEP` in live `evaluateAll()` (default off). Backtest via `findStrategy` does **not** need this flag.
- `QUANT_BULL_BEAR_ENABLED` — name lives in `config/bullBearResearch.json` (`enabledEnvVar`). Parser exists; **ChiefTrader does not consume it** until an additive wiring pass.

IBKR: `IBKR_GATEWAY_URL` (default `https://localhost:5000/v1/api`), optional `IBKR_GATEWAY_PATH` so `npm run dev` can spawn the Gateway (2FA is still manual).

## Architecture

### Process Model

Single Node.js process: Express + Vite middleware (dev) or static files (prod) + raw `ws`. SPA: `src/App.tsx` (very large single file). Backend entry: `server.ts` (routes, some business logic, and the legacy simulation endpoint still live here; many routes also live under `src/server/routes/`).

**Login-screen gotcha (real production bug):** `if (!isAuthenticated) return <Login/>` sits in the same `App()` function *after* most `useEffect` hooks. Hooks still run on the login screen. Gate every fetch/WebSocket `useEffect` on `isAuthenticated` (hoist that state near the top). The early return does **not** skip effects declared above it.

### Two Separate Execution Paths

**1. Real agent pipeline (EventBus-driven)**

```
Alpaca WebSocket → emitMarketData() → MARKET_DATA + MARKET_DATA_UPDATED
    ↓
Independent agents (timer or MARKET_DATA):
  TechnicalAgent       → real RSI/MACD/Bollinger; TRADE_IDEA_GENERATED
  NewsEngine           → real RSS + paid news APIs
  FundamentalAgent     → AlphaVantage + AIRouter (~60s, tracked symbols)
  MacroAgent           → AlphaVantage + AIRouter (~75s)
  PortfolioMonitor     → ~60s; settings.takeProfitPct / trailingStopPct;
                         Quant thesis invalidation via config/thesisInvalidation.json
                         (exits are SELL *ideas*, not raw broker flattens)
  QuantSignalAgent     → off unless QUANT_ENGINE_ENABLED=true
  KronosForecastAgent  → optional local Chronos; honest warning if /health is down
    ↓ TRADE_IDEA_GENERATED {traceId, symbol, side, confidence, reasoning, agent, currentPrice?}
ChiefTraderAgent
  → weights from agent_performance_stats (and config/agentWeights.json defaults)
  → optional AIRouter.routeConsensus (per-symbol cooldown); HOLD can veto
  → min independent agreeing agents + weighted confidence vs
    tradingSafety.consensusApprovalThreshold (0.75 in JSON, not a TS literal)
    ↓ CHIEF_APPROVED_IDEA
    → optional OpenAlice fire-and-forget (does not block this trade)
RiskAgent → RiskEngine.evaluateRisk()
  → refuses if no live price
  → every gate is recorded even after the first failure (audit trail)
  → first failure in evaluation order is the reported rejection
    ↓ RISK_ASSESSMENT_COMPLETED
OrderManagementService → BrokerManager.getActiveBroker().placeOrder(...)
    ↓ trades table + ORDER_EXECUTED
    ↓ WebSocket wildcard → React
```

**RiskEngine gates (order matters for the reported reason; all are recorded):**

`emergency_stop` (also blocks `TRADING_PAUSED`), `daily_loss` (kill-switch fraction from `tradingSafety.dailyLossKillSwitchFraction`, currently 0.8 of the daily limit), `consecutive_loss`, `portfolio_drawdown` (settings `maxPortfolioDrawdownPct`, default 15% from peak), `order_rate_limit` (settings, default 5/min), `market_hours` (Alpaca clock; **skip** if no Alpaca keys; **fail-closed** if keys exist but the clock HTTP/network fails — an outage is not treated as open; closed session blocks), `data_freshness` (stale tick > `stalePriceThresholdMs`), `news_veto` (`news_clusters.impactScore`, 4h window, **direction-blind**), `price_validity`, then `PositionSizing.ts` gates (`order_notional_cap`, concentration/correlation/`sufficient_size`/`open_positions_cap`, …), `sell_position_exists` (SELL only), `argus_capital_allocation`.

Restricted live (`RestrictedLiveMode.ts`): extra hardcoded ceilings when `tradingMode === 'LIVE'` (`restrictedLiveMaxOrderNotionalDollars` 5000, `restrictedLiveMaxOpenPositions` 3, `restrictedLiveMaxDailyLossDollars` 1000). File-reviewed; never a UI knob. No-op in paper.

Position sizing: shared `PositionSizing.ts` (live RiskEngine and `BacktestEngine`). Default `FIXED_DOLLAR` (`settings.maxTradeSize`). Optional `PERCENT_OF_EQUITY`. Stop-per-share assumption is `tradingSafety.stopLossAssumptionPct` (0.05) — **not ATR**. `quant/risk/ExpectedValue.ts` (Kelly, EV in R) is used by **QuantSignalAgent to refuse emitting a strategy idea** when EV is missing/non-positive; **RiskEngine still does not size from Kelly**.

**2. Legacy simulation (`GET /api/v1/signals` in `server.ts`)**

Fabricates hardcoded agents, votes by count, may call Alpaca REST, writes `data/portfolio.json`. Bypasses RiskEngine, BrokerManager, and the `trades` table. Some UI still hits it.

**These paths do not share state.** Real pipeline → SQLite `trades`. Legacy → `portfolio.json`.

### EventBus

`src/server/core/EventBus.ts` — Node `EventEmitter` singleton. `EventStore.ts` is a capped in-memory ring. Decision-lifecycle events persist to `event_traces`. Canonical type strings live in `config/eventNames.json`; prefer importing that (or a loader) over new literals. High-frequency ticks are not all durably stored.

### Config JSON (reviewed files, not API/UI knobs)

Loaded via `src/server/config/loadRepoConfigJson.ts` from repo `config/`. Missing required keys **fail boot**.

| File | Role |
|---|---|
| `tradingSafety.json` | Thresholds (consensus bar, stale ms, concentration, restricted-live caps, quant lookback/interval, regime mismatch multiplier, `minStrategyConfidenceToTrade`, …) |
| `eventNames.json` | EventBus type strings |
| `agentWeights.json` | Default ChiefTrader weights |
| `markets.json` | US/CA metadata (`MarketRegistry.ts`). Does **not** authorize Canadian live routing |
| `smcConfluence.json` | SMC detection/strategy weights |
| `thesisInvalidation.json` | Rule types’ strategy lists, thresholds, messages — **no strategy-id literals in ThesisInvalidation.ts** |
| `noTradeReasons.json` | First-class NO_TRADE catalog |
| `bullBearResearch.json` | Bull/Bear schema; numeric fields must come from Quant |
| `consensusFixtures.json` | Test fixtures |

### AIRouter

`AIRouter.getInstance()`. All LLM calls go through this. Failover, health, EMA latency, `setAgentRoute()` / `GET|POST /api/v1/config/routing`. `estimateCost()` uses published pricing; local/Ollama is `$0`.

### Local AI (optional)

`docs/LOCAL_AI_SETUP.md`, `npm run setup:ai`. Kronos: `npm run ai:serve` / `scripts/local_ai_service.py` / `amazon/chronos-t5-mini`. Ollama checked non-blockingly at boot (`[LocalAI] ...`).

`src/server/ai/research/parseResearchNote.ts` validates Bull/Bear JSON. LLM entry/stop/target/EV/probability are **nulled** and listed on `inventedNumericFieldsRejected`. Interpretive confidence is allowed and is **not** a calibrated win rate.

### Database

`better-sqlite3` + Drizzle, WAL. File: `data/argus.db` (gitignored). Schema: `src/server/db/schema.ts` (**45** `sqliteTable` exports as of this writing — count drifts; read the file). Migrations: `drizzle/`. Import `db` from `src/server/db/index.ts` only — a second process opening the same file has been seen to report a false `SQLITE_CORRUPT` while the app connection stays healthy (`PRAGMA integrity_check`).

Notable tables: `settings`, `trades`, `fills`, `portfolio`, `aiProviders`, `aiModels`, `aiUsage`, `aiCalls`, `learnedRules`, `agentPerformanceStats`, `agentPredictions`, `agentConfidenceCalibration`, `eventTraces`, `news_articles`, `news_clusters`, `ohlcvBars`, `backtestRuns`, `escalationDecisions`, `openaliceVerifications`, `quant_assessments`, `quant_strategy_backtests`, `quant_backtest_decision_log`, `risk_assessments`, `risk_gate_results`, `transactions`, `consensus_decisions`, `prediction_outcomes`, `training_examples`.

Backup: `GET /api/v1/system/export-db` (WAL checkpoint + download). Restore: `POST /api/v1/system/import-db` (`application/octet-stream`; restart required). Also copy `data/.encryption_key` or encrypted keys are unrecoverable.

### Broker Layer

`BrokerManager.getInstance().initialize()` from `startServer()`. Default if none selected: `InternalPaperBroker` (in-memory fills, $100k default cash).

- **AlpacaBroker** — paper or live; only fully unattended broker.
- **InteractiveBrokersAdapter** — Client Portal Web API. Local Gateway + human 2FA ~24h (`requiresManualReauth: true`). Cannot place Canadian-exchange equities (IIROC 3200A.1(b)(i)). **Gotcha:** Gateway WAF 403 if no `User-Agent`; Node `https.request` sends none; adapter sets one. `U*` accounts live; `DU*` paper — adapter trusts the Gateway session.
- **CoinbaseBroker** — real Advanced Trade CDP-JWT client (crypto spot). `placeOrder()` **refuses in paper** (no Coinbase sandbox). Not live-verified against a funded account in this environment. `.env.example` comments may lag the adapter — trust the broker file header.
- **QuestradeBroker** — real read-only OAuth2. `placeOrder()`/`modifyOrder()` throw (partner-developer restriction). BrokerManager will not make it the order-placing broker.

### Encryption

`EncryptionService.ts` — AES-256-CBC. `ENCRYPTION_SECRET` or `data/.encryption_key`.

### AutoBot Start Gate (TradingEngine)

`TradingEngine.toggle()` is **async**. On `enabled: false → true` it checks allocated `budget` vs broker `buyingPower`/`cash` and **rejects** if over. Callers must `await` (`POST /autobot/toggle`, `POST /settings`). No separate daily *deployment* cap (daily loss is a kill-switch, not a notional cap).

### Reflection / Learning

`ReflectionEngine` (~60s) scores predictions vs price, updates `agent_performance_stats.currentWeight` (feeds ChiefTrader). LLM rule text → `learned_rules` / `tradingEngine.state.memoryRules`. Rule **text is not injected into live agent prompts** (write-only).

### Additive Quant Decision Layer (optional)

`src/server/quant/`. Reuses `RSIEngine` / `MACDEngine` / `TechnicalIndicators` / `PositionSizing` / `BacktestEngine`. Off unless `QUANT_ENGINE_ENABLED=true`.

- **indicators/** — trend (SMA/EMA/DMI/ADX/BOS/CHoCH), momentum (StochRSI/ROC/Williams/CCI + reused RSI/MACD), named RSI/MACD **divergence as a feature** (`isTradeSignal: false`), volatility, volume, S/R, price action.
- **indicators/smc.ts** — liquidity, wick sweep (not close-beyond breakout), displacement, FVG, order blocks, trap as **pattern** (`isIntentionalManipulation: false`). Sweep `isTradeSignal: false`. Thresholds: `smcConfluence.json`.
- **statistics.ts** — general rolling stats (distinct from PositionSizing/AgentSynergy correlations).
- **RegimeEngine.ts** — BULLISH_TREND / BEARISH_TREND / SIDEWAYS_RANGE from multiple signals + dead-zones. Distinct from unused `MarketRegimeAgent.ts` (LLM) and unused `AdvancedQuantEngines.ts`.
- **MarketContext.ts** — SPY/QQQ/IWM/sector ETFs. Breadth: `available:false` (no source).
- **QuantitativeFeatureEngine.ts** — facade; `NOT_SUPPORTED` for breadth/options/L2/volume profile/TSI/anchored VWAP/pairs/Canadian FX — never fill zeros.
- **strategies/** — `CORE_STRATEGIES` / `ALL_STRATEGIES` = five: Momentum Breakout, Pullback Continuation, Mean Reversion, Trend Following, Range Reversion. `EXPERIMENTAL_STRATEGIES` = `SMC_LIQUIDITY_SWEEP` (**UNVALIDATED**). Default `evaluateAll()` is five; live inclusion of SMC only if `QUANT_SMC_STRATEGY_ENABLED=true` (checked at **call time**). `findStrategy(id)` searches core then experimental so **backtests work without the live flag**. Off-regime confidence is discounted (`regimeMismatchConfidenceMultiplier`), never zeroed.
- **thesis/assembleTradeThesis.ts** — numbers from engines only; HOLD → `NO_TRADE` from `noTradeReasons.json`. Attached as `quantDetail.tradeThesis`. Does not change approval math.
- **analysis/ThesisInvalidation.ts** — rule **types** in TS; strategy IDs/thresholds/messages in JSON. PortfolioMonitor emits SELL ideas through the pipeline.
- **scoring/GroupedScores.ts** — grouped 0–100; correlated oscillators blended, not independent votes.
- **risk/ExpectedValue.ts** — R:R, EV in R, fractional Kelly (refuses &lt; 20 closed trades; Kelly fraction capped at 10% of capital). Not a RiskEngine replacement.
- **ai/QuantContradictionAnalyzer.ts** — qualitative review via AIRouter; never overwrites side/confidence.
- **QuantSignalAgent** — timer over real daily bars; `agent:'QuantEngine'`; additive `quantDetail` (assessment, `featureSnapshot`, `tradeThesis`, optional `smc`). ChiefTrader may attach `supportingQuantDetail`. EV gate can suppress the idea entirely.
- **BacktestEngine.runStrategyBacktest()** — separate from `run()` (untouched). Long-only. Regime-segmented results, backtest EV/Kelly, buy-and-hold vs symbol+SPY, `FailureClassification` (only categories this engine can know). SMC context is passed when that strategy is requested.
- **WalkForwardValidator** — `run()` mode (`LOOKBACK` / `backtestLookbackBars` = 50) or strategy mode (`regimeMinBars` = 60). `POST /api/v1/backtest/walk-forward`.
- **MonteCarlo / AccountSizeReport** — scenario analysis; whole-share honesty.
- **Observability** — `GET /api/v2/quant/strategies` (`strategies` = five core; `experimentalStrategies` with `validationStatus: UNVALIDATED`), assessments, strategy-backtests, decision-log (`verboseLogging:true`), monte-carlo. Scanner: `QuantSignalsPanel.tsx`.

### External Verification (OpenAlice, optional)

`src/server/integrations/openalice/`. Off unless `OPENALICE_ENABLED` and `OPENALICE_MCP_URL`. Read-only, non-blocking, never credentials into BrokerManager/RiskEngine. Results inform **future** decisions only. Not live-verified against a real OpenAlice in this environment. See `OPENALICE_INTEGRATION_AUDIT.md`.

### Routes

- `server.ts` — remaining `/api/v1/` mixed in
- `configRoutes.ts` — `/api/v1/config`
- `autobotRoutes.ts`, `newsRoutes.ts`, `analyticsRoutes.ts`, `systemRoutes.ts`, `webhooks.ts`, `chaosRoutes.ts`, `integrationRoutes.ts`
- `v2System.ts` — `/api/v2` including `POST /trading/execute-override` (still full RiskEngine; never OMS-direct), `GET /market/sentiment-trend` (**-1 to +1**, not 0–100), `GET /trading/execution-quality` (submit-to-fill latency; **no slippage field** — proposal price is not persisted)

### Frontend (Agent Network)

- `DigitalTwinVisualizer` — node/edge glow from **real WebSocket events only**
- `AgentWorkflowTheater` — educational per-agent motion; looping scenes are architecture, not ticks; cards pulse on matching live events
- `OrchestrationStatus` — real `/api/v2/orchestration/*`
- Do not dump hidden chain-of-thought. Safe: side, confidence, EV, model name, latency, data-quality, NO_TRADE code, `inventedNumericFieldsRejected`

## Known Broken / Non-Functional (incomplete; FINAL_ANALYSIS.md wins for UI)

- **L2 order book** — no L2 source (Alpaca IEX is top-of-book). UI must stay “L2 Depth Data Unavailable”, not a fake ladder.
- **`AdvancedQuantEngines` / `MarketRegimeAgent`** — compute/emit; **not consumed** on the live path.
- **`archive/python-platform/`** — disconnected; the Node app never imports it.
- **Default notional cap** — `FIXED_DOLLAR` `maxTradeSize` (default $3,000) often binds before the 20% symbol cap on large accounts. `PERCENT_OF_EQUITY` exists but is opt-in via settings.
- **No fractional/notional shares** — `Math.floor(dollars / price)`; Alpaca `qty` only, never `notional`.
- **No daily capital-deployment cap** — daily loss kill-switch ≠ cumulative buy notional cap.
- **Learned rule text** — not in live prompts.
- **Canadian automated routing** — blocked (IIROC). `markets.json` documents this; it does not unlock IBKR/Questrade execution.
- **MultiAgentDialogueGraph** and several Agent Network charts still use fabricated/mock series — do not cite them as live accuracy.

## Adding a New Agent

1. Emit `TRADE_IDEA_GENERATED` with `{traceId, symbol, side, confidence (0–1), reasoning, agent, currentPrice}`.
2. ChiefTrader already listens.
3. Add `agent_performance_stats` (and `config/agentWeights.json` default if it should have a bootstrap weight).
4. LLM calls: `AIRouter.getInstance().routeTask(...)` only.
5. New EventBus types: add to `config/eventNames.json` first.

## Adding a Quant Strategy

1. Pure `evaluate(ctx)` module. Put it in `EXPERIMENTAL_STRATEGIES` until validated (OOS + paper), not in `CORE_STRATEGIES`.
2. Invalidation: add strategy id / thresholds to `config/thesisInvalidation.json` if an existing **rule type** applies. New comparison logic = new rule type in `ThesisInvalidation.ts`, still no strategy-id `if` ladders.
3. Confluence weights belong in JSON, not magic numbers in the strategy file.
4. Backtest is long-only; bearish setups will not open shorts.
5. Do not enable live flags to “see if it works.”
