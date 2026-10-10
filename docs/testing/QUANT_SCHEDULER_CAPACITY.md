# Quant Scheduler Capacity — Pool Sizing, Derivation & Measurement Procedure

2026-10-09 (P2 scheduler mission, Task C). This document records how the bounded
priority quant scheduler's (`src/server/scheduling/quantPriorityScheduler.ts`)
concurrency and SLA numbers were chosen, what they are NOT based on, and the exact
procedure an operator follows to raise them with evidence. Per repo AGENTS.md
("Performance: measure before optimizing; don't invent thresholds without
evidence"), the pool sizes below are **conservative starting values, not measured
optima** — a live load test against the real provider has not been run from this
environment, and this document does not pretend otherwise.

## The pools

| Pool | Config key | Value | What it bounds |
|---|---|---|---|
| Quant workers | `quantSchedulerQuantWorkerPoolSize` | 4 | Concurrent `evaluateSymbol()` calls (the compute+orchestration slot) |
| Data-fetch | `quantSchedulerDataFetchPoolSize` | 4 | Concurrent scheduler-initiated `ensureBars()` pre-fetches (outside any quant slot) |
| Java bridge | (owned by QuantCoreBridge, not the scheduler) | — | `quantJavaCoreRequestTimeoutMs`=100ms, circuit breaker (threshold 3 / cooldown 30s), `quantJavaCoreTickMaxConcurrency`=20 |
| AI | (owned by AICallGovernor, never a scheduler pool) | — | `analyzeContradictionsBounded` latency bound `quantContradictionMaxWaitMs`=8000ms |

## Why 4 / 4 (derivation, honest)

These values were **not** derived from a live load test. They were chosen as safe
starting points from constraints already measured or enforced elsewhere in the
codebase:

1. **Provider burst protection does not live in these pools.** `HistoricalDataGateway`
   serializes Alpaca REST through its own pace chain (<=150 req/min), coalesces
   in-flight refreshes per symbol|timeframe|window, and arms a reactive 429 backoff
   shared across callers. Raising the scheduler pools therefore cannot create a
   provider burst the gateway isn't already pacing — the pools bound *our* in-flight
   work, not provider request rate. This is the same separation the existing
   `quantMaxConcurrentSymbols` comment already relies on ("raise only after measuring
   rate-limit headroom").
2. **Per-evaluation cost envelope.** The certification SLA suite
   (`src/server/certification/quantSchedulerSla.test.ts`) budgets a generous 30s per
   `evaluateSymbol` pass as a worst case; real passes over 400 daily bars (regime +
   21 strategies + scoring) are CPU-bound milliseconds-to-seconds in-process. 4
   workers keeps event-loop impact bounded on the deployment host while the
   data-fetch pool (4) guarantees a stalled provider fetch for symbol A can never
   hold a quant compute slot needed by B/C/D — the exact pathology the scheduler
   was built to eliminate.
3. **Precedent.** The fast-lane evaluator already runs
   `fastLaneMaxConcurrentEvaluations`=3 concurrent real evaluations against the same
   gateway without provider incident; 4+4 is in the same envelope, with the gateway's
   pacing as the backstop.

## What would justify raising them (measurement procedure)

Run this on the **deployment host** (not this sandbox) during a real session window,
with `QUANT_PRIORITY_SCHEDULER_ENABLED=true` and the scheduler's structured events
(`QUANT_SCHEDULER_*` in `observability_events`) flowing:

1. Baseline: record `admissionToQuantStartMs` / `admissionToTerminalMs` p50/p95 per
   priority class for one full session at 4/4.
2. Raise ONE pool by +2 (never both at once). Run one full session.
3. Check, in order:
   - a. `HistoricalDataGateway` 429/backoff rate did not increase
      (`quant_symbol_evaluation_finished` outcomes `RATE_LIMITED`, gateway
      `rateLimitedUntilMs` arming frequency).
   - b. Event-loop lag p95 did not regress (the scheduler must never starve the
      tick path; `pipelineAgentHealth` / heartbeat watchdog silence is a veto).
   - c. `admissionToQuantStartMs` p95 per class improved or held.
   - d. Memory (RSS) stayed flat across the session (no per-worker accumulation).
4. Only if (a)-(d) all hold, keep the new value and record the session date,
   universe size, and measured p95s in this document's log below. If any check
   fails, revert and record why.

**Vetoes (never raise past these):** any increase in provider 429s attributable to
the quant lane; any heartbeat-watchdog silence; any unbounded RSS growth; any
`ASSESSMENT_EXPIRED` regression caused by queueing rather than provider delay.

## SLA targets (user-endorsed, 2026-10-09)

| Class | admission → quant-start p95 | admission → terminal p95 |
|---|---|---|
| HIGH (P0/P1) | `quantSchedulerHighPriorityAdmissionToStartSlaMs` = 30s | `quantSchedulerHighPriorityAdmissionToCompleteSlaMs` = 60s |
| NORMAL (P2) | `quantSchedulerNormalAdmissionToStartSlaMs` = 60s | `quantSchedulerNormalAdmissionToCompleteSlaMs` = 120s |

These are certification targets encoded in
`src/server/scheduling/quantPriorityScheduler.test.ts`, derived from the same
`config/tradingSafety.json` production loads. They derive from provider capacity
measurements in the following sense: the data-fetch pool + gateway pacing envelope
above is what makes the start-SLA achievable (a P0 never waits behind more than
`quantWorkerPoolSize` in-flight evaluations plus queued higher-priority work), and
the per-priority deadlines (`quantSchedulerP{0,1,2,3}DeadlineMs` = 60s/120s/300s/900s)
are the enforcement mechanism — P0/P1 deadlines align with the HIGH complete SLA,
P2 with one `quantCycleIntervalMs`, P3 is best-effort background.

## Liveness watchdogs (2026-10-10 review)

Two independent watchdogs bound hung work; neither invents cancellation (neither
`ensureBars()` nor `evaluateSymbol()` accepts an `AbortSignal`):

| Stage | Config key | Value | On expiry |
|---|---|---|---|
| Data-fetch | `quantSchedulerDataFetchTimeoutMs` | 30s | Candidate terminally `PROVIDER_TIMEOUT`; late fetch discarded |
| Quant evaluation | `quantSchedulerQuantEvaluationTimeoutMs` | 120s | **Quarantine**: quant slot returned to the pool (capacity recovers), dedup entry kept (no duplicate work), late settle discarded → `ASSESSMENT_EXPIRED` (`QUANT_EVALUATION_TIMED_OUT_LATE_SETTLE`) |

A quarantined evaluation that never settles is evicted by the sweeper after
`quantSchedulerQuantQuarantineMaxAgeMs` (600s) → `ASSESSMENT_EXPIRED`
(`QUANT_QUARANTINE_AGE_EXCEEDED`), releasing the dedup entry. Hung work can therefore
neither wedge pool throughput (slot recovered at the watchdog) nor pin a symbol's
dedup key forever (evicted by age). This mirrors the fast-lane hung-lease quarantine.

## Data-readiness routing (2026-10-10 review)

The scheduler's readiness check mirrors the gateway's `ensureBars()` sufficiency
contract exactly (bar-count floor **or** coverage ratio ≥
`quantBarsCacheMinCoverageRatio`, plus tail freshness for present-time requests).
Tail freshness uses the gateway's own `quantBarsTailFreshnessToleranceMs` — the
gateway is the authoritative enforcer, so routing and enforcement can never
silently diverge on two different tolerance knobs.

## Measurement log

| Date | Host/session | Pools (quant/fetch) | Universe | HIGH start p95 | HIGH complete p95 | NORMAL start p95 | NORMAL complete p95 | Verdict |
|---|---|---|---|---|---|---|---|---|
| 2026-10-09 | sandbox (synthetic) | 4/4 | 80 (stub) | «test | «test | «test | «test | synthetic only - not a capacity measurement |
| _pending_ | deployment host | 4/4 | real session | — | — | — | — | run the procedure above |

## Related

- Scheduler implementation: `src/server/scheduling/quantPriorityScheduler.ts`
- Scheduler tests (incl. SLA encoding): `src/server/scheduling/quantPriorityScheduler.test.ts`
- Forensic regressions (MRNA/CRCL/COMBINED): `src/server/scheduling/quantSchedulerForensicRegressions.test.ts`
- Previous scheduling contract (legacy path, still the default):
  `src/server/certification/quantSchedulerSla.test.ts`
