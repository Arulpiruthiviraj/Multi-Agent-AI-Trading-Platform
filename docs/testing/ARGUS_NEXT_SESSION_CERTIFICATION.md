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

**Executable form:** `argus certify-next-session [--db=<path>] [--json] [--with-suites] [--engine-url=<url>] [--with-sim] [--sim-speed=N]`
(`scripts/argus-cli.ts` → `scripts/certifyNextSession.ts`). Snapshots the production DB
read-only into an isolated copy (sqlite3 online backup; never writes the source), reports
the real lifecycle state read-only (authorized PAPER quant strategies, the PAPER allocation
profile, open positions, key trading-safety numbers as configured), runs the canonical
authorization + data-readiness + build/config/schema provenance against the copy, and emits
`OVERALL_STATUS` (`READY` / `READY_WITH_CONDITIONS` / `NO_GO`) with exit codes
0 / 2 / 3 (1 = internal error). Exit 3 is a certification RESULT, not a bug.

**GO / NO-GO verdict (fail-closed, Phase 2):** the report's `goNoGo` field (and the
`VERDICT:` line in human output) maps the driver plus the optional simulated session:
`GO` only when the driver is `READY` AND the simulated session (when run with `--with-sim`)
passed; anything else is `NO-GO` with the reasons in `goNoGoReasons`. `READY_WITH_CONDITIONS`
is never a `GO`. A correct, explainable `NO-GO` is a valid result.

`--with-sim` runs a synthetic market-open session through the `scripts/sim/marketOpen.ts
--certify` infrastructure (Test A no-trade safety + Test B tradeable scenario), labeled
`SYNTHETIC_SEEDED` / `NON_ORGANIC` / `CERTIFICATION_FIXTURE_ONLY` and folded into the
verdict — it never forces a strategy signal, a Chief/Risk approval, or a fill above the
broker boundary, and it is never organic paper evidence. The checklist
below is the human-readable contract; the CLI is its machine execution for the areas it can
measure directly, and names the exact test files that own the rest (`delegatedToSuite`).

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

---

## 11. Run record — 2026-10-11/12 (Worker H, `mission/oct8-oct9-closure`)

**Command:** `argus-cli certify-next-session --json` (release certification driver,
`src/server/certification/releaseCertificationDriver.ts`, via `scripts/certifyNextSession.ts`).
Production DB snapshotted with the sqlite3 online `.backup` API into an isolated copy
(the prior raw-copy snapshot fallback was deleted by Worker A — verified still absent;
a failed snapshot fails loud, never falls back).

**Verdict: NO_GO (exit 3)** — truthful, not a bug. The driver orchestrates all mandatory
checks; check states are `PASS` / `FAIL` / `NOT_RUN` / `UNKNOWN` / `NOT_CERTIFIED`, and
**READY requires every mandatory check to be PASS** — a partial probe can never report READY.

| Field (of 44 emitted) | Value |
|---|---|
| `OVERALL_STATUS` | `NO_GO` |
| `AUTHORIZED_PAPER_QUANT_STRATEGIES` | **0** → `FAIL` (`QUANT_FIRST_OPERATIONALLY_INACTIVE`) — genuine: `quantPolicyEnabled=true` but zero strategies clear the real authorization check against real state. A pipeline that *can* execute is not a pipeline *authorized* to execute. |
| `LIFECYCLE_SUMMARY` | 5 strategies missing lifecycle rows |
| `QUANT_POLICY_REACHABILITY` | **PASS** — 0 unresolvable (the path is exercisable; authority resolves per real lifecycle state) |
| `JEV_CONFIGURED` / `JEV_WIRING` / `JEV_GOVERNOR` / `JEV_SCHEMA` / `JEV_FAILURE_MODE` | `false` / governed-but-inert / **PASS** (governor) — Jev has no API key, every flag OFF, never wired into decisions; `decide()` throws `NO_API_KEY` before any network attempt |
| `ALL_AI_DOWN_QUANT` | Mechanism-certified separately (§12): validated quant idea passes the policy prefilter but is NOT approved — single voice cannot clear the remediated consensus gate (0.75 strict >, min-2-agents) with all AI down |
| `HISTORICAL_DATA_FRESHNESS` / `INTRADAY_DATA_READINESS` | Production `data/argus.db`: **0 `ohlcv_bars` rows, 0 `quant_assessments`, 0 fills/trades/decision_provenance, 0 trade_lifecycle_transitions** (verified by direct sqlite3 queries) — the gate reports exactly this |
| `SCHEDULER_P50/P95/P99/MAX` | measured against the production-size universe |
| `ARTIFACT_HASH` | **PASS** (`dist/server.cjs` hashed) |
| `JAVA_ARTIFACT_HASH` | `UNKNOWN` (no packaged jar) — fail-closed, not assumed |
| `BUILD_SHA` / `CONFIG_HASH` / `SCHEMA_VERSION` / `STRATEGY_REGISTRY_HASH` / `DB_SNAPSHOT_ID` / `PRODUCTION_CONFIG_EQUIVALENT` | emitted; the verdict attaches to this exact tuple — any change invalidates it |

**Check states:** 18 PASS / 10 UNKNOWN / 1 FAIL / 16 NOT_RUN; `READY=false`. `UNKNOWN` is
fail-closed (e.g. engine unreachable for live probes, no packaged Java artifact) — never
treated as healthy.

**New CLI fields since the 2026-10-09 checklist:** `ARTIFACT_HASH`, `JAVA_ARTIFACT_HASH`,
`DB_SNAPSHOT_ID`, `PRODUCTION_CONFIG_EQUIVALENT`, `JEV_*` (5 fields), `SCHEDULER_P50/P95/P99/MAX`,
`FULL_SESSION`, `WALL_CLOCK_SOAK` — all 44 required fields verified emitted
(`BUILD_SHA` … `OVERALL_STATUS`). Human-readable table output verified (`certify-next-session`
without `--json`).

## 12. AI-down re-verification (Worker C's caveat)

`src/server/quant/AiOfflineQuantCertification.test.ts` — **4/4 PASS** (2026-10-12):
Jev + every AI provider unavailable; an authorized TEST-only Quant fixture driven through
`QuantExecutionPolicy` → ChiefTrader → RiskEngine → PositionSizing → OMS → simulated PAPER broker.

- Validated quant idea **passes the policy prefilter but is NOT approved** — single voice
  cannot clear the remediated consensus gate (0.75 strict >, min-2-agents). The mechanism
  works mechanically with zero AI.
- Negative control (a): AI-originated idea fails closed with AI down — `DESK_NO_TRADE`, no approval, no AI calls.
- Negative control (b): UNTESTED-lifecycle strategy idea falls back to consensus — single voice, no approval.
- `triggerMet=false` is terminally rejected.

**This is mechanism certification, not alpha proof.** It certifies that the pipeline functions
without AI and that the consensus gate holds — it says nothing about whether any strategy is
profitable.


## 13. 2026-10-13 protective-exit retry release gate

Runtime behavior found on 2026-10-13 adds a mandatory release invariant for any build carrying open positions:

| Invariant | Check | PASS | FAIL |
|---|---|---|---|
| `PROTECTIVE_EXIT_RETRY_OWNERSHIP` | Emit a genuine sealed PortfolioMonitor protective SELL; force a Risk rejection; verify the same position can emit a fresh protective trace on the next PortfolioMonitor review. Then hold a PENDING/PARTIALLY_FILLED close beyond `exitIdeaCooldownMs` and verify no duplicate close is emitted. Finally deliver terminal REJECTED/CANCELED/FILLED and verify exact-trace ownership releases. | rejected exits retry on the next review; in-flight closes stay single-flight; unrelated traces cannot release ownership | any fixed 5-minute blind spot after rejection, or any duplicate close while a prior close is unresolved ⇒ **NO_GO** |
| `BROKER_RESIDENT_PROTECTION` | Query the actual PAPER execution account for working protective orders; do not infer from configured stop percentages. | explicit broker working-order evidence exists and matches the held quantity/order contract | if absent/unknown, report **software-only protection**; unattended PAPER may not be called fully protected |
| `PORTFOLIO_MONITOR_CADENCE` | During at least four 15-minute maintenance cycles, measure maximum gap between position reviews while an open position is present. | no maintenance task causes a missed protection window beyond the certified bound | gap exceeds bound or cannot be measured ⇒ **NO_GO** for unattended PAPER |

The first invariant is covered by `src/server/continuous/continuousIntelligence.test.ts` on `repair/oct13-protective-exit-retry`. It still requires exact-SHA CI and controlled-runtime verification before deployment. The second and third are runtime-only and must never be inferred from unit tests.
