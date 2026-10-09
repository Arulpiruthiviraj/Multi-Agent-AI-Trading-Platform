# ARGUS — Code-Only Defect Repair & Self-Diagnostic Hardening (2026-10-08)

**Mission:** code-only repair of the 13 defects observed in the 2026-10-08 live PAPER session
(09:30–16:00 ET), plus self-diagnostic hardening. **This mission deliberately did not "fix
the database" and did not promote any strategy lifecycle.** Without the live DB and the
evidence behind the strategies, no lifecycle promotion can be legitimately decided here.
Instead the code now makes bad production state SAFE (fail-closed), VISIBLE (explicit
verdicts, reason codes, diagnostics), and ensures missing state cannot gain privilege.

**Base:** `main` @ `844a6eb`. All work committed on `main`; **NOT pushed** (parent reviews and pushes).
`npx tsc --noEmit` clean. Targeted suites green (see per-defect test evidence).

**How to read this doc:** each defect has: observed symptom → root cause → code fix → tests →
what still needs runtime validation. Items marked **RUNTIME_VALIDATION_REQUIRED** can only be
proven on the deployment host against the real DB / real session; the code changes make the
bad state safe and visible, they do not prove the production state is good.

---

## Defect #1 — Quant-first path dormant; lifecycle/authorization mismatch; strategies with no lifecycle record

**Observed:** `QUANT_POLICY_APPROVED`/`REJECTED`/`NOT_AUTHORIZED` counters all 0; ideas went to
the old ConsensusPolicy path. `PULLBACK_CONTINUATION=RETIRED`. Four CORE strategies
(`MOMENTUM_BREAKOUT`, `MEAN_REVERSION`, `TREND_FOLLOWING`, `RANGE_REVERSION`) had no
`learning_versions` rows at all.

**Root cause (code-proven):** two compounding gaps in `QuantStrategyAuthorization.ts`.
(a) `getStrategyLifecycleStatus()` returns `'UNTESTED'` both when a row genuinely exists with
status UNTESTED *and* when no row exists at all — missing state silently inherited the UNTESTED
default's consensus-path semantics, hiding the operational gap. (b) The codebase used one word
("eligible") for two different concepts: `StrategyEmissionEligibility`'s "Eligible" (may enter
the real-selection idea pool) vs `resolveQuantStrategyAuthorization()`'s execution authority
(may skip consensus via QuantExecutionPolicy) — a future reader could promote ACTIVE_EXPLORATION
to execution authority on the strength of its "Eligible" label.

**ACTIVE_EXPLORATION evidence conclusion (from code, cited):**
`StrategyEmissionEligibility.ts` documents ACTIVE_EXPLORATION as "bounded, monitored real
exposure while evidence accumulates. Eligible." — eligibility for the *real-selection pool*,
whose ideas then take the *unchanged consensus intake* ("real exposure" via the normal spine,
never the AI-independent path). The quant-first design
(`docs/architecture/ARGUS_QUANT_FIRST_DECISION_ARCHITECTURE.md` §4 and
`docs/architecture/ARGUS_ARCHITECTURE.md`'s 2026-10-07 entry) explicitly requires DB lifecycle
`VALIDATED`/`CHAMPION` for `AUTHORIZED_QUANT_POLICY` and routes ACTIVE_EXPLORATION to
`REQUIRES_CONSENSUS`. **Therefore ACTIVE_EXPLORATION was designed as emission eligibility, NOT
execution authority.** ACTIVE_EXPLORATION + PAPER ⇒ REQUIRES_CONSENSUS (never QuantExecutionPolicy);
ACTIVE_EXPLORATION + LIVE ⇒ NOT_ELIGIBLE, because the paper-only environment lock fails first —
no LIVE authority exists in this module under any lifecycle status.

**Code fix:**
- `src/server/quant/strategies/StrategyEmissionEligibility.ts`: new read-only
  `hasStrategyLifecycleRecord()` (existence check; never creates a row); module header now
  documents EMISSION ELIGIBILITY ≠ EXECUTION AUTHORITY with the ACTIVE_EXPLORATION ruling.
- `src/server/quant/QuantStrategyAuthorization.ts`: new `QuantAuthority` member `NOT_AUTHORIZED`
  + reason `NO_LIFECYCLE_RECORD`; the resolver checks record existence FIRST (inside the same
  fail-closed try) and returns `NOT_AUTHORIZED`/`NO_LIFECYCLE_RECORD` with `lifecycleStatus: null`
  (reporting `'UNTESTED'` would falsely imply a recorded decision). New named predicate
  `mayEmitStrategyIdea()` (emission eligibility) vs `resolveQuantStrategyAuthorization()`
  (execution authority). Module header documents the NOT_AUTHORIZED routing contract and the
  ACTIVE_EXPLORATION evidence conclusion.
- `src/server/services/ChiefTraderAgent.ts`: the policy router treats `NOT_AUTHORIZED` like
  `NOT_ELIGIBLE` — terminal `DESK_NO_TRADE` (`terminalReasonCode 'QUANT_NOT_AUTHORIZED'`), never
  re-routed to consensus. Rationale (documented in code): routing missing-state ideas to
  consensus would let missing state silently inherit today's behavior and hide the operational
  gap; safety wins. A *transient lookup failure* is different and stays `REQUIRES_CONSENSUS` +
  `STRATEGY_LIFECYCLE_LOOKUP_FAILED` — a DB outage must not wedge the desk.
- `src/server/quant/QuantExecutionPolicy.ts` (test only): policy layer refuses `NOT_AUTHORIZED`
  authorizations with `QUANT_AUTHORITY_INVALID` (defense in depth; the resolver never emits one).
- No idempotent lifecycle initializer was added: the code does not prove one is supposed to
  exist, and auto-promotion is forbidden. RETIRED stays RETIRED. The PAPER-validation circular
  dependency (can't gain evidence without execution, can't execute without validation) is
  documented in the module header as an operator decision, not silently resolved.

**Tests:** `QuantStrategyAuthorization.test.ts` (missing → NOT_AUTHORIZED/NO_LIFECYCLE_RECORD;
recorded UNTESTED ≠ missing; ACTIVE_EXPLORATION+PAPER → REQUIRES_CONSENSUS;
ACTIVE_EXPLORATION+LIVE → NOT_ELIGIBLE; RETIRED never promoted),
`StrategyEmissionEligibility.test.ts`, `ChiefTraderAgent.router.test.ts` (10/10),
`QuantExecutionPolicy.test.ts` (NOT_AUTHORIZED never enters the policy),
`quantLiveAuthority.spine.test.ts` (5/5: exactly one grant module, lock checked before grants,
exactly one call site, LIVE env → refusal), `quantSpineInvariants.test.ts` (6/6: router ordering,
spine primitives only, lock evaluated at call time — behavioral).

**RUNTIME_VALIDATION_REQUIRED:** the production DB still has the four CORE strategies with no
lifecycle rows (not fixed here, by design). After deployment, run `argus quant-readiness` —
it will show them as NOT_AUTHORIZED/NO_LIFECYCLE_RECORD. The operator must record an explicit
lifecycle decision (e.g. UNTESTED baseline via `recordStrategyLifecycleTransition`) for each
strategy whose ideas should route at all; until then their ideas are terminally dropped, which
is the safe state.

## Defect #2 — ~16GB DB backup + integrity check blocked the Node event loop for minutes

**Observed:** health endpoint unresponsive during backup; the session's watchdog read that as
"frozen" (see defect #3).

**Root cause:** `DbBackupService` ran the SQLite online copy via `sqliteDb.backup()` on the main
thread, and worse, `PRAGMA integrity_check` as one synchronous C call — the event loop could
not serve health, heartbeats, or trading for minutes on a multi-GB DB.

**Code fix:** `src/server/services/DbBackupService.ts` + new
`src/server/services/dbBackupWorkerSource.ts`. ALL heavy work (online copy on a read-only
worker connection — the engine's main-thread connection remains the sole writer, integrity
check, sha256, atomic publish) now runs in a `worker_thread`; the worker body is an eval'd
plain-JS source string so it survives the esbuild-bundled `dist/server.cjs` production build
(no filesystem path needed). The main thread only orchestrates: preflight, spawn, progress
logging (30s), timeout (`dbBackupWorkerTimeoutMs`, default 6h — generous on purpose; a premature
timeout would strand a `.partial` orphan), result handling. New state machine
`IDLE/RUNNING/SUCCEEDED/FAILED/SKIPPED_DISK` via `getBackupStatus()` + `isMaintenanceInProgress()`
— the watchdog's "maintenance in progress" contract. Worker factory is injectable so tests
simulate crashes/hangs without real threads.

**Tests:** `DbBackupService.worker.test.ts` (6/6): main-loop heartbeat never stalls during a
120MB backup; disk-preflight skip under simulated low disk + loud diagnostic + zero writes;
concurrent backup rejected (`BackupAlreadyRunningError`); worker crash publishes nothing (no
half-written final file; service removes its own temp); worker error propagates with phase
named. `DbBackupService.test.ts` + `DbBackupService.reentrancy.test.ts` updated and green.

**RUNTIME_VALIDATION_REQUIRED:** real timing on the deployment host with the real ~16GB DB:
measure health-endpoint p99 during a backup window and confirm the heartbeat never stalls.
The 6h worker timeout should be re-tuned after the first real run if the copy is much faster.

## Defect #3 — Watchdog false-frozen restart storm

**Observed:** kill → restart → TRADING_PAUSED → backup starts → event loop blocks → watchdog
sees "frozen" → kill → … Each restart made things worse.

**Root cause (three compounding gaps):** (a) the watchdog treated *any* stale heartbeat +
unresponsive `/ready` + live PID as genuinely frozen — known event-loop-blocking maintenance
(DB backup, startup, graceful drain) produces exactly the same observable signature, and the
watchdog force-killed the engine mid-maintenance; (b) the restart budget
(maxRestarts/window) lived only in the watchdog process's memory, so restarting the watchdog
itself silently reset it — no durable stop existed; (c) no startup grace: a stale heartbeat
with a live PID in the ~65–75s boot window looked like a freeze.

**Code fix:**
- `scripts/lib/watchdogMaintenanceState.ts` (new) + `src/server/core/maintenanceState.ts`
  (new): the engine publishes a FRESH, explicit maintenance claim
  (`data/.argus_maintenance_state.json`); a stale/missing file is untrusted and ignored.
- `scripts/lib/argusWatchdogLogic.ts`: new decisions `MAINTENANCE_DEFERRED` (judgment deferred,
  never escalated, while a fresh claim is active, bounded by `maintenanceDeferralMaxMs`),
  `STARTUP_GRACE` (counters frozen, never reset, until `startupGraceMs` after `startedAt`),
  `COOLDOWN_WAIT` (exponential backoff: `min(base * 2^restartsInWindow, max)`), `STORM_LOCKOUT`.
- `scripts/lib/watchdogStateStore.ts` (new): restart timestamps + storm-lockout flag persisted
  to `data/.argus_watchdog_state.json` — a fresh watchdog boot with an active lockout re-enters
  STORM_LOCKOUT instead of restarting. Lockout is lifted only by explicit
  `argus watchdog-clear-lockout` (new CLI command; clears the flag only — does not start the
  engine, does not resume trading). `argus watchdog-status` now also shows lockout state and
  restart-budget counters.
- `scripts/lib/argusWatchdogActions.ts` (new): `assertRestartSpecNeverResumesTrading()` — the
  restart spec is asserted at runtime to contain no trading-resume flag; `argus-cli start` is
  invoked WITHOUT `--enable-trading`, so tradingState stays TRADING_PAUSED after any watchdog
  restart (verified live in prior audits; now also test-guarded). Before spawning, the watchdog
  reconciles the engine pid file against the atomic startup claim and refuses to spawn while a
  live process holds it (defense in depth — `argus-cli start` refuses too).
- `config/watchdog.json` (new): all thresholds as config, not TS literals, each overridable via
  `ARGUS_WATCHDOG_*` env; missing keys fail watchdog startup (a watchdog with unknown
  thresholds must not guess).

**Tests:** 47/47 across `argusWatchdogLogic.test.ts`, `argusWatchdogActions.test.ts`,
`argusWatchdogDefect3.test.ts`, `watchdogMaintenanceState.test.ts`, `watchdogStateStore.test.ts`,
`maintenanceState.test.ts`: maintenance deferral, startup grace, backoff caps, storm lockout
engages and persists across watchdog restarts, TRADING_PAUSED survives restart, no second
engine under an active claim.

**RUNTIME_VALIDATION_REQUIRED:** the storm-lockout path and maintenance-deferral path need a
real multi-minute backup on the deployment host to prove the watchdog defers instead of
killing. Verify `argus watchdog-status` shows the lockout after a forced storm in a staging
run before trusting it in production.

## Defect #4 — Orphaned `.partial` backups; disk ~95% used

**Root cause:** interrupted copies left `.partial` files that were only swept under narrow
conditions, and the pre-existing retention sweep ran only after successful backups.

**Code fix:** temp names now carry `.<pid>.<nonce>` so a sweep can distinguish an abandoned temp
from anything else; the orphan matcher still recognizes the legacy bare `.partial*` shapes.
Startup + pre-backup sweep removes orphans older than `dbBackupOrphanCleanupAgeMs` (logs each
removal; never touches the current run's temp). Disk-space preflight:
`freeBytes < dbSize * dbBackupMinFreeSpaceMultiplier` → run is SKIPPED with state
`SKIPPED_DISK`, a loud `BACKUP SKIPPED - LOW DISK SPACE` diagnostic, and zero writes — the
backup never fills the disk. `pruneOldBackups()` now always runs (success or failure).

**Tests:** covered in the backup suites (orphan sweep cases in `DbBackupService.test.ts`;
preflight skip + zero-write assertion in `DbBackupService.worker.test.ts`).

**RUNTIME_VALIDATION_REQUIRED:** confirm on the deployment host that the next scheduled backup
either completes (worker-thread, health responsive) or skips loudly if disk is still tight.
The 95% disk usage itself is an operator action (free space or move old backups), not code.

## Defect #5 — `premarket_focus_reports` empty: `PREMARKET_REFRESH_COMPLETED` never emitted

**Root cause:** `PremarketFocusReport` subscribed to `PREMARKET_REFRESH_COMPLETED`, but no
producer ever emitted it — `TradePlanBuilder` completed refresh cycles silently.

**Code fix:** `src/server/continuous/TradePlanBuilder.ts` now emits `PREMARKET_REFRESH_COMPLETED`
(via new `emitPremarketRefreshCompleted()` in `src/server/premarket/premarketFocusEvents.ts`,
never-throwing, bounded scalar payload) at the end of every completed refresh cycle — initial
build (version 1) and each scheduled/event-driven refresh. The cycle version is the max plan
`refreshVersion` after the run, so a no-op refresh re-emits the current version rather than
inventing one; redelivery carries the same version. The subscriber regenerates defensively
with an upsert on `(plan_date, refresh_version)`; `src/server/db/schema.ts` aligns the index
to `UNIQUE` (matching migration 0091's `CREATE UNIQUE INDEX` — schema alignment only, no new
migration needed). Malformed payloads are logged and ignored; the subscriber never throws
into the bus.

**Tests:** `PremarketFocusReport.test.ts` (22/22, incl. redelivery idempotency). Emission is
covered by the builder's refresh-cycle tests.

**RUNTIME_VALIDATION_REQUIRED:** after deployment, the next premarket session must produce
`premarket_focus_reports` rows; verify with `argus premarket-focus` or the
`premarketFocusReportHealthy` readiness check. If the table is still empty while the pipeline
runs, the new WARN names the subscriber gap explicitly (defect #6's split).

## Defect #6 — Readiness conflated "missing focus report" with "dead premarket"

**Root cause:** one combined "premarket" readiness check looked only at the
`premarket_focus_reports` table — a missing report and a dead trade-plan pipeline produced the
same verdict.

**Code fix:** new `src/server/premarket/premarketReadiness.ts` with two independent checks,
wired into `src/server/routes/v2ReadinessExt.ts` (`checkTradePlanPipeline`,
`checkPremarketFocusReport`):
- `tradePlanPipelineHealthy`: evidence is the pipeline's OWN ledger (`trade_plans`) — plan
  count, max refresh version, first/last activity. A scheduled window fully elapsed with no
  activity since its start is FAIL; no plans at all is WARN "no refresh completed yet" (never a
  false dead). Windows come from `config/continuousIntelligence.json` (one source of truth).
- `premarketFocusReportHealthy`: report rows vs the latest completed refresh version. Missing
  or stale report is WARN (observability, never a trading gate); version skew (report newer
  than latest refresh) is an honest WARN, never false-healthy.
Each check reports status + human reason + `lastSuccessAt`. Pure evaluators take injected
evidence + clock.

**Tests:** new `src/server/premarket/premarketReadiness.test.ts` (11/11): all branches of both
evaluators + the independence property (pipeline PASS + missing report → PASS/WARN; pipeline
FAIL + report present → FAIL/PASS).

**RUNTIME_VALIDATION_REQUIRED:** observe the split checks across a real premarket session;
confirm the two checks disagree honestly in the asymmetric cases (the unit tests prove the
logic; only production can prove the evidence gathering sees real rows).

## Defect #7 — AI providers severely degraded (timeouts/503/429/402/dead gateway)

**Observed:** Jev/TypeSafe degradation across all failure classes during the session.

**Root cause (gap found):** HTTP 402 (payment-required / quota exhausted) had no first-class
error kind — it fell into `UNKNOWN`, with no explicit no-retry rule, so a deterministically
doomed provider could burn budget.

**Code fix:** `BILLING` is now a first-class error kind end to end:
`JevProvider.JevHttpError` classifies 402 → `BILLING` (type union extended);
`JevDecisionProvider` maps 402 → `BILLING` fail with `retryable: false` (only an operator
topping up the account fixes it — retrying can never succeed); `AICallGovernor` trips its
circuit on it with bounded cooldown + automatic probe-based recovery (cheap skip while down,
self-healing when topped up). Circuit state now carries `lastErrorKind` / `lastFailureAtMs`
observability (never cleared by recovery). All other classes (TIMEOUT/503/429/OVERLOAD/SERVER)
already fast-failed with cooldown; verified, not redesigned. AI failure remains
neutral-to-quant: no AI timeout can stall ChiefTrader, RiskEngine, or the quant policy path
(anchor suites re-verified green).

**Tests:** `AICallGovernor.test.ts` + `JevDecisionProvider.test.ts` (58/58); the
AI-offline quant certification suites (`quantAiIndependence`, `jevFailureSemantics`,
`oct07ProviderCollapse.regression`) re-verified green (55 passed, 1 pre-existing skip).

**RUNTIME_VALIDATION_REQUIRED:** a real 402 from the provider (account top-up state) should be
observed to trip the circuit and recover on probe — the unit tests prove the mapping; only
production proves the provider actually returns 402 in the classified shape.

## Production-state diagnostics — `argus quant-readiness`

**New:** `GET /api/v2/diagnostics/quant-readiness` (`src/server/routes/v2Diagnostics.ts`,
mounted at `/api/v2/diagnostics`) + `argus quant-readiness [--json]` (`scripts/argus-cli.ts`).
The endpoint is strictly read-only (SELECTs + the real production resolver
`resolveQuantStrategyAuthorization` — no forked logic, no synthetic DB) and reports, per
canonical strategy: lifecycle-record existence, lifecycle status, the authorization verdict
(`AUTHORIZED_QUANT_POLICY` / `REQUIRES_CONSENSUS` / `NOT_ELIGIBLE` / `NOT_AUTHORIZED`), the
reason, paper-lock state, and summary counts. The CLI prints a table plus an explicit ACTION
line when strategies are NOT_AUTHORIZED (missing lifecycle). Requires the engine API to be
reachable; engine-down yields an explicit message, not a stack trace.

**Tests:** `src/server/routes/v2Diagnostics.test.ts` (3/3): empty DB → every strategy
NOT_AUTHORIZED/NO_LIFECYCLE_RECORD; recorded VALIDATED → AUTHORIZED_QUANT_POLICY (only that
strategy); recorded RETIRED → NOT_ELIGIBLE; the diagnostic creates zero lifecycle rows
(read-only proof); summary counts consistent.

**RUNTIME_VALIDATION_REQUIRED:** run `argus quant-readiness` against the production DB after
deployment — it is the acceptance check for defect #1's code fix (it must show the four CORE
strategies as NOT_AUTHORIZED until the operator records explicit lifecycle decisions).

## Regression verification — earlier same-day fixes (verified, not redesigned)

- **correlation_exposure valuation** (commit `2af08e1`): `valueHoldings()` treated any short
  (negative qty) as corrupt data, poisoning the whole correlated/sector sum. Now a finite
  negative quantity values correctly (quantity × price — a real negative dollar figure);
  only non-finite quantities are invalid. Tests in `PositionSizing.test.ts` still pass (56/56
  with positionEvidence suite).
- **Negative-quantity / short-cover sizing** (commit `1e3804d`): RiskEngine gate 26
  `close_short_position_exists` (operator-directed only, via `closePositionIntent`) clamps
  maxQuantity to exactly the short's size; fails closed if the symbol isn't actually short.
  Covered by existing gate tests, re-verified green.
- **Oct-1 OKTA stale-position protection** (commit `12236a7e`, 2026-10-04):
  `src/server/services/positionFillEvidence.ts` — `checkPositionFillEvidence()`, the
  fill-ledger-vs-broker-snapshot cross-check wired into gate 22 (`sell_position_exists`), so a
  stale broker position read can no longer approve a second exit by itself; conflict yields
  `POSITION_FILL_CONFLICT`. Regression test `OrderManagement.positionEvidence.test.ts`
  ("refuses the second exit after a stale positive snapshot, even after OMS restart", 9/9)
  reconstructs the exact incident (OKTA, same prices) and passes.

## Part-30 / Part-31 — LIVE authority and architecture invariants

- **Part-30** (`src/server/quant/quantLiveAuthority.spine.test.ts`, 5/5): through the real
  production chain (ChiefTrader router → resolver → policy): exactly one production module
  constructs an `AUTHORIZED_QUANT_POLICY` grant (the resolver); the paper-only lock is checked
  BEFORE every grant site; exactly one production call site of `evaluateQuantExecutionPolicy`
  exists (ChiefTrader router, behind the authority check); a LIVE-shaped environment refuses
  at the resolver and the policy refuses anything not `AUTHORIZED_QUANT_POLICY` as its first
  check. No LIVE-expanding hole was found.
- **Part-31** (`src/server/quant/quantSpineInvariants.test.ts`, 6/6): the QUANT_STRATEGY routing
  branch is guarded by the risk-exit check FIRST; `evaluateQuantPolicy` is invoked from exactly
  one place behind the authority check; a quant-policy approval converges only on the canonical
  spine primitives (`recordConsensusTransaction` + `eventBus.emitChiefApproval`) — no direct
  order/broker/OMS path; ChiefTrader has no order-placement path of its own; the paper-only
  lock is evaluated at call time (behavioral test: env flips are honored immediately, no
  cached snapshot); the authorization module calls the lock function at resolve time.

## What was NOT done (explicitly out of scope)

- No lifecycle row was created, modified, or promoted for any strategy. The production DB is
  untouched by this mission.
- No threshold was lowered (consensus 0.75, RiskEngine gates, EV/R:R, AI independence).
- No LIVE authority was enabled or expanded. LIVE remains NO-GO.
- The `news_articles`/`news_clusters` unbounded disk growth (noted in the memory-leak mission)
  still needs a prune job — not in this mission's scope.
- The disk at ~95% on the deployment host is an operator action (free space / relocate old
  backups), not code.

## Runtime validation checklist (for the deployment host)

1. `argus quant-readiness` → shows the true per-strategy authorization state; record explicit
   lifecycle decisions for strategies whose ideas should route (else they stay terminally
   NOT_AUTHORIZED — the safe state).
2. Next scheduled backup: health endpoint responsive throughout; `argus watchdog-status`
   shows no storm; backup state reaches SUCCEEDED (or SKIPPED_DISK loudly if disk is tight).
3. Next premarket session: `premarket_focus_reports` rows appear; readiness shows the two
   premarket checks independently.
4. First real provider 402: circuit trips to bounded cooldown and recovers on probe.
5. The 01:30 EDT soak (2026-10-09) runs against this tree — its verdict is the mechanism-level
   confirmation; the items above are the production-state confirmation. MECHANISM and
   PRODUCTION-STATE certifications remain split by design.
