# Argus logging and observability

**CODE-VERIFIED** — `src/server/observability/StructuredLogger.ts`, `ObservabilityStore.ts`, `config/observability.json`, `EventStore.ts`, `SecretRedaction.ts`.

---

## Logger implementation

| Layer | Role |
|---|---|
| `logStructured` / `structuredLogger` | JSON line to stdout + enqueue `observability_events` |
| `console.log` / `console.error` | Legacy component prefixes (`[ChiefTrader]`, `[Risk Engine]`, `[OMS]`, `[PortfolioWorker]`, `[EventStore]`) — still widely used |
| `EventStore` | EventBus → in-memory ring + `event_traces` |
| `TracingService` | `transaction_traces`, `agent_reasoning_logs` |
| File | `data/logs/crash.log` on `unhandledRejection` / `uncaughtException` (P0.6). Dev log `logs/argus-dev.log` may exist locally (**PARTIAL** — process-manager dependent) |

Fail-open: logger never throws to callers. Safety categories cannot log below `safetyMinLevel` INFO.

---

## Levels and format

Config levels: TRACE, DEBUG, INFO, WARN, ERROR, FATAL.

Defaults: `persistMinLevel` INFO, `consoleMinLevel` INFO, `retentionDays` 14, `maxQueueSize` 2000, `dropPolicy` newest.

Stdout record fields: `ts`, `level`, `logger`, `msg`, `sessionId`, `correlationId`, `decisionId`, `traceId`, `category`, `eventType`, `symbol`, `orderId`, `component`. Extra fields JSON in `payload` (truncated `maxPayloadChars` 8000), secrets redacted.

Persisted: `observability_events` (batched). `marketDataPersist: false`. MARKET_DATA taxonomy defaultLevel TRACE + sampled (`marketDataSampleEveryN` 50).

Safety categories (never DEBUG): TRADING_SAFETY, RISK, ORDER, FILL, KILL_SWITCH, RECONCILIATION, LIVE_ARM, BROKER.

---

## Correlation IDs

| ID | Log field | Typical source |
|---|---|---|
| session | `sessionId` | process session (`sess…`) |
| trace | `traceId` / `decisionId` / `correlationId` | EventBus payload / `ObservabilityContext` |
| order | `orderId` | `trades.id` |
| symbol | `symbol` | payload |
| transaction | not a first-class structured field | look in `msg` / payload / `event_traces.transaction_id` |

`config/tracing.json`: core events require `traceId` (warn-only).

---

## Which logs are authoritative

| Source | Authoritative for |
|---|---|
| `risk_assessments` / `risk_gate_results` | Why risk passed/failed |
| `consensus_decisions` / `consensus_evidence` | Why consensus passed/failed |
| `trades` / `fills` | What OMS/broker recorded locally |
| `event_traces` | That an EventBus type fired (except MARKET_DATA/CALCULATION_COMPLETED not persisted) |
| `observability_events` | Structured INFO+ logs that were enqueued |
| `console.log` | Informational; may be the only record for in-memory heartbeats |
| Digital Twin / AgentWorkflowTheater | **Not** authoritative (educational / event-driven glow) |

---

## Correlate: LOG → EVENT → DATABASE ROW → ORDER → FILL

1. Grab `traceId` from a JSON log line (or `correlation_id` from `event_traces`).
2. `GET /api/v2/traces/:traceId` joins event_traces, transaction_traces, observability_events, risk, trades, fills, ai_calls (promptHash in assembled view).
3. If you have `orderId`, `GET /api/v2/observability/orders/:orderId`.
4. If you have `ARG-…`, `GET /api/v2/diagnostics/why/:id`.
5. Confirm fill: `fills.order_id = trades.id`.

In-memory `recentEvents` / `tradeTraces` **die on restart**. Prefer SQLite.

Export JSON redacts secrets and does not display hidden chain-of-thought. `ai_calls.prompt` may still exist forensically — do not dump CoT to operators. **CODE-VERIFIED** CLAUDE.md.

---

## Component log prefixes (informational)

| Area | Typical prefix / category |
|---|---|
| Agents | `[TechnicalAgent]`, `[FundamentalAgent]`, `[MacroAgent]`, `[Kronos]`, `[QuantSignal]` — **PARTIAL** exact strings per file |
| Consensus | `[ChiefTrader]` |
| Risk | `[RiskManager]`, `[Risk Engine]`, category RISK |
| OMS | category ORDER; timeout UNKNOWN messages |
| Broker | category BROKER; Alpaca circuit breaker |
| Recon | RECONCILIATION_* events; pause reasons |
| Portfolio | `[PortfolioWorker]` |

---

## HTTP

| Path | What |
|---|---|
| GET /api/v2/observability/metrics | sessionId, counters, live NO-GO |
| GET /api/v2/observability/events | recent observability_events |
| GET /api/v2/observability/decisions/:traceId | decision bundle |
| GET /api/v1/system/event-traces | event_traces (redacted at write) |
| GET /api/v2/system/events | EventStore / DB hybrid |

Auth: `/api/*` requires session when not authed; `/health` and `/ready` unauthenticated. **CODE-VERIFIED** `server.ts`.
