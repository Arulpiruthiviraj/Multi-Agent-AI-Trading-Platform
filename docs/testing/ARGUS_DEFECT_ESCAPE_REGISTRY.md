# Argus Defect Escape Registry

**Date:** 2026-10-09 · **Status:** living document — every defect that escaped existing tests
gets an entry here, the test that would have caught it, and the release invariant that now blocks
on it. This is a testing-mission Phase 1 document; it records history, it does not change code.

## Entry format

- **DEFECT_ESCAPE_ID** — stable identifier, format `OCT<day>_<NAME>_ESCAPE`.
- **What happened** — the observed failure, with date.
- **OLD_TEST_GAP** — the honest reason existing tests missed it.
- **NEW_TEST** — the regression test that now covers it. Filenames are real repo paths,
  verified against the tree on 2026-10-09. Where a dedicated test file does not exist, the
  coverage mechanism is described without inventing a filename.
- **NEW_RELEASE_INVARIANT** — the Layer-5 gate that now blocks on this class of defect.
- **Responsible layer** — which certification layer (§3 of
  `ARGUS_PRODUCTION_CERTIFICATION_ARCHITECTURE.md`) owns preventing recurrence.

---

### OCT8_LIFECYCLE_AUTHORITY_ESCAPE

- **What happened (2026-10-08):** Production ran a full session with **0 authorized Quant
  strategies** and **20 strategies missing lifecycle rows**. The quant pipeline was
  mechanism-complete — every stage could execute — but nothing in production state authorized
  any strategy to use it. The readiness certification reported `READY_WITH_CONDITIONS`
  without failing on this.
- **OLD_TEST_GAP:** Existing tests proved the spine *could* execute by seeding lifecycle
  authority into isolated test DBs. No test read the **real production DB**, and no
  pre-market check asserted `AUTHORIZED_PAPER_QUANT_STRATEGIES > 0`. Mechanism tests were
  treated as reachability evidence.
- **NEW_TEST:** Layer-3 production-state certification (read-only per-strategy report —
  `strategyId, enabled?, lifecycle record?, lifecycle state, PAPER Quant authorized?, reason,
  data prerequisites, scheduled?, reachable?`), plus the permanent labeling rule that seeded
  authority only proves `MECHANISM_E2E`.
- **NEW_RELEASE_INVARIANT:** `PRODUCTION_LIFECYCLE_CERTIFICATION` +
  `AUTHORIZED_PAPER_QUANT_STRATEGIES > 0` — and `= 0` ⇒ `QUANT_FIRST_OPERATIONALLY_INACTIVE`
  = **FAIL**, even if `quantPolicyEnabled = true`.
- **Responsible layer:** LAYER 3 (production-state certification).

### OCT8_BACKUP_EVENT_LOOP_ESCAPE

- **What happened (2026-10-08):** The database backup ran on the main Node event loop and
  blocked it for minutes **during trading hours**, freezing the engine while the market was
  open.
- **OLD_TEST_GAP:** Backup tests (`src/server/services/DbBackupService.test.ts`,
  `src/server/services/DbBackupService.reentrancy.test.ts`) verified backup *correctness*
  and reentrancy in isolation. No test ran a backup **during a simulated trading session**
  and asserted the event loop stayed responsive.
- **NEW_TEST:** `src/server/services/DbBackupService.worker.test.ts` — backup moved to a
  `worker_thread` with disk preflight; regression coverage verifies the non-blocking path
  and the preflight failure mode.
- **NEW_RELEASE_INVARIANT:** `BACKUP_NON_BLOCKING` — a backup must be able to run during
  trading hours without degrading the event-loop heartbeat.
- **Responsible layer:** LAYER 4 (full session simulation) + LAYER 5 checklist.

### OCT8_WATCHDOG_RESTART_ESCAPE

- **What happened (2026-10-08):** The watchdog restarted the engine repeatedly in a storm —
  restarts cascaded instead of stabilizing, because the watchdog had no notion of
  maintenance windows and no memory of prior storms across restarts.
- **OLD_TEST_GAP:** No test exercised repeated rapid restarts, and no test verified watchdog
  behavior *across process restarts* (state was in-memory only).
- **NEW_TEST:** Watchdog storm coverage added with the fix — maintenance-aware watchdog with
  persisted storm lockout (state survives restarts), verified by regression tests exercising
  restart-storm sequences.
- **NEW_RELEASE_INVARIANT:** `WATCHDOG_CHAOS` — fault-injection scenario: repeated crashes
  must trigger lockout, not a restart cascade.
- **Responsible layer:** LAYER 4 (fault injection) + LAYER 5 checklist.

### OCT8_NEWS_RETENTION_ESCAPE

- **What happened (2026-10-08):** `news_articles` / `news_clusters` grew unboundedly with
  no prune path — the synthesis tests verified that features *worked* but never that growing
  tables stayed *bounded*; the leak was visible only through disk forensics.
- **OLD_TEST_GAP:** Every test asserted decision-pipeline behavior; none asserted table
  growth bounds. No registry of which tables must be pruned existed.
- **NEW_TEST:** `src/server/db/newsRetention.test.ts` (cutoffs, idempotency, event-loop
  heartbeat across batches) + `src/server/db/retentionCoverage.test.ts` — **mutation-proven**:
  fails by design if any append-only table lacks a registered sweeper in the central
  `RETENTION_SWEEPERS` registry.
- **NEW_RELEASE_INVARIANT:** `MEMORY_SOAK` — bounded table growth asserted over soak
  windows; every table written by a session must have a bounded-growth story.
- **Responsible layer:** LAYER 4 (bounded-growth proof in session simulation).

### OCT9_QUANT_SCHEDULER_LATENCY_ESCAPE

- **What happened (2026-10-09):** Quant evaluation cycles took **~17 minutes** with
  `concurrency=1` and the universe snapshotted at cycle start. Late-arriving movers waited
  a full cycle to be evaluated, and promoted symbols were never Quant-assessed in time.
- **OLD_TEST_GAP:** Scheduler tests (`src/server/quant/strategies/StrategyExplorationScheduler.test.ts`,
  `src/server/services/AutoTradeScheduler.test.ts`) verified scheduling *logic*, never cycle
  latency at production concurrency against a production-size universe, and never
  late-admission timing for symbols promoted mid-cycle.
- **NEW_TEST:** Scheduler SLA/completeness/late-admission assertions added to the release
  gate (cycle completion time at production concurrency, per-cycle per-strategy coverage,
  late-admission latency for mid-cycle promotions), building on
  `src/server/quant/strategies/StrategyExplorationScheduler.test.ts` for scheduling logic.
  The timing dimension is enforced at Layer 4/5, not by a unit test — that is the point of
  the escape.
- **NEW_RELEASE_INVARIANT:** `QUANT_SCHEDULER_SLA` + `QUANT_COVERAGE_COMPLETENESS` —
  cycles complete within SLA; every enabled strategy evaluated every cycle; late arrivals
  assessed within the late-admission bound.
- **Responsible layer:** LAYER 4 (session simulation under load) + LAYER 5 checklist.

### OCT9_PIT_PROVENANCE_ESCAPE

- **What happened (2026-10-09):** Exact point-in-time replay was impossible — input bar
  IDs, observed/available-at timestamps, quote timestamps, and StrategyContext inputs were
  not retained, so a past decision could not be replayed identically and its inputs could
  not be audited.
- **OLD_TEST_GAP:** Replay tests replayed decisions from reconstructed inputs, never
  asserting that the *original* inputs were retained. No test asked "can you replay
  decision X from what production actually stored?"
- **NEW_TEST:** PIT replay provenance retention — a past decision must replay identically
  from retained provenance (input bar IDs, observed/available-at timestamps, quote
  timestamps, StrategyContext inputs).
- **NEW_RELEASE_INVARIANT:** `PIT_REPLAY` — provenance retained and replay-verified for the
  exact build under certification.
- **Responsible layer:** LAYER 3 (production state retains provenance) + LAYER 5 checklist.
- **IMPLEMENTED 2026-10-09 (certification mission item 1):** `decision_provenance` table
  (drizzle 0099) + `src/server/replay/provenance/decisionProvenance.ts` — emission on the real
  QuantSignalAgent decision path (never blocking, never a gate), no-lookahead enforced at
  write AND replay time (future-dated provenance is REJECTED), replay through the REAL
  `evaluateAll()` path with byte-for-byte evaluation equality gated on identical build SHA +
  strategy-spec config versions, byte caps + per-decision row cap + registered retention
  sweeper (90d, in RETENTION_SWEEPERS / retentionCoverage.test.ts). Regression:
  `decisionProvenance.test.ts` (POINT_IN_TIME_REPLAY) and
  `decisionProvenanceRetention.test.ts`.

### OCT9_STALE_CACHE_TAIL_ESCAPE

- **What happened (2026-10-09):** `HistoricalDataGateway.ensureBars()` judged cache
  sufficiency on row count/coverage only. An old-but-large cache suppressed the provider
  refresh entirely — the Oct-9 forensic found 508/972 late bar-input records with a newest
  bar more than 7 days old. Strategies evaluated on stale inputs while the cache looked
  "sufficient".
- **OLD_TEST_GAP:** Gateway tests seeded caches with sufficient row counts and asserted
  the fetch was skipped; no test seeded a sufficient-count cache with a STALE tail and
  asserted a refresh was attempted. Fixture `CACHEDENOUGH` itself carried a 31-day-old
  newest bar — the defect, disguised as the happy path.
- **NEW_TEST:** Stale-tail gate tests in `HistoricalDataGateway.test.ts` (fresh tail ->
  accept; stale tail -> refresh attempted; exact tolerance boundary +/-60s deterministic;
  historical end-date exemption; provider failure -> old data not relabeled fresh; empty
  provider -> missing stays missing; concurrency coalescing; 429 cooldown preserved).
- **NEW_RELEASE_INVARIANT:** `STALE_CACHE_STATUS` — `certify-next-session` probes the
  production snapshot's bar tails; the gateway refuses to treat a stale tail as sufficient.
- **Responsible layer:** LAYER 1 (gateway contract) + LAYER 5 (`certify-next-session`).
- **IMPLEMENTED 2026-10-10:** commit `f9277c7` (tail-freshness gate on `ensureBars()` cache
  acceptance + in-flight refresh coalescing).

### OCT9_FAST_LANE_LEASE_ESCAPE

- **What happened (2026-10-09):** `fastLaneEvaluator.ts` released its concurrency slot AND
  its per-symbol dedup entry on caller timeout while `evaluateSymbol()` could still be
  running. The governor believed a slot was free while work continued (invisible
  concurrency), and a replacement evaluation for the same symbol could start, defeating
  the dedup guard (duplicate concurrent work).
- **OLD_TEST_GAP:** Evaluator tests awaited the evaluator promise normally; no test timed
  out the caller while the underlying work was still in flight and then asserted the slot
  stayed held and no duplicate evaluation started.
- **NEW_TEST:** Lease tests in `fastLaneEvaluator.test.ts` (caller timeout -> lease held in
  CALLER_TIMED_OUT; late settle discarded via generation guard; replacement refused via
  PRIOR_EVALUATION_STILL_IN_FLIGHT; bounded quarantine after N consecutive timeouts / T ms
  age returns the slot while keeping dedup; lease-book observability).
- **NEW_RELEASE_INVARIANT:** `FAST_LANE_LEASE_TEST` — `certify-next-session` points at the
  lease suite; a caller timeout must never release active capacity.
- **Responsible layer:** LAYER 1 (evaluator contract) + LAYER 2 (concurrency invariant).
- **IMPLEMENTED 2026-10-10:** commit `27e17d3` (lease-held-until-settle + bounded hung-work
  quarantine). The bounded priority scheduler (`quantPriorityScheduler.ts`) applies the same
  pattern to its quant stage (watchdog -> quarantine -> age-bounded eviction).

### OCT9_ZERO_AUTHORIZED_STRATEGIES_ESCAPE

- **What happened (2026-10-09):** The Oct-9 session ran with **21 strategies, 0 authorized
  Quant-policy, 20 missing lifecycle rows**, and certification reported
  `READY_WITH_CONDITIONS` without failing. The same class as
  `OCT8_LIFECYCLE_AUTHORITY_ESCAPE`, one day later — the invariant had been *identified*
  but not yet *enforced as a gate*.
- **OLD_TEST_GAP:** The mandatory invariant existed as a forensic finding, not as an
  automated gate. Nothing in the release path computed
  `AUTHORIZED_PAPER_QUANT_STRATEGIES` and failed on zero.
- **NEW_TEST:** Same as `OCT8_LIFECYCLE_AUTHORITY_ESCAPE` — Layer-3 report — plus the gate
  itself: the release checklist computes the count and fails closed on zero.
- **NEW_RELEASE_INVARIANT:** `AUTHORIZED_PAPER_QUANT_STRATEGIES = 0` ⇒
  `QUANT_FIRST_OPERATIONALLY_INACTIVE` = **FAIL**. Identifying an escape is not the same
  as gating on it.
- **Responsible layer:** LAYER 5 (release certification) — this entry exists to record that
  a known defect re-escaped because the gate was not yet wired.

### OCT9_PROMOTION_ROUTE_GAP

- **What happened (found 2026-10-09):** The deeper root cause behind
  `OCT8_LIFECYCLE_AUTHORITY_ESCAPE` / `OCT9_ZERO_AUTHORIZED_STRATEGIES_ESCAPE`: a static
  probe of production (non-test) sources found **LIFECYCLE_PROMOTION_ROUTE=ABSENT** — no
  production code path ever recorded a `VALIDATED`/`CHAMPION` lifecycle decision into
  `learning_versions`. The research side (`promotionEngine.deriveLifecycleStatus()`) could
  derive a research-vocabulary VALIDATED from evidence, but the operator/review decision
  point between research evidence and the runtime lifecycle table did not exist as code.
  Zero authorized strategies was not a threshold problem or an engine problem; it was a
  missing workflow.
- **OLD_TEST_GAP:** Tests proved the authorization mechanism by seeding lifecycle rows
  into isolated DBs. Nothing tested — or even specified — the legitimate route by which a
  real strategy could EARN a VALIDATED row. The gap was invisible because no test asked
  "how does a strategy legitimately get here?"
- **NEW_TEST:** `src/server/lifecycle/certificationBridge.test.ts` (10/10) — the designed
  bridge workflow against isolated DBs: insufficient evidence / bad OOS / poor
  walk-forward → no authority; RETIRED PULLBACK_CONTINUATION stays retired; legitimate
  reviewed qualification → VALIDATED recorded by the workflow itself →
  AUTHORIZED_QUANT_POLICY via the real resolver; missing operator review → no transition
  (type-level brand + runtime gate); LIVE authority impossible (inexpressible in the
  bridge vocabulary + paper-only env lock). Plus a static test asserting the bridge
  module holds exactly one `recordStrategyLifecycleTransition` call site.
- **NEW_RELEASE_INVARIANT:** The promotion route is no longer absent: research evidence →
  sample-sufficiency gates → UNSKIPPABLE operator review →
  `executeCertificationTransition()` → `learning_versions`. The Layer-3 certification
  output now names this route (`certificationBridge` field) whenever it reports missing
  lifecycle rows — the legitimate fix is documented at the point of diagnosis, not left
  as tribal knowledge.
- **Responsible layer:** LAYER 3 (production-state certification) + operator runbook
  (`docs/testing/LIFECYCLE_CERTIFICATION_BRIDGE.md`).

---

## Oct 8/9 defect-hunt entries

### OCT9_OMS_POSITION_ORDER_UNRESOLVED_ESCAPE

- **What happened (found 2026-10-09):** OMS crash recovery could leave an order in
  `POSITION_ORDER_UNRESOLVED` — the order existed at the broker but OMS could not resolve
  its position linkage after restart, risking duplicate orders or orphaned positions.
- **OLD_TEST_GAP:** No test restarted OMS mid-order-lifecycle and asserted the order's
  position linkage resolved via `client_order_id` lookup.
- **NEW_TEST:** `src/server/services/OrderManagement.crashRecovery.test.ts` — restart
  mid-lifecycle; orders resolve through `reconcileStaleOrders()` by `client_order_id`.
  (Related: `src/brokers/__tests__/IbkrSocketSession.crashRecovery.test.ts` for the
  IBKR-specific orderRef/reconnect gap.)
- **NEW_RELEASE_INVARIANT:** `RECONCILIATION` — crash-recovery matrix: every in-flight
  order state resolvable after restart; no duplicates, no orphans.
- **Responsible layer:** LAYER 4 (restart scenario) + LAYER 5 checklist.

### OCT9_BROKER_QUANTITY_VALIDATION_ESCAPE

- **What happened (found 2026-10-09):** Quantity validation was **inconsistent across the
  6 broker adapters** — an order quantity accepted by one adapter could be rejected (or
  mis-sized) by another, so the adapter in use changed order semantics.
- **OLD_TEST_GAP:** Each adapter was tested against its own expectations; no test asserted
  a **single quantity-validation contract across all 6 adapters**.
- **NEW_TEST:** `src/brokers/adapterQuantityValidation.test.ts` — all 6 adapters against
  the same validation matrix.
- **NEW_RELEASE_INVARIANT:** `RISK_SPINE` — adapter parity is part of the spine check;
  swapping the active broker must not change validation semantics.
- **Responsible layer:** LAYER 1 (component correctness) + LAYER 2 (BrokerManager canonical).

### OCT9_SELL_RISK_GATES_ESCAPE

- **What happened (found 2026-10-09):** **SELL assessments omitted risk gates 18–21** —
  the BUY path ran all gates but the SELL path silently skipped four of them.
- **OLD_TEST_GAP:** Gate tests exercised the BUY path thoroughly; no test asserted that a
  SELL assessment runs the *same* gate set as BUY.
- **NEW_TEST:** `src/server/engines/RiskEngine.gates.test.ts` — extended to assert gate
  parity between BUY and SELL assessments (gates 18–21 fire on SELL).
- **NEW_RELEASE_INVARIANT:** `RISK_SPINE` — BUY/SELL gate parity asserted on the exact build.
- **Responsible layer:** LAYER 1 (component correctness).

### OCT9_AGED_PENDING_ROWS_ESCAPE

- **What happened (found 2026-10-09):** Aged-out PENDING rows were **silently ignored** —
  rows that passed their evaluation horizon were never graded or archived, quietly
  corrupting backlog metrics and outcome accounting.
- **OLD_TEST_GAP:** No test advanced the clock past a pending row's horizon and asserted
  what happened to it. Pending-row tests only covered the happy path.
- **NEW_TEST:** `src/server/db/archiveDiagnosticPending.test.ts` — aged PENDING rows are
  archived through the defined path instead of silently ignored.
- **NEW_RELEASE_INVARIANT:** `RECONCILIATION` — no silently-ignored pending work at session
  end; backlog metrics reconcile.
- **Responsible layer:** LAYER 4 (session simulation to post-market) + LAYER 5 checklist.

### OCT9_AI_QUARANTINE_STICKY_ESCAPE

- **What happened (found 2026-10-09):** The AI provider health quarantine was **sticky
  with no recovery path** — once a provider was quarantined offline, nothing ever
  re-probed it, so a transient outage became a permanent loss of that provider.
- **OLD_TEST_GAP:** Quarantine tests verified that a failing provider gets quarantined;
  no test verified that a *recovered* provider gets re-admitted.
- **NEW_TEST:** `src/server/ai/AIProviderHealthQuarantineRecovery.test.ts` — quarantine →
  recovery probe → re-admission; plus `src/server/ai/AIRouter.providerResilience.test.ts`.
- **NEW_RELEASE_INVARIANT:** `ALL_AI_DOWN_QUANT` — the AI-down scenario must also cover
  provider *recovery*, not just provider failure.
- **Responsible layer:** LAYER 4 (AI outage + recovery scenario).

### OCT9_MODELRUNTIME_CHILD_REAP_ESCAPE

- **What happened (found 2026-10-09):** `ModelRuntimeManager` child processes were
  **never reaped** — spawned model processes accumulated as zombies across the session.
- **OLD_TEST_GAP:** Tests verified that child processes were *spawned* correctly; no test
  asserted they were *reaped* on completion or shutdown.
- **NEW_TEST:** `src/server/ai/ModelRuntimeManager.childReaping.test.ts` — spawn →
  terminate → assert no lingering child processes (extends
  `src/server/ai/ModelRuntimeManager.test.ts`).
- **NEW_RELEASE_INVARIANT:** `MEMORY_SOAK` / `LISTENER_TIMER_STABILITY` — process counts
  stable across start/stop cycles and soak windows.
- **Responsible layer:** LAYER 4 (soak) + LAYER 5 checklist.

### OCT9_SYSTEMMETRICS_LISTENER_LEAK_ESCAPE

- **What happened (found 2026-10-09):** `SystemMetricsWorker.stop()` leaked **6 EventBus
  listeners per toggle** — repeated start/stop cycles accumulated listeners, degrading the
  bus and memory over time.
- **OLD_TEST_GAP:** Lifecycle tests verified the worker *started* and *stopped*; no test
  counted listeners before and after a start/stop cycle.
- **NEW_TEST:** `src/server/services/SystemMetricsWorker.lifecycle.test.ts` — listener
  counts asserted stable across start/stop cycles.
- **NEW_RELEASE_INVARIANT:** `LISTENER_TIMER_STABILITY` — no listener/timer leaks across
  start/stop cycles, on the exact build.
- **Responsible layer:** LAYER 4 (soak) + LAYER 5 checklist.

### OCT9_RETENTION_TDZ_IMPORT_ESCAPE

- **What happened (found 2026-10-09):** An **import cycle** caused a temporal-dead-zone
  failure that **broke the retention sweepers at import time** — the sweeps never ran,
  silently, because the module graph failed before the registry was populated.
- **OLD_TEST_GAP:** Retention tests imported the sweeper modules through paths that
  happened to avoid the cycle; no test imported the registry the way production does and
  asserted it was populated.
- **NEW_TEST:** `src/server/db/retentionCoverage.test.ts` — mutation-proven: it fails if
  any append-only table lacks a registered sweeper, which also fails if the registry
  itself fails to import. Import-order is now load-bearing test surface.
- **NEW_RELEASE_INVARIANT:** `MEMORY_SOAK` — the coverage test runs in the pre-market
  gate; a broken sweeper registry is a red gate, not a silent skip.
- **Responsible layer:** LAYER 2 (architecture invariant — module graph integrity) +
  LAYER 5 checklist.

### OCT10_SOAK_PATH_RETENTION_ESCAPE

- **What happened (found 2026-10-10):** A 180-sim-minute SOAK_3H synthetic session (the
  soak profile from `scripts/soak/threeHourSoakChild.ts`) wrote rows to
  **16 append-only tables with no prune path anywhere in the codebase**:
  `consensus_debate_predictions` (27/iter), `consensus_decisions` (8/iter),
  `consensus_evidence` (10/iter), `reconciliation_events` (1/iter) — confirmed by row
  counts against an isolated synthetic DB — plus 12 more on the session path in live
  configurations (`portfolio_snapshots`, `ai_usage`, `kronos_predictions`,
  `prediction_outcomes`, `prediction_outcome_horizons`, `missed_opportunities`,
  `learning_observations`, `meta_label_features`, `quant_forecasts`,
  `explainability_reports`, `training_examples`, `learned_rules`). At soak cadence
  (hundreds of iterations per run) these grow unbounded — the same defect class as
  `candidate_rankings` (2026-09-22) and `news_articles` (2026-10-08).
- **OLD_TEST_GAP:** The 2026-10-08 session guard ran a 6-minute QUIET_OPEN session and
  asserted every written table had a retention story — but the soak profile (news shock,
  8 symbols, 180 sim-minutes, reconciliation worker, outcome evaluators) writes tables
  the 6-minute session never touches. No test enumerated the soak profile's write set.
- **NEW_TEST:** `src/server/db/soakPathRetention.test.ts` — per-table cutoff/idempotency
  for all 16 sweepers, consensus_evidence join/orphan semantics, event-loop heartbeat,
  never-throws; `retentionCoverage.test.ts` extended with all 16 tables (fails by design
  if any lacks a sweeper). Bonus: the new tests caught `prepare()` outside the try block
  violating the sweeper "never throws" contract, and wrong key/time columns for
  `quant_forecasts` (PK is `forecast_id`) and `prediction_outcomes` (no `created_at`).
- **NEW_RELEASE_INVARIANT:** `RETENTION_COVERAGE` — the coverage test runs in the
  pre-market gate; any append-only table without a registered sweeper is a red gate.
- **Responsible layer:** LAYER 4 (soak) + LAYER 5 checklist.

---

## Phase 2 — October 10 escapes (cross-cutting defect hunt, commits 6294ace..ab30389)

### OCT10_IBKR_WEB_PORTFOLIO_THROW_ESCAPE

- **What happened (found 2026-10-10, fixed 3edf5bc):** The IBKR Web adapter's
  `portfolio()` and `orders()` THREW on a positions-request failure instead of returning
  `[]`. A failing request became an exception propagating up the call stack instead of an
  empty, fail-closed, observable result.
- **OLD_TEST_GAP:** Broker adapter tests exercised the happy path and malformed payloads;
  no test failed the underlying positions request and asserted the empty-array contract.
- **NEW_TEST:** Broker suites (25/25 at the pre-mission review, 2026-10-11) — request
  failure -> `[]`, never throw.
- **NEW_RELEASE_INVARIANT:** Broker adapter fail-closed contract — a failing broker
  request must return the empty result, never throw, or the pre-market gate is red.
- **Responsible layer:** LAYER 2 (provider contract).

### OCT10_QUESTRADE_SIDE_MISLABEL_ESCAPE

- **What happened (found 2026-10-10, fixed 781bfb3):** The Questrade adapter mapped order
  sides STC/STO/Short to **BUY**. A BUY-mislabeled short side is a severe order-semantics
  defect; PAPER_ONLY / LIVE_NO_GO contained the blast radius.
- **OLD_TEST_GAP:** Side-mapping was assumed correct by construction; no test asserted
  the exact side mapping for every row type.
- **NEW_TEST:** Broker suites (25/25) — exact side mapping asserted per row type;
  malformed rows skipped individually (per-row skip added).
- **NEW_RELEASE_INVARIANT:** Broker order-semantics contract — every adapter's side
  mapping is asserted exhaustively in the pre-market gate.
- **Responsible layer:** LAYER 2 (provider contract).

### OCT10_ALPACA_MALFORMED_ROW_ESCAPE

- **What happened (found 2026-10-10, fixed 1856513):** `AlpacaBroker.orders()` crashed on
  malformed rows instead of skipping them — one bad row killed the whole read.
- **OLD_TEST_GAP:** Adapter tests fed only well-formed rows; no malformed-row resilience test.
- **NEW_TEST:** Broker suites (25/25) — malformed rows skipped, valid rows processed.
- **NEW_RELEASE_INVARIANT:** Same broker order-semantics contract as above.
- **Responsible layer:** LAYER 2 (provider contract).

### OCT10_JAVA_JSON_LONG_ESCAPE

- **What happened (found 2026-10-10, fixed 6294ace/170b19c):** Java `Json.write` emitted
  `Long.MAX_VALUE` for integral doubles >= 2^63 (silent numeric corruption at the TS-Java
  boundary); malformed JSON numbers/escapes mapped to HTTP 500 instead of
  `JsonParseException` (400) (a client-input error masquerading as a server failure).
- **OLD_TEST_GAP:** No boundary tests on numeric serialization at the Java/TS boundary;
  no status-code assertion for malformed JSON input.
- **NEW_TEST:** Java defect-hunt tests (6294ace, 170b19c). TS-Java bridge contract now
  pinned by the static, mutation-checked test (d89945b).
- **NEW_RELEASE_INVARIANT:** Bridge-contract test runs in the pre-market gate; any
  serialization/schema drift is red.
- **Responsible layer:** LAYER 2 (engine boundary).

### OCT10_JAVA_SLASH_SYMBOL_ESCAPE

- **What happened (found 2026-10-10, fixed 4151eab):** Symbols containing `/` were
  truncated at the slash in path-param handlers.
- **OLD_TEST_GAP:** No adversarial-symbol tests on path-param routing.
- **NEW_TEST:** Java defect-hunt tests (4151eab).
- **NEW_RELEASE_INVARIANT:** Same bridge-contract invariant as above.
- **Responsible layer:** LAYER 2 (engine boundary).

### OCT10_JAVA_EMA_SEED_ESCAPE

- **What happened (found 2026-10-10, fixed fc8cb23):** Java's stale first-price EMA
  seeding diverged from the MACDEngine.ts 2026-09-22 SMA-seeded fix — a TS/Java parity
  propagation was missed, so the two engines seeded their first EMA differently.
- **OLD_TEST_GAP:** Parity tests existed but did not cover the seeding edge; no
  automated check that a TS-side parity fix is propagated to Java.
- **NEW_TEST:** Parity tests (fc8cb23).
- **NEW_RELEASE_INVARIANT:** TS-Java parity suite in the pre-market gate.
- **Responsible layer:** LAYER 2 (engine boundary).

### OCT10_SCHEDULER_SPLIT_BRAIN_ESCAPE

- **What happened (found 2026-10-10, fixed 667e718):** Enabling/disabling
  `QUANT_PRIORITY_SCHEDULER_ENABLED` mid-run could leave the legacy and priority
  scheduler paths disagreeing about ownership of candidates (split-brain on flag
  transitions).
- **OLD_TEST_GAP:** Scheduler tests flipped no flags mid-run; no ownership-handoff test
  across transitions.
- **NEW_TEST:** Flag-transition tests (667e718).
- **NEW_RELEASE_INVARIANT:** Exactly one scheduling authority across flag transitions,
  asserted in the scheduler suite; the flag stays default OFF in `.env.example`.
- **Responsible layer:** LAYER 1 (scheduler contract).

### OCT10_COALESCE_WEDGE_ESCAPE

- **What happened (found 2026-10-10, fixed 4262bda; completed 2026-10-11, b215132):**
  `ensureBars` coalescing entries (`inflightEnsureBars`) had no liveness bound — a
  stalled provider call would wedge the window's entry FOREVER. The Oct-10 fix added TTL
  eviction, but the TTL timer DELETED the in-flight entry while the fetch was still
  pending (TONIGHT-13), causing duplicate provider work + zombie cache clobbering.
- **OLD_TEST_GAP:** Coalescing tests never stalled the underlying fetch; the TTL fix's
  own test did not cover delete-while-pending.
- **NEW_TEST:** Coalescing TTL tests (4262bda); retain-until-settle + caller-side-timeout
  regression (b215132).
- **NEW_RELEASE_INVARIANT:** Coalescing entries are liveness-bounded and settle-guarded;
  the release invariant is that no bounded timeout deletes shared in-flight state.
- **Responsible layer:** LAYER 1 (data contract) + LAYER 2 (async ownership).

---

## Phase 3 — Mission-night escapes (2026-10-11, defects TONIGHT-01..26)

### OCT11_CONSENSUS_BYPASS_ESCAPE

- **What happened (found 2026-10-11, fixed 52b6933):** The 2026-10-07 quant-first policy
  router's `AUTHORIZED_QUANT_POLICY` branch approved ideas directly —
  `recordConsensusTransaction` + `emitChiefApproval` with `threshold: 0` ("never compared
  against") and `independentAgreeingAgents: 0` / `requiredAgents: 0` — structurally
  skipping the standing strict >0.75 consensus bar and the min-2-independent-agents
  floor. It was a silent architectural exception to invariants Arul had explicitly
  hardened as absolute.
- **OLD_TEST_GAP:** The spine tests (`quantLiveAuthority.spine.test.ts`,
  `quantSpineInvariants.test.ts`) asserted the OLD single-grant shape; no test
  asserted that NO approval path exists with threshold 0.
- **NEW_TEST:** Router suite rewritten (policy-pass enters the pool; single voice and
  <0.75 ideas never approved); `quantSpineInvariants` static tests pin "no approval
  primitives / no threshold: 0"; boundary tests pin exactly-0.75 -> NO TRADE and
  0.7501 -> eligible (TONIGHT-26, c78e98e).
- **NEW_RELEASE_INVARIANT:** No idea may be approved without clearing the identical
  strict >0.75 / min-2-independent-agents gate; static scan for approval primitives
  outside the consensus path is a pre-market gate.
- **Responsible layer:** LAYER 5 (release gate) + LAYER 1 (spine invariant).

### OCT11_CACHE_COLLISION_LOOKAHEAD_ESCAPE

- **What happened (found 2026-10-11, fixed ea1c0c1):**
  `HistoricalDataGateway.memoryKey()` bucketed on whole hours and ignored
  provider/adjustment/session-mode/data-type; `getBars()` returned cache hits UNFILTERED.
  A wider query warming the bucket + a narrower same-bucket query returned post-cutoff
  bars — cache-served lookahead, a point-in-time integrity defect.
- **OLD_TEST_GAP:** Cache tests warmed and re-queried the SAME window; no test queried a
  narrower window after a wider one and asserted no post-cutoff bars.
- **NEW_TEST:** Regression: query T1, query T2>T1 (warm), repeat T1 -> no post-T1 data
  (ea1c0c1).
- **NEW_RELEASE_INVARIANT:** Cache identity is exact-window + source-exact; PIT replay
  fixtures must include cross-window cache warming.
- **Responsible layer:** LAYER 1 (data contract).

### OCT11_STALE_TAIL_REOPEN_ESCAPE

- **What happened (found 2026-10-11, fixed 1ab3563):** The Oct-10 stale-tail gate
  (f9277c7) was correct for the non-empty provider path, but the IBKR-empty path
  (`'if (existing.length > 0) return;'`) served cached bars WITHOUT consulting the
  staleTail flag — silently re-admitting the Oct-9 forensic condition (508/972 records
  >7d stale). A fix can re-open a closed defect when a parallel path predates the fix.
- **OLD_TEST_GAP:** The f9277c7 regression tested the non-empty path only; no
  stale-cache + IBKR-empty regression.
- **NEW_TEST:** Regression: IBKR empty + stale cache + empty Alpaca -> DATA_STALE,
  never READY-as-fresh (1ab3563). Closes OCT9-02 (register).
- **NEW_RELEASE_INVARIANT:** Every provider-response shape (empty, partial, error)
  must be exercised against a stale cache in the data-contract suite.
- **Responsible layer:** LAYER 1 (data contract).

### OCT11_QUARANTINE_PIN_ESCAPE

- **What happened (found 2026-10-11, fixed 7bd0ddc):** `reapHungLeases` skipped
  QUARANTINED leases — a never-settling evaluation pinned the symbol with
  `FAST_LANE_SYMBOL_QUARANTINED` until process restart.
- **OLD_TEST_GAP:** Reaper tests never aged a quarantined lease; no max-age test on the
  quarantine state.
- **NEW_TEST:** Regression: quarantined lease older than max age -> evicted (7bd0ddc).
- **NEW_RELEASE_INVARIANT:** `fastLaneQuarantineMaxAgeMs` (3600000ms default,
  `config/tradingSafety.json`) — every non-terminal resource state has a bounded age.
- **Responsible layer:** LAYER 1 (fast-lane contract). Mission adjudication: quarantine
  is BLESSED as the formally-sanctioned safe-abandonment protocol.

### OCT11_JEV_GOVERNOR_BYPASS_ESCAPE

- **What happened (found 2026-10-11 by Worker C, fixed 02217be):**
  `NewsEngine.tryJevFirstAnalysis` (Phase 2 escalation) called Jev directly, bypassing
  `AICallGovernor` — the Phase 1 shadow path was migrated (c991233, OCT8-10) but Phase 2
  was not. Same defect class, second instance: a fix applied to one call path does not
  automatically cover its sibling.
- **OLD_TEST_GAP:** No call-site inventory test asserted every Jev call routes through
  the governor.
- **NEW_TEST:** Governor routing pinned (capability, kind, materiality) at 02217be.
- **NEW_RELEASE_INVARIANT:** Every Jev call site routes through `AICallGovernor`;
  a static call-site inventory test owns this.
- **Responsible layer:** LAYER 2 (AI-provider contract).

### OCT11_ASYNC_OWNERSHIP_ESCAPE

- **What happened (found 2026-10-11, fixed 4c437c4/b9975e4/a637a90):** Three
  async-ownership defects from Worker D's audit: (17) `PrioritySemaphore` granted permits
  to terminally-transitioned waiters (wasted handoff, over-reported `waitingCount`);
  (18) `AICallGovernor` singleflight deleted the dedup entry when the timeout RACE
  settled while `invoke` still ran (duplicate provider call in the window); (19)
  `AIRouter` dedup pruned entries by TTL alone while sequential 20s-per-provider
  executions outlived the TTL (duplicate call for long executions).
- **OLD_TEST_GAP:** Ownership tests asserted the happy handoff/settle, not the
  race/settle-boundary: no dead-waiter pruning test, no race-vs-invoke settle test,
  no execution-lifetime-vs-TTL test.
- **NEW_TEST:** Semaphore waiter-cancellation; governor onInvokeSettled; router
  settled-flag prune — all at their fix commits.
- **NEW_RELEASE_INVARIANT:** Async-ownership audit items: every shared in-flight entry
  has exactly one documented owner and one settle boundary; TTL never deletes live
  shared state.
- **Responsible layer:** LAYER 2 (async ownership).

### OCT11_SOAK_UNIT_MISLABEL_ESCAPE

- **What happened (found 2026-10-11, fixed 72c7169):** The soak child stored
  `monitorEventLoopDelay` percentiles (NANOSECONDS) into fields named `*Ms` with no /1e6
  conversion — every soak report's event-loop numbers were 1e6x mislabeled — and
  `stabilityVerdict` was PASS inferred merely from zero iteration errors while resource
  bounds gated nothing.
- **OLD_TEST_GAP:** No unit assertion on soak report fields; the verdict's gating
  inputs were never asserted.
- **NEW_TEST:** Soak-child regression (72c7169); verdict now gates on
  SOAK_MAX_RSS_MB / SOAK_MAX_RSS_DELTA_MB / SOAK_MAX_EVENT_LOOP_P95_MS /
  SOAK_MAX_DB_GROWTH_BYTES / SOAK_MAX_WAL_BYTES with violations in boundViolations.
- **NEW_RELEASE_INVARIANT:** Soak verdicts are resource-gated; historical soak reports
  predating 72c7169 are not evidence (units mislabeled, verdict un-gated).
- **Responsible layer:** LAYER 4 (soak). **Finding for coordinator:** 5 new SOAK_* env
  vars are not yet in `.env.example`.

---

## Reading this registry

1. **Every entry is a real escape**, dated, with the honest gap named. "No test exercised X"
   is the expected OLD_TEST_GAP phrasing — most escapes were not subtle logic errors but
   entirely untested dimensions (time, restart, recovery, growth, parity).
2. **A fix without a NEW_TEST is not done**, and a NEW_TEST without a NEW_RELEASE_INVARIANT
   is a finding, not a gate (`OCT9_ZERO_AUTHORIZED_STRATEGIES_ESCAPE` is the cautionary
   example — the finding existed a full day before the gate did).
3. When a new escape is found: add the entry, add the test, add the invariant, then fix.
   The order matters — it is what keeps the next escape from being this one again.
