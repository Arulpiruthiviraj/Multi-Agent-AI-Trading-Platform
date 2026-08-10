# Transaction Observatory, Replay Engine & AI Training Data Architecture

**Status: all 8 phases (§11) implemented, live-verified, and committed.** This document
started as investigation + design only (see the original framing below, kept for the
architectural reasoning); implementation followed after sign-off on §12's open decisions.
Every phase was verified against the real running dev server before being marked done - see
each phase's commit message for the specific live evidence (real transaction ids, real
persisted rows, real API responses). What follows is the original audit/design text, unedited.

Investigation + design document. All claims are sourced from reading the real code (file:line),
not from prior
documentation. Four parallel investigations fed this doc: event model, agent/AI pipeline,
risk/order/broker, and frontend/logging.

---

## 0. The finding that reshapes everything else

**`traceId` today does not identify "one transaction."** It identifies one *agent's own
emission*.

Every agent mints its own id, independently, in three different formats:
`Math.random().toString(36).substring(7)` (TechnicalAgent, PortfolioMonitor),
`crypto.randomUUID()` (Macro/Fundamental/News), `` `kronos-${Date.now()}` `` (Kronos). Worse
than the format inconsistency: **`ChiefTraderAgent.evaluateConsensus()` groups contributing
ideas by `symbol`, not by `traceId`** (`ChiefTraderAgent.ts:143`), then emits
`CHIEF_APPROVED_IDEA` carrying whichever single idea's `traceId` happened to trigger that
particular call (`ChiefTraderAgent.ts:127,134,162`). So if Technical, News, and Kronos each
independently proposed BUY AAPL with three different self-generated traceIds, and News's idea
is what tips the weighted vote over 0.75, the trade that reaches RiskEngine and `trades` carries
**News's traceId only** — Technical's and Kronos's contributing evidence exists in
`event_traces` under two *different, unlinked* trace IDs that nothing downstream ever queries.

This means today, `GET /api/v2/system/trace/:traceId` — the one real "show me everything about
this trade" endpoint — structurally **cannot** return the full multi-agent story for most
trades, no matter how much UI is built on top of it. This is not a UI gap; it's a data-model
gap, and it has to be fixed before Sections 3–12 of the original request ("watch the entire
life of a transaction," "one transaction = one complete story") are achievable at all.

The fix (detailed in §5/§6) is to stop treating "traceId" as the unit of a transaction. Instead:
a **`transactions`** table gets one row per symbol per consensus-evaluation-cycle, with its own
canonical id (`ARG-YYYY-MM-DD-NNNN`, matching the format you specified), minted once by
`ChiefTraderAgent` at the moment it evaluates consensus. Every contributing agent keeps emitting
its own event under its own self-generated id (no need to touch how Technical/News/etc. already
work) — but a new join table (`consensus_evidence`) links the transaction to every
`agent_decisions` row that fed it, regardless of which agent's id happens to match which event.
`RiskEngine`, `OrderManagement`, and `trades` then key off the **transaction id**, not an
arbitrary agent's traceId.

---

## 1. What already exists (real, verified)

**Event backbone**
- `EventBus.ts` — real singleton `EventEmitter`, wildcard `'*'` re-emit used by the WS layer.
- `EventStore.ts` — real envelope (`eventId/schemaVersion/correlationId/source/type/timestamp/payload`),
  in-memory `recentEvents` (cap 200) + `tradeTraces` map (cap 500, oldest-evicted), durable
  persistence to `event_traces` for **9 of ~25 real event types** (see §6). Fire-and-forget
  writes (uncaught failures only log).
- `GET /api/v2/system/trace/:traceId` (`v2System.ts:135`) — memory-first, DB-fallback single-trace
  lookup. `GET /api/v1/system/event-traces?correlationId=` — DB-only, paginated. `GET
  /api/v2/system/events` — raw in-memory ring buffer.
- WS wildcard broadcast (`server.ts:1907`) sends `{type, data}` per event, 1:1, unbatched.

**Real per-agent pipeline** (all confirmed non-mocked): `TechnicalAgent` (real RSI/MACD/Bollinger,
event-driven off `MARKET_DATA`), `NewsEngine` (real FinBERT local-first escalation, real
RSS/paid providers), `FundamentalAgent`/`MacroAgent` (60s/75s timers, real AlphaVantage + AIRouter,
hardcoded 3-symbol universe), `KronosForecastAgent` (real call to a local Chronos inference
service, real `KRONOS_FORECAST_STARTED/COMPLETED` pair — the *only* agent with a real
started/completed bracket today), `ChiefTraderAgent` (real weighted-vote consensus via
`EvidenceAggregator`, optional multi-provider AI debate), `RiskEngine` (real, 12+ sequential
gates — see §4), `OrderManagement` (real idempotency-by-traceId check, real broker call, real
fill-polling), `PortfolioReconciliation` (real broker-vs-local comparison every 5 min),
`ReflectionEngine` (real 60s scoring loop, real weight feedback into consensus),
`ExplainabilityAgent` (real AI-generated report on `ORDER_EXECUTED`/veto, written to
`explainability_reports`), `OpenAliceVerificationService` (built this engagement — real MCP
client, non-blocking, disabled by default).

**Real frontend**
- `TradeReplayModal.tsx` — an already-working VCR-style replay UI: fetches the real
  `/system/trace/:id` and `/data/explainability/:id` routes, has play/pause/skip-to-start/skip-to-end/scrub.
  **Has a dangerous flaw**: silently falls back to a hand-built 6-event fake trace
  (`TradeReplayModal.tsx:72-79`) with no visual indication when the real trace is empty —
  directly violates "no fake observability" (req #34) today, and must be fixed regardless of
  what else gets built.
- `DigitalTwinVisualizer.tsx` — real live agent-network view, real `buildTransactions()` grouping
  by traceId into a 4-stage state machine, real "Transactions"/"Raw Events" tabs. **Live-only**:
  populated purely from the current WebSocket session, 150-event client cap, nothing persisted,
  lost on refresh, no VCR controls (its "Play/Pause" toggles the live subscription, not playback).
- `NodeInspectionPanel.tsx` — real per-node event data, but presented as a generic JSON dump; no
  purpose-built latency/model/confidence card.
- Trade history table (`App.tsx:8252`) — real, each row has a working "Replay" button that opens
  `TradeReplayModal`.

**These are two separate, non-communicating implementations of overlapping ideas** — one
live-only, one DB-backed-with-a-fake-fallback. Building a third, parallel thing would be a
mistake; §8 proposes unifying them.

---

## 2. What is missing

1. **A canonical transaction id that actually spans one decision cycle** (§0).
2. **A per-gate structured RiskEngine result.** Today `RiskEngine.evaluateRisk()` is one
   function with **early-exit** returns (`RiskEngine.ts`, 12+ sequential gates) — a gate that
   never runs because an earlier gate already rejected is indistinguishable, in the emitted
   event, from a gate that ran and passed. The rejection reason is a **prose string**, not a
   structured `{gate, current, max, proposed}` object. The "9 gates lighting up in sequence"
   visualization in the request literally cannot be built from what's emitted today.
3. **No AI call ledger.** `AIRouter.routeTask()`/`routeConsensus()` send the real prompt to the
   real provider and get a real response — and then only the token counts/latency/cost land in
   `ai_usage`. The prompt text and raw response are discarded in-memory after the call returns.
   There is no `prompt_version`, `model_version`, or `config_version` tracked anywhere in the
   codebase. This is the single biggest gap for reproducibility and for "why did the model say
   that" investigation.
4. **No order-stage persistence.** `trades` gets exactly **one** INSERT per order, written once
   after the broker call (and optional fill-poll) resolves — never a PENDING row followed by an
   UPDATE. The broker's own order id is never stored. There are no `ORDER_SUBMITTED`/
   `ORDER_ACCEPTED`/`ORDER_FILLED` events — only one `ORDER_EXECUTED`, fired once, regardless of
   final status.
5. **No reconciliation history.** `RECONCILIATION_MISMATCH`/`MATCH` are emitted live but never
   written to a table — there is no way to ask "how many reconciliation mismatches happened last
   month."
6. **No point-in-time-correct outcome evaluation.** `ReflectionEngine.evaluateAgents()` scores
   predictions by finding a *nearby* FILLED trade within 5 minutes and comparing current price to
   *that trade's* entry price (`ReflectionEngine.ts:111`, an explicitly-commented approximation)
   — not by looking up the real price at a defined horizon after the prediction. `kronos_predictions.actualResult/mae/rmse/mape/directionalAccuracy`
   are schema columns that are **never written** — `evaluateTrade()` is an empty stub
   (`KronosMetrics.ts:31`).
7. **No `trace_id` on `agent_predictions` or `ai_usage` or `kronos_predictions`.** None of these
   can currently be joined to `event_traces`, to each other, or to an eventual outcome.
8. **No structured/durable logging.** `Logger.ts` exists (looks complete: `logTrade`/
   `logAiDecision`/`logEventTrace`, JSONL-to-file) and is **100% dead code** — zero call sites,
   and `logs/` does not exist on disk because the module has never actually been imported by
   anything that runs. Production (`npm run start`) writes 166 raw `console.*` calls to stdout
   and nothing else; there is no per-transaction log file today, anywhere.
9. **No live, real, per-trade multi-agent consensus view.** The one component that looks like
   this (`ChiefTraderAgent.tsx`'s "veto" tab) is a hardcoded 4-symbol demo sandbox with canned
   vote outcomes — not connected to any real trade.
10. **No VCR controls (step/speed/jump-to-event) on the persisted-replay path.** `TradeReplayModal`
    has play/pause/scrub but not step or speed; `DigitalTwinVisualizer` has neither, on live data
    only.
11. **`learned_rules` confirmed fully dead** (not new — worse than previously found): not just
    unread by any prompt, but not even queried for UI display anywhere. Any design that assumes
    the reflection loop currently influences behavior beyond `agentPerformanceStats.currentWeight`
    would be wrong.

---

## 3. What can be reused (build on, don't replace)

- `EventStore.ts`'s envelope + `event_traces` table — extend persistence coverage and add a
  `transactionId`/`sequence` column; don't replace the mechanism.
- `TradeReplayModal.tsx` — closest thing to the target replay UI; extend with step/speed
  controls and **remove the fake-fallback path**, replacing it with an explicit "no trace data
  available for this transaction" state.
- `DigitalTwinVisualizer.tsx`'s live agent-network rendering, `CATEGORY_STYLE`/node-map, and
  framer-motion pulse pattern — reuse for the *live* half of the Observatory; feed it from the
  new transaction-scoped data model instead of only the client-side WS buffer.
- `EvidenceAggregator`'s already-real weighted-vote math and `AggregationResult{agreements,
  disagreements}` — this is exactly the data the "agent consensus map" (req #7) needs; it just
  needs to be persisted (§5's `consensus_evidence`) instead of only living inside one event
  payload.
- `ohlcv_bars` (real historical OHLCV, already used by the backtest engine) — reuse this as the
  point-in-time price source for the new prediction-outcome evaluator (§4.6), instead of
  building a second price history mechanism.
- `ModelCapabilityRegistry.ts` — reuse directly as the source of agent/model version metadata
  for scorecards (req #26); it already tracks `local/costPerCall/liveEligible` per model.
- Existing migration-hand-trim workflow (`drizzle-kit generate` + manual trim) — same process
  for every new table below.

---

## 4. What should be redesigned

1. **RiskEngine: evaluate all gates, don't early-exit.** This is a real behavioral question,
   not just cosmetic — I want your sign-off before touching it (see §12). Recommendation:
   refactor `evaluateRisk()` to run every gate and accumulate `{gate, passed, detail}` into an
   array, THEN decide approve/reject from the accumulated results (first hard-fail wins for the
   final verdict, same behavior as today) — but now every gate's real evaluated state is known
   and persistable, which is required for the "9 gates lighting up" visualization and doesn't
   change which trades get approved, only what's recorded about gates evaluated after the first
   failure.
2. **OrderManagement: multi-stage row instead of single insert.** Insert a `PENDING` row at
   submission time (before the broker call), capture `broker_order_id` as soon as `placeOrder()`
   returns, and UPDATE the row as fill-polling resolves. This is what makes "Order Created →
   Broker Submission → Broker Accepted → Fill Polling → FILLED" a real, timestamped sequence
   instead of one row that appears fully-formed after the fact.
3. **AIRouter: persist the AI call, not just the aggregate counters.** Add a real `ai_calls`
   write (prompt, raw response, parsed decision, versions) alongside the existing `ai_usage`
   aggregate row — both stay, they serve different purposes (fast aggregate stats vs. full
   forensic record).
4. **ReflectionEngine's outcome evaluation → a proper point-in-time evaluator.** Replace the
   "nearby FILLED trade" proxy with a job that, for each `agent_decisions`/`model_predictions`
   row, looks up the real price from `ohlcv_bars` at a defined horizon after `decision_at`, and
   writes a real `prediction_outcomes` row. Keep `ReflectionEngine`'s weight-update behavior
   as-is (it's real and working) — only replace how it *finds* the comparison price.
5. **Unify `TradeReplayModal` and `DigitalTwinVisualizer`'s transaction view** into one
   Transaction Observatory component (§8) instead of maintaining two parallel implementations.
6. **Remove/replace dead code that could be mistaken for live infrastructure**: `Logger.ts`
   (unused), `persistTradeActivity()` (unused), `executeAutoBotTradeInSovereign()` (unused),
   `calculateATR()` (unused, despite `RiskEngine`'s own comment implying ATR sizing — sizing is
   actually a flat 5%-of-price assumption today). None of the new design should build on these
   under the assumption they're wired in.

---

## 5. Proposed database schema

Evolves existing tables where a real one already covers the concept; adds new tables only where
nothing does. All new tables get real, first-class columns for anything queryable (req #31) —
JSON only for genuinely flexible/raw payloads.

**New — the transaction backbone**
```
transactions (
  id TEXT PRIMARY KEY,            -- 'ARG-2026-08-10-000123', minted once by ChiefTraderAgent
  symbol TEXT NOT NULL,
  opened_at TEXT NOT NULL,        -- earliest contributing agent_decision's timestamp
  closed_at TEXT,
  status TEXT NOT NULL,           -- OPEN | NO_CONSENSUS | RISK_REJECTED | EXECUTED | FILLED | RECONCILED
  final_decision TEXT,            -- BUY | SELL | HOLD | REJECTED
  outcome TEXT DEFAULT 'PENDING'  -- WIN | LOSS | PENDING | N_A
)
```
`status='NO_CONSENSUS'` rows matter: they're what let you answer "why didn't Argus trade AAPL
even though 3 agents said BUY" (req #25) — created for any symbol that accumulates ideas but
never crosses the consensus threshold within `ChiefTraderAgent`'s 60s window.

**Evolve `event_traces` → `transaction_events`** (rename table, keep columns, add):
```
+ transaction_id TEXT             -- FK transactions.id (nullable — MARKET_DATA/CALCULATION_COMPLETED still may not have one)
+ sequence INTEGER                -- tie-break ordering within the same millisecond
```
Also: extend `NO_PERSIST_TYPES` coverage — persist `KRONOS_*`, `NEWS_*`, `ESCALATION_DECISION`,
`MARKET_REGIME_DETECTED`, `RECONCILIATION_*` (all decision-relevant, low-frequency). Keep
`MARKET_DATA`/`CALCULATION_COMPLETED` excluded (genuinely tick-frequency, per req #35).

**Evolve `agent_predictions` → `agent_decisions`**, add:
```
+ trace_id TEXT            -- the agent's own emitted id (kept, for backward joins to transaction_events)
+ transaction_id TEXT      -- FK transactions.id
+ agent_version TEXT
+ model TEXT, model_version TEXT, provider TEXT
+ latency_ms INTEGER
+ tokens_in INTEGER, tokens_out INTEGER, cost REAL
+ status TEXT, error TEXT
+ evidence TEXT            -- JSON, raw indicator/context snapshot (flexible payload, not the queryable fields above)
```

**New — `consensus_evidence`** (the fix for §0's grouping bug):
```
consensus_evidence (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL,       -- FK transactions.id
  agent_decision_id TEXT NOT NULL,    -- FK agent_decisions.id
  side TEXT, confidence REAL, weight REAL, agreed INTEGER  -- agreed with final consensus side?
)
```

**New — `consensus_decisions`** (ChiefTraderAgent's math, currently only inside an event payload):
```
consensus_decisions (
  transaction_id TEXT PRIMARY KEY,
  symbol TEXT, side TEXT,
  weighted_confidence REAL, threshold REAL, approved INTEGER,
  agreements_count INTEGER, disagreements_count INTEGER,
  debate_used INTEGER, debate_provider_count INTEGER,
  reasoning TEXT, created_at TEXT
)
```

**New — `risk_assessments` + `risk_gate_results`** (requires §4.1's RiskEngine refactor):
```
risk_assessments (
  transaction_id TEXT PRIMARY KEY,
  approved INTEGER, max_quantity REAL,
  rejection_gate TEXT,              -- which gate caused the final rejection, if any
  account_equity REAL, buying_power REAL,
  created_at TEXT
)
risk_gate_results (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  gate_name TEXT NOT NULL, sequence INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  detail TEXT                        -- JSON: {current, max, proposed} etc, per-gate shape varies
)
```

**Evolve `trades` → adds (keep the table and name — it's the real order+fill record)**:
```
+ transaction_id TEXT
+ broker_order_id TEXT
+ request_id TEXT           -- the idempotency key actually used
+ submitted_at TEXT, accepted_at TEXT, filled_at TEXT
```
Requires §4.2's OMS refactor (insert-then-update) to actually populate the staged timestamps.

**New — `fills`** (thin; today's brokers are single-shot market orders, but this future-proofs
partial fills cheaply):
```
fills (id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, broker_fill_id TEXT, quantity REAL, price REAL, filled_at TEXT)
```

**New — `portfolio_snapshots` + `reconciliation_events`**:
```
portfolio_snapshots (id INTEGER PRIMARY KEY, symbol TEXT, quantity REAL, average_price REAL,
  current_price REAL, source TEXT, snapshot_at TEXT, reconciliation_id INTEGER)
reconciliation_events (id INTEGER PRIMARY KEY, checked_at TEXT, broker TEXT, matches INTEGER,
  mismatches TEXT, worst_impact_dollars REAL, action_taken TEXT)
```

**New — `ai_calls`** (the AI-call ledger, req #6/#32/#33):
```
ai_calls (
  id TEXT PRIMARY KEY, transaction_id TEXT, agent TEXT,
  provider TEXT, model TEXT, model_version TEXT, prompt_version TEXT,
  prompt TEXT, raw_response TEXT, parsed_response TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost REAL, latency_ms REAL,
  status TEXT, error TEXT, created_at TEXT
)
```
`ai_usage` stays as-is (fast aggregate counters already used by dashboards) — `ai_calls` is the
new forensic record, linked by `transaction_id` where one exists.

**Generalize `kronos_predictions` → `model_predictions`** (broaden beyond Kronos-only naming; add):
```
+ transaction_id TEXT, agent TEXT
```
and actually implement the currently-empty `evaluateTrade()` to populate outcome columns via the
new evaluator (§4.4), OR split cleanly per the original request:

**New — `prediction_outcomes`**:
```
prediction_outcomes (
  prediction_id TEXT PRIMARY KEY,   -- FK model_predictions.id or agent_decisions.id
  actual_price REAL, actual_return REAL, actual_direction TEXT,
  mfe REAL, mae REAL, pnl REAL, outcome TEXT, evaluated_at TEXT
)
```

**New — `training_examples`** (materialized, batch-built, never live-written — req #23):
```
training_examples (
  id TEXT PRIMARY KEY, transaction_id TEXT,
  observed_at TEXT, available_at TEXT, decision_at TEXT,   -- point-in-time integrity columns, req #24
  feature_snapshot TEXT,   -- JSON, frozen inputs as of decision_at only
  label TEXT,              -- from prediction_outcomes
  created_at TEXT
)
```

This directly matches your conceptual model (`transactions / transaction_events /
agent_decisions / model_predictions / ai_calls / evidence / consensus_decisions /
risk_assessments / orders / fills / portfolio_snapshots / prediction_outcomes /
training_examples`) — implemented as 4 evolved tables + 10 new ones, not a wholesale rebuild.

---

## 6. Event model

**Keep** every existing event name/payload as-is (no breaking changes to working agents).
**Add**:
- `TRANSACTION_OPENED` / `TRANSACTION_CLOSED` — emitted by `ChiefTraderAgent` when it mints a
  new `transactions.id`, and by whichever stage closes the loop (fill, reject, or timeout).
- `RISK_GATE_EVALUATED` — one per gate, `{transactionId, gate, sequence, passed, detail}` —
  required for the real-time gate-lighting visualization (req #9); requires §4.1's refactor.
- `ORDER_SUBMITTED` / `ORDER_ACCEPTED` / `ORDER_FILLED` — replacing the current single
  `ORDER_EXECUTED`-at-the-end pattern with real stage transitions (req #10); requires §4.2's
  refactor. `ORDER_EXECUTED` can stay as a final summary event for existing consumers.
- `AI_CALL_COMPLETED` — `{transactionId, agent, provider, model, latencyMs, cost, tokensIn,
  tokensOut}` (no raw prompt/response over the wire — that stays DB-only for size/security) —
  feeds the live "AI agent inspection" card (req #6) without requiring a DB round-trip on the
  live path.

**Extend `EventStore`'s persisted-type set** to include `KRONOS_*`, `NEWS_*`,
`ESCALATION_DECISION`, `MARKET_REGIME_DETECTED`, `RECONCILIATION_*`, and the new events above.
Continue excluding `MARKET_DATA`/`CALCULATION_COMPLETED` (tick-frequency, per req #35 — these
stay live-only + in `ohlcv_bars`, not in the decision ledger).

**Fix `correlationId` extraction** in `EventStore.ts` to prefer `transactionId` first, falling
back to the legacy `traceId`/`trace_id` fields for anything not yet migrated.

---

## 7. Transaction replay architecture

Replay must satisfy req #37 exactly: **no re-running models, no recalculating decisions** —
replay a `transaction_id` by reading, in timestamp order:
`transaction_events` (filtered by `transaction_id`) → `agent_decisions` →
`consensus_evidence`/`consensus_decisions` → `risk_assessments`/`risk_gate_results` →
`trades`/`fills` → `portfolio_snapshots` → `prediction_outcomes`.

A single backend endpoint, `GET /api/v2/transactions/:id/replay`, assembles all of the above into
one ordered event list with **no model calls in the request path** — every field returned is a
column read, never a recomputation. If any stage's data is genuinely absent (pre-migration
history, or a stage that never ran because the transaction stopped earlier), the API returns an
explicit `"stage": "UNAVAILABLE"` marker — never a fabricated value, and the fake-trace fallback
in `TradeReplayModal.tsx` gets deleted, not extended.

**Live vs. replay** are the same rendering component fed by two different sources: live mode
subscribes to the WS wildcard (as `DigitalTwinVisualizer` does today); replay mode fetches the
endpoint above once and drives the exact same node/edge/timeline components from a static,
already-fetched array, with a client-side scheduler for play/pause/step/speed (multiplies the
delay between each stage's real recorded timestamps — speed changes playback pacing, never the
data).

---

## 8. UI architecture

One feature, "Transaction Observatory," replacing the current split between
`DigitalTwinVisualizer`'s live view and `TradeReplayModal`'s replay view — not two features:

- **Mission Control tab** (evolves the existing panel) — the live agent-network graph
  (`DigitalTwinVisualizer`'s existing rendering, reused), now also showing `RISK_GATE_EVALUATED`
  pulses through a small persistent gate-ladder, and real global metrics (req #14) pulled from
  real endpoints only — `agents active` from real agent heartbeats/last-event timestamps (not
  fabricated), `AI models healthy` from `ai_providers.health`, everything else already real
  (trades today, broker connection state, `AutoBot` running state).
- **Transaction Observatory tab** (new) — search/select by `transaction_id`, symbol, date, agent,
  outcome (req #29's Trace Explorer folded into the same surface rather than a separate one,
  since they're the same underlying query). Selecting a transaction opens the unified replay view
  (§7): pipeline diagram (req #3), agent consensus map (req #7) built directly from
  `consensus_evidence` (no client-side re-derivation of agreement/disagreement — the server
  already computed it), Chief Trader weighted-math breakdown (req #8, straight from
  `consensus_decisions` columns), Risk gate ladder (req #9, from `risk_gate_results`, showing
  "not evaluated" honestly for gates after an early rejection unless §4.1's refactor ships),
  order lifecycle (req #10, from the evolved `trades` timestamps + `fills`), reconciliation delta
  (req #11, from `portfolio_snapshots`/`reconciliation_events`). VCR bar: play/pause/step/speed
  (0.25×–10×)/scrub/jump-to-event, extending `TradeReplayModal`'s existing scaffold rather than
  writing a new one.
- **Node inspection** (evolves `NodeInspectionPanel`) — adds a purpose-built card layout for
  AI-backed nodes (provider/model/prompt version/tokens/cost/confidence/decision, req #6) instead
  of the current generic JSON dump, still falling back to raw JSON for anything without a
  dedicated card.
- **Analytics / Scorecards tab** (new, req #26/#27) — per-agent/model accuracy, calibration
  buckets, latency, cost, contribution — queries `agent_decisions` + `prediction_outcomes`
  directly; every number traceable to a real row, "DATA UNAVAILABLE" where sample size is zero
  (not a fabricated placeholder).

No new animation is decorative: every visual state change maps to a specific persisted or
live-streamed event listed in §6, per req #4's explicit requirement.

---

## 9. Logging architecture

Given `Logger.ts` is dead and nothing writes real log files today, and the durable per-transaction
record is better served by the relational schema in §5 (queryable, joinable — a `.jsonl` file
isn't), I'd narrow the ask in §17/§18/§19 of your message to what actually earns its keep:

- **Keep console output as the live operational stream** (it works, it's simple, nothing is
  broken here) but wire it through a single thin structured-console wrapper (not a new
  dependency — Node's built-in `console` with a consistent `[Category] message` prefix, which
  most of the codebase already does informally) so categories are grep-able. This replaces
  `Logger.ts`'s dead JSONL-file design, which duplicates what `transaction_events` already does
  durably and queryably.
- **The one new file-based artifact worth building**: an on-demand, generated (not
  continuously-appended) **human-readable Markdown report per transaction** (req #19),
  `GET /api/v2/transactions/:id/report.md` — rendered *from* the relational tables at request
  time, not maintained as a live-appended file. This avoids the append-only-file consistency
  problems (concurrent writes, partial transactions, rotation) while still giving you the
  "AAPL BUY — Transaction Investigation" document you described, always up to date because it's
  generated from current data, not stale because a writer crashed mid-append.
- Structured JSON/CSV/Markdown **export** of any transaction or query result (req #30) — same
  principle: generated on demand from the relational store, not a parallel file system to keep in
  sync.

This deliberately does not build `logs/system/`, `logs/agents/`, etc. as *files* — the
relational schema in §5 already is that structure, just queryable instead of grep-only. If you
want literal log files for a specific operational reason (e.g. feeding an external log shipper),
say so and I'll size that separately — it's a straightforward addition once the data model exists.

---

## 10. Point-in-time integrity for future training

`training_examples` (§5) is built by an **offline batch job**, never live-written, with three
mandatory timestamp columns per row: `observed_at` (when the underlying market/news fact actually
occurred), `available_at` (when Argus could have known it — for news, this is when the article
was ingested, not published; for a price bar, the bar's close time), and `decision_at` (when the
agent/consensus decision was made). The job's **only** write path is: for a candidate
`transaction_id`, pull every contributing `agent_decisions`/`ai_calls`/`consensus_evidence` row,
and **reject the row (log it, don't silently drop it) if any input's `available_at >
decision_at`**. This is the concrete validation mechanism req #24 asks for — a hard assertion,
not a convention. Because `agent_decisions`/`ai_calls`/news tables already have real timestamps
today (just not systematically checked against each other), this validation can run against
already-collected data as soon as the schema exists — it doesn't need to wait for new data to
accumulate, only for the timestamp columns above to be populated going forward.

---

## 11. Deliverables mapping (A–L) + phased order — all shipped

Implemented in dependency order, each live-verified against the real running dev server and
committed separately (commit hashes below are on `main`):

- **Phase 0 ✅ (`b25c39d`):** `transactions.id` minted in `ChiefTraderAgent`;
  `consensus_evidence`/`consensus_decisions` added. Fixed §0's grouping bug — live-verified two
  agents' evidence, under two different traceIds, correctly linking to one transaction.
- **Phase 1 ✅ (D, F — `3a17c3a`):** `ai_calls` ledger wired into `AIRouter.routeTask`/
  `routeConsensus`; `agent_predictions` evolved with `traceId`/`aiCallId`/`provider`/`latencyMs`.
  Live-verified a real local Ollama call's full prompt/response persisted verbatim.
- **Phase 2 ✅ (D — `83e1009`):** `risk_assessments`/`risk_gate_results` + RiskEngine all-gates
  refactor (confirmed design change, §12). All 19 pre-existing tests pass unchanged; new
  `RiskEngine.gates.test.ts` proves downstream gates still evaluate after an earlier failure.
- **Phase 3 ✅ (D — `d009772`):** `trades` evolved + OMS insert-then-update; `fills`;
  `portfolio_snapshots`/`reconciliation_events`. Live-verified a real broker order id and staged
  timestamps, with an honest still-PENDING result (no fabricated fill) for a synthetic symbol.
- **Phase 4 ✅ (E, G — `8b74bfc`):** `PredictionOutcomeEvaluator` (real point-in-time OHLCV bars,
  MFE/MAE) + `prediction_outcomes`; `ReflectionEngine` now reads it instead of the old
  nearest-trade proxy. Also fixed a real bug found while live-verifying Phase 5: `RiskAgent` was
  bypassing RiskEngine's gate ladder entirely on 3 of its own pre-checks (`e1cc0c1`).
- **Phase 5 ✅ (A, B, C — `396150d`):** `TransactionObservatory` + `TransactionExplorer`
  components; new `/api/v2/transactions` list + full-replay-assembly endpoints. Fixed
  `TradeReplayModal`'s fake-fallback (was fabricating a 6-event sample trace) and a
  display-row/raw-trade mixup that made `traceId` always undefined.
- **Phase 6 ✅ (I — `95c18f3`):** `/api/v2/analytics/scorecards` — live-verified against real
  session data; found a genuine overconfidence signal in `NewsAgent` (80-90% stated confidence
  bucket landed at 38.6% actual accuracy over 57 real evaluated predictions).
- **Phase 7 ✅ (J — `95c18f3`):** `TrainingExampleBuilder` + `training_examples`, point-in-time
  leakage check enforced as a real test (constructed leaked case, confirmed rejected).
- **Phase 8 ✅ (H — `95c18f3`):** `/api/v2/transactions/:id/report.md` (generated on demand, never
  a stale appended file) + `/export` (json/csv/jsonl/md). Live-verified against a real
  transaction from earlier in the same session.
- **Phase K (OpenAlice):** already implemented in a prior pass — non-blocking, read-only, no
  execution authority. Not yet wired into `consensus_evidence` (would need OpenAlice results fed
  back as evidence for a *future* transaction on the same symbol) — a reasonable next increment,
  not attempted here since no live OpenAlice instance exists to verify against.
- **Phase L (testing):** delivered per-phase rather than as a separate pass — every phase above
  shipped with either a new real-DB integration test or updated existing tests proving the
  specific behavior claimed (95 tests total, up from 77 at the start of this work).

---

## 12. Open decisions — resolved

1. **RiskEngine all-gates refactor (§4.1) — CONFIRMED.** Evaluate every gate, same approve/reject
   outcome, full per-gate record.
2. **`NO_CONSENSUS` transactions — CONFIRMED tracked.** Every symbol whose accumulated ideas never
   cross the approval threshold before being cleared gets a `transactions` row.
3. **Logging — CONFIRMED relational + on-demand exports.** No `logs/*.jsonl` tree.
4. **`ai_calls` raw prompt/response — CONFIRMED store as-is**, no redaction/truncation.

Phase 0 (transaction identity fix) starts now.
