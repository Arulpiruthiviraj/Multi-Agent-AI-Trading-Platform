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
