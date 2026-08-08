# Argus - DATA FLOW

Complete real data flow through Argus, traced against source on 2026-08-08. A prior revision of this document described a single unified pipeline driven by `TradingEngine.ts`'s "main orchestration loop" emitting `MARKET_DATA_UPDATED`, a `ReflectionAgent.ts` class, a `POSITION_CLOSED` event, and `predictionEngineWeights`-driven consensus — **none of that exists in this codebase**. Below is what actually runs, with real class names, real event names, and real file paths.

---

## 🔄 Complete Real System Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL DATA SOURCES                        │
├─────────────────────────────────────────────────────────────────┤
│  Alpaca WebSocket (real, if keyed) │ RSS feeds (real, no key)   │
│  AlphaVantage/Finnhub/Polygon/FMP (real, if keyed)               │
└────────────┬──────────────────────┴──────────────────────────────┘
             ↓
┌─────────────────────────────────────────────────────────────────┐
│              MARKET DATA INGESTION (TWO INDEPENDENT CLIENTS)     │
├─────────────────────────────────────────────────────────────────┤
│  1. server.ts: initializeAlpacaWebSocket()                      │
│     → populates module-local `liveQuotes` object                │
│     → feeds the legacy /api/v1/signals endpoint and              │
│       BrokerManager.tick() (real fills for InternalPaperBroker)  │
│  2. MarketDataWorker.connectAlpaca() (src/server/services/)      │
│     → populates its own `latestPrices` map AND a real 1-minute   │
│       OHLC bar aggregator used by RiskEngine for ATR              │
│     → eventBus.emitMarketData() → emits 'MARKET_DATA'            │
│  These are uncoordinated duplicates, not two different feeds.    │
└────────────┬────────────────────────────────────────────────────┘
             ↓ eventBus event: 'MARKET_DATA' {symbol, price, volume, timestamp}
┌─────────────────────────────────────────────────────────────────┐
│                    INDEPENDENT AGENT WORKERS                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  TechnicalProposerAgent (src/server/services/TechnicalAgent.ts) │
│  │  • on('MARKET_DATA'): real RSI/MACD/Bollinger Bands math   │  │
│  │  • NO LLM call - pure math                                │  │
│  │  • emitTradeIdea({traceId, symbol, side, confidence (0-1), │  │
│  │      reasoning, agent: "TechnicalAgent", currentPrice})    │  │
│  │  • also emitCalculation(traceId, 'TechnicalEngine', ...)    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  NewsEngine (src/server/news/NewsEngine.ts)                │  │
│  │  • setInterval(10s), independent of MARKET_DATA             │  │
│  │  • fetchAllLatest() across 3 RSS + 4 paid providers (sequential, │
│  │    not parallel - a slow provider serializes the whole cycle) │
│  │  • normalize → dedupe → credibility → classify → symbols →  │  │
│  │    impact → cluster (writes news_articles/news_clusters) →   │
│  │    NewsScoringEngine.analyzeWithAI() via AIRouter            │
│  │  • if tradingBias !== NEUTRAL and outside the 5-min per-symbol│
│  │    cooldown: emitTradeIdea({agent:"NewsAgent", confidence:   │
│  │      (aiConfidence/100)*credibility, newsDetails, ...})       │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  FundamentalAnalysisAgent / MacroEconomyAgent               │  │
│  │  • setInterval(60s / 75s), 3 hardcoded symbols round-robin  │  │
│  │  • AlphaVantage fetch → AIRouter.routeTask() (prompt now     │
│  │    explicitly asks for 0-100 confidence, normalized /100     │
│  │    before emitting - this was a scale bug, fixed)            │
│  │  • emits HOLD/confidence:0 "DATA_UNAVAILABLE" if unkeyed      │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  PortfolioMonitorWorker (src/server/services/PortfolioMonitor.ts) │
│  │  • setInterval(60s), scans real `portfolio` table + live price │
│  │  • hardcoded +5%/-3% thresholds (does NOT read settings.       │
│  │    takeProfitPct/trailingStopPct - see RISK_ENGINE.md)         │
│  │  • emitTradeIdea({agent:"PortfolioManager", side:"SELL", ...}) │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  KronosForecastAgent — 🔴 NEVER FIRES.                     │  │
│  │  Listens for 'MARKET_DATA_UPDATED', which nothing emits.    │  │
│  │  Even if triggered, KronosInference.predict() unconditionally│ │
│  │  throws. See KRONOS.md.                                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  AdvancedQuantEngines / MarketRegimeAgent                   │  │
│  │  • Real computation/LLM call, real events emitted            │  │
│  │  • Output is NEVER consumed by ChiefTraderAgent or RiskEngine │
│  │    (confirmed: TradingEngine's CALCULATION_COMPLETED handler │
│  │    only branches on engine==='TechnicalEngine'; nothing       │
│  │    subscribes to MARKET_REGIME_DETECTED at all)               │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└────────────┬────────────────────────────────────────────────────┘
             ↓ eventBus event: 'TRADE_IDEA_GENERATED'
┌─────────────────────────────────────────────────────────────────┐
│                     CHIEF TRADER CONSENSUS                      │
├─────────────────────────────────────────────────────────────────┤
│  ChiefTraderAgent.reviewIdea() → evaluateConsensus()             │
│  (src/server/services/ChiefTraderAgent.ts)                      │
│  • Weights read from agent_performance_stats (synced every 10s, │
│    NOT from a table called predictionEngineWeights)             │
│  • If adversarialDebateMode && confidence > 0.6 && not already   │
│    in a 60s per-symbol debate cooldown:                          │
│      AIRouter.routeConsensus("ConsensusDebate", prompt, traceId) │
│      → fans out to EVERY registered provider in parallel         │
│      → debate result confidence normalized to 0-1 scale before   │
│        being pushed into the same weighted-average pool           │
│        (0.5 for HOLD, 0.8 for BUY/SELL - this was previously 50/80│
│        on a 0-100 scale, which broke the 0-1 clamp and            │
│        auto-approved nearly any debated trade - fixed)            │
│  • weightedConfidence = Σ(agentConfidence × agentWeight) / Σweight, clamped [0,1] │
│  • if weightedConfidence > 0.75:                                 │
│      eventBus.emitChiefApproval({traceId, symbol, side,          │
│        confidence, reasoning, agentsContext, currentPrice?})     │
│      (currentPrice is the most recent real price attached by any │
│       contributing idea, so RiskEngine has something real to size│
│       against - a prior version dropped this field entirely)      │
└────────────┬────────────────────────────────────────────────────┘
             ↓ eventBus event: 'CHIEF_APPROVED_IDEA'
┌─────────────────────────────────────────────────────────────────┐
│                     RISK VERIFICATION                           │
├─────────────────────────────────────────────────────────────────┤
│  RiskAgent.assessRisk() → RiskEngine.evaluateRisk()              │
│  (src/server/services/RiskAgent.ts, src/server/engines/RiskEngine.ts) │
│  • Resolves price: approval.currentPrice, else                   │
│    marketDataWorker.getLatestPrice(symbol), else REFUSES          │
│    (no hardcoded fallback price - a prior version defaulted to $150)│
│  • Real 14-period Wilder ATR from real 1-min bars, OR a flagged   │
│    flat-5% fallback if <15 bars exist yet                         │
│  • Real daily-loss / 3-consecutive-loss circuit breakers, recomputed│
│    from the `trades` table's real `profitLoss` column on every call│
│  • Real 30% single-symbol concentration cap vs. real broker equity │
│  • Real high-impact-news veto against news_clusters.impactScore   │
│    (a prior version queried news_articles, which has no such       │
│    column, and could never veto anything)                          │
│  • emitRiskAssessment({approved, maxQuantity, currentPrice,         │
│      stopLossPrice, atr?, usedFallbackStop, reasoning})             │
└────────────┬────────────────────────────────────────────────────┘
             ↓ eventBus event: 'RISK_ASSESSMENT_COMPLETED'
┌─────────────────────────────────────────────────────────────────┐
│                        TRADE EXECUTION                          │
├─────────────────────────────────────────────────────────────────┤
│  OrderManagementService.executeOrder()                          │
│  (src/server/services/OrderManagement.ts)                       │
│  • Only proceeds if approved && maxQuantity > 0                  │
│  • BrokerManager.getActiveBroker().placeOrder(...)                │
│    → real Alpaca REST call | real in-memory sim fill |            │
│      throws for Questrade/IBKR/Coinbase (see BROKER_ENGINE.md)    │
│  • If PENDING (async paper-broker fill): polls broker.orders()    │
│    a few times for a terminal status before giving up             │
│  • Computes `profitLoss` for SELL fills against the `portfolio`   │
│    table's cost basis (used by RiskEngine's circuit breakers)      │
│  • db.insert(trades, {id, symbol, side, quantity, price, status,   │
│      timestamp, reasoning, traceId, profitLoss, newsUsed, ...})    │
│  • eventBus.emitOrderExecution({traceId, id, symbol, side,          │
│      quantity, price, status, profitLoss})                         │
└────────────┬────────────────────────────────────────────────────┘
             ↓ eventBus event: 'ORDER_EXECUTED'
┌─────────────────────────────────────────────────────────────────┐
│                    PORTFOLIO RECONCILIATION                     │
├─────────────────────────────────────────────────────────────────┤
│  PortfolioReconciliationWorker (setInterval, 5 min)              │
│  Pulls the broker's real positions and repairs the local          │
│  `portfolio` table to match. There is no separate "position       │
│  monitoring" step that checks stop-loss/take-profit against the   │
│  broker directly - that's PortfolioMonitorWorker (above), on its  │
│  own 60s timer with hardcoded thresholds.                          │
└────────────┬────────────────────────────────────────────────────┘
             ↓
┌─────────────────────────────────────────────────────────────────┐
│                    REFLECTION & LEARNING                        │
├─────────────────────────────────────────────────────────────────┤
│  ReflectionEngine.evaluateAgents() (setInterval, 60s)            │
│  (src/server/services/ReflectionEngine.ts)                       │
│  • Scores agents against real subsequent price movement           │
│  • Updates agent_performance_stats.currentWeight - THIS feeds      │
│    back into ChiefTraderAgent's consensus math (real influence)    │
│  • On recent losses: AIRouter.routeTask('ReflectionEngine', ...)   │
│    → writes one sentence into learned_rules                        │
│  • eventBus.emitLearningEvent(rule) → emits 'LEARNED_NEW_RULE'      │
│    (NOT 'POSITION_CLOSED', which doesn't exist in this codebase,    │
│    and NOT 'NEW_RULE_LEARNED', which two OTHER listeners in the     │
│    codebase incorrectly wait for and never receive - see EVENTBUS.md)│
│  🔴 The rule TEXT is loaded into tradingEngine.state.memoryRules    │
│  at boot but is NEVER injected into any agent's prompt. Only the    │
│  numeric weight adjustment above actually closes a feedback loop.   │
└────────────┬────────────────────────────────────────────────────┘
             ↓
┌─────────────────────────────────────────────────────────────────┐
│                      FRONTEND UPDATES                           │
├─────────────────────────────────────────────────────────────────┤
│  Every event above reaches the browser via the EventBus wildcard  │
│  → WebSocket forwarding (server.ts). App.tsx (src/App.tsx)         │
│  actually calls useWebSocket().subscribe() for only 2 of the       │
│  ~15 broadcast event types: 'AUTOBOT_STATE_UPDATED' and             │
│  'TRADE_IDEA_GENERATED'. Most of what this diagram describes        │
│  reaches the browser and is then ignored by every component.       │
│  See FRONTEND_GUIDE.md for the real per-dashboard breakdown.        │
└─────────────────────────────────────────────────────────────────┘
```

---

## The other execution path (legacy, still live)

`GET /api/v1/signals` in `server.ts` is a **completely separate** flow that does not touch anything above:

```
Request arrives → build 9 hardcoded agent_* signal objects (static confidence values)
  → optionally call Gemini for one sentiment score (only if the module-level `ai`
    variable is non-null, which it never is in the current code - it's hardcoded to
    `null` unconditionally, so this branch is always skipped and a canned fallback
    sentiment/reasoning string is used every time)
  → count BUY/SELL/HOLD votes → finalDecision
  → if BUY/SELL: call Alpaca's REST /v2/orders directly (bypassing BrokerManager,
    RiskEngine, and OrderManagementService entirely)
  → update data/portfolio.json (a separate ledger from the `trades`/`portfolio` tables)
```

Some older frontend panels still call this endpoint. Don't assume a call to `/api/v1/signals` exercises anything described in the main diagram above.

---

## State Management (real)

### In-memory (`tradingEngine.state`) — lost on restart except what's re-loaded from DB at boot
```ts
{
  enabled, tradingMode, budget, spent, riskLevel, maxTradeSize, dailyLossLimit,
  currentDailyLoss,      // UI-display mirror; NOT the source of truth RiskEngine reads
  history: [],           // last 100 log entries, reset on restart
  memoryRules: [],        // re-loaded from `memory_rules` table at boot
  activeCycle: {...},     // static, not actively transitioned - see SYSTEM_DESIGN.md
  engines: {...}          // updated only by the TechnicalEngine branch of CALCULATION_COMPLETED
}
```

### SQLite (real persistence — see [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) for the full 20-table list)
`settings`, `trades`, `portfolio`, `ai_usage`, `ai_providers`, `agent_performance_stats`, `learned_rules`, `memory_rules`, `news_articles`, `news_clusters`, `kronos_predictions` (schema-ready, never populated), `event_traces` (schema exists, no writer).

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
- [EVENTBUS.md](./EVENTBUS.md) — full event catalog and the two confirmed name mismatches
- [ARCHITECTURE.md](./ARCHITECTURE.md) — component map
- [API_REFERENCE.md](./API_REFERENCE.md) — real API endpoints
