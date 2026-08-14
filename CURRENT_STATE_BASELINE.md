# CURRENT_STATE_BASELINE.md

**Purpose:** A read-only forensic snapshot of the Argus trading platform as it exists right now, to serve as the regression baseline before any future enhancement work. No code, configuration, dependencies, schema, or tests were modified while producing this report.

**Method:** Five parallel research passes (routes/WebSocket/auth, DB schema/persistence, AI agents/AIRouter, testing/config/deployment, frontend tab-by-tab cross-check) plus direct independent verification of every surprising or high-stakes claim (re-running `vitest`/`tsc`/`build` myself rather than trusting a single report). Where this document draws on the repository's own existing audit trail (`CLAUDE.md`, `FINAL_ANALYSIS.md`), that is stated explicitly and cross-checked against current source, not assumed current.

**Tagging convention, used throughout:**
- **[FACT]** — confirmed directly against current source code, or a command I ran myself and observed the output of.
- **[INFERENCE]** — a reasonable conclusion from the code's structure, not a directly-stated fact.
- **[UNKNOWN]** — cannot be confirmed without running the live app against real credentials/market conditions, or without information only the user has.

**Important caveat found during this audit [FACT]:** the codebase was under active concurrent modification while this report was being assembled — `src/server/routes/v2System.ts` gained a `newsArticles` import and two new routes (`GET /market/sentiment-trend`, `GET /trading/execution-quality`) between when research agents were dispatched and when they returned, and the test count moved from 305 to 309 passing between two of my own `vitest run` calls in the same session. Some specific line numbers or counts below may have shifted again by the time this is read. Where a number matters, it is stated as "observed at time of writing," not as a permanent fact.

---

## 1. Executive Summary

Argus is a real, substantially-implemented, event-driven multi-agent paper-trading platform: independent agents evaluate real market data and produce trade ideas, a Chief Trader aggregates them into a weighted consensus, a Risk Engine sizes and gates the trade against real account state, and an Order Management Service executes it through a real broker adapter. **[FACT, established across `RiskEngine.ts`, `ChiefTraderAgent.ts`, `OrderManagement.ts`, `BrokerManager.ts`, independently re-read this pass.]**

Two prior, extensive, independently-verified audits already exist in this repository — `CLAUDE.md` (architecture reference) and `FINAL_ANALYSIS.md` (a 26-section, ~2,600-line running audit log spanning many sessions). This report does not duplicate their content wholesale; it independently re-verifies their key claims against the current working tree and adds several facts neither document currently states.

**What this audit independently confirmed is real right now:**
- The full pipeline (`MARKET_DATA` → agents → `TRADE_IDEA_GENERATED` → `ChiefTraderAgent` → `RiskEngine` → `OrderManagement` → broker → `event_traces`/WebSocket) exists in code, is wired end-to-end, and has direct test coverage that does not mock the pipeline it claims to test (`marketDataToRisk.test.ts`, `v2System.override.test.ts`).
- 11 real, independently-evaluated risk gates in `RiskEngine.ts`, all persisted to `risk_assessments`/`risk_gate_results`.
- A real 41-table SQLite schema (not 27 as `CLAUDE.md` currently states — see §22), with 4 tables that have no writer found anywhere in the codebase (dead schema).
- 5 real trading/analysis agents (Technical, News, Fundamental, Macro, Kronos) with genuinely different levels of "real" behind them — TechnicalAgent and Kronos compute signals from local math; NewsAgent has real local-first FinBERT gating before any LLM call; Fundamental/MacroAgent call the LLM unconditionally whenever data is available, with confidence taken directly from the LLM's own JSON output, unverified.
- Of ~20 frontend tabs, 7 are now fully real with zero fabrication (as of this session's Phase 3 work), up from 5 documented in `FINAL_ANALYSIS.md` §25.3 — and one additional tab (News Intel) is fully real right now but not yet credited as such in `FINAL_ANALYSIS.md`'s own tally. 13 tabs still contain at least one fabricated/hardcoded widget.

**What this audit found that neither prior document states:**
- **`npx tsc --noEmit` reporting clean is not meaningful evidence for any React-typed code.** `@types/react` is not installed and `node_modules/react` ships no `.d.ts` files, so every `react` import resolves to implicit `any`. A real, confirmed type-union bug (`activeTab`'s declared type omits `"news"`, `"intelligence"`, `"evaluation"`, `"kronos"`, yet all four are used) is silently swallowed by this gap. **[FACT]**
- The `scrypt` salt used by `EncryptionService.ts` (the real, currently-used encryption module) is the hardcoded literal string `'salt'`, identical for every install. **[FACT]**
- A GET route (`/api/v1/brokers`) is registered by two different routers both mounted at bare `/api/v1`; the wrong one always wins due to Express's first-match-wins semantics, and the correct one is only reachable at a different, second path added specifically to route around this. **[FACT]**
- The `/api/v1/signals` route, which `CLAUDE.md` currently describes as fabricating 9 agent objects and writing to `data/portfolio.json`, is now a deprecated no-op stub returning a static `HOLD` response — `CLAUDE.md`'s description is stale. **[FACT]** Conversely, `CLAUDE.md`'s statement that `PORT` is hardcoded and not read from the environment is confirmed still accurate. **[FACT]**
- Full test-suite runs were observed to disagree within the same session: one research pass reported all 42 test files crashing at setup (`afterAll` called outside a suite context); two immediate, independent re-runs by me showed 42/42 files and 309/309 tests passing. This is reported as an open reliability question, not resolved either way — see §16 and §20.

**Overall characterization, unchanged from the repository's own prior conclusion:** BETA-quality paper-trading infrastructure. **No statistically validated trading edge has been demonstrated anywhere in this codebase** — this baseline does not change that, and does not attempt to.

---

## 2. Repository Structure

**[FACT — from direct directory listings and file reads this session and prior sessions in this engagement.]**

```
Multi-Agent-AI-Trading-Platform/
├── server.ts                      # ~2000 lines — Express app, most v1 routes, WS server, static/SPA serving
├── src/
│   ├── App.tsx                    # ~11,200 lines — the entire React SPA, one file, 20 tabs
│   ├── components/                # ~40 .tsx files — dashboard widgets, one per major panel
│   │   └── shared/AwaitingSignal.tsx  # new this session — shared empty-state component
│   ├── brokers/                   # BrokerManager + 5 broker adapters (Alpaca/Internal/IBKR/Questrade/Coinbase)
│   ├── marketdata/                # MarketDataAdapter abstraction — Polygon/Yahoo adapters, both mocked, disconnected from the live pipeline
│   └── server/
│       ├── core/                  # EventBus, EventStore, AuthConfig, RateLimiters, EncryptionService, TransactionRegistry
│       ├── ai/                    # AIRouter + per-provider adapters (Gemini/OpenAI/DeepSeek/NVIDIA/OpenAI-compatible), EscalationPolicy, LocalSentiment
│       ├── db/                    # Drizzle schema (41 tables), db/index.ts (connection+migration), resolveDbDir.ts
│       ├── engines/                # RiskEngine, PositionSizing, TradingEngine, RSIEngine, kronos/*, backtest/*
│       ├── services/               # ~30 files — one per agent/worker (Technical/Fundamental/Macro/Kronos agents, ReflectionEngine, OrderManagement, PortfolioReconciliation, etc.)
│       ├── news/                   # NewsEngine + provider/classifier/dedup/cluster/impact sub-modules
│       ├── routes/                 # configRoutes, systemRoutes, autobotRoutes, integrationRoutes, v2System, analyticsRoutes, webhooksRoutes, chaosRoutes, newsRoutes
│       └── integrations/openalice/ # optional, off-by-default MCP-based external verification
├── drizzle/                        # 17 migrations (0000-0016) + snapshots
├── e2e/                            # 1 Playwright spec
├── scripts/                        # scan_unallowlisted_writes.ts (CI security gate), Python bootstrap/local-AI scripts
├── data/                            # argus.db (gitignored, live SQLite file) + backups/
├── Dockerfile, docker-compose.yml
├── .github/workflows/ci.yml
├── CLAUDE.md                       # architecture reference, partially stale (see §22)
└── FINAL_ANALYSIS.md               # 26-section running audit log, ~2,600 lines
```

**[FACT]** Both `src/App.tsx` and `server.ts` are single monolithic files (11,200 and ~2,000 lines respectively) — this is the actual architecture, not a simplification for this report; `CLAUDE.md` itself describes this ("The SPA is `src/App.tsx` (~11K lines, single file)").

---

## 3. Architecture

**[FACT, synthesized from direct reads of `SystemBootstrap.ts`, `EventBus.ts`, `RiskAgent.ts`, `OrderManagement.ts`, `server.ts`'s WS setup.]**

```
                         ┌─────────────────────────────┐
                         │   Alpaca WebSocket (real)   │
                         └──────────────┬──────────────┘
                                         ▼
                         MarketDataWorker.ts (real, single source)
                                         │  eventBus.emitMarketData()
                                         ▼
        ┌─────────────┬──────────────┬──────────────┬───────────────┐
        ▼             ▼              ▼              ▼               ▼
  TechnicalAgent   NewsEngine   FundamentalAgent  MacroAgent   KronosForecastAgent
  (local math)    (local-first  (AlphaVantage +   (AlphaVantage  (local Chronos
                   FinBERT gate  LLM, unconditional +LLM,unconditional service via HTTP)
                   + LLM)        when data present) when data present)
        │             │              │              │               │
        └─────────────┴──────────────┴──────────────┴───────────────┘
                                         │  TRADE_IDEA_GENERATED
                                         ▼
                              ChiefTraderAgent.ts
                    (weighted consensus, Beta-Binomial confidence
                     calibration, optional multi-provider AI debate)
                                         │  CHIEF_APPROVED_IDEA
                                         ▼
                                   RiskAgent.ts
                             (thin forwarder — always calls RiskEngine)
                                         ▼
                                  RiskEngine.ts
                    (11 gates, always all evaluated & persisted:
                     emergency_stop, daily_loss, consecutive_loss,
                     portfolio_drawdown, order_rate_limit, market_hours,
                     data_freshness, news_veto, price_validity,
                     symbol/sector/correlation concentration, sufficient_size)
                                         │  RISK_ASSESSMENT_COMPLETED
                                         ▼
                            OrderManagementService.ts
                  (idempotent by traceId, insert-then-update lifecycle,
                   real fill polling, real realized P&L on SELL)
                                         ▼
                          BrokerManager.getActiveBroker()
             ┌───────────────┬────────────────┬─────────────┬─────────────┐
             ▼               ▼                ▼             ▼             ▼
      InternalPaper       Alpaca            IBKR        Questrade     Coinbase
      (default, sim)   (only fully      (real, human    (read-only,  (real, crypto,
                        unattended       2FA ~24h)       no order      no paper mode)
                        broker)                          placement -
                                                          permanent
                                                          restriction)
                                         │  ORDER_EXECUTED
                                         ▼
                    EventBus wildcard '*' → per-connection WS broadcast
                                         │
                                         ▼
                                  React SPA (App.tsx)

Parallel, durable side-channel:
  Every event except MARKET_DATA/CALCULATION_COMPLETED → event_traces table (EventStore.ts)
  Every AI call (prompt+response+cost) → ai_calls table (AIRouter.ts)
  Every consensus decision → transactions/consensus_decisions/consensus_evidence (TransactionRegistry.ts)

Research plane, separate from the live pipeline:
  HistoricalDataGateway (real Alpaca bars) → ohlcv_bars
      → BacktestEngine (shares PositionSizing.ts with live RiskEngine,
                         real commissions/slippage, corporate-action safety halt,
                         but does NOT replicate RiskEngine's other 10 gates)
```

**[FACT]** `SystemBootstrap.start()`/`.stop()` starts/stops most timer-driven workers, but several singletons (`oms`, `riskAgent`, `technicalAgent`, `chiefTrader`, `transactionLifecycleTracker`, `marketRegimeAgent`, `explainabilityAgent`, `kronosForecastAgent`) are only referenced, not explicitly started/stopped — they self-initialize as module-level `EventBus.on(...)` registrations at import time, so they are listening regardless of whether `system.start()` was ever called. **[FACT]** `advancedQuantEngines.start()` is called in `SystemBootstrap.start()` but has no matching `.stop()` call in `SystemBootstrap.stop()`.

---

## 4. Feature Inventory

**[FACT unless noted]** — status legend: 🟢 WORKING · 🟡 PARTIALLY WORKING · 🟠 MOCKED · 🔴 BROKEN/DEAD · ⚫ UNUSED · UNKNOWN as noted.

| Feature | Status | Files | Evidence |
|---|---|---|---|
| Alpaca market-data streaming | 🟢 | `MarketDataWorker.ts` | Real WS connection, real reconnect (flat 5s retry, not exponential backoff) |
| TechnicalAgent (RSI/MACD/SMA/Bollinger) | 🟢 | `TechnicalAgent.ts` | Confidence computed from real indicator-strength ratios, `strengthToConfidence()` |
| NewsEngine pipeline | 🟢 (core), 🟡 (clustering is 1:1, not real ML clustering) | `NewsEngine.ts` + 8 sub-modules | Real RSS + 4 API providers gated on real key presence; FinBERT local-first escalation gate is real |
| FundamentalAgent | 🟡 | `FundamentalAgent.ts` | Real AlphaVantage call + cache/cooldown; honestly reports `DATA_UNAVAILABLE` on quota exhaustion; AI escalation unconditional, no confidence gate |
| MacroAgent | 🟡 | `MacroAgent.ts` | Same pattern as Fundamental, symbol-independent data cached globally |
| KronosForecastAgent / Chronos forecasting | 🟢 (core), 🔴 (2 of its own events are dead code) | `KronosForecastAgent.ts`, `KronosInference.ts` | Real HTTP calls to a local Python service; `KRONOS_REVERSAL`/`KRONOS_BREAKOUT` events reference a `marketStructure` field never set by `buildPrediction` |
| ChiefTraderAgent consensus | 🟢 | `ChiefTraderAgent.ts`, `EvidenceAggregator.ts` | Real weighted vote; `HOLD`/confidence-0 ideas already excluded from both vote arms (verified, not assumed) |
| Confidence calibration (Beta-Binomial) | 🟢 | `ConfidenceCalibration.ts` | Real math, tested against the real NewsAgent overconfidence finding; not yet observed changing a live decision |
| RiskEngine (11 gates) | 🟢 | `RiskEngine.ts`, `PositionSizing.ts` | All gates always evaluated (not first-failure-short-circuit) and persisted |
| OrderManagementService | 🟢 | `OrderManagement.ts` | Idempotent, insert-then-update lifecycle, real fill polling |
| BrokerManager + 5 adapters | 🟢 (Alpaca/Internal), 🟡 (IBKR, Coinbase — real but unverified against a live account), 🔴 (Questrade order placement — permanent restriction, by design) | `BrokerManager.ts` + adapters | Capability-gated `setLiveMode()`, confirmed since Section 22 |
| Portfolio reconciliation | 🟢 | `PortfolioReconciliation.ts` | Real mismatch/match event, pauses trading past $100 impact |
| Transaction Observatory (backend) | 🟢 | `TransactionRegistry.ts`, `TransactionLifecycleTracker.ts` | Real canonical transaction ledger, terminal-state bug fixed (Section 17.1) |
| Manual "Execute Override" (Advanced Trade Sandbox) | 🟢 (newly wired this session) | `App.tsx`, `v2System.ts` `/trading/execute-override` | Real, goes through the actual RiskAgent→RiskEngine→OMS chain; test confirms the *real* singleton picks up the event, not a mock |
| Backtest engine | 🟡 | `BacktestEngine.ts` | Real position sizing shared with live RiskEngine, real commissions/dynamic slippage, real corporate-action safety halt — does **not** replicate the other 10 RiskEngine gates or model partial fills |
| Walk-forward validation | 🟢 | `WalkForwardValidator.ts` | Real chronological rolling-split validation (per `FINAL_ANALYSIS.md` §9, not independently re-read this pass) |
| Strategy Scanner (RSI over real data) | 🟢 (newly real this session) | `StrategyScanner.tsx`, `v2System.ts` `/strategy/rsi-scan` | Confirmed — no `charCodeAt()` synthetic data remains |
| Strategy Synergy Matrix | 🟢 (newly real this session) | `StrategySynergyMatrix.tsx`, `AgentSynergy.ts`, `/strategy/agent-synergy` | Real Pearson correlation over real 5 agents; invented names removed |
| Observability & Trade Tracing tab | 🟢 (newly real this session) | `App.tsx` `audit` tab | Real transaction list + real `TransactionObservatory` modal reuse |
| News Intel tab | 🟢 (confirmed fully real; not yet credited in FINAL_ANALYSIS's own tally) | `NewsDashboardTab.tsx` | The previously-flagged decorative "Ticker Impact" card is gone, replaced with a real-data-derived card |
| Market Sentiment Trend / Execution Quality Chart backend | 🟡 (backend routes exist and are tested; frontend components not yet confirmed wired to them) | `v2System.ts` `/market/sentiment-trend`, `/trading/execution-quality`, `v2System.uiTruth.test.ts` | Observed appearing mid-audit (see caveat above) — **not independently verified end-to-end this pass; flagged UNKNOWN whether `MarketSentimentTrend.tsx`/`ExecutionQualityChart.tsx` actually consume them yet** |
| Autonomous Dashboard | 🟡 real core, mostly fake shell | `AutonomousDashboard.tsx` | Hardcoded `$103.45`/`+$3.45` portfolio value, hardcoded AI-health block, fake daily trading report |
| Mission Control Granular Module Toggles | 🔴 | `App.tsx` `handleToggle`/`handleSetMode` | Confirmed: local React state only, zero backend call |
| Mission Control "Strategy Arena" sub-component | 🟠 | `AutonomousMissionControl.tsx` | `winRate:68` hardcoded, fake "Generate Strategy"/"Run Simulation" |
| Trading Arena's ~8 remaining fabricated widgets | 🟠/🔴 | `MarketSentimentTrend.tsx`, `RiskAttributionTreemap.tsx`, `StrategyProfitSunburst.tsx`, `TradeEfficiencyReport.tsx`, `ExecutionQualityChart.tsx`, plus inline `mockRiskDecompositionData`/`mockDrawdownData`/Market Historian widget/agent-node sparklines in `App.tsx` | Confirmed unchanged this pass |
| Agent Network's "Agent ROI & Metric Comparison" widget | 🔴 (newly documented this pass — not in prior FINAL_ANALYSIS evidence list) | `App.tsx:2271-2281,6981-7153` | `mockAgentComparativeMetrics`/`mockAgentRoiData`, hardcoded per-agent Sharpe/drawdown/wins |
| Opportunity Feed tab | 🔴 | `App.tsx` | 3 hardcoded cards, "LIVE SCAN ACTIVE" badge is false |
| Holdings Stress Testing panel | 🔴 | `App.tsx` | Identical output regardless of which scenario button is clicked |
| Learning & Evolution tab | 🔴 | `App.tsx` | Hardcoded "Mistakes Corrected: 14" etc. |
| VEC Event Memory's VectorClusteringMap | 🔴 | `VectorClusteringMap.tsx` | Hardcoded 12-crisis sample array |
| Validation tab | 🔴 | `SystemValidationSuite.tsx` | `(Date.now() % 1000 / 1000) > 0.1` deterministic ~90%-pass RNG |
| Deployment tab "Run Quant Audit" | 🟠 | `App.tsx` | `setTimeout` + score from the user's own dropdown selections |
| Settings Token Consumption panel | 🔴 | `App.tsx` | Hardcoded `mockTokenConsumptionData` |
| MarketDataAdapter abstraction (Polygon/Yahoo) | ⚫ | `src/marketdata/` | Registered but never consulted by `MarketDataWorker` or any agent — fully disconnected from the live pipeline |
| Legacy scheduler (`/api/v1/scheduler`) | ⚫ | `server.ts` | In-memory only, no DB persistence, nothing else reads `targetWeights` |
| Legacy risk-veto stub (`/api/v1/risk`) | ⚫ | `server.ts` | In-memory `riskVetos` array with no writer found anywhere — stays empty for the process lifetime |
| `/api/v1/mcp/trade`, `/api/v1/llm/dual-verify-trade` | 🔴 | `server.ts` | The Gemini client (`ai`) is hardcoded to `null` even when `GEMINI_API_KEY` is set; the dual-verify route always returns 503 |
| `/api/v1/event-memory` (semantic precedent search) | 🔴 | `server.ts` | Underlying `historicalPrecedents` array is never populated; falls back to a hardcoded canned "2018 Sino-US Trade War" string when Gemini unavailable |
| `agentMemory`, `newsProviders`, `predictionEngineWeights`, `users` tables | ⚫ | `schema.ts` | No `db.insert`/`db.update` writer found anywhere for any of these 4 tables |

---

## 5. End-to-End Workflows

**[FACT, traced through actual source, not documentation.]**

### 5a. Real automated trade flow
```
Alpaca WS tick → MarketDataWorker.latestPrices.set() + eventBus.emitMarketData()
  → TechnicalAgent (buffers 50 ticks, computes RSI/MACD/SMA/Bollinger locally)
    → eventBus.emitTradeIdea({traceId, symbol, side, confidence, reasoning, agent:"TechnicalAgent"})
  → [in parallel] NewsEngine (10s timer) / FundamentalAgent (60s timer) / MacroAgent (75s timer) / KronosForecastAgent (per-tick, 60s cooldown)
    → each emits TRADE_IDEA_GENERATED with agent-specific confidence provenance (see §4/§20)
  → ChiefTraderAgent.evaluateConsensus() — calibrates each agent's stated confidence via ConfidenceCalibration,
    computes weighted vote via EvidenceAggregator, approves if weighted confidence > 0.75
    → eventBus.emit('CHIEF_APPROVED_IDEA', {traceId, transactionId, symbol, side, confidence, currentPrice})
  → RiskAgent.assessRisk() — thin forwarder, always calls riskEngine.evaluateRisk()
    → RiskEngine evaluates all 11 gates unconditionally, persists risk_assessments + risk_gate_results
    → eventBus.emitRiskAssessment({traceId, transactionId, approved, maxQuantity, reasoning})
  → OrderManagementService (listens on RISK_ASSESSMENT_COMPLETED) — if approved && maxQuantity>0:
    → inserts PENDING trades row → BrokerManager.getActiveBroker().placeOrder() → polls for fill
    → updates trades row (status/price/profitLoss/filledAt), inserts fills row on FILLED
    → eventBus.emitOrderExecution({traceId, transactionId, id, symbol, side, quantity, price, status, profitLoss})
  → TransactionLifecycleTracker (listens on RISK_ASSESSMENT_COMPLETED/ORDER_SUBMITTED/ORDER_EXECUTED)
    → updates transactions.status to RISK_REJECTED / EXECUTED / FILLED / ORDER_REJECTED as each real event fires
  → EventStore persists every event except MARKET_DATA/CALCULATION_COMPLETED to event_traces
  → EventBus wildcard '*' → every open WebSocket connection receives {type: eventName, data: payload}
  → React SPA updates via subscribe() hooks (WebSocketContext)
```

### 5b. Manual "Execute Override" flow (newly wired this session)
```
User clicks "Execute Override" in Advanced Trade Sandbox (App.tsx)
  → POST /api/v2/trading/execute-override {symbol, side}
  → v2System.ts route: reads marketDataWorker.getLatestPrice(symbol) — 422 if no real tick yet
    → recordConsensusTransaction() mints a real transactions/consensus_decisions/consensus_evidence row,
      tagged agent:'ManualOverride', debateUsed:false (never disguised as an AI signal)
    → eventBus.emit('CHIEF_APPROVED_IDEA', {...}) — the SAME event RiskAgent listens for after real consensus
  → From here, identical to 5a from RiskAgent onward — RiskEngine's full 11-gate ladder is NOT bypassed;
    only ChiefTraderAgent's own consensus step is skipped (the stated purpose of an "override")
  → Frontend subscribes to real RISK_ASSESSMENT_COMPLETED / ORDER_EXECUTED WS broadcasts for live status
```
**[FACT]** Verified via `v2System.override.test.ts`, which does not mock `RiskAgent`/`RiskEngine` — the real singletons (imported transitively via `SystemBootstrap`) pick up the emitted event and a real `risk_assessments` row appears.

### 5c. Legacy/dead flows (for contrast — must not be confused with 5a)
- `GET /api/v1/signals` — now a static `HOLD` stub, no computation, no side effects. **[FACT, corrects CLAUDE.md.]**
- `POST /api/v1/mcp/trade` — parses natural-language intent via a Gemini client that is hardcoded to `null`; will throw/fall to a catch block on every real invocation. **[FACT]**

---

## 6. AI / Agent Architecture

**[FACT, from direct reads of every agent file plus `AIRouter.ts` in full.]**

| Agent | Confidence provenance | External calls | Failure behavior | Cadence |
|---|---|---|---|---|
| TechnicalAgent | Self-derived from indicator-strength ratios (`strengthToConfidence`, range [0.55,0.95]) | None | N/A — doesn't fire until 50 real ticks buffered | Event-driven, per MARKET_DATA tick |
| NewsEngine | Non-escalated path: formula from real FinBERT sentiment magnitude. Escalated path: taken directly from LLM JSON, unverified | AlphaVantage/Finnhub/Polygon/FMP + 3 RSS feeds; local FinBERT HTTP; AIRouter (only when escalated) | Honest per-provider error tracking; skips providers without a configured key; no fabricated articles | 10s timer |
| FundamentalAgent | Taken directly from LLM JSON when escalated, unverified; `confidence:0` HOLD when data unavailable | AlphaVantage `OVERVIEW`; AIRouter (unconditional whenever data + Gemini key present, **no confidence gate**) | Two honestly-distinct `DATA_UNAVAILABLE` reasons (rate-limited vs not configured); 24h cache+cooldown | 60s timer, round-robins 1 of 3 symbols |
| MacroAgent | Same pattern as Fundamental | 3 parallel AlphaVantage endpoints (INFLATION/FEDERAL_FUNDS_RATE/UNEMPLOYMENT); AIRouter unconditional | Same pattern as Fundamental; data cached globally, not per-symbol | 75s timer |
| KronosForecastAgent | Self-derived from forecast quantile spread, capped [0.3,0.85] | Local Chronos inference HTTP service (`localhost:8008` by default) | Throws `KRONOS_UNAVAILABLE` with an actionable message; never fabricates a forecast | Per-tick, 60s cooldown per symbol, requires 30 real ticks buffered |

**Cross-agent observation [FACT]:** only NewsEngine has real local-first escalation gating (skip the LLM entirely when FinBERT is decisive). Fundamental/MacroAgent call the LLM unconditionally with no confidence-based skip — `EscalationPolicy.ts` exists and is used by NewsEngine only.

**Event-shape inconsistency [FACT]:** `KronosForecastAgent.ts` emits `TRADE_IDEA_GENERATED` via a raw `eventBus.publish()` call rather than the `emitTradeIdea()` helper every other agent uses, with `agent: 'KronosEngine'` (not `'KronosForecastAgent'`) and no `newsDetails`/`aiCallId`/`provider`/`latencyMs` fields the other agents include.

**Dead sub-features [FACT]:** `KronosForecastAgent`'s `KRONOS_REVERSAL`/`KRONOS_BREAKOUT` events check a `marketStructure` string field that `KronosInference.buildPrediction()` never sets — these two events can never fire as currently wired. `KronosModelManager`'s `memoryUsage`/`gpuUsage`/`inferenceTime` fields are initialized to placeholder values and never updated anywhere.

**AIRouter.ts [FACT]:** real failover ordering (DB priority → health → success rate → latency), with providers marked `Offline` from real accumulated failures moved to the end of the order rather than removed. Real per-call forensic ledger (`aiCalls` table: prompt, raw response, tokens, cost, latency, status). Real, cited per-provider cost tables in `GeminiProvider`/`OpenAIProvider`/`DeepSeekProvider`; a disclosed generic fallback estimate ($0.50/1M in, $1.50/1M out) for any other OpenAI-compatible endpoint. `routeConsensus()` fires the same prompt in parallel to every enabled provider and aggregates a weighted BUY/SELL/HOLD verdict — not observed called from any of the 5 agents read this pass; **[UNKNOWN]** where it is actually invoked from (likely ChiefTraderAgent's optional AI-debate step, not independently confirmed this pass).

**Encryption [FACT]:** `EncryptionService.ts` (the one real, used implementation — the previously-documented dead duplicate under `services/` no longer exists in the current tree, confirmed via glob) refuses to boot without `ENCRYPTION_SECRET` set. AES-256-CBC with a random IV per call, but the scrypt key-derivation salt is the hardcoded literal `'salt'`, identical across every install.

---

## 7. Trading Engine

**[FACT]** `TradingEngine.ts` holds a large in-process `AutoBotState` object. Persisted to `settings` table: `tradingState` (TRADING_ENABLED/TRADING_PAUSED/EMERGENCY_STOP), `peakEquity`, `maxPortfolioDrawdownPct`, `maxOpenPositions`, `maxOrdersPerMinute`, `memoryRules` (rehydrated on boot). **Not persisted, reset on restart:** `history` (activity feed), `scheduledTasks`, `cycleCount`, `equityHistory`, `learningJournal`, `discoveredOpportunities`, `bypassedTrades`, and several other fields.

**[FACT]** `setTradingState()` is the only path allowed to change the tri-state; it writes an immutable `kill_switch_events` row and, on `EMERGENCY_STOP`, cancels real outstanding broker orders unless `cancelOpenOrders:false` is passed.

**[FACT]** `toggle()` applies an explicit field allowlist (fixed, per `FINAL_ANALYSIS.md` §16, re-confirmed structurally present via the current `configRoutes.ts`/`autobotRoutes.ts` route reads this pass) rather than `Object.assign(state, req.body)`.

---

## 8. Calculation Engines

**[FACT]**

| Engine | Real or fabricated | Notes |
|---|---|---|
| RSI (`RSIEngine.ts`) | Real, Wilder's smoothing | Shared by `TechnicalAgent`, `BacktestEngine`, and the new `/api/v2/strategy/rsi-scan` route |
| MACD, SMA, Bollinger (`TechnicalAgent.ts`) | Real, computed locally | No external calls |
| Position sizing (`PositionSizing.ts`) | Real, shared function | Same code path used by both live `RiskEngine` and `BacktestEngine` — closes a previously-documented live/backtest drift risk |
| Commissions (`Commissions.ts`) | Real, sourced | SEC Section 31 fee + FINRA TAF, sells-only, cited against 2026 rate notices |
| Slippage (`Slippage.ts`) | Real, dynamic | ATR-based volatility component + participation-rate component, not a flat constant |
| Pearson correlation (`AgentSynergy.ts`) | Real, general-purpose | New this session; distinct from `PositionSizing.ts`'s return-based correlation |
| Beta-Binomial confidence calibration (`ConfidenceCalibration.ts`) | Real | Verified against the real NewsAgent overconfidence finding |
| Portfolio stress-testing (Holdings tab) | **Fabricated** | Identical output regardless of scenario selected — confirmed this pass |
| `calculateATR()` in `server.ts` | Dead code | Per `FINAL_ANALYSIS.md`, zero callers — not re-verified this exact pass but no contradicting evidence found |

---

## 9. Broker Integration

**[FACT, unchanged from `FINAL_ANALYSIS.md` §18/22, not independently re-verified against live accounts this pass — no test credentials available in this environment. UNKNOWN whether any adapter has ever been exercised against a real funded account.]**

| Broker | Can place real orders? | Constraint |
|---|---|---|
| Internal Paper Simulator | Yes (simulated) | Default; in-memory cash/positions reset on restart |
| Alpaca | Yes | Only broker that runs fully unattended |
| Interactive Brokers | Yes, with caveats | Real Client Portal client; human 2FA ~24h; no Canadian-listed equities (IIROC restriction) |
| Coinbase Advanced Trade | Yes | Real CDP-JWT auth; crypto spot only; no paper/sandbox mode — `placeOrder()` refuses in paper mode |
| Questrade | No, permanently | Real read-only account access; order execution is Questrade-partner-only by their own API policy, not a code gap |

**[FACT]** `BrokerManager.setLiveMode()` checks `broker.getCapabilities()` before the confirmation-phrase gate, refusing a mode the broker doesn't actually support (Section 22 fix, structurally present in current `BrokerManager.ts`, not independently re-read line-by-line this pass).

---

## 10. Market Data

**[FACT]** Single real source: Alpaca (WebSocket for live ticks, REST for historical bars), via `MarketDataWorker.ts`/`HistoricalDataGateway.ts`. A separate `MarketDataAdapter` abstraction exists (`src/marketdata/`, Polygon + Yahoo adapters) but both are 100% mocked and never consulted by the live pipeline — confirmed structurally disconnected. `MarketDataCrossChecker.ts` (real) compares Alpaca's live price against Questrade's real quote every 60s and emits a discrepancy event past 0.5% divergence — this is observability only, never feeds into RiskEngine's gates.

---

## 11. News / Data Sources

**[FACT]** 7 real providers registered in `NewsProviderManager`: 3 hardcoded RSS feeds (Yahoo Finance, CNBC, WSJ) + 4 API providers (Finnhub, AlphaVantage, Polygon, FMP), each skipped without error if unconfigured. Real dedup (by fingerprint + provider article id), real credibility scoring (starts from a hardcoded `0.8` provider weight regardless of the provider's own real `credibilityWeight` field — a real, minor inconsistency). `NewsClusterEngine` does 1:1 article-to-cluster mapping, not real multi-article clustering, per its own code comment. `NewsSymbolExtractor` matches against a hardcoded 7-ticker whitelist plus provider-supplied symbols.

---

## 12. Database

**[FACT, full schema read this pass — see the dedicated agent report incorporated above.]** 41 tables (not 27, correcting `CLAUDE.md`). better-sqlite3 + Drizzle, WAL mode set immediately after connection open. Migrations run synchronously at module-load time and **re-throw on failure** (crashes startup rather than continuing on an inconsistent schema — a previously-fixed reliability bug, structurally confirmed still present). 17 migrations exist (`0000`–`0016`).

**DB file location [FACT]:** resolved by `resolveDbDir.ts` — always `<cwd>/data` on Windows regardless of what exists at `/data`; only considers `/data` on non-Windows platforms. This specifically fixes a previously-real incident where Windows' path resolution silently redirected the live DB into an unrelated `C:\data` folder.

**Dead tables (schema exists, no writer found anywhere) [FACT]:** `users`, `agentMemory` (read-only, no writer), `newsProviders`, `predictionEngineWeights`.

**In-memory-only state lost on restart [FACT]:** most of `TradingEngine.state` (history, scheduledTasks, cycleCount, equityHistory, learningJournal, etc.), `InternalPaperBroker`'s cash/positions/orders, `liveQuotes` cache, `EventStore`'s ring buffers. `MARKET_DATA`/`CALCULATION_COMPLETED` events are deliberately excluded from durable persistence (too high-frequency); every other tracked event type is persisted to `event_traces`.

---

## 13. EventBus / WebSockets

**[FACT]** `EventBus.ts` is a singleton `EventEmitter` wrapper; every real `emit()` also re-emits to a wildcard `'*'` listener (with a recursion guard). This wildcard is what the WebSocket layer subscribes to, per-connection, for broadcasting. Raw `ws` server (not Socket.IO), manual upgrade handling: rate-limited (20 connections/min/IP via a hand-rolled sliding-window limiter), authenticated via the same session cookie as REST when `AUTH_ENABLED` is true. Two additional broadcasts bypass EventBus entirely: a 1s broker-tick interval and a 2s raw `AUTOBOT_STATE_UPDATED` broadcast of the full in-memory `TradingEngine.state`.

**Persisted event envelope [FACT]:** `{eventId, schemaVersion, correlationId, source, type, timestamp, payload}`, written fire-and-forget (errors logged, never awaited) to `event_traces`.

---

## 14. Frontend

**[FACT, corrected/current tab-by-tab table, superseding `FINAL_ANALYSIS.md` §15.20/§26.4 where they now differ — see full agent report incorporated in §4/§20.]**

20 `activeTab` values exist; the declared TypeScript union omits 4 of them (`news`, `intelligence`, `evaluation`, `kronos`) despite all four being used via `setActiveTab(...)` calls — a real type-safety gap masked by the missing `@types/react` (see §17).

**Current tally, observed this pass:** 7/20 tabs fully real with zero fabrication (Observatory, Activity Log, Agent Evaluation, Kronos Model, News Intel, Observability & Tracing, Strategy Scanner) — News Intel and the last two are newly confirmed/newly built this session. 13/20 tabs still contain at least one fabricated or hardcoded widget. Full per-tab detail is in §4's table above; do not re-derive it independently without re-reading the current `App.tsx`, since this number has moved twice in one session already.

---

## 15. Backend

**[FACT]** Express app in `server.ts` (~2000 lines) plus 9 mounted route files under `src/server/routes/`. Two real, confirmed route-collision bugs: `GET /api/v1/brokers` shadowed between `configRoutes.ts` and `integrationRoutes.ts` (worked around by a separately-named path); `configRoutes.ts` is double-mounted at both `/api/v1/config` and bare `/api/v1`. Global auth gate middleware runs before `express.json()`; `/api/v1/auth/*` always bypasses it (required for login itself); non-`/api/*` paths pass through regardless of auth state (needed for the static SPA).

---

## 16. Testing

**[FACT, with an open reliability question — see below.]** 42 test files (`*.test.ts` under `src/`+`scripts/`) + 1 Playwright spec. 21 of the 42 explicitly set `ARGUS_DB_PATH` for real isolated-DB integration testing; 3 use `vi.mock` for a fully-mocked style (`RiskEngine.test.ts`, `ChiefTraderAgent.test.ts`, `OrderManagement.test.ts`); the rest are pure-function unit tests with no DB involvement at all.

**Command outputs observed this pass:**
- `npx tsc --noEmit`: exit 0, no errors (but see §17 caveat — not meaningful for React code).
- `npm run build`: succeeds, ~3MB main JS chunk (uncompressed), non-fatal chunk-size warning.
- `npm audit`: 4 moderate, 0 high/critical (all in the dev-only `drizzle-kit`→`esbuild` chain, not shipped to production).
- **`npx vitest run`: one research pass reported ALL 42 files crashing at setup** (`Error: Vitest failed to find the current suite`, traced to `vitest.setup.ts:29`'s top-level `afterAll()` call). **I independently re-ran the exact same command twice immediately after and got 42/42 files, 309/309 tests passing both times.** This contradiction is reported honestly, not resolved — it may indicate environment-sensitive flakiness (e.g., a transient lock, a concurrent process touching files mid-run, or a real edge case in how `setupFiles` interacts with the installed vitest version under certain conditions) rather than a permanent break, since the file's structure (a bare `afterAll` imported from `'vitest'` at module top level, used as a global setup hook) is a documented, generally-supported pattern for `vitest.config.ts`'s `setupFiles`. **[UNKNOWN — root cause of the one observed crash.]**

**Playwright E2E [FACT, from `FINAL_ANALYSIS.md` §25.5, not re-executed this pass to avoid disturbing a live session]:** the one E2E spec was previously found to fail when actually run — a fresh E2E database's onboarding wizard modal blocks the click the test is waiting to make, since the test never dismisses it. Not independently re-verified this specific pass.

---

## 17. Configuration

**[FACT]** `tsconfig.json` has no `strict` flag set (strict mode is off) and no explicit `include` (defaults to the whole project minus `dist`). **`@types/react` is not present in `node_modules/@types`, and `node_modules/react` ships no `.d.ts` files** — every `react` import resolves to implicit `any`, which means `npx tsc --noEmit` reporting clean is not meaningful evidence for the correctness of any React-typed code in `App.tsx` or any component file. This directly explains why a real type-union bug (the `activeTab` union omitting 4 real values) produces zero compiler diagnostics.

`vitest.config.ts` includes only `src/**/*.test.ts` and `scripts/**/*.test.ts`, `globals:false`, `setupFiles: ['./vitest.setup.ts']`. `playwright.config.ts` spins up a fully isolated dev-server instance (disposable temp DB, throwaway auth creds) — never touches real `.env`/`data/argus.db`.

---

## 18. Security

**[FACT, cross-checked against `AuthConfig.ts` in full this pass.]** `isAuthEnabled` is purely `!!AUTH_PASSWORD`. `validateCredentials` explicitly returns `false` when auth is disabled (closing the historical empty-body-login bypass). Startup guard (`checkAuthConfig`/`enforceAuthConfigOrExit`, called unconditionally before the HTTP server binds): fatal (`process.exit(1)`) if `NODE_ENV=production` and `AUTH_PASSWORD` unset, or if `AUTH_PASSWORD` is set but `AUTH_USERNAME`/`AUTH_SESSION_SECRET` are missing or the secret is the literal default placeholder. Non-fatal warning-only if not production and auth disabled — the app boots fully open in that case, and every `/api/*` route (and the WS upgrade path) is unauthenticated for the life of the process.

**New finding this pass, not previously documented:** `EncryptionService.ts`'s scrypt salt is the hardcoded literal `'salt'`, identical for every install — this weakens (though does not eliminate) the key-derivation step used to encrypt stored broker/AI-provider API keys.

Rate limiting is real and applied broadly (login/AI/trading/backtest/WS-upgrade limiters), but `backtestLimiter` is defined and exported yet **not found applied to any route** in this pass's read of `systemRoutes.ts` — the `/backtest`/`/backtest/walk-forward` endpoints appear unthrottled despite a limiter existing for exactly that purpose. **[FACT, not independently re-confirmed against every route file — flagged for follow-up, not asserted as certain.]**

---

## 19. Performance

**[FACT]** Single ~3MB (uncompressed) / ~615KB (gzip) main JS bundle, no code-splitting — confirmed via a fresh `npm run build` this pass, unchanged from prior audits. `NewsAgent`'s average real AI-call latency was previously measured at ~24 seconds/call (per `FINAL_ANALYSIS.md` §15.19, not re-measured this pass — **[UNKNOWN]** current value).

---

## 20. Reliability

**[FACT]** Market-data reconnect is a flat 5s `setTimeout` retry, not exponential backoff. DB migration failures now crash startup rather than continuing silently (a previously-fixed real bug, structurally confirmed present). The one observed full-test-suite-crash-then-immediate-pass contradiction (§16) is itself a reliability signal worth taking seriously even though the root cause is unresolved.

---

## 21. Trading Safety

**[FACT]** 11 real RiskEngine gates, all always evaluated and persisted regardless of which one fails first: `emergency_stop`, `daily_loss`, `consecutive_loss`, `portfolio_drawdown`, `order_rate_limit`, `market_hours`, `data_freshness`, `news_veto`, `price_validity`, `symbol_concentration`/`sector_concentration`/`correlation_exposure` (via `PositionSizing.ts`), `sufficient_size`. `OrderManagementService` is idempotent by `traceId` — a second order for the same trace is refused. The new manual "Execute Override" path (§5b) was specifically verified to still pass through this entire gate ladder rather than calling the broker directly. **No path was found in this pass that calls `BrokerManager`/`OrderManagementService` directly, bypassing `RiskEngine`** — this is a positive finding, not a gap, but it is also not an exhaustive proof; **[INFERENCE]** based on the routes and services actually read this pass, not a complete repo-wide trace of every possible call site.

**Live vs. paper separation [FACT]:** gated behind `LIVE_TRADING_CONFIRMATION_PHRASE` and, since Section 22, a capability check (`broker.getCapabilities().liveTrading`/`.paperTrading`) before that phrase is even checked.

**No statistically validated trading edge exists anywhere in this codebase.** This is unchanged by anything in this report and is not re-litigated here — see `FINAL_ANALYSIS.md` §15.18/§26.7 for the full evidentiary basis (a real, demonstrated negative Sharpe for NewsAgent's only large enough sample, and zero backtests clearing the engine's own significance floor).

---

## 22. Documentation Accuracy

**[FACT — direct comparison of `CLAUDE.md`'s claims against current source.]**

| CLAUDE.md claim | Current reality |
|---|---|
| "27 tables" | **41 tables**, confirmed by full schema read |
| `/api/v1/signals` "fabricates 9 hardcoded agent objects... writes to `data/portfolio.json`" | **Stale.** Current code is a deprecated no-op stub returning a static `HOLD` response; no fabrication, no writes, no agent objects |
| "`PORT` — not actually read... `server.ts` hardcodes port `3000`" | **Confirmed accurate**, unchanged |
| "`BrokerManager.initialize()` is never called from `startServer()`" | Not independently re-verified this exact pass — no contradicting evidence found |
| "Known startup gap" language throughout | Broadly still describes real, current gaps (e.g., disconnected MarketDataAdapter abstraction) |

**[FACT]** `FINAL_ANALYSIS.md`'s own §26.4 tally (7/20 real, 13/20 fabricated) is accurate for 19 of the 20 tabs it discusses, but understates News Intel — that tab is now fully real with zero fabrication, and the document has not yet been updated to credit this. This is exactly the kind of "real progress happened and was never recorded" pattern `FINAL_ANALYSIS.md` §25.8 itself warns about.

---

## 23. Dependency Map

**[FACT, from `package.json` read in full this pass.]** Node pinned to `24.18.0`. Key runtime deps: `express ^4.21.2`, `better-sqlite3 ^12.11.1`, `drizzle-orm ^0.45.2`, `ws ^8.21.0`, `react ^19.0.1`/`react-dom ^19.0.1`, `@google/genai ^2.4.0`, `@modelcontextprotocol/sdk ^1.29.0`, `express-rate-limit ^7.5.1`, `vite ^6.2.3`. Key devDeps: `vitest ^4.1.10`, `@playwright/test ^1.62.1`, `drizzle-kit ^0.31.10`, `typescript ~5.8.2`, `tsx ^4.21.0`. **`@types/react`/`@types/react-dom` are absent from both `package.json` and `node_modules`** — a real, load-bearing gap given §17's finding.

---

## 24. Regression Protection Checklist

🔴 = MUST NOT CHANGE without explicit approval and a regression test proving equivalence · 🟡 = CHANGE ONLY WITH APPROVAL · 🟢 = safe to enhance without special ceremony.

**🔴 MUST NOT CHANGE**
- `RiskEngine.evaluateRisk()`'s gate order, gate count (11), and "always evaluate every gate" behavior.
- `OrderManagementService`'s idempotency-by-`traceId` check.
- `AuthConfig.ts`'s startup guard logic (fatal-in-production-if-unset behavior) and `validateCredentials`'s explicit `false`-when-disabled return.
- `BrokerManager.setLiveMode()`'s capability check + confirmation-phrase gate ordering.
- The event contract `TRADE_IDEA_GENERATED`/`CHIEF_APPROVED_IDEA`/`RISK_ASSESSMENT_COMPLETED`/`ORDER_EXECUTED` payload shapes — many downstream listeners (`TransactionLifecycleTracker`, `EventStore`, the WebSocket wildcard broadcast, the frontend's `subscribe()` calls) depend on these exact field names.
- `resolveDbDir.ts`'s Windows-never-considers-`/data` logic.
- The `settings.tradingState` persistence path (kill-switch durability across restarts).

**🟡 CHANGE ONLY WITH APPROVAL**
- Any of the 5 agents' confidence-computation formulas (TechnicalAgent's `strengthToConfidence`, Kronos's quantile-spread formula, the Beta-Binomial calibration math) — these are exactly the kind of "quiet correctness" logic a well-intentioned refactor could silently alter.
- `AIRouter`'s failover ordering and dead-provider-deprioritization logic.
- `PositionSizing.ts` (shared by both live RiskEngine and BacktestEngine — a change here has two blast radii at once).
- The `ARGUS_DB_PATH` test-isolation mechanism (`vitest.setup.ts`, and every test file's own `beforeAll` pattern) — given §16's unresolved flakiness, this is fragile enough to warrant caution before further changes.
- The `activeTab` type union and any of the 20 tab-render blocks in `App.tsx` — given the missing `@types/react` gap, a typo here will not be caught by `tsc`.

**🟢 SAFE TO ENHANCE**
- Any of the confirmed-fabricated widgets (§4's 🟠/🔴 rows) — replacing fabricated data with real data is explicitly the kind of change this whole engagement has been doing safely, provided the real RiskEngine/OrderManagement gate ladder is never bypassed in the process.
- Dead/unused code identified in this report (disconnected `MarketDataAdapter`, dead `agentMemory`/`newsProviders`/`predictionEngineWeights`/`users` tables, the `/api/v1/scheduler` and `/api/v1/risk` legacy stubs) — but only after explicit user confirmation that "no writer found" truly means "safe to remove," not just "not found in this pass's reading."

---

## 25. Critical Findings

### CRITICAL
1. **`tsc --noEmit` passing is not meaningful evidence of type safety for any React code.** `@types/react` is absent; a real type-union bug already exists undetected (`activeTab` omitting 4 real values). Any future refactor of `App.tsx` should not be trusted as "typechecked" until this is addressed or independently verified some other way.
2. **Unresolved test-suite reliability contradiction.** One observed run showed all 42 test files crashing at setup; two immediate re-runs by me passed cleanly. Root cause not established. This must be understood before treating any single `vitest run` as ground truth for whether a future change broke something.

### HIGH
3. `backtestLimiter` is defined but was not found applied to any route in this pass — the `/backtest`/`/backtest/walk-forward` endpoints may be unthrottled.
4. `EncryptionService.ts`'s scrypt salt is a hardcoded literal, identical across every install — weakens key derivation for stored credentials.
5. Route shadowing: `GET /api/v1/brokers` is served by the wrong router due to Express mount order; worked around by a differently-named path rather than fixed at the source.
6. 13/20 frontend tabs still contain fabricated content indistinguishable from real data by looking alone (down from 15/20 before this session's Phase 3 work).
7. `CLAUDE.md`'s table count (27) and `/api/v1/signals` description are stale and will mislead anyone who trusts them without checking source.

### MEDIUM
8. Fundamental/MacroAgent's AI escalation has no confidence gate (unlike NewsEngine) — every real data point triggers an LLM call whenever a Gemini key is configured.
9. `MarketDataAdapter` abstraction (Polygon/Yahoo) is fully disconnected from the live pipeline — dead scaffolding that could mislead a future developer into thinking a second data source is wired in.
10. 4 database tables (`users`, `agentMemory`, `newsProviders`, `predictionEngineWeights`) have no writer anywhere — dead schema.
11. Backend routes for Market Sentiment Trend / Execution Quality Chart appeared mid-audit; whether the corresponding frontend components actually consume them was not verified this pass.

### LOW
12. `KronosForecastAgent`'s `KRONOS_REVERSAL`/`KRONOS_BREAKOUT` events can never fire (dead code — check a field that's never set).
13. `KronosModelManager`'s `memoryUsage`/`gpuUsage`/`inferenceTime` telemetry fields are static placeholders, never updated.
14. Event-shape inconsistency: Kronos's `TRADE_IDEA_GENERATED` payload differs from every other agent's.
15. `/api/v1/mcp/trade` and `/api/v1/llm/dual-verify-trade` are dead (Gemini client hardcoded to `null`).
16. `/api/v1/event-memory`'s "historical precedents" dataset is permanently empty; falls back to a hardcoded canned string.

### WORKING WELL — do not unnecessarily change
- RiskEngine's 11-gate ladder and its "always evaluate everything" design.
- The event-driven pipeline's actual wiring from market data through to order execution — genuinely real, genuinely traceable via `event_traces`.
- `PositionSizing.ts`'s shared-code approach between live and backtest.
- The Transaction Observatory's canonical transaction ledger.
- This session's Phase 3 frontend work (Strategy Scanner, Synergy Matrix, Execute Override, Observability tab) — verified real, tested, and correctly routed through the existing safety gates rather than around them.
- `AuthConfig.ts`'s fail-fast startup guard design.

---

## 26. Recommended Improvements

*(Recommendations only — not implemented, per the explicit instruction governing this report.)*
- Install `@types/react`/`@types/react-dom` so `tsc --noEmit` becomes a meaningful signal for the frontend, then fix the `activeTab` union and any other errors it reveals.
- Investigate the test-suite crash-vs-pass contradiction under controlled, repeated conditions (e.g., run in isolation, then under load, then with a fresh `node_modules`) before trusting CI green as proof of nothing broken.
- Update `CLAUDE.md`'s table count and `/api/v1/signals` description to match current source.
- Confirm whether `backtestLimiter` is genuinely unapplied and, if so, decide whether that's intentional.
- Decide whether the 4 dead tables and the disconnected `MarketDataAdapter` abstraction should be removed or documented as intentionally-reserved-for-future-use.

## 27. Technical Debt

- Two monolithic files (`App.tsx` ~11,200 lines, `server.ts` ~2,000 lines) carrying almost the entire frontend/backend respectively.
- Duplicate/shadowed route registrations (`configRoutes.ts` double-mounted; `/api/v1/brokers` collision).
- Legacy in-memory-only stubs (`/api/v1/scheduler`, `/api/v1/risk`) with no persistence and no real consumer.
- Dead events, dead telemetry fields, dead schema tables enumerated above.

## 28. Production Readiness

Unchanged conclusion from `FINAL_ANALYSIS.md`'s own standing verdict, independently re-affirmed by nothing in this pass contradicting it: **suitable for continued, monitored paper trading of the real backend pipeline; not suitable for live capital**, both because no statistically validated trading edge has been demonstrated and because this pass's own new findings (§25 CRITICAL items) mean the project's own type-safety and test-suite signals are less trustworthy than they appear at face value.

## 29. "DO NOT BREAK" Functionality List

See §24's 🔴 list — reproduced here as the single canonical list for this purpose:
1. RiskEngine's 11-gate, always-evaluate-everything design.
2. OrderManagementService's idempotency-by-traceId.
3. AuthConfig's fatal-in-production startup guard.
4. BrokerManager.setLiveMode()'s capability-then-confirmation-phrase gate ordering.
5. The core event payload shapes (`TRADE_IDEA_GENERATED`/`CHIEF_APPROVED_IDEA`/`RISK_ASSESSMENT_COMPLETED`/`ORDER_EXECUTED`).
6. resolveDbDir.ts's Windows-specific `/data` exclusion.
7. settings.tradingState's restart-durability.

## 30. Proposed Roadmap (informational only — no action taken)

1. Resolve the two CRITICAL findings (§25 #1-2) before trusting any future "tests pass" or "typecheck clean" claim at face value.
2. Update `CLAUDE.md` to match current source (table count, `/api/v1/signals`).
3. Continue the existing, already-in-progress pattern of wiring remaining fabricated tabs to real data, one at a time, each verified never to bypass RiskEngine/OrderManagement.
4. Only after the above: consider any deeper refactor of the two monolithic files, given how much regression surface they represent.

---

**End of baseline. No source files, configuration, dependencies, schema, or tests were modified in the production of this report. Per the governing instructions, no further action will be taken until this is reviewed.**
