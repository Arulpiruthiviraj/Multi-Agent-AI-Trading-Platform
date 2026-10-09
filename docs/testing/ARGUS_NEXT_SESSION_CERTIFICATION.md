# Argus Next-Session Certification — Release-Gate Checklist

**Date:** 2026-10-09 · **Status:** the pre-market release gate (Layer 5 of
`ARGUS_PRODUCTION_CERTIFICATION_ARCHITECTURE.md`). Runs against the **exact build, exact
config, exact schema** for the next session, against an **isolated copy of production
state**. PAPER only, LIVE_NO_GO.

**How to read each invariant:** *Check* = how it is verified. *PASS* = the exact condition.
*FAIL* = what a failure means and what happens next. An invariant that cannot be checked is
FAIL (fail closed). Verdicts: `READY` / `READY_WITH_CONDITIONS` / `NO_GO`.

**NO-GO policy:** Any mandatory invariant red ⇒ `NO_GO`. The session does not run under
automation. `READY_WITH_CONDITIONS` is allowed only for documented, operator-accepted
conditions that do not touch safety (thresholds, gates, authority, reconciliation); each
condition is listed explicitly and expires at the next session. Authorization state is never
manufactured to turn a NO_GO into a READY.

---

## 1. Mode and safety posture

| Invariant | Check | PASS | FAIL |
|---|---|---|---|
| `PAPER_MODE` | Boot the exact build; assert engine mode is PAPER end-to-end (order path, broker adapter, accounting) | every order path resolves to the paper broker; `PAPER_TRADING_ONLY` semantics hold | any path can reach a live order endpoint ⇒ **NO_GO** |
| `LIVE_NO_GO` | Assert no LIVE arming path is reachable: `setLiveMode(true)` throws, no credential or flag silently arms LIVE | LIVE disarmed and disarmable-only-by-explicit-operator-action | any reachable arming path ⇒ **NO_GO** |
| `SINGLE_ENGINE` | Attempt to start a second engine process against the same state; assert the atomic startup claim rejects it | second process cannot trade; exactly one engine holds the claim | two processes can both trade ⇒ **NO_GO** (this was a real P0 escape class) |

## 2. Production-state authorization (the mandatory invariant)

| Invariant | Check | PASS | FAIL |
|---|---|---|---|
| `PRODUCTION_LIFECYCLE_CERTIFICATION` | Read-only Layer-3 report on the isolated production-state copy: per strategy — `strategyId, enabled?, lifecycle record?, lifecycle state, PAPER Quant authorized?, reason, data prerequisites, scheduled?, reachable?`. **No seeding, no inserted approvals, no manufactured state.** | report complete; every enabled strategy has a known reachability verdict with a machine-readable reason code | report incomplete or any enabled strategy's reachability unknown ⇒ **NO_GO** |
| `AUTHORIZED_PAPER_QUANT_STRATEGIES > 0` | Count strategies where the real authorization check passes against real state | count ≥ 1, genuinely certified | count = 0 ⇒ `QUANT_FIRST_OPERATIONALLY_INACTIVE` = **FAIL** ⇒ **NO_GO** — **even if `quantPolicyEnabled = true`**. A pipeline that can execute is not a pipeline authorized to execute. (Escapes: `OCT8_LIFECYCLE_AUTHORITY_ESCAPE`, `OCT9_ZERO_AUTHORIZED_STRATEGIES_ESCAPE`.) |
| `QUANT_POLICY_REACHABLE` | Exercise signal → QuantExecutionPolicy → ChiefTrader path with real config (no forced signals; use the real evaluation entry points) | the path is exercisable; policy authority resolves per real lifecycle state | path broken or policy authority unresolvable ⇒ **NO_GO** |

## 3. Scheduler: SLA, completeness, late admission

| Invariant | Check | PASS | FAIL |
|---|---|---|---|
| `QUANT_SCHEDULER_SLA` | Run Quant evaluation cycles at production concurrency against a production-size universe; measure cycle completion time | cycles complete within the documented SLA | cycles exceed SLA (the ~17-minute escape class) ⇒ **NO_GO** |
| `QUANT_COVERAGE_COMPLETENESS` | Assert every enabled strategy is evaluated every cycle | zero skipped strategies per cycle | any enabled strategy skipped ⇒ **NO_GO** |
| Late admission | Promote a symbol mid-cycle (mover/discovery); measure time to first Quant assessment | assessed within the late-admission bound — never "wait a full cycle" | late arrivals wait a full cycle or are never assessed ⇒ **NO_GO** |

## 4. Data readiness (per strategy)

| Invariant | Check | PASS | FAIL |
|---|---|---|---|
| `MARKET_DATA` | Assert required feeds are live and fresh within staleness bounds | all required feeds fresh | stale/missing required feed ⇒ **NO_GO** |
| Per-strategy data prerequisites | From the Layer-3 report: each authorized strategy's required bars/indicators/feeds available | all prerequisites met for every authorized strategy | an authorized strategy lacks required data ⇒ that strategy is `reachable? = no` (reported, not certified); if zero strategies remain reachable ⇒ **NO_GO** |

## 5. The risk spine

| Invariant | Check | PASS | FAIL |
|---|---|---|---|
| `RISK_SPINE` | Trace the real pipeline on the exact build: ChiefTrader → RiskEngine (all gates, BUY **and** SELL — gates 18–21 parity) → PositionSizing → OMS → fill → protective exit, with every AI provider killed | spine intact; SELL runs the same gate set as BUY; exits fire without AI | any bypass, missing gate, or AI-dependent exit ⇒ **NO_GO** |
| `ALL_AI_DOWN_QUANT` | Kill every AI provider; run validated quant flow (setup → policy → ChiefTrader → Risk → sizing → OMS → paper fill → organic exit to flat) | validated quant still trades; AI failure cannot stop quant | quant blocked by AI outage ⇒ **NO_GO** |

## 6. Reconciliation matrix

| Invariant | Check | PASS | FAIL |
|---|---|---|---|
| `RECONCILIATION` | Reconcile broker/account/position/order state on the isolated production-state copy; crash-recovery matrix: restart OMS mid-order-lifecycle and assert every in-flight order resolves via `client_order_id` (`reconcileStaleOrders()`), no duplicates, no orphans; aged PENDING rows archived, never silently ignored | clean reconcile; all in-flight orders resolvable; no unresolved `POSITION_ORDER_UNRESOLVED`; no silently-ignored pending work | any mismatch, unresolvable order, or silently-aged row ⇒ **NO_GO**. Mismatches escalate — never silently acknowledged, never auto-flattened. |

## 7. Resource and stability checks

| Invariant | Check | PASS | FAIL |
|---|---|---|---|
| `BACKUP_NON_BLOCKING` | Run DB backup during simulated trading hours (`DbBackupService.worker.test.ts` path: worker_thread + disk preflight) | event-loop heartbeat maintained; backup completes in worker | backup blocks the event loop ⇒ **NO_GO** |
| `WATCHDOG_CHAOS` | Fault injection: repeated rapid crashes | maintenance-aware watchdog + persisted storm lockout engages; no restart cascade | restart storm cascades ⇒ **NO_GO** |
| `MEMORY_SOAK` | Bounded-growth assertion over the soak window: every table written has a bounded-growth story (registered sweeper / permanent record / documented bounded); `retentionCoverage.test.ts` green | all tables bounded; no unbounded growth | any unbounded table ⇒ **NO_GO** |
| `QUEUE_BOUNDS` | Assert all queues bounded with documented overflow behavior | bounds hold under load | unbounded queue ⇒ **NO_GO** |
| `LISTENER_TIMER_STABILITY` | Start/stop cycles (e.g. `SystemMetricsWorker` — 6 listeners leaked per toggle was the real escape); assert listener/timer counts stable | counts stable across cycles | leak detected ⇒ **NO_GO** |

## 8. Premarket, restart, PIT

| Invariant | Check | PASS | FAIL |
|---|---|---|---|
| `PREMARKET_PIPELINE` | Run the premarket refresh on the exact build | completes and emits its completion event before the open | incomplete or missing completion event ⇒ **NO_GO** |
| Restart recovery | Restart mid-session (crash scenario) | order state resolvable, no duplicate orders, session resumes cleanly | duplicates or unresolvable state ⇒ **NO_GO** |
| `PIT_REPLAY` | Replay a past decision from retained provenance (input bar IDs, observed/available-at timestamps, quote timestamps, StrategyContext inputs) | replays identically | provenance missing or replay diverges ⇒ **NO_GO** |

## 9. Tier mapping

| Tier | Runs | Budget | Contains |
|---|---|---|---|
| **FAST PR GATE** | every PR | minutes | Layer 1 + Layer 2 (fast subset); `tsc`; lint. Blocks merge. |
| **PRE-MARKET RELEASE GATE** | before each session | tens of minutes | **This entire checklist** (§1–§8): Layers 1–3 full; Layer-4 key scenarios (AI-down, restart, backup-during-hours, watchdog chaos); Layer-5 verdict. Blocks the session. |
| **NIGHTLY** | overnight | hours | Full Layer-4 scenario + fault-injection/chaos matrix; SOAK runs; retention/label coverage audits; full PIT replay sweep. Blocks the next release, not tonight's session. |

Rules: a PR touching runtime behavior must pass the pre-market gate before the session
following its merge. The nightly tier may never be the first place a pre-market invariant is
checked. A verdict attaches to (build hash, config hash, schema version, state snapshot id) —
any change to one invalidates it.

## 10. The permanent rule, restated at the gate

Tests that seed VALIDATED, insert approvals, or provide perfect fixtures prove **mechanism**
(`MECHANISM_E2E`), never **reachability**. A `MECHANISM_E2E` PASS must never be interpreted as
`PRODUCTION READY`, quoted in a Layer-3 report, or used to satisfy `AUTHORIZED_PAPER_QUANT_STRATEGIES`.
The gate measures what production state actually authorizes — it never manufactures the answer.
