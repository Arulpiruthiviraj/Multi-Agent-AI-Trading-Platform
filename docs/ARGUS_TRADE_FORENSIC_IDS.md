# Argus trade forensic ID system

All identifiers currently used on the live path and observatory. Formats are **CODE-VERIFIED** unless marked otherwise.

There is **no** dedicated “idea ID” table. An idea is identified by the emitting agent’s `traceId` plus `agent_predictions.id` (UUID minted at log time).

---

## ID catalog

### traceId (decision / correlation)

| Field | Value |
|---|---|
| Generated | `generateTraceId(symbol)` in `src/server/core/traceId.ts` |
| Format | `{traceIdPrefix}_{SYMBOL}_{unixSec}_{hex4}` e.g. `trace_AAPL_1723891200_a3f9` |
| Prefix | `config/tracing.json` `traceIdPrefix` = `"trace"` |
| Same string as | EventBus `payload.traceId`, observability `decisionId` / `correlationId` on the spine |
| Tables | `trades.trace_id` (unique when non-null), `risk_assessments.trace_id` PK, `risk_gate_results.trace_id`, `event_traces.correlation_id`, `agent_predictions.trace_id`, `transaction_traces.trace_id`, `ai_calls.trace_id`, `kronos_predictions.trace_id`, `observability_events.trace_id` / `decision_id` |
| Survives restart | Yes, once persisted |
| Exception | `PortfolioMonitor.emitRiskExit` sets `traceId: randomUUID()` — **not** the `trace_SYMBOL_…` format. **CODE-VERIFIED** |
| Core-event enforcement | `TRADE_IDEA_GENERATED`, `CHIEF_APPROVED_IDEA`, `RISK_ASSESSMENT_COMPLETED`, `ORDER_EXECUTED` require traceId; `warnOnlyOnMissingTraceId: true` |

### transactionId

| Field | Value |
|---|---|
| Generated | `mintTransactionId()` in `src/server/core/TransactionRegistry.ts` |
| Format | `ARG-YYYY-MM-DD-NNNNNN` (UTC date from `toISOString().slice(0,10)`; counter reseeded from DB per day) |
| Tables | `transactions.id` PK, `consensus_decisions.transaction_id` PK, `consensus_evidence.transaction_id`, `trades.transaction_id`, `risk_assessments.transaction_id` (nullable), `event_traces.transaction_id`, `ai_calls.transaction_id` (usually null at call time), `kronos_predictions.transaction_id`, `training_examples.transaction_id` |
| Survives restart | Yes. Counter reseeds from existing `ARG-{today}-%` rows |
| Use | Canonical **decision cycle** joining all voters. Prefer this over a single agent `traceId` when asking “why this approval” |

### agent_predictions.id (idea log row)

| Field | Value |
|---|---|
| Generated | `crypto.randomUUID()` in `ReflectionEngine.logPrediction` |
| Format | UUID |
| Table | `agent_predictions.id` PK |
| Relation | Soft: `trace_id` → consensus_evidence.source_trace_id |
| Survives restart | Yes |

### trades.id (local order / trade ID)

| Field | Value |
|---|---|
| Generated | OMS UUID at insert (**CODE-VERIFIED** schema comments: inserted at submission) |
| Format | UUID |
| Table | `trades.id` PK |
| Relation | `fills.order_id`; `observability_events.order_id`; `transaction_traces.order_id` |
| Survives restart | Yes |
| Unique | `idx_trades_trace_id_unique` on `trace_id` (NULL distinct) |

### request_id / clientOrderId

| Field | Value |
|---|---|
| Column | `trades.request_id` — schema comment: idempotency key, **== id today** |
| Use | OMS crash recovery `reconcileStaleOrders()` by `client_order_id` (DEF-05/06) |
| Survives restart | Yes |

### broker_order_id

| Field | Value |
|---|---|
| Generated | Broker adapter after accept |
| Table | `trades.broker_order_id`; `reconciliation_acknowledgements.broker_order_id` |
| Survives restart | Yes |
| Missing | Timeout / throw before id → PENDING UNKNOWN |

### fills.id

| Field | Value |
|---|---|
| Generated | SQLite autoincrement |
| Table | `fills.id` PK |
| Relation | `order_id` → `trades.id` (APPLICATION-LEVEL) |
| Unique | `(order_id, cumulative_quantity)` `idx_fills_order_cumulative` |
| Survives restart | Yes |

### broker_fill_id

Broker-native fill identifier when provided. Nullable.

### consensus decision ID

There is **no** separate UUID. **Primary key is `transaction_id`.**

### consensus_evidence.id

Autoincrement integer. Child of transaction (APPLICATION-LEVEL).

### risk assessment ID

**Primary key is `trace_id`**, not a separate assessment UUID.

### risk_gate_results.id

Autoincrement. Child of assessment via `trace_id` (comment-FK, not SQL FK).

### reconciliation_events.id / reconciliation_acknowledgements.id

Autoincrement. Cycle-level and ack-level.

### kill_switch_events.id

Autoincrement.

### event_traces.id / EventEnvelope.eventId

UUID (`uuidv4()` in `EventStore.ts`). In-memory envelope **and** SQLite PK when persisted.

### observability_events.id

UUID at `logStructured` persist.

### sessionId

`config/observability.json` `sessionIdPrefix` `"sess"` + runtime suffix. Process-scoped observability, not a trade id.

### OpenAlice request id

`openalice_verifications.id` — requestId / OpenAlice issue id. **Does not block** OMS.

### Pipeline flatten / rebalance traceId

`PipelineFlatten` / `PortfolioRebalance` mint `traceId` as `pipeline-{buy|sell}-{uuid}` and persist a synthetic `ManualOverride` evidence row with `weightedConfidence: 1.0`, `threshold: 0`, `approved: true`, then emit `CHIEF_APPROVED_IDEA`. **Skips ChiefTrader quorum. Does not skip RiskEngine.** **CODE-VERIFIED** `PipelineFlatten.ts`.

### Strategy engine / research IDs

`strategy_engine_signals.id`, `quant_assessments.id`, `backtest_runs.id`, `replay_runs.id`, `pit_decision_ledger.id`, `trade_lifecycle_transitions.id` — research/telemetry. **RESEARCH-ONLY** unless a live idea was also emitted.

---

## What is not an ID

- `settings.budget` — allocation dollars, not an id
- Strategy name strings — not order keys
- UI Digital Twin node ids — telemetry pulse `traceId` prefixes `telemetry-pulse-` are **ignored** by Risk/OMS

---

## Trace one trade by ID (canonical)

1. Start with `trades.id` = `f47ac10b-…`
2. Read `trace_id`, `transaction_id`, `broker_order_id`
3. `GET /api/v2/observability/orders/f47ac10b-…`
4. `GET /api/v2/traces/{trace_id}`
5. `GET /api/v2/diagnostics/why/{transaction_id}`
6. SQL join evidence / gates / fills as in `docs/sql/02_trade_full_trace.sql`

Worked (fictional) numbers: [ARGUS_CONSENSUS_FORENSICS.md](ARGUS_CONSENSUS_FORENSICS.md). Do not treat fictional IDs as database-verified.
