# Database Schema - Argus Trading Terminal

Complete reference for the real SQLite schema, verified line-by-line against `src/server/db/schema.ts` on 2026-08-08. **A prior revision of this file described a different, fictional schema** (tables named `learningEvents`, `tradeJournal`, columns like `trades.orderId`/`stopLoss`/`takeProfit`/`realizedPnL`/`commission` that don't exist in this codebase). Every table and column below is copied directly from the real schema file.

---

## 🗄️ Overview

**Database file**: `data/argus.db` (SQLite, WAL mode) — not `sqlite.db` at the repo root, which is an orphaned leftover file nothing in the code reads.
**ORM**: Drizzle ORM
**Migrations**: `drizzle/0000_eager_hobgoblin.sql`, `drizzle/0001_abnormal_songbird.sql` — verified in sync with `schema.ts` (spot-checked: `trades.profit_loss`, `news_clusters`, `impact_score`, `kronos_predictions`, `prediction_engine_weights`, `explainability_reports`, `event_traces` all present in the migrations).
**Schema definition**: `src/server/db/schema.ts`
**Migrations run automatically** on every server start (`db/index.ts` calls Drizzle's `migrate()` at import time). `npm run db:migrate` (`tsx database/migrate.ts`) is broken — that path doesn't exist in this repo.

**Total tables: 20** (verified by counting `sqliteTable(...)` calls in `schema.ts` — a prior draft of this audit pass miscounted this as 23; 20 is correct).

---

## 📊 Table Definitions (all 20, real columns only)

### 1. `users`
No auth system uses this table currently (the real session-based auth in `server.ts` is password-only, no user accounts).
```ts
users: id (INTEGER PK autoincrement), email (TEXT NOT NULL), passwordHash (TEXT), createdAt (INTEGER, default Date.now())
```

### 2. `settings`
Single row, read/written by `TradingEngine`, `configRoutes.ts`. Real, actively used.
```ts
settings: id, tradingMode (default 'Paper'), riskLevel (default 'Balanced'), selectedBroker, selectedAiProvider,
  budget (default 50000), strategy (default 'Momentum Focus'), maxTradeSize (default 3000),
  dailyLossLimit (default 5000), takeProfitPct (default 15), trailingStopPct (default 5),
  minAiConfidence (default 75), autoBotEnabled (BOOL, default false), adversarialDebateMode (BOOL, default true),
  createdAt
```
`takeProfitPct`/`trailingStopPct` are persisted here but **not enforced** by `RiskEngine` — see [RISK_ENGINE.md](./RISK_ENGINE.md).

### 3. `broker_connections`
```ts
brokerConnections: id, brokerName, apiKeyEncrypted, secretEncrypted, paperMode (BOOL, default true), status (default 'Disconnected')
```
`status` is display-only — `BrokerManager` doesn't read/write it as a gate. Written by `configRoutes.ts` POST `/brokers`.

### 4. `ai_providers`
Real registry read by `AIRouter.initialize()`.
```ts
aiProviders: id (TEXT PK, uuid), providerName, displayName, apiEndpoint, apiKeyEncrypted, enabled (BOOL, default true),
  priority (default 1), active (BOOL, default true), health (default 'Healthy'), latency (default 0), quota (default 0),
  requests (default 0), tokens (default 0), inputTokens (default 0), outputTokens (default 0), cost (default 0),
  successRate (default 100), lastFailure, lastSuccess, createdAt, updatedAt
```
`cost` is written by `AIRouter` on every call but is **always `0`** — no provider implementation returns a nonzero `estimateCost()`. `successRate` is a real EMA of actual outcomes, updated on every call.

### 5. `ai_models`
🟠 **Decorative** — seeded by `seedModels.ts` with 6 hardcoded rows (including a `"Claude"` provider that has no corresponding `AIProvider` class anywhere in the codebase). `AIRouter`'s actual provider instantiation reads only `ai_providers`, never this table.
```ts
aiModels: id, providerId, provider, model, displayName, capabilities, predictedOhlc, marketStructure, momentum,
  actualResult, mae, rmse, mape, directionalAccuracy, contextWindow (default 8192), maxOutput (default 4096),
  reasoningSupport (BOOL), visionSupport (BOOL), toolCalling (BOOL), structuredOutput (BOOL), streaming (BOOL, default true),
  pricingInput (default 0), pricingOutput (default 0), enabled (BOOL, default true), priority (default 1),
  latencyScore (default 0), errorRate (default 0), tokenUsage (default 0), estimatedCost (default 0),
  lastUsedAt, lastHealthCheck
```
Note the odd forecast-related columns (`predictedOhlc`, `mae`, `rmse`, `directionalAccuracy`) on a *model registry* table — these mirror columns also present on `kronos_predictions` and appear to be copy-paste residue; nothing writes forecast data into `ai_models`.

### 6. `ai_usage`
Real, append-only. Written by `AIRouter.routeTask()`/`routeConsensus()` on every call, success or failure.
```ts
aiUsage: id, timestamp, provider, model, predictedOhlc, marketStructure, momentum, actualResult, mae, rmse, mape,
  directionalAccuracy, agent, promptTokens (default 0), completionTokens (default 0), latency (default 0),
  cost (default 0), responseStatus, retryCount (default 0)
```
Same forecast-column residue as `ai_models`, unused here. `cost` is always `0` for the same reason as `ai_providers.cost`.

### 7. `trades`
Real execution log. Written by `OrderManagementService.executeOrder()`. Read by `RiskEngine` (circuit breakers), `ReflectionEngine`, UI.
```ts
trades: id (TEXT PK), symbol, side, quantity, price, status, timestamp, reasoning, traceId, profitLoss,
  newsUsed (BOOL, default false), newsSentiment, newsConfidence, newsSources, newsReasoning
```
There is **no** `orderId`, `strategyType`, `aiConfidence`, `entryPrice`, `exitPrice`, `stopLoss`, `takeProfit`, `commission`, or `notes` column — a prior doc revision invented all of these. `profitLoss` is computed by `OrderManagementService` for SELL fills against the `portfolio` table's cost basis, and is the field `RiskEngine`'s daily-loss/consecutive-loss circuit breakers actually read.

### 8. `portfolio`
Local mirror of broker positions, kept in sync by `PortfolioReconciliationWorker` every 5 minutes.
```ts
portfolio: symbol (TEXT PK), quantity, averagePrice, currentPrice, lastUpdated, unrealizedPnL, brokerSource
```

### 9. `learned_rules`
```ts
learnedRules: id (TEXT PK), agent, cause, rule, confidence, timestamp
```
Written by `ReflectionEngine.generateReflectionRule()`. **Never read back into any agent's prompt** — see [AI_CONTEXT.md](./AI_CONTEXT.md).

### 10. `agent_predictions`
```ts
agentPredictions: id, agentName, symbol, prediction, confidence, reasoning, timestamp
```
Written by `ReflectionEngine.logPrediction()` on every `TRADE_IDEA_GENERATED` event. Read back by `ReflectionEngine.evaluateAgents()` to compute win rates.

### 11. `agent_performance_stats`
The table `ChiefTraderAgent` actually reads for its dynamic consensus weights (`syncWeights()`, every 10s).
```ts
agentPerformanceStats: agentName (TEXT PK), totalPredictions (default 0), correctPredictions (default 0),
  winRate (default 0), averageReturn (default 0), profitFactor (default 0), sharpeRatio (default 0),
  currentWeight (default 1.0), lastEvaluated
```
Note: this is **not** the same table as `prediction_engine_weights` (#20 below) — a prior doc conflated the two. This one has real read/write traffic and real influence on trading decisions.

### 12. `explainability_reports`
```ts
explainabilityReports: traceId (TEXT PK), symbol, decision, reportText, timestamp
```
Written by `ExplainabilityAgent` after every `ORDER_EXECUTED`/vetoed `RISK_ASSESSMENT_COMPLETED` (gated on `GEMINI_API_KEY` being set). Read by `GET /api/v2/data/explainability/:traceId`.

### 13. `agent_memory`
```ts
agentMemory: id (INTEGER PK autoincrement), agentName, decision, reasoning, confidence, result
```
Schema present; no writer was found in the current codebase during this audit pass.

### 14. `event_traces`
```ts
eventTraces: id (TEXT PK), correlationId, tradeId, timestamp, source, destination, eventType, payload,
  durationMs, success (BOOL, default true), errorInfo
```
🔴 **No writer anywhere in the codebase.** Don't confuse this with `EventStore.ts`'s separate in-memory `recentEvents`/`tradeTraces` arrays, which is what actually backs `GET /api/v2/system/events` and `GET /api/v2/system/trace/:traceId` — that data is never persisted here or anywhere else, and is lost on restart.

### 15. `memory_rules`
```ts
memoryRules: id (INTEGER PK autoincrement), ruleText, weight (default 1.0), createdAt
```
User-injected context rules via `POST /api/v1/autobot/memory`. Loaded into `tradingEngine.state.memoryRules` at boot — same "never injected into a prompt" caveat as `learned_rules` applies here too.

### 16. `news_articles`
```ts
newsArticles: id (TEXT PK), title, content, url, source, author, publishedAt, clusterId, sentimentScore,
  credibilityScore, relevanceScore, summary, symbols (TEXT, JSON array)
```
Written by `NewsClusterEngine.createOrUpdateCluster()`. **No `impactScore` column** — that lives on `news_clusters` instead. `RiskEngine`'s news veto correctly queries `news_clusters`, not this table.

### 17. `news_clusters`
```ts
newsClusters: id (TEXT PK), title, summary, createdAt, updatedAt, eventType, sentimentScore, impactScore,
  timeHorizon, isArchived (BOOL, default false), symbols (TEXT, JSON array)
```
This is the table `RiskEngine`'s high-impact-news veto actually reads.

### 18. `news_providers`
```ts
newsProviders: id (TEXT PK), name, type, apiKeyEncrypted, enabled (BOOL, default true), lastFetch,
  health (default 'Healthy'), errorCount (default 0), credibilityWeight (default 1.0)
```
Schema exists for a DB-backed provider registry, but the real news providers are hardcoded in `NewsProviderManager`'s constructor (`RssNewsProvider` × 3, `FinnhubNewsProvider`, `AlphaVantageNewsProvider`, `PolygonNewsProvider`, `FMPNewsProvider`) rather than loaded from this table. `GET /api/v1/news/providers` synthesizes its response from the in-memory provider list with hardcoded `health: 'Healthy'` / `errorCount: 0` / `lastFetch: <now>` placeholders, not from this table's real rows.

### 19. `kronos_predictions`
```ts
kronosPredictions: timeframe (default '1m'), id (INTEGER PK autoincrement), symbol, prediction, confidence,
  forecastHorizon, expectedMove, volatility, support, resistance, model, predictedOhlc, marketStructure,
  momentum, actualResult, mae, rmse, mape, directionalAccuracy, timestamp
```
Schema is correct and fully wired to receive data from `KronosMetrics.recordPrediction()` — but **never populated**, because Kronos cannot produce a successful prediction under any configuration. See [KRONOS.md](./KRONOS.md).

### 20. `prediction_engine_weights`
```ts
predictionEngineWeights: id (TEXT PK, engine name e.g. 'Kronos'/'Technical'), winRate (default 0), accuracy (default 0),
  averagePredictionError (default 0), precision (default 0), recall (default 0), roi (default 0),
  sharpeContribution (default 0), drawdownContribution (default 0), lastUpdated
```
Schema exists; no writer was found in the current codebase during this audit pass. Do not confuse this with `agent_performance_stats` (#11), which *is* the table that actually drives `ChiefTraderAgent`'s weighting.

---

## 🔄 Migrations

Migrations run automatically on server start — there is nothing to run manually. If you change `schema.ts`, generate a new migration with:

```bash
npx drizzle-kit generate
```

Review the generated SQL in `drizzle/` before committing. The `npm run db:migrate` script is broken (points at a nonexistent `database/migrate.ts`); don't rely on it.

---

## 📈 Real Query Examples (drawn from actual current code)

### Today's realized loss (from `RiskEngine.evaluateRisk()`)
```ts
const recentTrades = await db.select().from(schema.trades)
  .orderBy(desc(schema.trades.timestamp)).limit(200).all();
const todayStr = new Date().toISOString().slice(0, 10);
const todaysRealizedLoss = recentTrades
  .filter(t => t.timestamp?.slice(0, 10) === todayStr && typeof t.profitLoss === 'number')
  .reduce((sum, t) => sum + t.profitLoss, 0);
```

### High-impact news check (from `RiskEngine.evaluateRisk()`)
```ts
const recentClusters = await db.select().from(schema.newsClusters)
  .orderBy(desc(schema.newsClusters.createdAt)).limit(50).all();
// filter: impactScore > 80, createdAt within last 4h, symbol present in JSON.parse(symbols)
```

### Agent weight sync (from `ChiefTraderAgent.syncWeights()`)
```ts
const stats = await db.select().from(agentPerformanceStats).all();
for (const s of stats) this.agentWeights[s.agentName] = s.currentWeight;
```

---

## 🔧 Maintenance

```bash
# Backup
cp data/argus.db data/argus_backup_$(date +%Y%m%d).db

# Size
ls -lh data/argus.db
```

There is a real `GET /api/v1/system/export-db` / `POST /api/v1/system/import-db` pair in `server.ts` that operate on the correct `data/argus.db` path (a prior version of this endpoint pointed at a nonexistent `database/argus.db` path and always 404'd — fixed).

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
- [RISK_ENGINE.md](./RISK_ENGINE.md) — the tables `RiskEngine` actually reads
- [API_REFERENCE.md](./API_REFERENCE.md) — real API endpoints
