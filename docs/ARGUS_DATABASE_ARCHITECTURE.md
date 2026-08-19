# Argus database architecture

**CODE-VERIFIED** against `src/server/db/schema.ts` (count `sqliteTable(` = **58**) and `drizzle/*.sql` (0000–0040). Inspected 2026-08-18.

**SQL foreign keys:** none. `schema.ts` does not call `references()`. Drizzle comments that say “FK” are **APPLICATION-LEVEL RELATIONSHIP** only.

**Engine:** SQLite via `better-sqlite3` + Drizzle. WAL. Single writer. Import `db` from `src/server/db/index.ts` only (DEF-18).

**File:** `data/argus.db` (gitignored). Migrations: `drizzle/*.sql` applied on first import of `src/server/db/index.ts`. `npm run db:migrate` (`database/migrate.ts`) imports that same module.

**Do not estimate.** Column lists below are transcribed from `schema.ts` TypeScript definitions (SQLite names in parentheses).

---

## How to re-count

```bash
rg -c "sqliteTable\(" src/server/db/schema.ts
```

Runtime DB may lag if an old process skipped a migration — compare `PRAGMA table_info` to this file. A live `PRAGMA` dump is **DATABASE-VERIFIED** only when executed against that file.

---

## SQLite types used

Drizzle mappings in this schema:

| Drizzle | SQLite affinity |
|---|---|
| `text()` | TEXT |
| `integer()` | INTEGER |
| `integer(..., { mode: 'boolean' })` | INTEGER 0/1 |
| `real()` | REAL |

Timestamps are mixed: ISO **TEXT**, epoch **INTEGER** (ms). There is no schema-wide convention — check the table.

JSON is stored as **TEXT** (no JSON1 requirement in schema).

---

## Constraints that actually exist

**Primary keys:** every table has a PK (see catalog).

**Unique indexes (named):**

| Index | Table | Columns |
|---|---|---|
| `idx_trades_trace_id_unique` | trades | trace_id (NULLs distinct) |
| `idx_fills_order_cumulative` | fills | order_id, cumulative_quantity |
| `idx_agent_confidence_calibration_bucket` | agent_confidence_calibration | agent_name, bucket_low |
| `idx_prediction_outcomes_source` | prediction_outcomes | prediction_id, source_table |

**Other indexes:** ohlcv, quant, lifecycle, pit, replay, strategy engine, reasoning logs, transaction_traces, observability_events, config_change_events — see catalog.

**Check constraints:** none declared in `schema.ts`.

**Enums:** none at SQL level. Status strings are documented in comments (application-enforced).

---

## Table catalog (all 58)

| Table | Purpose | PK | Important fields | FKs | Written by | Read by | Source of truth |
|---|---|---|---|---|---|---|---|
| users | Login accounts | id | email, password_hash | none | auth/setup | auth | operational |
| sessions | HTTP sessions | session_token | username, expires_at | none | auth | auth | operational |
| settings | Operator runtime settings | id | trading_mode, budget, trading_state, pipeline_agent_enabled_json, … | none | config routes / engine | almost all | operational (single-row typical) |
| kill_switch_events | State transitions | id | from_state, to_state, actor | none | TradingEngine / emergency routes | audit UI | audit trail |
| broker_connections | Stored broker creds | id | api_key_encrypted, paper_mode | none | config | BrokerManager | operational (secrets encrypted) |
| ai_providers | Provider registry + health | id | api_key_encrypted, health | none | config / AIRouter | AIRouter, UI | operational |
| ai_models | Model catalog | id | provider, model | none | config | UI | operational / cache |
| ai_usage | Token/cost aggregates | id | tokens, cost | none | AIRouter | dashboards | telemetry aggregate |
| trades | OMS order ledger | id | status, trace_id, transaction_id, broker_order_id | none (logical→transactions, fills) | OMS | recon, UI, traces | **authoritative local orders** |
| diagnostic_trade_archive | Archived diagnostic trades | id | snapshot_json | none | diagnostic paths | forensics | audit |
| fills | Fill ledger | id | order_id, cumulative_quantity | none (logical→trades.id) | fillLedger / OMS | P&L, traces | **authoritative local fills** |
| daily_trading_summary | Per-day rollup | date | realized_pnl | none | summary writer | UI | derived (**PARTIAL** sync) |
| reconciliation_events | Recon cycle | id | matches, mismatches JSON | none | PortfolioReconciliation | ops | recon state + audit |
| reconciliation_acknowledgements | Operator ack of orphans | id | fingerprint, status | none | ReconciliationAcknowledgements | recon | operational ack |
| portfolio_snapshots | Point-in-time positions | id | source ARGUS\|BROKER, reconciliation_id | none (logical→recon) | recon | history | audit snapshot |
| portfolio | Current holdings | symbol | quantity, average_price | none | recon hydrate | PortfolioMonitor, RiskEngine | **current state** (broker-compared) |
| learned_rules | LLM post-trade rules | id | rule, agent | none | ReflectionEngine | ChiefTrader debate prompt only | derived / prompt spice |
| agent_predictions | Idea log | id | agent_name, prediction, trace_id | none | ReflectionEngine | analytics, joins | audit of ideas |
| agent_performance_stats | Weights / win rates | agent_name | current_weight | none | ReflectionEngine | ChiefTrader | derived weights |
| agent_confidence_calibration | Beta-Binomial buckets | (unique agent+bucket_low) | calibrated_confidence | none | ReflectionEngine | ChiefTrader | derived |
| explainability_reports | UI copy | trace_id | report_text | none | ExplainabilityAgent | UI | derived |
| agent_memory | Legacy memory rows | id | decision | none | various | UI | **PARTIAL** / legacy |
| event_traces | Durable EventBus envelopes | id | correlation_id, event_type, payload | none | EventStore | traces | audit (sampled; no MARKET_DATA) |
| memory_rules | Autobot memory rules | id | rule_text | none | autobot routes | debate? | operational |
| news_articles | Ingested articles | id | cluster_id, sentiment | none | NewsEngine | news UI | operational ingest |
| news_clusters | Clustered news | id | impact_score, symbols | none | NewsEngine | news_veto gate | operational |
| news_providers | News API config | id | api_key_encrypted | none | config | NewsEngine | operational |
| kronos_predictions | Chronos forecasts | id | prediction, confidence INTEGER | none | KronosForecastAgent | UI / outcomes | operational / research |
| agent_routing_overrides | Per-agent LLM route | agent_name | provider_id | none | config routing | AIRouter | operational (wins over json) |
| ohlcv_bars | Historical bars | id | symbol, timeframe, timestamp | none | historical gateway | backtest/replay | research warehouse |
| backtest_runs | Technical backtests | id | trade_log JSON | none | BacktestEngine | UI | RESEARCH-ONLY |
| prediction_engine_weights | Engine scorecard | id | win_rate | none | evaluators | UI | derived |
| escalation_decisions | Local vs paid LLM | id | escalated | none | EscalationPolicy | audit | audit |
| transactions | Consensus cycle | id | status, final_decision | none | TransactionRegistry + lifecycle tracker | observatory | **authoritative decision unit** |
| consensus_decisions | Consensus math row | transaction_id | weighted_confidence, approved | none | TransactionRegistry | forensics | authoritative consensus |
| consensus_evidence | Per-agent votes | id | source_trace_id, weight | none | TransactionRegistry | forensics | authoritative votes |
| ai_calls | Prompt/response ledger | id | prompt, raw_response | none | AIRouter | traces (hash in export) | audit (secrets redacted at EventStore; prompts may exist) |
| risk_assessments | Risk decision | trace_id | approved, rejection_gate | none | RiskEngine | OMS consumers / UI | **authoritative risk** |
| risk_gate_results | Per-gate record | id | gate_name, passed, detail | none | RiskEngine | UI | **authoritative gates** |
| prediction_outcomes | PIT outcomes | id | source_table | none | PredictionOutcomeEvaluator | learning | research |
| training_examples | PIT training rows | id | feature_snapshot | none | TrainingExampleBuilder | unused trainer | RESEARCH-ONLY |
| openalice_verifications | External verify | id | status, direction | none | OpenAlice adapter | UI | advisory, not orders |
| external_data_cache | AV cache + RL | id | payload, rate_limited_until | none | Fundamental/Macro | same | cache |
| quant_assessments | Quant cycle | id | regime JSON, emitted_trade_idea | none | QuantSignalAgent | UI | operational when flag on / research |
| quant_strategy_backtests | Named strategy BT | id | strategy_id | none | runStrategyBacktest | UI | RESEARCH-ONLY |
| quant_backtest_decision_log | Verbose BT log | id | backtest_run_id | none | optional verbose BT | research | RESEARCH-ONLY |
| trade_lifecycle_transitions | Desk lifecycle | id | candidate_id, state | none | EventStore / lifecycle store | desk API | audit |
| pit_decision_ledger | Replay ledger | id | as_of_ms, published_at_ms | none | recordPitLive | replay | research PIT |
| strategy_configurations | WFO inbox | id | status RESEARCH_PARAM_CANDIDATE | none | research scripts | research | RESEARCH-ONLY |
| replay_runs | Replay metadata | id | execution_environment REPLAY | none | replay | research | RESEARCH-ONLY |
| strategy_engine_signals | Isolated engine signals | id | evidence_class SHADOW\|ANALYSIS_ONLY | none | strategiesEngine | UI | RESEARCH-ONLY / SHADOW |
| strategy_engine_backtest_runs | Isolated BT | id | metrics_json | none | strategiesEngine | UI | RESEARCH-ONLY |
| strategy_engine_promotions | Promotion records | id | strategy_id | none | strategiesEngine | UI | RESEARCH-ONLY (does not live-enable) |
| agent_reasoning_logs | CoT-ish summaries | id | reasoning_summary | none | TracingService | traces | audit |
| transaction_traces | Lifecycle by trace | trace_id | lifecycle_status, order_id | none | TracingService | GET traces | derived lifecycle |
| observability_events | Structured logs | id | level, category, message | none | StructuredLogger batch | observability API | telemetry |
| config_overrides | Settings overlay vs .env | key | value | none | settingsEffectiveRoutes | EffectiveRuntimeConfig | operational overlay |
| config_change_events | Overlay audit | id | setting, source | none | same | audit | audit (no secrets) |

---

## Column reference (spine tables)

### trades

`id` TEXT PK, `symbol` TEXT NOT NULL, `side` TEXT NOT NULL, `quantity` REAL NOT NULL, `price` REAL NOT NULL, `status` TEXT NOT NULL, `timestamp` TEXT NOT NULL, `reasoning` TEXT, `trace_id` TEXT UNIQUE INDEX, `profit_loss` REAL, `news_used` INT bool default 0, `news_sentiment` REAL, `news_confidence` REAL, `news_sources` TEXT, `news_reasoning` TEXT, `transaction_id` TEXT, `broker_order_id` TEXT, `request_id` TEXT, `submitted_at` TEXT, `accepted_at` TEXT, `filled_at` TEXT, `quant_strategy_id` TEXT, `quant_stop_price` REAL, `quant_target_price` REAL, `quant_invalidation_json` TEXT, `execution_environment` TEXT.

Status comment: PENDING, FILLED, REJECTED, CANCELED. Environment: PAPER | LIVE | UNKNOWN | BACKTEST | REPLAY | SIMULATION.

### fills

`id` INTEGER PK autoincrement, `order_id` TEXT NOT NULL, `broker_fill_id` TEXT, `quantity` REAL NOT NULL, `price` REAL NOT NULL, `filled_at` TEXT NOT NULL, `cumulative_quantity` REAL.

### transactions

`id` TEXT PK, `symbol` TEXT NOT NULL, `opened_at` TEXT NOT NULL, `closed_at` TEXT, `status` TEXT NOT NULL, `final_decision` TEXT, `outcome` TEXT default PENDING.

Status comment: OPEN | NO_CONSENSUS | RISK_REJECTED | EXECUTED | ORDER_REJECTED | FILLED | RECONCILED.

### consensus_decisions

`transaction_id` TEXT PK, `symbol`, `side`, `weighted_confidence` REAL, `threshold` REAL, `approved` INT bool, `agreements_count` INT default 0, `disagreements_count` INT default 0, `debate_used` INT bool, `debate_provider_count` INT, `reasoning` TEXT, `created_at` TEXT NOT NULL.

### consensus_evidence

`id` INTEGER PK, `transaction_id` TEXT NOT NULL, `source_trace_id` TEXT, `agent` TEXT, `side` TEXT, `confidence` REAL, `weight` REAL, `reasoning` TEXT, `agreed` INT bool, `current_price` REAL.

### risk_assessments

`transaction_id` TEXT, `trace_id` TEXT PK, `symbol`, `side`, `approved` INT bool, `max_quantity` REAL, `rejection_gate` TEXT, `account_equity` REAL, `buying_power` REAL, `reasoning` TEXT, `created_at` TEXT NOT NULL.

### risk_gate_results

`id` INTEGER PK, `trace_id` TEXT NOT NULL, `gate_name` TEXT, `sequence` INT, `passed` INT bool, `detail` TEXT JSON.

### portfolio

`symbol` TEXT PK, `quantity` REAL, `average_price` REAL, `current_price` REAL, `last_updated` TEXT, `unrealized_pnl` REAL, `broker_source` TEXT, `currency` TEXT default USD.

### settings (operator)

Includes: `trading_mode` default Paper, `budget` default 50000, `max_trade_size` default 3000, `take_profit_pct` default 15, `trailing_stop_pct` default 5, `auto_bot_enabled` default false, `trading_state` default TRADING_ENABLED, `max_portfolio_drawdown_pct` default 0.15, `position_sizing_mode` default FIXED_DOLLAR, schedule fields, `pipeline_agent_enabled_json`, strategy engine fields. Full list: `schema.ts` `settings`.

### Remaining tables

Columns for `users`, `sessions`, `kill_switch_events`, `broker_connections`, `ai_*`, `news_*`, `kronos_predictions`, `ohlcv_bars`, `backtest_runs`, `quant_*`, `strategy_engine_*`, `observability_events`, `config_*` match `schema.ts` line ranges in the grep of `sqliteTable`. If a forensic query needs a non-spine column, open `schema.ts` rather than guessing — this document does not abbreviate spine tables.

`ai_models` contains leftover Kronos-like columns (`predicted_ohlc`, `mae`, …) on a **models catalog** table — possible schema leftover. **PARTIAL** whether those columns are written.

`kronos_predictions.confidence` is **INTEGER**, unlike other agents’ 0–1 REAL. **CODE-VERIFIED**.

---

## ER-style map (APPLICATION-LEVEL only)

```
agent_predictions.trace_id ──────────────┐
kronos_predictions.trace_id ─────────────┤
ai_calls.trace_id ───────────────────────┤
event_traces.correlation_id ─────────────┼── triggering / contributing traces
                                         │
consensus_evidence.source_trace_id ──────┘
        │
        │ transaction_id
        ▼
transactions.id
        ├── consensus_decisions.transaction_id
        ├── consensus_evidence.transaction_id
        ├── risk_assessments.transaction_id     (nullable)
        ├── trades.transaction_id               (nullable until OMS)
        └── event_traces.transaction_id         (from approval onward)

CHIEF_APPROVED_IDEA (event, not a table)
        ▼
risk_assessments.trace_id  ←── trades.trace_id  ←── same triggering trace
        └── risk_gate_results.trace_id
        ▼
RISK_ASSESSMENT_COMPLETED
        ▼
trades.id
        ├── fills.order_id
        └── observability_events.order_id

portfolio.symbol  (recon-hydrated; NOT inserted by OMS)
        ▲
reconciliation_events.id ── portfolio_snapshots.reconciliation_id  (comment only)

kill_switch_events  (independent audit of trading_state)

config_overrides.key ── config_change_events.setting  (logical)

strategy_engine_* ── isolated; live path does not import
```

---

## Lifecycle of a trade (DB writes)

```
TRADE_IDEA_GENERATED
  → agent_predictions INSERT (ReflectionEngine, not transactional with EventBus)
  → event_traces INSERT (fire-and-forget .catch log)
  → (optional) pit_decision_ledger at ChiefTrader

evaluateConsensus
  → transactions INSERT (OPEN or NO_CONSENSUS)
  → consensus_decisions INSERT
  → consensus_evidence INSERT (all coalesced voters)
  → CHIEF_APPROVED_IDEA only if approved

RiskEngine persistThenPublish
  → risk_assessments INSERT
  → risk_gate_results INSERT (all gates)
  → then emit RISK_ASSESSMENT_COMPLETED
  → on persist fail: RISK_BLOCK, no emit (OMS never fires)

OMS
  → trades INSERT PENDING (unique trace_id)
  → broker placeOrder
  → trades UPDATE accepted/filled/rejected
  → fills INSERT (unique watermark)

PortfolioReconciliation (~5 min)
  → reconciliation_events INSERT
  → portfolio_snapshots INSERT
  → portfolio UPSERT current state

PortfolioMonitor SELL
  → same idea path with agent PortfolioManager
  → FILLED SELL may set trades.profit_loss
```

### Transactional behavior

SQLite one writer. Consensus persist is **three sequential inserts** (`transactions`, `consensus_decisions`, `consensus_evidence`) in `recordConsensusTransaction` — **not** wrapped in `db.transaction()`. **CODE-VERIFIED**. A crash between inserts can tear a cycle. Risk persist is similarly sequential inserts in one `try`.

Risk persist: assessments then gates in one `try`; failure returns false and **rolls back neither explicitly** if the first insert succeeded and the second failed — **PARTIAL** (possible torn risk row). Treat persist `false` as fail-closed for OMS.

EventStore persist is **not** in the same transaction as consensus/risk/OMS.

### Persist-before-publish

| Path | Behavior |
|---|---|
| RiskEngine | **Yes** — persist then emit. **CODE-VERIFIED** + P0.3 tests |
| Consensus | Persist in `recordConsensusTransaction` then emit approval — **CODE-VERIFIED** intent in registry; confirm order in ChiefTrader call sites when debugging races |
| EventStore | Persist **after** in-memory emit (listeners already ran). Fire-and-forget |
| agent_predictions | After event (listener) |

### Idempotency / duplicates

- Unique `trades.trace_id`
- Unique fill watermark
- OMS pre-insert lookup **plus** unique index (race closed)
- Coalesce one vote per agent
- Recon ack fingerprint for `FILLED_ORDER_MISSING_LOCALLY`

### Restart

- In-memory: EventStore ring, ChiefTrader `recentIdeas`, pipeline heartbeats, LIVE_ARM, debate-in-flight
- Durable: all tables above
- OMS `reconcileStaleOrders` for PENDING

---

## Database health

See `docs/sql/18_integrity_checks.sql`.

| Symptom | How to detect |
|---|---|
| Database locked | Logs `SQLITE_BUSY`; one writer rule |
| WAL / false SQLITE_CORRUPT | DEF-18 — second process on same file |
| Missing fills | integrity query filled_trades_without_fills |
| Missing risk | approved consensus without risk_assessments |
| Trades without consensus | trades.transaction_id null or dangling |
| Fills without trades | integrity |
| Orders without risk | trades.trace_id not in risk_assessments **or** approved=0 with a fill (impossible lifecycle) |
| Positions without broker confirm | recon mismatches JSON; do not treat local portfolio as broker SoT |
| Timestamp anomalies | filled_at < submitted_at query |
| Duplicate evidence | `16_duplicate_evidence.sql` |

WAL checkpoint: graceful shutdown (`gracefulShutdown.ts`). Backup: `GET /api/v1/system/export-db`.

---

## Migrations

41 SQL files `drizzle/0000_eager_hobgoblin.sql` … `drizzle/0040_config_overrides.sql`. Multi-statement files require `--> statement-breakpoint` (0040 lesson). Schema drift: **CODE-VERIFIED** table count is `schema.ts`, not a remembered number.
