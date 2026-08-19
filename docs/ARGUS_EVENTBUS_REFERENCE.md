# Argus EventBus reference

**CODE-VERIFIED** — `src/server/core/EventBus.ts`, `eventNames.ts`, `config/eventNames.json`, `EventStore.ts`.

Implementation: Node `EventEmitter` singleton, `setMaxListeners(50)`. `publish()` asserts traceId then `emit()`. `MARKET_DATA` via `publish` also super-emits `MARKET_DATA_UPDATED`.

Dispatch: listeners isolated — a throw is logged and **remaining listeners still run**. Wildcard `*` supported.

`TRADE_IDEA_GENERATED` is gated inside `emit()`: `gateTradeIdea` then asset overlay; failures emit `TRADE_IDEA_REJECTED` / `ASSET_CANDIDATE_BLOCKED` instead of delivering the idea.

Synchronous: listeners run on the emitting call stack (async work inside a listener is the listener’s problem). There is **no** EventBus retry. Duplicate events are possible if producers emit twice; OMS/Risk have their own idempotency.

Persistence: `EventStore` subscribes **only** to `config/eventNames.json` `persist[]`. Then **skips SQLite** for `MARKET_DATA` and `CALCULATION_COMPLETED` (`NO_PERSIST_TYPES`). Telemetry pulses skipped.

**Contradiction:** `persist[]` includes `MARKET_DATA` but SQLite write is skipped. The array means “subscribe,” not “always durable.”

JSON file has duplicate keys `SYSTEM_ANOMALY` and `SERVER_LOG` (harmless overwrite). Unique named events: **79**.

---

## Ordering (happy path)

```
MARKET_DATA
  → TRADE_IDEA_GENERATED
  → CHIEF_CONSENSUS_STARTED
  → (optional AGENT_DISAGREEMENT)
  → CHIEF_CONSENSUS_COMPLETED
  → CHIEF_APPROVED_IDEA          (approval only)
  → RISK_ASSESSMENT_STARTED      (if producer emits)
  → RISK_GATE_EVALUATED          (per gate; may not be in persist[])
  → RISK_ASSESSMENT_COMPLETED    (only after successful persist)
  → ORDER_SUBMITTED → ORDER_ACCEPTED → ORDER_FILLED / ORDER_EXECUTED
```

Rejects: `DESK_NO_TRADE` + `TRADE_LIFECYCLE` state NO_TRADE; or `RISK_BLOCK`; or broker reject without fill.

OpenAlice events are fire-and-forget after approval and **do not** gate OMS.

---

## Spine table

| Event | Producer | Consumers | Payload (typical) | DB effect | Failure |
|---|---|---|---|---|---|
| MARKET_DATA | MarketDataWorker / emitMarketData | Technical, Kronos, diagnostics | symbol, price, volume, timestamp | memory only | reject tick → MARKET_DATA_REJECTED |
| MARKET_DATA_UPDATED | EventBus.publish alias | UI/feeds | same | memory | — |
| TRADE_IDEA_GENERATED | emitTradeIdea after gates | ChiefTrader, ReflectionEngine | traceId, symbol, side, confidence, reasoning, agent, currentPrice? | agent_predictions; event_traces | gated → REJECTED |
| TRADE_IDEA_REJECTED | EventBus gate | diagnostics/UI | reason, symbol, agent, traceId | **not in persist[]** — may be memory-only | idea never reaches Chief |
| ASSET_CANDIDATE_BLOCKED | EventBus asset overlay | desk | reason, assetClass | event_traces (persist) | no idea |
| CHIEF_CONSENSUS_STARTED | ChiefTrader | UI | traceId, symbol, ideaCount | event_traces | debate pending skip |
| CHIEF_CONSENSUS_COMPLETED | ChiefTrader | UI, traces | approved, confidence, side, threshold | event_traces | always emitted after eval |
| AGENT_DISAGREEMENT | ChiefTrader | UI | buy/sell/hold evidence | event_traces | informational |
| CHIEF_APPROVED_IDEA | emitChiefApproval | RiskAgent, lifecycle, OpenAlice trigger | transactionId, traceId, side, evidence, supportingQuantDetail | after TransactionRegistry inserts | RiskAgent ignores telemetryPulse |
| DESK_NO_TRADE | ChiefTrader | EventStore lifecycle | reason | event_traces + trade_lifecycle_transitions | stop |
| RISK_ASSESSMENT_COMPLETED | RiskEngine emitRiskAssessment | OMS, lifecycle | approved, maxQuantity, rejectionGate, quant stops | after risk tables persist | persist fail → RISK_BLOCK, no this event |
| RISK_BLOCK | RiskEngine / DiagnosticService | UI | gate, reasoning | persist list | fail-closed |
| ORDER_SUBMITTED / ACCEPTED / FILLED / EXECUTED | OMS | UI, lifecycle | order ids | trades/fills updates | timeout stays PENDING |
| RECONCILIATION_* | PortfolioReconciliation | TradingEngine pause | mismatches | reconciliation_events | never auto-flatten |
| KILL_SWITCH_TRIGGERED / TRADING_STATE_CHANGED | TradingEngine | UI | states | kill_switch_events | blocks new risk |
| POSITION_MONITORED / PORTFOLIO_DECISION_RECORDED | PortfolioMonitor | desk | symbol, pnl | lifecycle / events | NO_PRICE skip |
| DIAGNOSTIC_CREATED | DiagnosticService | UI | DiagnosticMessage | event_traces | fingerprint dedup |

---

## Full inventory (79 unique names)

From `EVENTS` object after skipping `persist` and `$comment`:

MARKET_DATA, STRATEGY_SIGNAL_GENERATED, CALCULATION_COMPLETED, TRADE_IDEA_GENERATED, CHIEF_APPROVED_IDEA, RISK_ASSESSMENT_COMPLETED, ORDER_EXECUTED, LEARNED_NEW_RULE, OPENALICE_VERIFICATION_REQUESTED, OPENALICE_VERIFICATION_COMPLETED, OPENALICE_VERIFICATION_TIMED_OUT, CHIEF_CONSENSUS_STARTED, CHIEF_CONSENSUS_COMPLETED, RISK_ASSESSMENT_STARTED, ORDER_SUBMITTED, ORDER_ACCEPTED, ORDER_FILLED, CAPITAL_CHECK, AGENT_DISAGREEMENT, POSITION_MONITORED, POSITION_RISK_CHANGED, MODEL_HEALTH, DIAGNOSTIC_CREATED, DATA_STALE, MODEL_UNAVAILABLE, MODEL_FALLBACK, CAPITAL_BLOCK, RISK_BLOCK, PORTFOLIO_UPDATE, RECONCILIATION_EMERGENCY_HALT, RISK_GATE_EVALUATED, TECHNICAL_ANALYSIS_STARTED, TECHNICAL_ANALYSIS_COMPLETED, KRONOS_HIGH_CONFIDENCE, KRONOS_LOW_CONFIDENCE, KRONOS_REVERSAL, KRONOS_BREAKOUT, KRONOS_STATUS_CHANGE, KRONOS_FORECAST_STARTED, KRONOS_FORECAST_COMPLETED, KRONOS_BATCH_COMPLETED, UI_UPDATE, AI_PROVIDERS_EXHAUSTED, MODEL_STARTED, MARKET_DATA_DISCONNECTED, MARKET_DATA_GAP_DETECTED, MARKET_DATA_UPDATED, MARKET_DATA_SOURCE_DISCREPANCY, MARKET_DATA_REJECTED, TRADE_IDEA_REJECTED, ASSET_CANDIDATE_BLOCKED, ASSET_OPPORTUNITY_IDENTIFIED, WATCHLIST_SUBSCRIBE_REQUESTED, OPPORTUNITY_SCAN_COMPLETED, PORTFOLIO_DECISION_RECORDED, NEWS_ANALYSIS_STARTED, NEWS_ANALYZED, ESCALATION_DECISION, NEWS_CLUSTER_CREATED, NEWS_PROVIDER_FAILED, QUANT_ASSESSMENT_COMPLETED, MARKET_REGIME_DETECTED, TRADING_STATE_CHANGED, KILL_SWITCH_TRIGGERED, INITIAL_STATE_SNAPSHOT, SYSTEM_ANOMALY, SYSTEM_METRICS, RECONCILIATION_MISMATCH, RECONCILIATION_MATCH, RECONCILIATION_WARMUP, SERVER_LOG, OPS_OUTPUT, OPS_JOB_COMPLETED, NEWS_CATALYST, DESK_NO_TRADE, TRADE_LIFECYCLE, TRACE_SPAN, REMOTE_OP_OUTPUT, REMOTE_OP_STATUS.

**persist[] subscribe list** (subset): MARKET_DATA, CALCULATION_COMPLETED, TRADE_IDEA_GENERATED, CHIEF_APPROVED_IDEA, RISK_ASSESSMENT_COMPLETED, ORDER_EXECUTED, LEARNED_NEW_RULE, OPENALICE_*, CHIEF_CONSENSUS_*, RISK_ASSESSMENT_STARTED, ORDER_SUBMITTED/ACCEPTED/FILLED, CAPITAL_CHECK, AGENT_DISAGREEMENT, POSITION_MONITORED, POSITION_RISK_CHANGED, MODEL_HEALTH, DIAGNOSTIC_CREATED, DATA_STALE, MODEL_UNAVAILABLE, MODEL_FALLBACK, CAPITAL_BLOCK, RISK_BLOCK, RECONCILIATION_EMERGENCY_HALT, KILL_SWITCH_TRIGGERED, TRADING_STATE_CHANGED, RECONCILIATION_MISMATCH, NEWS_CATALYST, DESK_NO_TRADE, TRADE_LIFECYCLE, TRACE_SPAN, ASSET_CANDIDATE_BLOCKED, WATCHLIST_SUBSCRIBE_REQUESTED, OPPORTUNITY_SCAN_COMPLETED, PORTFOLIO_DECISION_RECORDED.

Events **on the bus but not in persist[]** (no EventStore SQLite unless another writer): includes TRADE_IDEA_REJECTED, RISK_GATE_EVALUATED, PORTFOLIO_UPDATE, most Kronos/news/quant names, MARKET_DATA_REJECTED, RECONCILIATION_MATCH/WARMUP. **CODE-VERIFIED** by set difference. Producers/consumers for each non-spine name: **PARTIAL** — grep the string in `src/` when needed.

---

## Duplicate / pulse events

Payloads with `telemetryPulse`, `diagnosticTelemetry`, or `traceId` starting `telemetry-pulse-` skip idea gates’ trading effects, skip EventStore SQLite, and RiskAgent/OMS ignore them. UI Digital Twin only.
