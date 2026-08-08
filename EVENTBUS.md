# Argus EventBus

Real event reference, verified against `src/server/core/EventBus.ts` and every `eventBus.on(...)`/`eventBus.emit(...)` call site in the codebase on 2026-08-08. Argus uses an in-memory Node `EventEmitter` subclass (`EventBus`) to decouple agent workflows — no persistence, no replay, no cross-process delivery.

**Read this before assuming an event "works."** Two confirmed event-name mismatches mean some listeners in this codebase have never fired, ever, and won't until fixed. They're documented explicitly below rather than silently perpetuated.

---

## Real event catalog

| Event | Emitted by | Consumed by | Notes |
|---|---|---|---|
| `MARKET_DATA` | `MarketDataWorker.emitMarketData()` | `TechnicalAgent`, `AdvancedQuantEngines`, `EventStore`, `SystemMetricsWorker` | **This is the real market-tick event name.** Payload: `{symbol, price, volume, timestamp}`. |
| `TRADE_IDEA_GENERATED` | `TechnicalAgent`, `NewsEngine`, `FundamentalAgent`, `MacroAgent`, `PortfolioMonitor`, (`KronosForecastAgent` — never reaches emission, see below) | `ChiefTraderAgent`, `ReflectionEngine.logPrediction`, `EventStore`, `SystemMetricsWorker` | Payload includes `confidence` on a **0-1 scale** consistently across all real emitters (this was previously a source of bugs — see `ChiefTraderAgent`'s debate branch history in git). `currentPrice` is attached by `TechnicalAgent`/`PortfolioMonitor`; other emitters omit it and downstream consumers fall back to the latest live tick. |
| `CHIEF_APPROVED_IDEA` | `ChiefTraderAgent.evaluateConsensus()` | `RiskAgent`, `EventStore` | Fires only when weighted confidence > 0.75. |
| `RISK_ASSESSMENT_COMPLETED` | `RiskEngine` (via its internal `veto()`/approve paths) | `OrderManagementService`, `ExplainabilityAgent`, `EventStore`, `SystemMetricsWorker` | `approved: false` on veto with a `reasoning` string; `approved: true` includes `maxQuantity`, `currentPrice`, `stopLossPrice`, `atr`, `usedFallbackStop`. |
| `ORDER_EXECUTED` | `OrderManagementService.executeOrder()` | `TradingEngine` (spent/dailyLoss tracking), `ExplainabilityAgent`, `EventStore` | Includes `profitLoss` for SELL fills where a cost basis was known. |
| `LEARNED_NEW_RULE` | `ReflectionEngine.generateReflectionRule()` via `eventBus.emitLearningEvent()` | `TradingEngine` (pushes to `state.memoryRules`) | 🔴 **See mismatch #2 below** — two other would-be listeners never receive this. |
| `CALCULATION_COMPLETED` | `TechnicalAgent` (`engine: 'TechnicalEngine'`), `AdvancedQuantEngines` (`engine: 'AdvancedQuantEngine'`) | `TradingEngine` (only handles `engine === 'TechnicalEngine'`), `EventStore`, `SystemMetricsWorker` | 🟠 `AdvancedQuantEngine`'s payload is real (ATR/ADX/VWAP/OBV/MFI/Stochastic) but `TradingEngine` never branches on it — it reaches the frontend via the wildcard broadcast only. |
| `MARKET_REGIME_DETECTED` | `MarketRegimeAgent.detectRegime()` | **Nobody** — confirmed by repo-wide search | 🔴 Reaches the browser over the wildcard broadcast; no component or agent subscribes to it. |
| `KRONOS_FORECAST_STARTED` / `KRONOS_FORECAST_COMPLETED` / `KRONOS_BATCH_COMPLETED` | `KronosEngine.predict()`/`batchPredict()` | Nobody meaningful | 🔴 Never actually fires in practice — see [KRONOS.md](./KRONOS.md); `predict()` throws before `KRONOS_FORECAST_COMPLETED` would ever be reached. |
| `KRONOS_HIGH_CONFIDENCE` / `KRONOS_LOW_CONFIDENCE` / `KRONOS_REVERSAL` / `KRONOS_BREAKOUT` | `KronosForecastAgent.broadcastForecast()` | Nobody | 🔴 Dead code path — this method is never reached because its trigger event never fires (see mismatch #1 below). |
| `KRONOS_STATUS_CHANGE` / `KRONOS_UPDATE` | `KronosModelManager` | Nobody meaningful | Fires with fabricated status constants (`'Ready'`, fake GPU/memory numbers) — real event, fake payload. |
| `SYSTEM_METRICS` | `SystemMetricsWorker.broadcastMetrics()` (every 2s) | Frontend, over the wildcard broadcast | Per-worker CPU/memory fields are hardcoded `"0.0"`/`"0"` (explicitly de-mocked from a prior `Math.random()` implementation — not measured, just zeroed). |
| `MARKET_DATA_DISCONNECTED` | `MarketDataWorker.start()` when no Alpaca keys are configured | Nobody found | Informational; confirms the "idle without fabricating data" design intent for the no-key case. |
| `NEWS_ANALYZED` / `NEWS_CLUSTER_CREATED` / `NEWS_PROVIDER_FAILED` | `NewsEngine`/`NewsClusterEngine`/`NewsProviderManager` | Frontend, over the wildcard broadcast | Real. |
| `AUTOBOT_STATE_UPDATED` | `server.ts` (a plain `setInterval(2000ms)`, **not** an EventBus event) | Frontend (`WebSocketContext`, one of the 2 event types `App.tsx` actually subscribes to) | Broadcast directly to all WS clients, bypassing `EventBus` entirely. |
| `UI_UPDATE` (with `payload.type: 'ai_metrics_update'`) | `AIRouter.routeTask()`/`routeConsensus()` | Frontend, over the wildcard broadcast | Real per-call telemetry, except `cost`/`tokens` fields, which are frequently `0` for the reasons in [AI_CONTEXT.md](./AI_CONTEXT.md) § AIRouter. |

---

## 🔴 Confirmed event-name mismatches (dead listeners)

### 1. `MARKET_DATA` vs. `MARKET_DATA_UPDATED`

```ts
// src/server/core/EventBus.ts — the ONLY real market-data emitter
public emitMarketData(symbol, price, volume, timestamp) {
   this.emit('MARKET_DATA', { symbol, price, volume, timestamp });
}
```
```ts
// src/server/services/KronosForecastAgent.ts:36 — listens for a DIFFERENT string
eventBus.on('MARKET_DATA_UPDATED', async (data: any) => { ... });
```
A repo-wide search confirms nothing anywhere emits `'MARKET_DATA_UPDATED'`. This listener has never fired. See [KRONOS.md](./KRONOS.md) for the full consequence chain.

### 2. `LEARNED_NEW_RULE` vs. `NEW_RULE_LEARNED`

```ts
// src/server/core/EventBus.ts — the real emitter, used by ReflectionEngine
public emitLearningEvent(event) { this.emit('LEARNED_NEW_RULE', event); }
```
```ts
// src/server/core/EventStore.ts:66 and src/server/services/SystemMetricsWorker.ts:57
eventBus.on('NEW_RULE_LEARNED', trackEvent('NEW_RULE_LEARNED')); // EventStore
eventBus.on('NEW_RULE_LEARNED', () => this.recordEvent('reflection-engine')); // SystemMetricsWorker
```
Both listen for the wrong string and never receive the real event. `TradingEngine`'s own listener (`eventBus.on('LEARNED_NEW_RULE', ...)`) uses the *correct* name and does work — so learned rules do reach `tradingEngine.state.memoryRules`, but the `EventStore` trace log and the `SystemMetricsWorker` "reflection-engine" activity indicator never record this event.

---

## Wildcard forwarding to the frontend

```ts
// EventBus.ts — every emit() also re-emits on '*' with (eventName, ...originalArgs)
public emit(event, ...args) {
    const result = super.emit(event, ...args);
    if (event !== '*') super.emit('*', event, ...args);
    return result;
}
```
```ts
// server.ts — the WebSocket handler forwards it correctly (fixed; a prior version
// assumed the wildcard listener received a single {eventType, payload} object,
// which produced malformed {type: undefined, data: <eventName string>} messages)
const wildcardHandler = (eventName: string, payload: any) => {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: eventName, data: payload }));
};
eventBus.on('*', wildcardHandler);
```
Every real event above reaches the browser through this path — the question, per [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md), is whether anything in `App.tsx` actually subscribes to it (for most event types, nothing does).

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
- [DATA_FLOW.md](./DATA_FLOW.md) — full pipeline trace using these events
- [KRONOS.md](./KRONOS.md) — the consequences of mismatch #1
