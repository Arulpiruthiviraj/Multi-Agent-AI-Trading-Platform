# Argus - API REFERENCE

Complete reference for the real HTTP and WebSocket API, verified against `server.ts`, `src/server/routes/configRoutes.ts`, and `src/server/routes/v2System.ts` on 2026-08-08. **A prior revision of this document invented an entirely different route namespace** (`/api/config/*`, `/api/autobot/*`, `/api/kronos/*`, `/api/market/*`, `/api/v2/health`, `/api/v2/execute`) that does not exist anywhere in this codebase. Every route below was confirmed present by direct inspection of the route-registration calls.

---

## 🌐 Base URL

**Default port is 5000** (`Number(process.env.PORT) || 5000`), not 3000, not the `/api/config`/`/api/autobot` prefixes a prior revision claimed. Override with `PORT` in `.env`.

```
http://localhost:5000
```

---

## 🔐 Authentication

Real, but **off by default**. If `APP_PASSWORD` is not set in the environment, every route below is open with no authentication at all. If it is set:

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "password": "..." }
```
Sets an HMAC-SHA256-signed, `httpOnly` session cookie (`argus_session`) on success.

```http
POST /api/v1/auth/logout
GET  /api/v1/auth/status     → { "requiresAuth": boolean, "authenticated": boolean }
```

**The `/ws` WebSocket endpoint has no authentication check at all**, independent of `APP_PASSWORD` — anyone who can reach the port can open it and receive the full live event stream.

---

## 📡 REST API — `/api/v1/config/*` (mounted from `configRoutes.ts`)

Note the real prefix is `/api/v1/config`, not `/api/config` as a prior revision of this doc claimed.

```http
GET  /api/v1/config/settings          → the single settings row (or a default object if none exists yet)
POST /api/v1/config/settings          → replaces the settings row wholesale (deletes then re-inserts) and calls tradingEngine.toggle(body)
GET  /api/v1/config/brokers           → all broker_connections rows (including encrypted key/secret ciphertext - not redacted)
POST /api/v1/config/brokers           → inserts a broker_connections row; encrypts apiKeyEncrypted/apiSecretEncrypted if not already in "iv:data" form
GET  /api/v1/config/providers         → all ai_providers rows (including encrypted key ciphertext)
POST /api/v1/config/providers         → upserts an ai_providers row by providerName
                                          ⚠️ has a known bug: also calls
                                          AIRouter.getInstance().registerProvider(provider, provider),
                                          registering a string where an AIProvider instance is expected.
                                          A newly-saved provider does not become routable until a
                                          full server restart re-runs AIRouter.initialize().
GET  /api/v1/config/models            → all ai_models rows (decorative - see AI_CONTEXT.md; not read by real routing)
GET  /api/v1/config/usage             → all ai_usage rows (cost column is always 0 - see AI_CONTEXT.md)
```

Real `settings` row shape (from `schema.ts`):
```json
{
  "id": 1,
  "tradingMode": "PAPER",
  "riskLevel": "Balanced",
  "selectedBroker": null,
  "selectedAiProvider": null,
  "budget": 50000,
  "strategy": "Momentum Focus",
  "maxTradeSize": 3000,
  "dailyLossLimit": 5000,
  "takeProfitPct": 15,
  "trailingStopPct": 5,
  "minAiConfidence": 75,
  "autoBotEnabled": false,
  "adversarialDebateMode": true
}
```

---

## 📡 REST API — `/api/v2/*` (mounted from `v2System.ts`)

```http
GET  /api/v2/agents/performance        → { ok, stats: agent_performance_stats rows }
POST /api/v2/system/toggle             → { enabled, mode } → SystemBootstrap.start()/stop() directly (bypasses tradingEngine.toggle's settings persistence)
GET  /api/v2/system/status             → { ok, status, workers: [...static descriptive list, not live per-worker health] }
GET  /api/v2/data/trades               → last 50 trades, ordered by timestamp desc
GET  /api/v2/data/portfolio            → all portfolio rows
POST /api/v2/system/backtest           → ⚪ MOCKED. Returns a hardcoded result object after a 2s setTimeout, regardless of {strategy, symbol, timeframe} input.
GET  /api/v2/system/events             → the in-memory EventStore.recentEvents array (last 200, NOT the event_traces DB table, which has no writer)
GET  /api/v2/system/trace/:traceId     → the in-memory EventStore.tradeTraces[traceId] array
GET  /api/v2/data/explainability/:traceId → the matching explainability_reports row, if ExplainabilityAgent generated one
```

There is **no** `GET /api/v2/health`, `GET /api/v2/agents` (without `/performance`), or `POST /api/v2/execute` — a prior revision of this document invented all three.

---

## 📡 REST API — top-level `/api/v1/*` (registered directly in `server.ts`)

The real, verified route list (grouped by area; response shapes reflect the real schema, not invented fields like `orderId`/`filledPrice`):

### Autonomous bot control
```http
GET  /api/v1/autobot/state             → the full tradingEngine.state object, verbatim (large; includes history, memoryRules, engines, activeCycle, etc.)
GET  /api/v1/autobot                   → a curated subset of the above, plus DB-backed memoryRules and shadowPortfolio
POST /api/v1/autobot/toggle            → tradingEngine.toggle(req.body); NO validation of broker/AI configuration before accepting {enabled:true}
POST /api/v1/autobot/memory            → add/delete a memory_rules row ({action:"add", rule} or {action:"delete", index})
POST /api/v1/autobot/evolve            → genetic-prompt evolution feature for the legacy simulation path
```

### Kronos
```http
GET  /api/v1/kronos/status             → KronosEngine.getStatus() - reports a FABRICATED "Ready" status; see KRONOS.md
```
There is no `/api/kronos/predictions`, `/api/kronos/predict`, or `/api/kronos/accuracy` — a prior revision invented all three under a nonexistent `/api/kronos` prefix.

### Legacy simulation path (bypasses the real pipeline entirely)
```http
GET  /api/v1/signals?symbol=...&sector=...&broker=...   → builds 9 hardcoded signal objects, votes by counting, may call Alpaca's REST API directly
POST /api/v1/backtest                  → ⚪ MOCKED. Hardcoded {returnPct:15.5, sharpe:2.1, maxDrawdown:0.05, trades:12, curve:[]} regardless of input.
POST /api/v1/llm/consensus
POST /api/v1/llm/dual-verify-trade      → 🔴 BROKEN. Always returns 503 "Gemini AI not initialized on the server" — the module-level `ai` variable it checks is unconditionally `null` in the current code, regardless of GEMINI_API_KEY.
GET  /api/v1/portfolio                 → legacy data/portfolio.json-backed ledger, separate from the real `portfolio` table
```

### Broker / market data (legacy path)
```http
GET  /api/v1/marketdata/adapters
POST /api/v1/marketdata/active
GET  /api/v1/brokers
POST /api/v1/brokers/active
GET  /api/v1/alpaca/config             → { hasAlpacaKeys: boolean }
GET  /api/v1/alpaca/quote?symbol=...
GET  /api/v1/alpaca/news?symbol=...
POST /api/v1/mcp/trade
```

### System / audit
```http
GET  /api/v1/audit/trail
POST /api/v1/system/emergency-stop     → only affects the legacy simulation's own state flags, does NOT call SystemBootstrap.stop() on the real workers
POST /api/v1/system/resume
GET  /api/v1/system/status
GET  /api/v1/system/export-db          → downloads the REAL data/argus.db file (fixed; a prior version pointed at a nonexistent database/argus.db path and always 404'd)
POST /api/v1/system/import-db          → overwrites data/argus.db with the request body (raw octet-stream, 50mb limit)
GET  /api/v1/agents                    → { weights: { agentName: currentWeight } } from agent_performance_stats
GET  /api/v1/performance               → per-agent win rate / return / profit factor / Sharpe, from agent_performance_stats
GET  /api/v1/trades                    → all real trades rows
GET  /api/v1/agent-memory              → all agent_memory rows
GET  /api/v1/event-traces              → all event_traces rows (will always be empty - no writer exists)
GET  /api/v1/pnl/analytics
```

### News (real, DB-backed)
```http
GET  /api/v1/news/timeline             → NewsTimelineEngine.getTimeline() - recent news_clusters
GET  /api/v1/news/memory?symbol=...    → NewsMemoryEngine.getRecentEventsForSymbol()
GET  /api/v1/news/providers            → real provider list from NewsProviderManager, with hardcoded health/errorCount/lastFetch placeholder fields
GET  /api/v1/news/articles
```

### Event memory (legacy, LLM-grounded historical-precedent search)
```http
POST /api/v1/event-memory/feedback
GET  /api/v1/event-memory
```

### Chaos engineering (intentional simulated-failure testing feature, not a bug)
```http
GET  /api/v1/chaos/config
POST /api/v1/chaos/config
POST /api/v1/chaos/macro-shock
POST /api/v1/chaos/macro-shock/clear
```

### Webhooks
```http
GET    /api/v1/webhooks
POST   /api/v1/webhooks
PUT    /api/v1/webhooks/:id
DELETE /api/v1/webhooks/:id
POST   /api/v1/webhooks/test
```

---

## 🔴 Routes the frontend calls that do NOT exist (confirmed 404 via the `app.all('/api/*', ...)` catch-all)

`App.tsx` contains `fetch()` calls to all of the following, none of which are registered anywhere in `server.ts`, `configRoutes.ts`, or `v2System.ts`:

```
/api/v1/portfolio/liquidate
/api/v1/portfolio/rebalance
/api/v1/risk/:vetoId/review
/api/v1/scheduler
/api/v1/secrets
/api/v1/secrets/test
/api/v1/settings/toggle-live
```

If you're implementing a UI feature that calls one of these, the backend route needs to be created — it isn't a naming mismatch you can fix by looking harder.

---

## 🔌 WebSocket API

**URL**: `ws://localhost:5000/ws` (note the `/ws` path — connecting to the bare origin, as a prior revision of this doc showed, will not upgrade).

```js
const ws = new WebSocket('ws://localhost:5000/ws');
ws.onmessage = (event) => {
  const { type, data } = JSON.parse(event.data);
  // type is the real EventBus event name (e.g. 'MARKET_DATA', 'TRADE_IDEA_GENERATED',
  // 'RISK_ASSESSMENT_COMPLETED', 'ORDER_EXECUTED', 'AUTOBOT_STATE_UPDATED', ...)
  // See EVENTBUS.md for the full catalog and real payload shapes.
};
```

Client sends `{"type": "ping"}`, server replies `{"type": "pong"}` — used for the heartbeat/dead-connection detection in `WebSocketContext.tsx`. There is no `market_update`/`trade_executed`/`ai_metrics_update`/`agent_proposal`/`risk_veto`/`learned_rule` message-type namespace as a prior revision invented — every WebSocket message's `type` field is the literal real EventBus event name (see [EVENTBUS.md](./EVENTBUS.md)), except `AUTOBOT_STATE_UPDATED`, which is a plain `setInterval(2000ms)` broadcast outside the EventBus entirely.

---

## 🛠️ Error Responses

Most handlers follow `res.status(500).json({ error: e.message })` on failure (standardized during this audit pass — several previously returned an unrelated hardcoded news-article fallback object on error, a copy-paste artifact that has been removed). There is no formal `{error, code, details}` envelope or `ERROR_CODE`/`RATE_LIMITED` taxonomy anywhere in the actual code — a prior revision of this document invented one.

---

## 📝 Notes for AI Agents

1. **Async operations**: many endpoints trigger real async work (AI calls, broker orders). Prefer the WebSocket stream for live updates — but check [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md) first, since most event types currently have no frontend consumer to build on.
2. **State consistency**: `/api/v1/autobot/state` returns `tradingEngine.state` verbatim, which is in-memory and resets on restart except for `settings`/`memory_rules`, which are reloaded from the DB.
3. **AI Router abstraction**: real — never call an LLM provider directly; always go through `AIRouter`.
4. **Kronos**: do not build against `/api/v1/kronos/status`'s `isAvailable: true` as evidence that forecasting works — it's fabricated. See [KRONOS.md](./KRONOS.md).
5. **Testing**: use Paper mode. There is no automated test suite backing any of these endpoints — manual verification is currently the only verification.

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
- [DATA_FLOW.md](./DATA_FLOW.md) — how these endpoints relate to the real pipeline
- [EVENTBUS.md](./EVENTBUS.md) — WebSocket message catalog
