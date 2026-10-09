# Argus live audit and defect repair — October 9, 2026

## Scope and evidence boundaries

This extends [the earlier nondisruptive audit](ARGUS_LIVE_SESSION_NONDISRUPTIVE_AUDIT_2026-10-09.md); earlier date-scoped evidence is retained there. Repairs run in codex/argus-session-repair-20261009, outside the active checkout. No deployment, restart, state change, lifecycle write, broker mutation, maintenance, or AI probe is authorized by this mission. LIVE_NO_GO remains authoritative. Build readiness and PAPER strategy readiness are separate questions.

Repository base: 019dba54fab7f9f8c456dc4d678238ba8f0f65f0. Current running immutable source SHA is UNKNOWN; repository HEAD is not a runtime build stamp. Engine PID 29536 and watchdog PID 18776 retain their original start times (09:40:28 and 09:44:17 ET). The earlier authenticated runtime sample reported PAPER, TRADING_ENABLED, autobot enabled, emergency stop inactive, LIVE_NO_GO. Those flags have not been freshly re-certified in this follow-up.

## Refreshed live evidence

Read-only SQLite query, captured 2026-10-09T15:42:48.862Z. Exact half-open window 14:42:48.862Z–15:42:48.862Z (10:42–11:42 ET). Event counts are not distinct symbols or deduplicated transitions. Queries use event_type/ts indexing and query_only; production modules are not imported.

- Discovery admitted: 390
- Subscriptions promoted: 53; not promoted: 968
- Quant assessments: 172
- Trade ideas: 4,845
- Strategy authorization checks: 18
- Quant policy approved/rejected: 0/0
- Chief consensus started/terminal reasons: 3,786/3,786
- Chief approved: 0
- Risk completed: 0
- Orders submitted / order filled / fill recorded events: 0/0/0

Refreshed lifecycle read returned only strategyEligibility:PULLBACK_CONTINUATION, RETIRED, sample size 22, recorded August 31. Other strategy lifecycle rows are absent. AUTHORIZED_PAPER_QUANT_STRATEGIES remains zero under the existing resolver; QUANT_POLICY_REACHABLE = NO; observed QUANT_POLICY_ACTUALLY_USED in this window = NO. Zero-event execution counts are not a substitute for another broker/ledger reconciliation. Earlier independent ledger checks and reconciliation evidence are in the linked audit.

First evidenced systemic limitation: no current strategy can obtain privileged Quant policy authorization. Consensus still operates; the earlier exact confidence audit found its maximum below 0.75. Discovery/subscription losses are also substantial, but event counts alone do not prove incorrect ranking or lost executable opportunities.

OS follow-up: engine working set 2,690,465,792 bytes; private memory 3,015,335,936 bytes; 407 handles; cumulative CPU 4,295.328125 seconds. This is a point sample, not utilization or a leak slope. MEMORY_CLASSIFICATION = UNKNOWN; confirmed allocation amplification below is not proof of the live memory root cause.

## Confirmed repairs in this follow-up

### D07 — P1: reflection allocates ungraded prediction payloads

EXPECTED: only predictions with matching durable outcomes can contribute to the existing calibration loop; pending payloads need not be loaded into V8.
ACTUAL: both prediction tables were materialized before joining outcomes in a JS Map.
REPRODUCTION: isolated real SQLite fixture with 100 rows per ledger and one graded row each; pre-fix test failed with agentPredictionsRowsScanned = 100 instead of 1.
ROOT CAUSE: prediction reads excluded telemetry but not the rows lacking outcomes; Maps retained pending payloads throughout subsequent awaits.
CLASSIFICATION: unnecessary history-sized allocation amplification; live heap/native leak causality NOT_PROVEN.
FIX: SQL EXISTS keyed by prediction ID and exact source ledger; Kronos numeric IDs cast to text to preserve original Map matching. Existing outcomes and formulas are unchanged.
FILES: ReflectionEngine.ts; ReflectionEngine.cycleMetrics.test.ts.
REGRESSION: post-fix materialization is one row per ledger; graded calibration retains WIN/LOSS; all 100 pending rows remain durable. Neighboring calibration, provider calibration, environment exclusion, effective weights, closed trades, attribution and reentrancy suites pass.
RESULT: 9 files / 58 tests passed.
DEPLOYMENT REQUIRED: YES, after session only.
REMAINING RISK: full graded history and outcome arrays remain unbounded by row count; this is not a complete scaling solution or memory-soak certificate. EXISTS can still scan ledger keys; live latency improvement is unverified.

### D08 — P2: recertification disagrees with canonical lifecycle at timestamp ties

EXPECTED: later append wins at equal createdAt, consistent with emission eligibility.
ACTUAL: review sorted only by createdAt, returning RETIRED after a same-millisecond ROLLED_BACK.
REPRODUCTION: real isolated lifecycle writes; pre-fix test failed because TIE_RECERT remained in quarantined IDs while canonical status was ROLLED_BACK.
ROOT CAUSE: missing rowid descending tiebreak in both review queries.
FIX: identical canonical latest-transition ordering.
FILES: StrategyRecertification.ts; StrategyRecertification.test.ts.
REGRESSION: same-millisecond retirement/reinstatement agrees with canonical reader. Review never changes authority.
DEPLOYMENT REQUIRED: YES.
REMAINING RISK: diagnostic correction only; no strategy is promoted by this change.

### D09 — P2: exact strategy lookup uses SQL wildcard matching

EXPECTED: EXACT_RECERT reads its own transition.
ACTUAL: LIKE treats underscore as a wildcard and can select newer EXACTXRECERT state.
ROOT CAUSE: LIKE used for an individual identifier, rather than equality.
FIX: exact eq(versionType, strategyEligibilityVersionType(strategyId)).
REGRESSION: separate strategy records with underscore/different character, asserted status and hypothesis remain exact. This assertion is included in the lifecycle regression; the first pre-fix failure was D08.
FILES: same as D08.
RESULT for D08/D09 and related authorization: 3 files / 48 tests passed.
DEPLOYMENT REQUIRED: YES.
REMAINING RISK: review evidence statistics are unchanged and still need real research interpretation.

### D10 — P2: resource observations lack a lightweight diagnostic surface

EXPECTED: existing process samples and canonical queue state are observable without historical report scans.
ACTUAL: metrics exposed counters/config but not process samples or active queue flush; expensive report requests timed out in the earlier audit.
CLASSIFICATION: observability gap; not evidence that a queue leaks.
FIX: additive process-resources route with bounded in-memory reads; pending/flushing distinguished, unknown in-flight batch size and missing telemetry null. No new sampler, queue, timer, probe or DB query.
FILES: ObservabilityMetrics.ts; ObservabilityStore.ts; observabilityRoutes.ts; corresponding tests.
REGRESSION: detached sample snapshot, unknown percentiles preserved, queued versus flushing state, resource route succeeds even with db.select forced to throw and makes zero selects.
DEPLOYMENT REQUIRED: YES.
REMAINING RISK: the route cannot expose samples in the current process until a separately authorized deployment. First queued event timestamp is not a measured enqueue-age or maximum-depth metric.

## Lifecycle and AI findings

StrategyEmissionEligibility explicitly defines ACTIVE_EXPLORATION as emission eligibility through ordinary consensus, not privileged AI-independent execution. The latest October 8 clarification and QuantStrategyAuthorization agree. It must not be changed into Quant policy authority based on the enum name.

Lifecycle creation is explicit/evidence-backed; production code does not automatically record VALIDATED transitions. Missing rows are therefore not themselves proof of a corrupt migration. VALIDATED is described as passed OOS/walk-forward validation; that permits research evidence before PAPER execution. A mandatory PAPER-only validation circular dependency is NOT_CONFIRMED. Research that has not passed is a qualification gap; manufacturing VALIDATED records would conceal it.

Existing all-AI-down certification uses isolated, explicitly labeled synthetic lifecycle fixtures and production policy/spine boundaries. It establishes mechanism capability only. Current production lifecycle evidence fails production-state reachability, and live session policy decisions remain zero. None of these three certification levels substitutes for another.

## Remaining audit boundaries

Backup worker, watchdog storm protection, premarket completion, OMS duplicate-close, negative quantities, correlation exposure and protected-path tests are included in the broader regression batch. Passing isolated tests does not verify today's live deployment of every feature. The earlier report records latest persisted reconciliation match and empty local positions/orders; a fresh broker fetch was not performed here.

No listener/timer leak has been established in this follow-up. Those inventories are incomplete, not certified absent. Market feed freshness, live event-loop percentiles, queue/cache cardinalities, provider circuits/in-flight state, running SHA, and an extended isolated soak remain certification gaps. The new lightweight diagnostic is preparation for later runtime verification, not retrospective measurements.

P0_REMAINING is UNKNOWN as a complete-system count; no P0 was found under the bounded checks performed. Full mission completion and absence of all P1 defects are NOT_CLAIMED. No external entitlement or profitable strategy edge is established.

## Deployment gate

RUNNING_ENGINE_UNTOUCHED = YES (no operations changing it; shared-host resource impact is not zero-guaranteed).
POST_MARKET_DEPLOYMENT_READY = NO pending final broader validation, review of remaining scaling risk, and separately authorized deployment/runtime verification.
The repaired artifact must not be merged/restarted into this session. Preserve safety, lifecycle evidence, state and .env. No automatic resume or LIVE arming.

### D11 — P1: Fast Lane mixed-case deduplication failure

EXPECTED: one active candidate per canonical symbol, independent of input case.
ACTUAL: stored uppercase symbols were compared with unnormalized input. Repeated lowercase/mixed-case arrivals created independent IDs and retained duplicate candidates until expiry.
REPRODUCTION: regression initially failed on the second mixed-case arrival; after repair, 100 repeated arrivals retain exactly one candidate.
ROOT CAUSE: normalization occurred only when building the stored object, after the duplicate check.
FIX: compute the existing uppercase representation before deduplication and reuse it for storage.
FILES: FastLaneManager.ts; FastLaneManager.test.ts.
DEPLOYMENT REQUIRED: YES; live frequency/impact is unverified, and this does not prove the live memory root cause.
REMAINING RISK: overall distinct-candidate and terminal-history pressure still needs measured load/soak evidence; TTL cleanup is not a fixed absolute capacity bound.

Testing discovered a separate fixture defect: the LIVE refusal test inherited PAPER_TRADING_ONLY=true, which correctly demotes requested LIVE to PAPER. The test now explicitly selects genuine LIVE inside its isolated process and restores environment stubs after each test. No broker is initialized by this test and no runtime environment is changed.

## Additional verification evidence

Authenticated status at 2026-10-09T15:48:10.644Z: TRADING_ENABLED, autobot true, LIVE_NO_GO; response latency 5,375ms. This refresh confirms those flags but does not provide an immutable running SHA or fresh broker reconciliation.

Source review confirms the observability route is mounted after the existing authentication middleware. AIRouter's in-flight dedup map has configured capacity/TTL and identity-checked finally cleanup; governor per-symbol budgets/cooldowns have caps/pruning. Observability pending queue is bounded by configured maxQueueSize=2000 and drops newest on overflow; flush batch is configured 100, delay 75ms. These are source configuration observations, not live queue depths. Reflection start is guarded by existing interval ownership and inFlight; singleton idea listener is constructor-owned. Full listener/timer inventory remains incomplete.

Validation sequence (failures retained, not suppressed):

- Reflection/architecture batch: 9 files / 58 tests PASS.
- Lifecycle/authorization batch: 3 files / 48 tests PASS.
- Resource/store/routes initial batch: 3 files / 9 tests PASS; an additional no-DB route regression was subsequently included in the broader run.
- Broader repair batch: 33 files / 377 tests PASS (includes AI-offline policy spine, RiskEngine/correlation, sizing, stale +14 duplicate CLOSE_LONG, backup, watchdog and premarket).
- Wider Chief/reconciliation/market-data/provider batch initially: 35 files passed, 2 failed; 344 tests passed, 30 failed, 1 skipped. Twenty-nine mocked WebSocket tests failed because this mission's ARGUS_DISABLE_MARKET_DATA_WS setting disabled their fixture; the heap test ran without exposed GC and measured transient allocation. These results are not called a full pass or dismissed as pre-existing flakes.
- Exact market-data rerun with mocked sockets enabled and exposed GC: 2 files / 99 tests PASS. No thresholds changed, no production connection, and deterministic map-cardinality assertions remain intact. This is isolated high-volume mechanism evidence, not a multi-hour soak or proof against production leaks.
- Fast Lane initial broader run: 7 files passed / 1 failed, 111 tests passed / 1 failed. Failure was the inherited PAPER-only fixture interaction described above; fixture repaired explicitly rather than altering runtime safety behavior.

Typecheck and production build passed before the final Fast Lane change; final reruns are recorded below when complete. Full npm test has not been run for this branch. No deployment or automatic lifecycle promotion occurred.

Final follow-up validation: Fast Lane/architecture 8 files / 112 tests PASS; final typecheck/build PASS. Latest persisted reconciliation id 6857 checked 15:48:03.488Z reports match; captured 15:53:16.305Z. Engine working set subsequently fell to 2,180,861,952 bytes; start time unchanged. This supports retaining UNKNOWN leak classification.
The owner subsequently explicitly authorized rebuilding/restarting with PAPER trading enabled. The earlier no-deployment rule governed the audit until that new instruction; deployment must preserve qualification and safety gates.
