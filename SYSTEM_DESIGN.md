# Argus - SYSTEM DESIGN

Detailed system design reference, verified against source on 2026-08-08. Complements [ARCHITECTURE.md](./ARCHITECTURE.md) (high-level map) with per-component design detail. Code snippets below are transcribed from the real implementation, not invented — where they're abbreviated for length, that's noted.

---

## 🎯 Design Principles — intent vs. reality

1. **Self-Documenting Code** — intent: every module declares inputs/outputs/side-effects/dependencies in a header comment. **Reality**: most module headers are identical boilerplate ("Core implementation and logic for the X.ts module...") copy-pasted across dozens of files. They do not reliably describe the specific module. Don't use a header comment as evidence of behavior — read the code.
2. **Provider Agnostic** — ✅ real. All LLM calls route through `AIRouter` (`src/server/ai/AIRouter.ts`). Cost tracking, which this principle is partly meant to enable, is **not** real — every provider's `estimateCost()` returns `0`.
3. **Event-Driven Architecture** — ✅ real for wired agents, 🔴 broken for two confirmed event-name mismatches (`MARKET_DATA` vs. `MARKET_DATA_UPDATED`; `LEARNED_NEW_RULE` vs. `NEW_RULE_LEARNED`) — see [EVENTBUS.md](./EVENTBUS.md).
4. **Security First** — 🟡 partial. API keys are encrypted at rest. Auth is off by default (no `APP_PASSWORD` ⇒ open API), and the WebSocket has no auth regardless.
5. **Fail-Safe Risk Management** — ✅ mostly real. `RiskEngine` always runs before execution and computes real ATR/circuit breakers. 🔴 Take-profit/trailing-stop settings are persisted but not enforced by `RiskEngine` — see [RISK_ENGINE.md](./RISK_ENGINE.md). There is no UI/API kill-switch that actually stops the real background workers (`enginesHalted` only affects the legacy simulation path).

---

## 🏛️ System Architecture (as implemented)

```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND LAYER (React)                   │
├─────────────────────────────────────────────────────────────┤
│  • App.tsx (~11,000 lines) - single component tree           │
│  • 50+ components, ~38 fetch() call sites                    │
│  • WebSocket client: only 2 of ~15 broadcast event types      │
│    are actually subscribed to (see FRONTEND_GUIDE.md)         │
│  • Tailwind CSS v4, dark theme                                │
└───────────────────────┬─────────────────────────────────────┘
                        ↓ HTTP/WS
┌─────────────────────────────────────────────────────────────┐
│                   BACKEND LAYER (Express)                   │
├─────────────────────────────────────────────────────────────┤
│  server.ts (~3,050 lines) - routing + legacy sim + real boot │
│  configRoutes.ts (/api/v1/config) + v2System.ts (/api/v2)    │
│  Raw `ws` WebSocketServer, no auth on the socket itself       │
└───────────────────────┬─────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│                    CORE SERVICES LAYER                      │
├─────────────────────────────────────────────────────────────┤
│  EventBus          │  AIRouter         │  BrokerManager     │
│  (real pub/sub)     │  (real, fake cost)│  (init() never    │
│                     │                   │   called at boot) │
├────────────────────┼───────────────────┼────────────────────┤
│  TradingEngine     │  RiskEngine       │  KronosEngine      │
│  (settings mirror,  │  (real ATR/       │  (BROKEN - always │
│   not a loop)       │   circuit breakers)│  throws)          │
├────────────────────┼───────────────────┼────────────────────┤
│  EncryptionService │  SystemBootstrap  │  Logger            │
│  (real AES-256-CBC) │  (starts workers, │  (exports unused    │
│                     │   never gates on   │   by anything -     │
│                     │   config)          │   dead code)        │
└───────────────────────┬─────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│                    AGENTS LAYER                              │
├─────────────────────────────────────────────────────────────┤
│  Technical Agent → real RSI, MACD, Bollinger                │
│  News Engine → real RSS + 4 paid APIs + AI scoring           │
│  Kronos Agent → BROKEN, cannot produce output                │
│  Macro/Fundamental Agents → real, 3 hardcoded symbols each    │
│  Chief Trader → real weighted consensus                      │
│  Reflection Engine → real weight updates; rule TEXT never fed back │
└───────────────────────┬─────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│                    DATA LAYER                               │
├─────────────────────────────────────────────────────────────┤
│  SQLite (Drizzle ORM), 20 tables — see DATABASE_SCHEMA.md    │
└───────────────────────┬─────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│                   EXTERNAL SERVICES                         │
├─────────────────────────────────────────────────────────────┤
│  Alpaca (real)  │  Gemini/OpenAI/DeepSeek/NVIDIA/OpenRouter (real, fake cost) │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 Component Design (real code, current)

### TradingEngine (singleton, `src/server/engines/TradingEngine.ts`)

**Not an orchestration loop** despite the class name — it's a settings mirror plus an in-memory event log.

```ts
class TradingEngine {
  public state: AutoBotState = {
    enabled: false, tradingMode: "PAPER", budget: 50000, spent: 0,
    history: [], activeCycle: { phase: "idle", ... }, memoryRules: [],
    engines: { ... }, lastLossResetDay: <today>
  };

  constructor() {
    eventBus.on('TRADE_IDEA_GENERATED', idea => this.logHistory('scan', ...));
    eventBus.on('CHIEF_APPROVED_IDEA', idea => this.logHistory('scan', ...));
    eventBus.on('RISK_ASSESSMENT_COMPLETED', a => this.logHistory(a.approved ? 'execute' : 'veto', ...));
    eventBus.on('ORDER_EXECUTED', order => {
      this.state.spent += order.quantity * order.price;
      // day-rollover reset, then accumulate realized losses for UI display only —
      // RiskEngine's actual daily-loss circuit breaker recomputes independently
      // from the trades table, not from this field.
      if (typeof order.profitLoss === 'number' && order.profitLoss < 0) {
        this.state.currentDailyLoss += Math.abs(order.profitLoss);
      }
    });
    eventBus.on('LEARNED_NEW_RULE', rule => this.state.memoryRules.unshift(rule));
    eventBus.on('CALCULATION_COMPLETED', calc => {
      if (calc.engine === 'TechnicalEngine') { /* updates UI-facing engines state */ }
      // NOTE: calc.engine === 'AdvancedQuantEngine' is never handled here —
      // that engine's real output never reaches this listener's branches.
    });
  }

  async initialize() { /* loads settings + memory_rules from DB; calls system.start() if autoBotEnabled was true */ }
  toggle(config) { /* Object.assign(this.state, config); persists to settings; calls system.start()/stop() */ }
}
```

`toggle()` performs **no validation** — no check for a configured broker, a working AI provider, or a completed setup flow before accepting `enabled: true`.

---

### AIRouter (singleton, `src/server/ai/AIRouter.ts`)

Real Strategy+Factory pattern. Provider interface (`src/server/ai/providers/AIProvider.ts`):

```ts
interface AIProvider {
  initialize(apiKey?: string): Promise<void>;
  authenticate(): Promise<boolean>;
  chat(prompt: string, options?: any): Promise<{content: string, tokens: number}>;
  estimateCost(inputTokens: number, outputTokens: number): number; // every concrete provider returns 0
  health(): Promise<string>;      // every concrete provider always returns "Healthy" (inherited default, never overridden)
  supportsStreaming/Vision/Tools/StructuredOutput/Reasoning(): boolean; // some providers claim `true` without implementing the corresponding method
}
```

Concrete implementations: `GeminiProvider`, `OpenAIProvider`, `DeepSeekProvider`, `NvidiaProvider` (extends `OpenAICompatibleProvider`), `OpenAICompatibleProvider` (covers OpenRouter/LiteLLM/Ollama/Groq/local — the only one with real 429/5xx retry+backoff). `routeTask()` sorts registered providers by priority → health → success-rate → latency, tries each with sequential failover, logs to `ai_usage`, and updates an EMA-based health/success score. `routeConsensus()` fans out to every registered provider in parallel via `Promise.all` for the multi-model debate feature.

---

### EventBus (singleton, `src/server/core/EventBus.ts`)

Real Node `EventEmitter` subclass, ~65 lines:

```ts
class EventBus extends EventEmitter {
  public emit(event, ...args) {
    const result = super.emit(event, ...args);
    if (event !== '*') super.emit('*', event, ...args); // wildcard forwarding for the WS broadcast
    return result;
  }
  public emitMarketData(symbol, price, volume, timestamp) { this.emit('MARKET_DATA', {...}); }
  public emitTradeIdea(idea) { this.emit('TRADE_IDEA_GENERATED', idea); }
  public emitChiefApproval(a) { this.emit('CHIEF_APPROVED_IDEA', a); }
  public emitRiskAssessment(a) { this.emit('RISK_ASSESSMENT_COMPLETED', a); }
  public emitOrderExecution(o) { this.emit('ORDER_EXECUTED', o); }
  public emitLearningEvent(e) { this.emit('LEARNED_NEW_RULE', e); }  // NOTE: two listeners elsewhere in the codebase (EventStore, SystemMetricsWorker) subscribe to the string 'NEW_RULE_LEARNED' instead and never receive this.
}
```

No persistence, no replay. See [EVENTBUS.md](./EVENTBUS.md) for the confirmed event-name mismatches.

---

### RiskEngine — see [RISK_ENGINE.md](./RISK_ENGINE.md) for the full real algorithm (ATR sizing, daily-loss/consecutive-loss/concentration circuit breakers, news veto). Not reproduced here to avoid drift between two docs describing the same code.

### KronosEngine — see [KRONOS.md](./KRONOS.md). 🔴 Cannot function; do not design new features assuming it produces output.

---

## 🔄 Trading "Cycle" — there is no state machine

A prior revision of this document described an `IDLE → SCAN → CONSENSUS → RISK → EXECUTE → MONITOR → REFLECT` state machine. **No such state machine exists in the code.** The system is purely event-driven and asynchronous: each agent runs on its own timer or event trigger, independently, and `ChiefTraderAgent` aggregates whatever ideas exist for a symbol whenever a new one arrives (with a 60s rolling clear of `recentIdeas` and a 60s per-symbol debate cooldown). There's no global "current phase" that all agents observe — `tradingEngine.state.activeCycle` exists as a field but its `phase` is set once at construction and not actively driven through transitions.

---

## 🗄️ Database Schema Design

See [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) for the full, verified 20-table list. Notable design realities:
- `agent_performance_stats` (not `prediction_engine_weights`, despite the latter's name suggesting it) is the table that actually drives `ChiefTraderAgent`'s consensus weighting.
- `event_traces` and `prediction_engine_weights` both have complete schemas and zero writers found in the current codebase.
- `kronos_predictions` has a complete, correctly-wired schema that will never receive real data until Kronos itself is fixed.

---

## 🔐 Security Architecture

```ts
// src/server/core/EncryptionService.ts, current
class EncryptionService {
  static encrypt(text) {
    // AES-256-CBC, key from ENCRYPTION_SECRET or a randomly generated key
    // persisted to data/.encryption_key (with a startup warning) if unset.
    // Throws on failure — no longer silently writes plaintext on error.
  }
  static decrypt(text) {
    // Returns the input unchanged if it doesn't look like "iv:ciphertext"
    // (treats it as legacy plaintext); throws on genuine decrypt failure.
  }
}
```

Encrypted fields: `broker_connections.apiKeyEncrypted`/`secretEncrypted`, `ai_providers.apiKeyEncrypted`.

**Auth**: real HMAC-SHA256-signed session cookies exist (`server.ts`), but only activate when `APP_PASSWORD` is set in the environment. Unset ⇒ every `/api/*` route is open. The `/ws` WebSocket endpoint has **no** authentication check at all, independent of `APP_PASSWORD`.

```bash
# Actually-read environment variables (see AI_CONTEXT.md for the full list)
ENCRYPTION_SECRET=      # AES-256 key material; a random one is generated+persisted if unset
APP_PASSWORD=           # unset = no auth at all
AUTH_SESSION_SECRET=    # defaults to a known public string if APP_PASSWORD is set but this isn't
GEMINI_API_KEY= / OPENAI_API_KEY= / DEEPSEEK_API_KEY= / ...
ALPACA_API_KEY= / ALPACA_SECRET_KEY=
```

---

## 📡 Real-Time Communication

**Protocol**: native `ws` WebSocketServer, no Socket.IO, mounted at `/ws` (`httpServer.on('upgrade', ...)` in `server.ts`, filtering on `pathname === '/ws'`).

```ts
// server.ts, current (abbreviated)
wss.on('connection', (ws) => {
  ws.on('message', (message) => { /* only handles {type:'ping'} -> {type:'pong'} */ });

  const wildcardHandler = (eventName, payload) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: eventName, data: payload }));
  };
  eventBus.on('*', wildcardHandler);
  ws.on('close', () => eventBus.off('*', wildcardHandler));
});

setInterval(() => { /* broadcast {type:'AUTOBOT_STATE_UPDATED', data: tradingEngine.state} to all clients */ }, 2000);
```

Client side (`src/context/WebSocketContext.tsx`): real exponential-backoff reconnect, a 5s heartbeat ping with a 15s dead-connection timeout that force-closes and reconnects. Events emitted while a client is disconnected are lost — there's no buffering or replay.

---

## 🚀 Build & Run (real scripts, from `package.json`)

```bash
npm run dev      # tsx server.ts, Vite middleware, hot reload
npm run build    # vite build (client) + esbuild bundle of server.ts -> dist/server.cjs
npm start        # node dist/server.cjs
npm run lint     # NO-OP placeholder: prints a string, does not lint or typecheck anything
npm run db:migrate  # BROKEN: tsx database/migrate.ts, that path does not exist in this repo
```

No Dockerfile, no CI configuration exists for this Node/React application. (A fully separate, disconnected Python service under `python-platform/` has its own `Dockerfile`/`docker-compose.yml` — irrelevant to deploying this app.)

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
- [ARCHITECTURE.md](./ARCHITECTURE.md) — high-level component map
- [DATA_FLOW.md](./DATA_FLOW.md) — full pipeline trace with exact event payloads
