# Argus Forensic Debugging Guide

**Status:** documentation / audit only (2026-08-18). Does not change trading behavior.

This is the primary operator and developer guide for:

- Why did Argus trade?
- Why didn't Argus trade?
- Why did Argus buy this stock?
- Why did Argus sell this stock?
- Why was this stock rejected?
- Where did the pipeline stop?
- Was the problem market data, an agent, consensus, risk, OMS, broker, fill, reconciliation, or portfolio management?

**Do not invent functionality.** If a fact cannot be verified from source, it is labeled **UNVERIFIED**.

| Companion | Purpose |
|---|---|
| [ARGUS_WHY_NOT_TRADING.md](ARGUS_WHY_NOT_TRADING.md) | 16-step “why idle / why rejected” runbook |
| [ARGUS_WHY_DID_IT_TRADE.md](ARGUS_WHY_DID_IT_TRADE.md) | Reconstruct a completed trade |
| [ARGUS_TRADE_FORENSIC_IDS.md](ARGUS_TRADE_FORENSIC_IDS.md) | Every ID, format, join |
| [ARGUS_DATABASE_ARCHITECTURE.md](ARGUS_DATABASE_ARCHITECTURE.md) | Tables, catalog, ER, lifecycle |
| [ARGUS_EVENTBUS_REFERENCE.md](ARGUS_EVENTBUS_REFERENCE.md) | Event inventory |
| [ARGUS_DOCUMENTATION_INDEX.md](ARGUS_DOCUMENTATION_INDEX.md) | Full map |

Evidence labels used throughout: **CODE-VERIFIED**, **TEST-VERIFIED**, **CONFIG-VERIFIED**, **DATABASE-VERIFIED**, **DOCUMENTED**, **UNVERIFIED**, **PARTIAL**, **DISABLED**, **RESEARCH-ONLY**, **SIMULATED**.

---

## Ground rules

1. The live decision path is EventBus → idea agents → ChiefTrader → RiskEngine → OMS → BrokerManager. **CODE-VERIFIED** — `CLAUDE.md`, `src/server/core/EventBus.ts`.
2. OMS is the sole production `.placeOrder(` caller. **TEST-VERIFIED** — `src/server/research/phase21.invariants.test.ts`.
3. RiskEngine persist-then-emit: persist failure emits `RISK_BLOCK` and does **not** emit `RISK_ASSESSMENT_COMPLETED`. **CODE-VERIFIED** — `RiskEngine.persistThenPublishAssessment`.
4. `MARKET_DATA` ticks are **not** written to SQLite. **CODE-VERIFIED** — `EventStore.ts` `NO_PERSIST_TYPES`.
5. There are **no SQL foreign keys** (`references()` count = 0 in `schema.ts`). All joins below are **APPLICATION-LEVEL RELATIONSHIP**.
6. LIVE real-money remains **LIVE_NO_GO**. Paper is supervised. Documentation does not raise readiness scores.

---

## Canonical live pipeline (verified)

```
Alpaca IEX WebSocket (or InternalPaper ticks)
    ↓
MarketDataWorker.acceptTickTimestamp + emit MARKET_DATA
    ↓
MARKET_DATA  (+ MARKET_DATA_UPDATED alias from EventBus.publish)
    ↓
Idea agents (timer and/or MARKET_DATA)
    TechnicalAgent / KronosForecastAgent / FundamentalAgent / MacroAgent
    NewsEngine (clusters always; TRADE_IDEA default OFF)
    QuantSignalAgent (off unless QUANT_ENGINE_ENABLED=true)
    PortfolioMonitor (~60s) → PortfolioManager SELL ideas
    ↓
eventBus.emitTradeIdea → gateTradeIdea + asset overlay
    ↓
TRADE_IDEA_GENERATED   OR   TRADE_IDEA_REJECTED / ASSET_CANDIDATE_BLOCKED
    ↓
ChiefTraderAgent (in-memory recentIdeas, TTL)
    EvidenceAggregator.aggregate + optional routeConsensus debate
    ↓
NO_CONSENSUS (transaction row, no CHIEF_APPROVED_IDEA)
       OR
CHIEF_APPROVED_IDEA (mints transactions.id)
    ↓
RiskValidationAgent (thin forwarder)
    ↓
RiskEngine.evaluateRisk (24 gates, serialized queue)
    persist risk_assessments + risk_gate_results
    ↓
RISK_ASSESSMENT_COMPLETED   OR   RISK_BLOCK (persist failed)
    ↓
OrderManagementService
    authorizeProductionOrder → BrokerManager.getActiveBroker().placeOrder
    ↓
trades row (PENDING→…) + fills
    ↓
ORDER_SUBMITTED / ORDER_ACCEPTED / ORDER_FILLED / ORDER_EXECUTED
    ↓
PortfolioReconciliation hydrates `portfolio`
    ↓
PortfolioMonitor exit candidate (SELL idea) → ChiefTrader risk-exit skip quorum
    ↓
RiskEngine → OMS → Broker → Fill → trades.profit_loss
```

**CODE-VERIFIED** against `EventBus.ts`, `ChiefTraderAgent.ts`, `RiskAgent.ts`, `RiskEngine.ts`, `OrderManagement.ts`, `PortfolioMonitor.ts`, `PortfolioReconciliation.ts`, `config/runtimeIntervals.json`, `config/deskIntelligence.json`.

---

## Fast triage

| Question | First check | If empty |
|---|---|---|
| Why isn't anything trading? | `GET /api/v2/diagnostics/why-not-trading` | Continue [WHY_NOT](ARGUS_WHY_NOT_TRADING.md) |
| Why this symbol? | `event_traces` + `agent_predictions` by symbol | Market data / agent gate |
| Why this approval? | `consensus_decisions` + `consensus_evidence` | Stop at ChiefTrader |
| Why this reject at risk? | `risk_assessments.rejection_gate` + `risk_gate_results` | Persist failed / never reached Risk |
| Why this order? | `trades` by `trace_id` or `transaction_id` | OMS never saw `RISK_ASSESSMENT_COMPLETED` |
| Why this fill? | `fills.order_id = trades.id` | Broker pending / timeout stays PENDING |
| Why this sell? | `agent_predictions` agent=`PortfolioManager` or Technical SELL | See [PORTFOLIO_EXIT](ARGUS_PORTFOLIO_EXIT_FORENSICS.md) |

HTTP reconstructors (session required when `AUTH_PASSWORD` is set):

- `GET /api/v2/diagnostics/why-not-trading`
- `GET /api/v2/diagnostics/why/:transactionId`
- `GET /api/v2/traces/:traceId` and `/export`
- `GET /api/v2/transactions/:id`
- `GET /api/v1/system/pipeline-agents`

**CODE-VERIFIED** — `src/server/routes/v2System.ts`, `traceRoutes.ts`, `systemRoutes.ts`.

---

## Stage catalog

For each stage: component, file, events, tables, IDs, failure, next hop, how to verify.

### 1. Market data ingest

| Field | Value |
|---|---|
| Component | `MarketDataWorker` |
| Source | `src/server/services/MarketDataWorker.ts` |
| Input | Alpaca IEX WebSocket (keys present) or broker-less idle |
| Output event | `MARKET_DATA`, `MARKET_DATA_UPDATED`, `MARKET_DATA_REJECTED`, `MARKET_DATA_DISCONNECTED`, `MARKET_DATA_GAP_DETECTED` |
| DB | **None for ticks.** Optional `ohlcv_bars` is historical/research, not the live tick path |
| IDs | Symbol string. Ticks have **no** `traceId` |
| Failure | Future skew / out-of-order (`tickFutureSkewMs`, `tickOutOfOrderEpsilonMs`). Null age → later `data_freshness` fail (DEF-08, by design) |
| Next | Idea agents listening to `MARKET_DATA` |
| Verify | `GET /api/v2/diagnostics` MARKET_DATA passing note; worker `getFeedStatus()` / `getLatestPriceAgeMs`. In-memory `EventStore.recentEvents` only — lost on restart |

**CONFIG-VERIFIED** — `config/tradingSafety.json` stale/tick fields. Default IEX universe is operator/watchlist dependent; CLAUDE.md cites `SPY,QQQ,IWM,DIA` as the common default. Confirm live symbols via pipeline snapshot / worker, not this paragraph alone (**PARTIAL** if the process is not running).

### 2. Idea agents

See [ARGUS_AGENT_FORENSICS.md](ARGUS_AGENT_FORENSICS.md). Summary:

| Agent | Trigger | Interval | Default idea emission |
|---|---|---|---|
| TechnicalAgent | `MARKET_DATA` | after enough ticks (RSI/MACD/BB) | LIVE PIPELINE |
| KronosForecastAgent | `MARKET_DATA` | cooldown `kronosPredictionCooldownMs` 60s | LIVE PIPELINE if Chronos `:8008` healthy |
| FundamentalAgent | timer | `fundamentalAgentMs` 60000 | LIVE PIPELINE (Alpha Vantage budget) |
| MacroAgent | timer | `macroAgentMs` 75000 | LIVE PIPELINE |
| NewsEngine | timer | `newsEngineMs` 10000 | Clusters **on**; `TRADE_IDEA` **DISABLED** (`newsEmitsTradeIdeas: false`) |
| QuantSignalAgent | timer | `quantCycleIntervalMs` 300000 | **DISABLED** unless `QUANT_ENGINE_ENABLED=true` |
| PortfolioMonitor | timer | `portfolioMonitorMs` 60000 | SELL ideas as `PortfolioManager` |

Heartbeats: in-memory `pipelineAgentHealth.ts` (`lastTickAt`, `currentState`). **Does not survive restart.** Verify `GET /api/v1/system/pipeline-agents`.

Ideas that pass `gateTradeIdea` become `TRADE_IDEA_GENERATED`. ReflectionEngine inserts `agent_predictions`. **CODE-VERIFIED** — `ReflectionEngine.ts` constructor listener.

### 3. TRADE_IDEA_GENERATED / REJECTED

| Field | Value |
|---|---|
| Emitter | `EventBus.emitTradeIdea` / `emit` of `TRADE_IDEA_GENERATED` |
| Source | `src/server/core/EventBus.ts`, `tradeIdeaContract.ts`, `multiAsset/ideaEligibility.ts` |
| Gate | `looksLikeListedTicker` + finite price (DEF-24). Asset overlay may emit `ASSET_CANDIDATE_BLOCKED` then `TRADE_IDEA_REJECTED` |
| DB | `agent_predictions` (async insert); `event_traces` (persisted); `pit_decision_ledger` later at ChiefTrader |
| IDs | `traceId` — usually `generateTraceId(symbol)` → `trace_<SYMBOL>_<unixSec>_<hex4>`. **Exception:** PortfolioMonitor uses `randomUUID()` |
| Next | `ChiefTraderAgent` |

### 4. ChiefTrader / EvidenceAggregator / debate

| Field | Value |
|---|---|
| Component | `ChiefTraderAgent`, `EvidenceAggregator` |
| Source | `src/server/services/ChiefTraderAgent.ts`, `EvidenceAggregator.ts` |
| Input | `TRADE_IDEA_GENERATED`; in-memory `recentIdeas` (TTL `chiefTraderIdeaTtlMs` 60000) |
| Events | `CHIEF_CONSENSUS_STARTED`, `CHIEF_CONSENSUS_COMPLETED`, `AGENT_DISAGREEMENT`, `CHIEF_APPROVED_IDEA` (approval only) |
| Math | See [ARGUS_CONSENSUS_FORENSICS.md](ARGUS_CONSENSUS_FORENSICS.md). Threshold **must exceed** `consensusApprovalThreshold` 0.75. Min **2** independent agents (excludes `ConsensusDebate`). Disagreement penalty 0.5. Hard veto HOLD: NewsAgent, ConsensusDebate |
| Risk-exit | `PortfolioManager` SELL skips debate and min-agents |
| DB | `transactions`, `consensus_decisions`, `consensus_evidence` via `TransactionRegistry.recordConsensusTransaction` |
| IDs | `transactionId` `ARG-YYYY-MM-DD-NNNNNN` minted at consensus persist |
| Failure | HOLD / confidence ≤ 0.75 / <2 independents / debate HOLD / Bear HOLD / quant AI contradiction |
| Verify | `chiefTrader.getLastConsensusOutcome()` exposed on why-not-trading; SQL `03_failed_consensus.sql` |

Debate: if confidence > `debateTriggerConfidence` 0.6, `AIRouter.routeConsensus('ConsensusDebate')`. Fail-closed HOLD if no usable verdict. **CODE-VERIFIED**.

### 5. RiskAgent → RiskEngine

| Field | Value |
|---|---|
| Component | `RiskValidationAgent` → `RiskEngine` |
| Source | `src/server/services/RiskAgent.ts`, `src/server/engines/RiskEngine.ts` |
| Input | `CHIEF_APPROVED_IDEA` (telemetry pulse ignored) |
| Events | `RISK_ASSESSMENT_STARTED` (if emitted), `RISK_GATE_EVALUATED`, `RISK_ASSESSMENT_COMPLETED` or `RISK_BLOCK` |
| DB | `risk_assessments` (PK `trace_id`), `risk_gate_results` |
| Gates | 24 — [ARGUS_RISK_FORENSICS.md](ARGUS_RISK_FORENSICS.md). All recorded even after first failure. Reported reject = first failure in evaluation order |
| Mutex | `evaluationQueue` promise chain. **TEST-VERIFIED** DEF-09 |
| Next | OMS only if `approved` and `RISK_ASSESSMENT_COMPLETED` fired |

### 6. OMS → BrokerManager → adapter

| Field | Value |
|---|---|
| Component | `OrderManagementService` |
| Source | `src/server/services/OrderManagement.ts` |
| Input | `RISK_ASSESSMENT_COMPLETED` with `approved` |
| Gate | `authorizeProductionOrder` (P0.1 LIVE_NO_GO) |
| DB | `trades` insert at submit; updates on accept/fill/reject; `fills` via `fillLedger` unique `(order_id, cumulative_quantity)` |
| Events | `ORDER_SUBMITTED`, `ORDER_ACCEPTED`, `ORDER_FILLED`, `ORDER_EXECUTED` |
| Broker timeout | stays **PENDING / UNKNOWN**, never fabricated FILLED. **CODE-VERIFIED** CLAUDE.md + OMS comments |
| IDs | `trades.id` UUID = local order id = `fills.order_id`; `clientOrderId` for crash recovery; `broker_order_id` |

See [ARGUS_EXECUTION_FORENSICS.md](ARGUS_EXECUTION_FORENSICS.md).

### 7. Reconciliation + portfolio

| Field | Value |
|---|---|
| Component | `PortfolioReconciliation` |
| Interval | `portfolioReconciliationMs` 300000 (~5 min) + boot warmup 30s |
| DB | `reconciliation_events`, `portfolio_snapshots`, hydrates `portfolio` |
| Never | auto-flatten (`autoFlattenOnReconciliationMismatch: false`); never auto-resume pause |
| Events | `RECONCILIATION_MATCH`, `RECONCILIATION_MISMATCH`, `RECONCILIATION_WARMUP`, `RECONCILIATION_EMERGENCY_HALT` |

### 8. Exits + P&L

PortfolioMonitor compares **live IEX price vs average cost** (not a peak-based trail unless a Quant lot stored `quantStopPrice` / `quantTargetPrice`). Copy may say “Scaling out”; emit is **full-position SELL**. TrailingStopPct is a **fixed cost-basis stop**, not a high-water trailing stop. **CODE-VERIFIED** — `PortfolioMonitor.ts`.

P&L: `trades.profit_loss` on closed sells; `portfolio.unrealized_pnl` current state; `daily_trading_summary.realized_pnl` (sync completeness **PARTIAL** — inspect both).

---

## Debugging by symbol / trade id / order id

Procedures live in [ARGUS_WHY_DID_IT_TRADE.md](ARGUS_WHY_DID_IT_TRADE.md) sections 18–20.

SQL: `docs/sql/`.

---

## What this guide is not

- Not a LIVE certificate.
- Not a substitute for `evaluateLiveReadiness()`.
- Not coverage of sibling engines (vibe-trading, autohedge, OpenAlice, Fincept) as order paths — they are untrusted read-only.
- Not 760 live quant edges (`quantStrategyTaxonomy.json` is aliases).
