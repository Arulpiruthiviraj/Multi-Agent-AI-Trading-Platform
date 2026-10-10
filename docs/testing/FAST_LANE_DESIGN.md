# Quant-Lane Fast Path for 180s High-Priority Admission — Design (DEFERRED)

**Date:** 2026-10-09 · **Status:** DEFERRED — assessed, not built (see §8 for the exact
blockers) · **Mission item:** ARGUS MISSION ITEM 3 (P2) · **Disposition:** QUANT_RESEARCH_REQUIRED

**Companion:** `src/server/testing/slow/tier4/quantFastLane180s.test.ts` — the FAILING SLA test
(`it.fails`) that pins the 180s target. It is expected-fail until this design (or an
equivalent) is implemented and proven; if it ever passes, vitest reports it as a failure,
which is the tripwire to convert it to a normal test.

---

## 1. Objective and scope

Guarantee that a newly admitted HOT mover (e.g. a `MARKET_MOVER`-class symbol from the
Alpaca movers funnel or a mid-cycle universe admission) **begins quant assessment within
180 seconds of admission**, without destabilizing the normal `QuantSignalAgent` cycle.

- "Begins assessment" = `QUANT_SYMBOL_EVAL_STARTED` is emitted for the symbol (the same
  observability hook the Phase 3 certification added in `b355138`), i.e. `evaluateSymbol()`
  actually starts, not merely "is queued".
- "Without destabilizing the normal cycle" = the cycle's SLA, completeness invariant, and
  provider budget keep their current guarantees; the normal lane is never starved; late
  admission never silently preempts an in-flight evaluation.
- Out of scope (unchanged by this design): all safety thresholds (0.75 AI consensus,
  EV/R:R, RiskEngine's 27 gates, lifecycle authority), LIVE paths, strategy formulas,
  alpha. PAPER only. Fail closed everywhere.

## 2. Current architecture (what the assessment verified)

`QuantSignalAgent.runCycle()` (`src/server/services/QuantSignalAgent.ts`):

1. Reads the universe **once** at cycle top from `marketDataWorker.getActiveSymbols()`
   (snapshot fixation — a symbol admitted mid-cycle is never in the in-flight cycle).
2. Fans out with bounded concurrency `min(quantMaxConcurrentSymbols, universeSize)`
   (`quantMaxConcurrentSymbols = 1`, `quantCycleIntervalMs = 300_000`, verified in
   `config/tradingSafety.json`).
3. Per-symbol `evaluateSymbol()` is wrapped (H2) to emit `QUANT_SYMBOL_EVAL_STARTED` /
   `QUANT_SYMBOL_EVAL_FINISHED` with outcome ∈ {ASSESSED, INSUFFICIENT_BARS, RATE_LIMITED,
   ERROR} on every exit path; on-demand callers (ConfluenceCoordinator, manual CONFIRM)
   already use it with `cycleCtx = null` (honest null cycleId).
4. The whole cycle runs under `createSingleFlightGuard` — a tick that fires while a cycle
   is in-flight is **coalesced (skipped)**, never queued (P1-A remediation). Under overrun,
   cadence degrades to one completion per cycle-duration with no catch-up.
5. On a 429 that escapes `evaluateSymbol`, the fan-out aborts (`PROVIDER_BACKOFF`), the
   tail is recorded in `notAttemptedSymbols`, and `nextCycleSymbol` resumes fairness next
   cycle. The gateway's 429 backoff (`HistoricalDataGateway.rateLimitedUntilMs`) is shared
   and reactive — armed *after* a 429, not before.

The certification floor (`quantSchedulerSla.test.ts`): admission → first terminal outcome
≤ one full cycle (interval + budget). With concurrency 1, a 100-symbol universe under a
slow provider takes far longer than 180s — the documented gap this design would close.

## 3. Proposed mechanism (not built)

A new, small, default-off module — e.g. `src/server/quant/QuantHighPriorityLane.ts` —
kept strictly separate from `runCycle()` (which is not modified):

- **Admission.** `admitHighPriority(symbol, source)` where `source` ∈ {MARKET_MOVER,
  NEWS_CATALYST, MANUAL}. Dedup by symbol (re-admission refreshes TTL, never duplicates).
  Bounded queue: cap (e.g. 8, config, never a TS literal per AGENTS.md) + per-item TTL
  (e.g. 15 min). Over-cap or expired → drop with a structured
  `QUANT_FAST_LANE_DROPPED` event carrying the reason (fail closed, never silent).
- **Dispatcher.** Serial, single-flight (`createSingleFlightGuard`, same primitive the
  cycle uses), **wake-on-admission** — no new interval timer (a second timer reintroduces
  the exact overlap class P1-A remediated). On wake, pop the head and call the existing
  public `quantSignalAgent.evaluateSymbol(symbol, { emitIdeas })`. No `cycleCtx`, so the
  H2 events honestly carry null cycleId — the same shape on-demand callers already use.
- **Idea-emission decision (open — see §8).** Two options, both problematic today:
  - `emitIdeas: true` — the lane can produce a real `QuantEngine` idea ahead of the
    cycle. Hazard: the symbol is still in the next cycle's snapshot, so it will be
    evaluated twice in-window; `emitTradeIdea` has no per-symbol dedup/cooldown
    (`EventBus.emitTradeIdea` only shape-gates), so this is a trading-behavior change
    whose ChiefTrader/OMS interaction cannot be fully verified in a unit test.
  - `emitIdeas: false` (the 2026-10-08 D1 evaluation-only mode) — full assessment,
    `quant_assessments` row, DESK_NO_TRADE codes, zero idea-emission hazard. But then
    nothing consumes the assessment: the hot mover still waits for the normal cycle for
    any decision-path effect. This satisfies the letter of "begins assessment within
    180s" while delivering no decision-path acceleration — a fast log line, not a fast
    path.
  - Recommended if ever built: ship evaluation-only first (matching the fastlane
    subsystem's phased approach — research object first, spine integration as a
    separately-authorized phase), and treat idea emission as its own design with its own
    dedup/cooldown gate.

## 4. Concurrency bounds

- The lane is **serial**: at most 1 in-flight lane evaluation, ever (single-flight
  guard). It never fans out.
- Worst-case concurrent provider consumers = cycle (≤ `quantMaxConcurrentSymbols` = 1)
  + lane (1) = **2**. This is the bound the design must defend: the gateway's 429
  backoff is reactive, so the lane doubles pre-429 request pressure against the same
  Alpaca bars endpoint. The lane must consult the shared backoff state before starting
  (a read accessor on `rateLimitedUntilMs` does not exist today — `clearBarsRateLimitBackoff`
  is the only test/ops hook; adding a read is additive and safe) and defer while backed
  off, with an honest `QUANT_FAST_LANE_DEFERRED` event. Deferral under backoff is the
  one case where the 180s guarantee is explicitly voided — fail closed beats SLA.
- The lane never borrows, pauses, or reorders the cycle's worker pool: no starvation of
  the normal lane by construction (separate dispatcher, separate guard).

## 5. Completeness preservation

The completeness invariant from Phase 3 is **per cycle snapshot**: every symbol in the
snapshot resolves to exactly one terminal outcome. The lane does not touch the snapshot,
so the invariant is preserved by construction. For lane items themselves, the existing
H2 wrapper already guarantees exactly one `QUANT_SYMBOL_EVAL_FINISHED` per
`QUANT_SYMBOL_EVAL_STARTED` (finally-block, errors rethrown unchanged) — the lane gets
the same terminal-outcome accounting as on-demand callers, with null cycleId. Lane
evaluations persist `quant_assessments` rows like any other evaluation; a `lane:
'high_priority'` provenance marker on the row/event payload keeps lane vs cycle
attribution forensically clean (no silent preemption: a symbol evaluated by both lane
and cycle in one window has two independently attributable outcomes, never one outcome
masquerading as the other).

## 6. Risk analysis (why this is deferred — the five blockers)

1. **Unbounded per-item latency breaks the 180s start guarantee.** A serial lane's
   worst-case start time for the Nth queued item is Σ(latencies of items ahead of it).
   Each lane item calls `evaluateSymbol` → `HistoricalDataGateway.ensureBars` →
   `fetch()` with **no timeout / AbortSignal** (verified: `HistoricalDataGateway.ts`
   lines ~316, ~403 — plain `fetch`, no signal). A hung provider connection hangs the
   item indefinitely; every item behind it misses 180s with no code-level recourse.
   The 180s guarantee is therefore unprovable from code as it stands.
2. **The fixes for (1) are scheduler architecture changes with unverifiable risks.**
   A per-symbol deadline requires *cancellation* of an in-flight `evaluateSymbol`:
   aborting mid-`quant_assessments`-insert risks torn rows; abandoning the wait while the
   method continues risks orphaned `TRADE_IDEA_GENERATED` emissions and abandoned-but-live
   evaluations accumulating — the exact P1-A unbounded-overlap defect the single-flight
   guard was built to kill. Preempting the normal cycle mid-fan-out has the same
   cancellation hazards plus snapshot-mutation semantics (research item #3 in the cert
   header). None of this can be fully verified in tests.
3. **Provider-budget doubling is unverifiable against the real provider.** Tests can
   mock 429s, but the rate interaction of two concurrent consumers against Alpaca's real
   limits is mock-only evidence. The backoff is reactive; the lane adds pre-429
   pressure the current single-consumer design never had.
4. **The idea-emission dilemma (§3).** `emitIdeas: true` = unverifiable trading-behavior
   change (no quant-side idea dedup exists); `emitIdeas: false` = decision-path vacuous.
   There is no third option without a new dedup/cooldown gate, which is itself a
   behavior change to the idea path.
5. **Admission-source plumbing under churn is new event surface.** Wiring the movers
   funnel / scanner into `admitHighPriority` with dedup/TTL/drop semantics under rapid
   universe churn is a new producer→scheduler contract; its drop/churn behavior needs
   its own fault-injection suite.

Per the mission decision rule ("a half-verified scheduler change is worse than a
documented gap — err on deferring"), these blockers mean: do not build.

## 7. What would make it buildable

In order, each independently verifiable in tests:

1. **Bounded provider fetch latency.** Add `AbortSignal.timeout` (or equivalent) plus a
   bounded retry budget to `HistoricalDataGateway`'s bars fetch, so per-item evaluation
   latency has a code-level upper bound `L`. Then a serial lane with queue cap `C`
   gives a provable worst-case start bound of `C × L` — choose `C`, `L` so `C × L ≤ 180s`
   (e.g. `L = 30s`, `C = 6`). This is the single change that converts the guarantee
   from "expected" to "provable". It is additive (a timeout that fires degrades to the
   existing RATE_LIMITED/ERROR path — fail closed) but touches the shared gateway, so
   it needs its own fault-injection suite first.
2. **Shared provider-budget token bucket** (or an explicit "lane yields while cycle
   worker is mid-provider-call" protocol) so the 2-consumer bound in §4 is enforced
   rather than hoped for.
3. **Lane idea-dedup/cooldown gate** if `emitIdeas: true` is ever wanted — a new,
   separately-tested gate on the idea path, not an emergent property.
4. Then: implement §3, convert `quantFastLane180s.test.ts` from `it.fails` to `it`,
   and extend it with the 429-during-lane and churn-drop fault-injection cases.

## 8. Open questions (QUANT_RESEARCH_REQUIRED)

1. **Admission sources and priority classes.** Which producers may admit (movers funnel?
   `MARKET_MOVER` rescue class? manual ops?), and do classes need relative priority or
   is FIFO sufficient? (The data-rescue subsystem already learned this lesson with
   `rescueReservedSlotsForPriorityClasses` — don't repeat the undifferentiated-pool
   mistake.)
2. **Queue cap and TTL values.** Must be grounded in measured per-item latency (see §7.1),
   not picked arbitrarily — same standard the rescue-capacity change met on 2026-09-05.
3. **The emitIdeas decision** (§3) — needs an operator/research call; it determines
   whether the lane is decision-path or forensic-only.
4. **Interaction with the single-flight overrun behavior.** Under sustained cycle
   overrun the lane still runs (separate guard) — is that desired, or should the lane
   also back off when the system is degraded? Fail-closed says the lane defers on
   provider backoff (§4); cycle-overrun without provider distress is a separate policy
   question.
5. **PAPER-only forever?** The existing fastlane subsystem is PAPER/research-only and
   fails closed on LIVE (`fastLaneConfig.ts`). A quant-lane extension should inherit
   that posture explicitly, not by accident.

## 9. Verification plan (when built)

- `src/server/testing/slow/tier4/quantFastLane180s.test.ts`: convert `it.fails` → `it`;
  HOT_MOVER_X admitted mid-cycle begins assessment ≤ 180s under the 100-symbol / slow-
  provider / churn scenario; normal lane still meets its cycle SLA in the same run;
  completeness invariant holds for the cycle snapshot; every lane item has exactly one
  terminal outcome.
- Fault injection: 429 during a lane evaluation → lane defers, cycle aborts honestly,
  no cross-contamination of abort flags; churn beyond queue cap → drops are logged
  with reason codes, never silent.
- `tsc --noEmit` clean, full suite green, push to main per the delivery instruction.

## 10. Safety confirmation

This document changes no code and no config. No threshold, gate, lifecycle row,
strategy formula, or LIVE path is touched. The companion test uses an isolated temp
SQLite DB (`ARGUS_DB_PATH`), `PAPER_TRADING_ONLY=true`, seeded `CERTIFICATION_FIXTURE`
bars, and never enables the lane (there is no lane to enable). The 01:30 EDT soak is
unaffected — nothing in this change runs outside the test worker.
