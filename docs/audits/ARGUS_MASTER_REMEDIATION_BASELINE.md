# ARGUS — Master Remediation Baseline (2026-09-14)

Baseline record for the "Autonomous Institutional Hardening & Alpha Development Master Prompt"
(31-phase mandate, received 2026-09-14, same day as the P1 memory incident and Phase B research
pass). Per that mandate's own Phase 0 instruction and its own rule #8 ("do not claim a problem is
fixed without evidence"), this document states plainly what was actually completed in this pass,
what was explicitly and deliberately not attempted, and why.

## Scope decision, stated up front

**This pass did not attempt all 31 phases, and should not be read as having done so.** The mandate
itself contains rules that structurally prevent single-session completion of most of its own later
phases: rule #8 requires evidence before claiming a fix, rule #9 forbids data-mining/requires
pre-registration and OOS validation before promotion, and Phase 19 (paper validation) explicitly
requires "a meaningful paper sample" — none of which a code-writing session can manufacture without
either fabricating evidence (forbidden by rule #2) or waiting on real elapsed calendar time. Phases
covering portfolio construction, capital allocation, canonical data-architecture consolidation,
feature-authority migration, forecast-correlation engines, and large-scale alpha research breadth
are each independently substantial (multi-day-to-multi-week) engineering efforts that deserve their
own dedicated design pass, review, and testing cycle — not compressed into a single session's worth
of unreviewed scaffolding. Producing surface-level stubs for those phases would satisfy the letter
of "work through all phases" while violating the mandate's own explicit acceptance criteria
("Do not declare Argus 'fixed' merely because... more strategies emit... backtest returns
improved... raw sample size increased").

**What this pass did complete**: four scoped, safety-adjacent engineering items — chosen because
they map directly onto the mandate's own stated priority order (items 1–2 of "PRIORITY ORDER":
memory reliability, trading/research process isolation) plus two research-validation items the
mandate names explicitly (Phase 10 raw-vs-normalized scoring comparison, Phase 11 controlled
re-review). Each below has real code, real tests, and real passing evidence — not a placeholder.

## Baseline state at the start of this pass

| Item | Value |
|---|---|
| Test suite | 493 files / 3,635 tests, green, `tsc --noEmit` clean |
| Trading state | `PAPER · TRADING_ENABLED · LIVE_NO_GO`, pid 27000 |
| Positions / orders | 0 / 0 |
| Memory | Healthy post-restart (~1.1GB RSS at last check, below the 2,048MB WARNING threshold) |
| P1 memory-leak incident | Root cause **UNKNOWN**; heap-snapshot capture instrumentation deployed and verified (baseline snapshot captured successfully, 11.8s real duration) same day |
| Phase B research finding | **NO VALIDATED CONDITIONAL ALPHA DISCOVERED** — 0/38 statistically eligible agent-confidence-bucket pairs; three promising candidates (QuantEngine BUY 0.7–0.8, QuantEngine SELL 0.6–0.7, TechnicalAgent SELL-vs-BUY asymmetry) all evaporated under effective-N correction |

## Work completed this pass

### 1. Restart-safety hardening (mandate item #26 / Phase 2-adjacent)

**Gap found**: an unclean prior shutdown already held new BUY-side idea generation
(`sessionRecovery.ts`'s `holdNewEntryIdeas`, pre-existing) but the persisted `tradingState` itself
was restored as-is on boot (`TradingEngine.ts:351`) — a persisted `TRADING_ENABLED` survived an
unclean restart with no additional check.

**Fix**: `sessionRecovery.ts`'s new `evaluateRestartSafety()` (pure decision function, unit-tested
in isolation) — when the prior shutdown was unclean AND the persisted state is `TRADING_ENABLED`,
`ArgusCoreBoot.ts` now force-transitions to `TRADING_PAUSED` via the existing `setTradingState()`
mechanism (recorded as a real, auditable `kill_switch_events` row, actor `RestartSafetyGuard`) —
never a new/second kill switch. Never touches `TRADING_PAUSED` or `EMERGENCY_STOP` states (nothing
to downgrade there); a clean restart's persisted `TRADING_ENABLED` is restored exactly as before,
unchanged.

**Evidence**: `sessionRecovery.test.ts` (+5 unit tests on the pure decision function),
`ArgusCoreBoot.restartSafety.test.ts` (new file, 1 real end-to-end integration test — seeds a dirty
session marker + a persisted `TRADING_ENABLED` settings row, runs the real `bootArgusCore()`, and
asserts the real post-boot `tradingEngine.state.tradingState === 'TRADING_PAUSED'` plus a real
`kill_switch_events` row). All green.

### 2. Trading/research-plane isolation guard (mandate item #25 / Phase 2)

**Gap found**: the heaviest read-only observability endpoints (`agent-edge`, `strategy-fairness`,
`strategy-scorecard` — each a real, non-trivial scan over potentially tens of thousands of rows)
had no protection against running concurrently with each other or while the trading process's own
memory was already elevated. A heavy diagnostic HTTP call is the leading suspected trigger for this
same day's separate P1 crash incident (unproven mechanism, but real enough to require a structural
guard).

**Fix**: `src/server/observability/heavyReportGuard.ts` — `guardHeavyReport()` wraps all three
endpoints with two real protections: (1) serialized execution (only one heavy report may run at a
time; a second concurrent attempt is refused immediately with HTTP 429, never queued); (2) a memory
circuit breaker reusing the existing `memoryTelemetryWarningRssMb` threshold (no new duplicate
number) — refuses to even start while RSS is already at/above WARNING, the exact precondition
present during the incident. Honestly documented limitation: a configured timeout
(`heavyReportTimeoutMs`) bounds how long the HTTP *caller* waits, not the underlying synchronous
`better-sqlite3` work itself (Node cannot forcibly cancel that) — the mutex is held until the real
work actually settles, not until the timeout fires, proven by a dedicated test.

**Evidence**: `heavyReportGuard.test.ts` (new file, 7 tests: pass-through, concurrent refusal,
memory-elevated refusal, mutex-survives-exception, and the honest timeout-vs-real-completion
behavior). All green. Wired into `observabilityRoutes.ts`'s three heaviest endpoints.

### 3. Strategy lifecycle re-certification review (mandate item #9 / Phase 11)

**Gap found**: `StrategyEmissionEligibility.ts`'s `RETIRED`/`DEGRADED` states correctly remove a
strategy from real selection on real evidence, and `reinstateStrategyForEmission()` exists to
reverse that — but nothing ever calls it, and nothing re-checks whether the retirement evidence
still holds. Concretely demonstrated same-day: `PULLBACK_CONTINUATION` was retired 2026-08-31 at
effective N≈22 / win rate≈22.7% / Wilson lower≈0.101; by 2026-09-14 its real accumulated evidence
had moved to effective N≈50 / win rate≈50.0% / Wilson lower≈0.366, with nothing having looked at it
since.

**Fix**: `src/server/quant/strategies/StrategyRecertification.ts` — `buildRecertificationReview()`
finds every currently-quarantined (RETIRED/DEGRADED) strategy id, and for each, compares its
original retirement evidence against fresh evidence computed via the existing, already-tested
`agentEdgeAnalytics.ts` (effective-N/Wilson-lower-bound via `effectiveSampleSize.ts` — no new,
parallel statistics implementation). Flags `evidenceHasShifted: true` only when fresh effective N
has grown materially (≥1.5×) AND the Wilson lower bound has crossed the 0.5 line — a narrow,
conservative "look here first" signal. **Per the mandate's own explicit instruction ("Never
automatically re-enable a retired strategy merely because its quarantine period expired") and this
codebase's standing "research produces hypotheses, never automatic production changes" rule: this
module never calls `reinstateStrategyForEmission()` or changes any strategy's status** — review
only, verified by a dedicated regression test that a flagged strategy remains exactly as quarantined
after the review runs.

**Evidence**: `StrategyRecertification.test.ts` (new file, 6 tests, real isolated-DB seed data
including real `agent_predictions`/`prediction_outcomes` rows). All green. Wired as
`GET /api/v2/observability/strategy-recertification` (guarded by the heavy-report mutex above) and
`argus-cli strategy-recertification`.

### 4. Raw-vs-normalized strategy score comparison (mandate item #7 / Phase 10)

**Gap found**: `quantThresholds.strategyScoreNormalizationEnabled` exists and is tested
(`StrategyScoreNormalizer.ts`, z-score against each strategy's own historical setupScore
distribution) but reviewed OFF because, per that module's own comment, "the mechanism is
implemented and tested, not yet observed live." The mandate's Phase 10 explicitly asks for a real
historical comparison before ever considering enabling it.

**Fix**: `src/server/research/strategyScoreNormalizationComparison.ts` — for a bounded window of
real `quant_assessments.strategyEvaluations` rows (capped at 5,000, no unscoped scan), computes
BOTH the raw winner (the array's own persisted order — `evaluateAll()` sorts raw-descending) and
the normalized winner (`computeNormalizedRank()`, the exact same pure function production would
use), then compares each candidate's real aggregate Wilson-lower-bound evidence (via the same
`agentEdgeAnalytics.ts` reused above) wherever the two winners diverge. **Explicitly documented,
stated-in-the-report-output limitation**: this is not a walk-forward/OOS test — both the historical
score distribution and the real-evidence comparison are computed over the same overall window, not
point-in-time-recomputed per cycle. The report says so in its own output, and **never flips
`strategyScoreNormalizationEnabled` itself** — a read-only research signal only, per the mandate's
own instruction not to enable normalized scoring merely because it changes trade count.

**Evidence**: `strategyScoreNormalizationComparison.test.ts` (new file, 5 tests, including a real
divergence-detection case and a real never-fabricate-evidence case). All green. Wired as
`GET /api/v2/observability/strategy-score-normalization-comparison` (heavy-report-guarded) and
`argus-cli strategy-score-normalization-comparison`.

## Config/doc changes

- `config/observability.json` / `src/server/config/observability.ts`: 9 new fields across the four
  items above (heap-snapshot thresholds from the same-day memory-incident fix, plus
  `heavyReportTimeoutMs`), each with a rationale comment, none hardcoded in TypeScript.
- `docs/architecture/ARGUS_ARCHITECTURE.md`: heap-snapshot section added same day (prior work);
  this baseline document is the Phase 0 record the mandate itself requests.

## What was explicitly NOT attempted this pass, and why

Per the "Scope decision" above — every phase from the mandate's list beyond the four items covered:
canonical data architecture consolidation (Phase 3), historical/corporate-action integrity work
(Phase 4), feature authority/versioning migration (Phase 5), data-quality semantic unification
(Phase 6), full signal-eventization redesign (Phase 7 — related to, but far larger than, the
narrow re-certification fix above), the alpha research factory (Phase 8), forecast validation and
correlation/diversity engines (Phases 12–13), portfolio construction and capital allocation
(Phases 14–15), risk-model expansion (Phase 16), execution-ambiguity audit completion (Phase 17),
execution-quality expansion (Phase 18), paper validation (Phase 19 — blocked on calendar time, not
code), attribution (Phase 20), postmarket/premarket automation (Phases 21–22), AI hardening beyond
what already exists (Phase 23), data/microstructure/distributed-compute expansion (Phases 24–26),
the unified observability view (Phase 27), a formal security audit (Phase 28), and the certification
model (Phase 31). Each remains a real, worthwhile, separately-scoped follow-on — not declared done,
not stubbed, not claimed as evidence-backed when it isn't.

## Post-deployment incident (P1-B): the heap-snapshot capture deployed same day caused a real freeze

Not one of the four items above, but discovered during this pass's own deployment and requiring
immediate correction, recorded here for the same evidence discipline this document applies to
everything else. **Tracked as a separate incident (P1-B) from the still-unresolved P1-A
memory-growth root cause** — the diagnostic built to investigate P1-A became a second, confirmed
reliability hazard in its own right; the two must not be conflated, and P1-A's root cause remains
exactly as unknown as before this incident.

**Confirmed, not suspected**: the heap-snapshot capture mechanism (deployed earlier the same day, in
response to P1-A) fired its first live WARNING-level capture at 2026-09-14T20:17:52Z (pid 27000).
The engine's event loop then went unresponsive for ~6 minutes; the external watchdog declared
`FROZEN_CONFIRMED` and force-killed the process at 20:24:10Z. The process being killed by the
external watchdog is a directly observed fact, not an inference.

**Likely mechanism** (well-supported by the timing, the 2.04GB completed output file, and the
missing completion log — but not proven to the precision of an exact duration-vs-size formula):
serializing ~2.04GB of heap data via `v8.writeHeapSnapshot()` (a real, synchronous, unavoidably-
blocking V8 call) is consistent with a multi-minute block, consistent with the observed freeze
window. "The snapshot capture caused the freeze" is a reasonable read of the timing; "2.04GB takes
exactly N minutes" is not established evidence, and this record does not claim it.

**The two low-memory baseline measurements (8.8s, 11.8s at ~600MB) do not license "baseline capture
is safe" as a general claim.** They show baseline capture was safe under that specific, low, tested
condition on two occasions — not that it is intrinsically or generally event-loop-safe at arbitrary
heap sizes. Two data points at one low memory level do not extrapolate to a multi-GB heap. Recorded
here as: *baseline capture is retained only under the currently-tested low-memory startup
condition; it is not considered generally event-loop-safe at arbitrary heap sizes.*

**One genuinely positive result inside this incident, tracked as a separate success from the
diagnostic failure above**: the restart-safety fix from item #1 fired for real, for the first time,
exactly as designed — `kill_switch_events`: `2026-09-14T20:25:02Z TRADING_ENABLED -> TRADING_PAUSED,
actor=RestartSafetyGuard`. Zero positions, zero orders throughout — no trading-capital exposure
occurred at any point in this incident.

**Immediate corrective action taken**: `heapSnapshotEnabled` flipped to `false`
(`config/observability.json`) — the WARNING/CRITICAL-triggered elevated-level capture disabled
entirely, pending redesign and separate validation. Baseline-only capture remains enabled as a
narrowly-scoped exception under the specific condition actually tested, not a general safety claim.
Test suite updated (`heapSnapshotCapture.test.ts` now forces the flag true via spy to keep
exercising the mechanism itself even while disabled by default) and re-verified green. Per the
"don't restart repeatedly merely to investigate" discipline: the dangerous trigger was disabled in
the boot-loaded config first, then the live engine was restarted exactly once to deploy that fix and
verify the new process cannot execute a WARNING/CRITICAL capture — not restarted again to probe
further. Trading remains paused; the restart-safety pause was not overridden to see whether Argus
would trade again — reliability takes priority over resuming alpha experimentation here. Both real
snapshot files (`data/heap-snapshots/`, gitignored) preserved as genuine forensic evidence for a
future offline analysis (e.g. Chrome DevTools' heap-snapshot comparison) — disk usage from these
should be monitored, not left unbounded.

**The eventual redesign is not "make the same call async."** `v8.writeHeapSnapshot()` blocks the
calling thread's own event loop regardless of how the call is scheduled — wrapping it in a
`Promise`, `setImmediate`, or a same-process worker-style wrapper does not change what the call
itself does. A `worker_thread` has its own separate V8 heap; it cannot snapshot the *main* thread's
heap merely by being asked from within the same process. The general engineering rule this incident
establishes: **a trading-critical process must not run any operation that synchronously blocks its
event loop for an unbounded or poorly-characterized duration; expensive diagnostics (heap analysis,
large snapshots, historical scans, strategy-fairness-style jobs) belong in a genuinely separate
research/forensic process, not inside the trading process itself.**

---

# ARGUS — Overnight Safety-First Remediation (2026-09-14, second pass, market closed)

Second mandate, received the same evening as the P1-B incident above, explicitly scoped to
reliability/safety (not alpha), with a required evidence vocabulary: **FIXED / MITIGATED /
INVESTIGATED / UNRESOLVED / BLOCKED / NOT ATTEMPTED**. Same scope discipline as the first pass:
real work on the highest-priority, most tractable items; everything else honestly labeled, not
faked. Per that mandate's own instruction, beginning with P1-B prevention and P1-A investigation.

## Evidence matrix

| Issue | Status | Evidence | Tests | Remaining risk |
|---|---|---|---|---|
| P1-B: dangerous heap capture cannot execute | **FIXED** | `heapSnapshotEnabled=false` verified as the only gate (single call site); no env var can re-enable it (only disable further); config JSON validated | New regression test (`heapSnapshotSafety.regression.test.ts`, 3 tests) reads the real on-disk config and fails if ever flipped back | None identified; re-enabling still requires a real code/design change, not just a config edit |
| Sync event-loop blocker inventory | **INVESTIGATED**, one **FIXED** | 27 files with sync fs calls inventoried; `DbBackupService.ts` found doing a synchronous ~4.08GB `copyFileSync` on **every boot** (not just daily) — same risk class as P1-B, was firing throughout this entire session | Converted to real async (`fs.promises`); existing `DbBackupService.test.ts` (2 tests) updated and passing | `sqliteDb.pragma('wal_checkpoint(TRUNCATE)')` in the same file remains genuinely synchronous (better-sqlite3 has no async API) — smaller, harder-to-eliminate residual risk, not fixed tonight. Remaining 25 files not individually re-audited beyond the earlier session's spot-checks (ChiefTraderAgent/AIRouter/QuantCoreBridge/MarketDataWorker, all bounded) |
| Watchdog/restart end-to-end test | **FIXED** | All 8 mandate checkpoints now asserted in one real end-to-end test: PAPER mode, unclean termination, restart, `TRADING_PAUSED`, `LIVE_NO_GO`, reconciliation-gated entry hold (pre-existing, separately tested), no bypass, explicit reactivation still required | `ArgusCoreBoot.restartSafety.test.ts` (1 real boot-level integration test, extended this pass with the `LIVE_NO_GO` assertion) | None identified |
| P1-A root-cause investigation | **INVESTIGATED**, root cause **UNRESOLVED** | Real, safe, bounded (O(1)-memory, verified under a 512MB hard cap) streaming analysis of the actual 2.04GB incident snapshot: 30,377,433 nodes / 92,056,473 edges. `string` nodes dominate (18,271,808 — 59.5% of self_size). Content sample shows the dominant recurring shape is `trace_<SYMBOL>_<epochMs>_<hash>` (exactly `generateTraceId()`'s format) interleaved with ISO timestamps, UUIDs, and full agent-reasoning text. `EventStore.ts` (the leading hypothesis, per its "capped in-memory ring" description) was checked and **ruled out by evidence** — its real configured caps (`eventStoreMaxRecentEvents: 200`, `eventStoreMaxTraces: 500`) are small and correctly enforced, far too small to explain 18M+ retained strings | New permanent offline tooling (`scripts/forensic/`, 2 scripts + README), not a throwaway | **The actual retaining owner is not identified.** This requires either a full retainer/dominator-path analysis (needs the 92M-edge array cross-referenced against nodes — a substantially larger undertaking than was safely completable tonight on a 16GB host with ~5GB free RAM alongside the live engine) or a controlled, live reproduction harness (mandate section 7) targeting the trace/decision-lifecycle path specifically. Recommended next step below |
| Memory guard hardening | **INVESTIGATED** | Re-read `applyMemoryCriticalFailSafe()`: idempotent (no-op if already non-`TRADING_ENABLED`, preventing duplicate-transition log spam), fail-open on its own failure (logged, never thrown), never runs expensive diagnostics itself (heap capture is a separate, now-disabled path, never gated behind or triggered by the guard's own pass/fail). No GC-forcing or measurement manipulation found | Pre-existing tests unchanged | Not independently re-tested under sustained live growth this pass (would require the same live-engine-risk tradeoff as full heap-snapshot analysis) |
| Research/trading-plane isolation | **FIXED** (first pass), re-verified | `heavyReportGuard.ts` (built first pass) — mutex + memory-circuit-breaker — still wraps the 3 heaviest observability endpoints; confirmed no new heavy endpoint was added this pass without the guard | 7 tests (first pass), re-run green this pass | Isolation is HTTP-route-level, not OS-process-level — a genuinely separate research process (mandate's own stated ideal) remains **NOT ATTEMPTED** |
| Bounded resource audit | **INVESTIGATED** (partial, carried over from first pass) | ChiefTraderAgent's per-symbol Maps, AIRouter's provider Maps, QuantCoreBridge's capped price/volume history, MarketDataWorker's per-symbol Maps — all confirmed bounded. `EventStore.ts` re-confirmed bounded this pass (200/500 caps, correctly enforced) | No new tests this pass (relied on existing coverage + this pass's read-only verification) | Full sweep of every Map/Set/array/queue/listener/timer in the codebase (mandate's own list) **NOT ATTEMPTED** — infeasible to complete exhaustively in one session; the highest-probability candidates given tonight's own heap evidence (trace/decision-lifecycle-adjacent structures) were prioritized instead |
| Event-loop latency monitoring | **INVESTIGATED** | `processTelemetry.ts` already uses `monitorEventLoopDelay({ resolution: 20 })` and records `histogram.mean` per sample (bounded 120-sample ring, `processTelemetryRingSize`) | Pre-existing | Only mean is captured, not p50/p95/p99/max as the mandate requests — a real, narrow, low-risk enhancement **NOT ATTEMPTED** tonight (would need `histogram.percentile(N)` calls added to the existing sampler; small, low-risk, deferred to keep this pass's changes reviewable) |
| Order/broker safety, capital/portfolio safety, data integrity, feature authority, eventization, forecast engine, calibration, strategy lifecycle, momentum/mean-reversion, score normalization, diversity | **NOT RE-ATTEMPTED this pass** | All were substantively audited/addressed in the same-day earlier session (DEF-30 broker crash recovery; FD-4–FD-9 order/fill/reconciliation fixes; Phase A momentum/mean-reversion classification; Phase B effective-N/diversity findings; `StrategyRecertification.ts`/`strategyScoreNormalizationComparison.ts` built first pass) | See earlier sections of this document and `docs/audits/ARGUS_PHASE_B_CONDITIONAL_ALPHA_DISCOVERY_2026-09-14.md` | Re-litigating already-tested, already-stable code on a safety-priority night was deliberately avoided — see "what was NOT changed" below |
| Alpha research factory, portfolio construction, execution redesign, paper validation, postmarket/premarket automation, data expansion, microstructure, distributed compute | **NOT ATTEMPTED** | — | — | Each requires either calendar time (paper validation), a measured bottleneck that doesn't yet exist (distributed compute), or substantial multi-day design work (portfolio construction) — correctly out of scope for one overnight pass, per both mandates' own rules |
| Static safety scan (section 31 list) | **INVESTIGATED**, partial | Confirmed via this pass's own targeted greps: single `setTradingState` writer (architecture-protection test, pre-existing, still green), single `writeHeapSnapshot` call site (this pass), `DbBackupService`'s sync copy found and fixed | — | Full exhaustive scan against every item on the mandate's section-31 list (duplicate listeners, retry storms, missing timeouts, etc.) **NOT ATTEMPTED** as a complete sweep |

## What was deliberately NOT changed tonight

Per both mandates' own absolute safety rules: no threshold, consensus requirement, calibration
formula, or RiskEngine gate was touched. No strategy was forced to emit. No confidence value was
manufactured. `tradingState` remains `TRADING_PAUSED` — not overridden to test whether Argus would
trade again; reliability took priority over resuming alpha experimentation, exactly as instructed.

## Recommended next step for P1-A (not started tonight, for the record)

The retaining owner behind the 18.27M string nodes remains unidentified. Two viable paths, neither
attempted tonight for the resource/safety reasons stated above:
1. **Offline retainer-path analysis** — load the preserved 2.04GB snapshot into Chrome DevTools'
   Memory panel on a machine with enough free RAM that doing so cannot compete with anything else
   running (i.e. not this host, not while the live engine is up).
2. **Live reproduction harness** (mandate section 7) — instrument the trace/decision-lifecycle path
   specifically (the strongest lead from tonight's content sample) with cheap, bounded counters
   (e.g. periodic `WeakRef`/`FinalizationRegistry`-based liveness sampling of recently-minted
   traceIds) in a genuinely isolated test run, never the live trading process.

## Current state after this pass

`PAPER · TRADING_PAUSED · LIVE_NO_GO` (paused by the restart-safety fix's own correct behavior
after the forced-kill incident above — not manually changed, and not re-resumed by this pass; that
remains an explicit operator decision). Full test suite re-run after all changes including the
hotfix: 497 files / 3,659 tests green, `tsc --noEmit` clean. No thresholds lowered, no evidence
fabricated, no strategy manufactured a trade.

---

# ARGUS — P1-A root cause identified and fixed (2026-09-14, third pass, same night)

## Root cause

**P1-A root cause:** unbounded concurrent outcome-evaluator execution against growing
production-scale tables causes sustained native/RSS memory growth. `PredictionOutcomeEvaluator.ts`
and `MultiHorizonOutcomeEvaluator.ts` (and, to a lesser degree, `ConsensusDebateOutcomeEvaluator.ts`
and `MissedOpportunityEvaluator.ts`) each ran on a bare `setInterval(() => asyncFn(), 300000)` with
no guard against overlapping invocations, and the first two additionally did an unbounded
`db.select().from(table).all()` every cycle against `agent_predictions` (108,563 live rows at
measurement time), `prediction_outcomes` (81,741), `kronos_predictions` (15,339), and
`news_predictions`.

**Native allocation mechanism within that workload: not definitively attributed to better-sqlite3.**
Retainer-path evidence and the pattern (heap fully GC-recoverable, RSS not) strongly suggested
better-sqlite3's native layer, but this was never proven by isolating it from the overlap condition
— and it didn't need to be: Patch A (below) alone eliminated the entire reproduced effect, so the
question was not pursued further.

## Evidence chain (three independent lines converging on the same subsystem)

1. **Heap evidence**: cross-referencing the preserved 2.04GB P1-B incident snapshot's `nodes` array
   against its `strings` table found 18,271,808 live `string`-type nodes resolving to only 649,013
   *distinct* string values — a ~28x average duplication ratio (719x for the single most-duplicated
   short value). `reasoningOrDebateText`/`uuid`/`tickerSymbolLike`(+short enum values)/`isoTimestamp`
   together account for ~62% of the 861MB string self_size.
2. **Retainer evidence**: a bounded, 3-pass streaming cross-reference of the incident snapshot's
   92,056,473-edge array (never loaded into a graph tool — the file is too large for this host's
   free RAM to do that safely) traced the most-duplicated string instances to `property edge
   "side"/"symbol"/"rawSide"/"winningSide"/"action"/"prediction"` from generic `Object` nodes
   spanning nearly the entire node-id address space, with retaining code-path context naming
   `evaluateMultiHorizonOutcomesForPrediction`, `evaluatePending`, `classifyVote`,
   `computeShadowConsensus`.
3. **Production code + live DB evidence**: following those names into source found the unbounded
   `.all()` + unguarded `setInterval` pattern described above, confirmed against the real (paused)
   engine's own database via a read-only, WAL-safe row count — never a write, never touched the
   live process.

## Isolated reproduction (never the live engine)

A dedicated harness (`scripts/forensic/reproduce_p1a_outcome_evaluators.ts`) seeded an isolated tmp
SQLite DB with production-scale synthetic rows (108,563 / 81,741 / 15,339, realistic field shapes)
and instrumented each evaluator directly — no `start()`/real timers, explicit `Promise.all()`
concurrency to deterministically simulate what an overrun `setInterval` cycle produces in
production, rather than waiting on real wall-clock timing.

**Before the fix** — `heapUsed` (V8-managed heap) was fully GC-recoverable in every condition
(~18-20MB post-GC, sequential or concurrent). **RSS was not**, and scaled with concurrency degree:

| Condition | RSS (post-GC) |
|---|---|
| End of 3x sequential cycles | ~415-421MB |
| 2 concurrent invocations | 489.6MB |
| 3 concurrent invocations | 609.1MB |
| 6 concurrent invocations (both evaluators × 3 each) | **747.3MB** |

## Fix (Patch A + Patch B, kept separate per explicit instruction)

**Patch A — evaluator overlap + unbounded queries** (`src/server/core/singleFlightInterval.ts` new;
`PredictionOutcomeEvaluator.ts`, `MultiHorizonOutcomeEvaluator.ts`, `ConsensusDebateOutcomeEvaluator.ts`,
`MissedOpportunityEvaluator.ts` modified):
- `createSingleFlightGuard()` — coalescing (never queuing) primitive intrinsic to each evaluator's
  own `evaluatePending()` method, so every caller is protected (the timer, and any future manual
  trigger), not just the specific path `start()` happens to use today.
- `PredictionOutcomeEvaluator`/`MultiHorizonOutcomeEvaluator` replaced their unbounded `.all()`
  fetches with a **bounded anti-join** (`LEFT JOIN ... WHERE outcome.id IS NULL`, `ORDER BY
  timestamp ASC LIMIT batchSize`) — deliberately not a monotonic id/timestamp watermark, since a
  watermark that had already advanced past a row could silently never retry it (the exit-aware
  walk-forward path can legitimately leave a row unevaluated for a long configured window). The
  anti-join instead uses the row's own real lifecycle state (does it have an outcome yet?) as the
  cursor, which cannot desync. Always-skipped categories (KronosEngine rows in
  `PredictionOutcomeEvaluator`, HOLD predictions in `MultiHorizonOutcomeEvaluator`, telemetry-pulse
  rows in both) are excluded in the SQL WHERE itself, not just the loop body — otherwise they would
  permanently occupy batch slots forever since neither evaluator ever writes a row for them.
  `predictionOutcomeBatchSize` / `multiHorizonOutcomeTracking.batchSize` (both 2000) plus a
  wall-clock safety bail-out (`predictionOutcomeMaxCycleWallClockMs` /
  `multiHorizonOutcomeTracking.maxCycleWallClockMs`, both 120000ms) bound per-cycle work.
- Metrics (`getMetrics()`): `totalScheduled`/`totalRun`/`totalSkippedInFlight`/`totalErrors`,
  `lastRunDurationMs`, and per-evaluator `lastCycle: {rowsFetched, rowsProcessed, rowsWritten,
  batches, bailedOnWallClock}`.
- Tests: `singleFlightInterval.test.ts` (14 tests — coalescing, metrics, stop(), error isolation,
  a guard protecting a plain class method with no timer involved at all) +
  `PredictionOutcomeEvaluator.test.ts`/`MultiHorizonOutcomeEvaluator.test.ts` gained overlap-
  coalescing, bounded-batch-size, and (for the horizon evaluator specifically) a correctness
  regression proving a row with only its largest horizon still missing is never dropped by the
  bounded anti-join.

**Patch B — `HistoricalDataGateway.memoryBars` bounded eviction** (kept separate — a real, standalone
defect found while building the Patch A validation harness, not the proven cause of the reproduced
RSS growth): the cache was `set` on every `getBars()` call but only ever `delete`d by a successful
`persistBars()` write for that exact window — a window that never gets a successful fetch (no data
for a symbol, or a window nothing re-queries) had no active eviction path beyond a lazy TTL check
that only fires if the same key is read again. Measured growing to 36,922 entries with zero
shrinkage across repeated cycles at production scale. Fixed with a real LRU bound
(`historicalBarsMemoryCacheMaxEntries`, 5000 — sized above legitimate per-cycle working-set needs,
not picked to make a graph look good). Tests prove `size <= max`, real LRU (not FIFO-by-insertion)
eviction via a `db.select` spy distinguishing a cache hit from a genuine miss.

## Post-fix validation (same harness, same production scale, re-run against the fixed code)

Extended to 20 **sequential** cycles per evaluator (not just a single concurrency burst — the
acceptance criterion is bounded RSS over sustained workload) plus the same concurrency ladder:

| Condition | RSS before | RSS after |
|---|---|---|
| Sequential cycles (20x each evaluator) | ~415-421MB (3-cycle sample) | flat 286.7MB → 289.8MB across all 20 POE cycles; flat ~289.7-290.4MB across all 20 MHOE cycles |
| 2 concurrent | 489.6MB | 289.5MB |
| 3 concurrent | 609.1MB | 289.5MB |
| 6 concurrent (both evaluators × 3 each) | 747.3MB | **289.6MB** |
| `heapUsed` post-GC | ~18-20MB | ~14.7-15.3MB |

`skippedInFlight` metrics confirm the guard fired exactly as designed (1 skip for 2 concurrent
calls, 2 skips for 3). `rowsFetched` stayed at 4000 (2000+2000, the two bounded batches) every
cycle regardless of the 108K+ row backlog, versus the full-table fetch before. `memoryBars` map
size plateaued at 4472 (well under the 5000 cap) and never grew further across the sustained run.
Patch A alone eliminated the entire reproduced concurrency-dependent RSS effect — no further
investigation into the native allocation path (SQLite vs. otherwise) was needed, per the "if Patch
A alone eliminates it, you've got an exceptionally strong causal validation" acceptance criterion.

Full suite after both patches: **499 files / 3,677 tests green**, `tsc --noEmit` clean.

## What was deliberately not done as part of this fix

- The live engine (pid unchanged, still `PAPER · TRADING_PAUSED · LIVE_NO_GO`) was never touched:
  no new production heap snapshot, no threshold change, no re-enabling trading to test the fix. All
  measurement was in isolated processes against isolated tmp databases.
- The fix has not yet been deployed to the live engine (would require a restart) — that is a
  separate, explicit operator decision, not assumed here.
- The exact native allocation mechanism (better-sqlite3 internals vs. something else) was
  deliberately left unattributed, per the instruction not to spend another investigation cycle on
  it once Patch A's isolated re-validation showed the reproduced effect was fully gone.
