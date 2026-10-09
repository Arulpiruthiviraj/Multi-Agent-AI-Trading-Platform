# Argus Production Certification Architecture

**Date:** 2026-10-09 · **Status:** design document (no code changes; testing mission Phase 1 docs) ·
**Scope:** PAPER only, LIVE_NO_GO. Nothing in this document may be read as authorization to
enable LIVE, place real-money orders, lower thresholds, promote strategies, or seed production state.

## 1. Purpose

Argus is a quantitative trading system that can use AI when AI adds value — not an AI trading bot
with quant features. The certification platform exists to prove, before every market session, that
the quant spine works in production as code, build, config, schema, registry, lifecycle state,
data capability, provider capability, scheduler capacity, and resource behavior — not merely that
each of those works in isolation against a synthetic fixture.

The Oct-8/9 forensic record is the motivating evidence: unit tests were green while production ran
with **zero authorized Quant strategies**, backups blocked the event loop during trading hours,
retention sweepers were broken by an import cycle, and certification reported
`READY_WITH_CONDITIONS` without failing on the one invariant that mattered. Each layer below is
assigned to a class of escape that actually occurred. See
`ARGUS_DEFECT_ESCAPE_REGISTRY.md` for the per-defect record.

## 2. Core testing principle

> **NO CRITICAL PATH MAY BE DECLARED READY MERELY BECAUSE A SYNTHETIC FIXTURE CAN EXERCISE IT.**

Readiness is a conjunction. A component, path, or strategy is **production ready** only when the
platform has shown that **current code + current build + current config + current schema +
current registry + current lifecycle state + current data capability + current provider capability
+ current scheduler capacity + current resource behavior** work together, against production or an
isolated copy of production state. Any test that proves mechanism by seeding authority, inserting
approvals, or providing perfect fixtures answers a narrower question and must be labeled as such
(see §5). It may never be relabeled, summarized, or presented as production readiness.

## 3. The five certification layers

### LAYER 1 — COMPONENT CORRECTNESS

**Question:** "Does each component behave correctly?"

Unit and property tests for: quant formulas (signals, indicators, EV, R:R), strategy entry/exit
conditions, lifecycle transitions (VALIDATED → CHAMPION → ACTIVE_EXPLORATION → …), authorization
checks, Risk gates (all gates, BUY and SELL paths), position sizing, OMS order-state machine,
fill accounting, PnL accounting, reconciliation logic, market-data normalization, retention
sweeper cutoffs and idempotency.

- **Entry:** a code change touching the component, or nightly.
- **Exit:** full Layer-1 suite green (`tsc` clean, no failures) on the exact build being certified.
- **Guarantee:** behavior of the component in isolation. Nothing more. A green Layer 1 says the
  bricks are sound; it says nothing about the building, the address, or whether anyone lives there.
- **Known blind spot (by design):** bounded-table growth was verified by Layer-1 tests while
  tables grew unboundedly in production; Layer 1 tests verify that *features work*, never that
  *growing tables stay bounded*. Cross-table bounded-growth proof belongs to Layer 4 and to
  `retentionCoverage.test.ts`-style coverage tests.

### LAYER 2 — ARCHITECTURE CERTIFICATION

**Question:** "Is the architecture still structurally safe?"

Invariant tests over the call graph and authority model of the real production code. The mandatory
invariant set includes:

1. **QuantExecutionPolicy cannot bypass ChiefTrader.** Policy signals route through ChiefTrader;
   no code path emits an order directly from a quant strategy.
2. **ChiefTrader cannot bypass RiskEngine.** Every trade proposal passes RiskEngine; there is no
   back door, fast path, or "emergency" override.
3. **RiskEngine cannot be skipped.** The pipeline is constructed so that Risk is a mandatory
   stage, not a checked call site — removal must break compilation or fail a test.
4. **PositionSizing is mandatory.** No order reaches OMS without passing through sizing.
5. **OMS is the sole production `.placeOrder` caller.** No other production code path may place
   orders; adapters expose transport only.
6. **BrokerManager is canonical.** Broker selection and credential routing go through the
   BrokerManager; no parallel instantiation that could split state.
7. **AI cannot become mandatory for authorized Quant.** Killing every AI provider must not stop a
   validated quant strategy from trading; QuantExecutionPolicy never touches advisory, and
   advisory is provably outside every decision.
8. **Protective exits do not depend on AI.** Stop-loss / risk-driven exits fire from the risk
   spine alone.
9. **LIVE authority cannot be granted by PAPER lifecycle state.** Promotion paths are
   fail-closed; no lifecycle row, flag, or state transition may silently arm LIVE.

- **Entry:** any architectural change (new engine, new adapter, policy change, dependency
  rewire), or nightly.
- **Exit:** all architecture invariants green on the exact build.
- **Guarantee:** the shape of the system is safe. It does not prove the system *runs* — that is
  Layer 4 — nor that production state authorizes anything — that is Layer 3.

### LAYER 3 — PRODUCTION-STATE CERTIFICATION

**Question:** "Can the real strategies actually use the architecture?"

A **read-only** snapshot/copy of the actual runtime DB plus the exact production config, read by
tooling that **never seeds lifecycle rows, never inserts approvals, never promotes strategies,
never manufactures state**. It produces a per-strategy report with exactly these columns:

| Column | Meaning |
|---|---|
| `strategyId` | strategy identifier |
| `enabled?` | operator-enabled flag in config |
| `lifecycle record?` | a lifecycle row exists (yes/no) |
| `lifecycle state` | the actual state value, or `NO_LIFECYCLE_RECORD` |
| `PAPER Quant authorized?` | does the real authorization check pass against real state? |
| `reason` | machine-readable reason code (`NO_LIFECYCLE_RECORD`, `NOT_AUTHORIZED`, `NO_DATA_PREREQ`, …) |
| `data prerequisites` | required feeds/bars/indicators available? (yes/no per item) |
| `scheduled?` | the scheduler will evaluate this strategy (yes/no, with cadence) |
| `reachable?` | full chain from schedule → evaluate → signal → policy → ChiefTrader → Risk → sizing → OMS reachable with current state |

**Mandatory invariant:** `AUTHORIZED_PAPER_QUANT_STRATEGIES = 0` ⇒
`QUANT_FIRST_OPERATIONALLY_INACTIVE = FAIL`, **even if** `quantPolicyEnabled = true`. A pipeline
that can execute is not a pipeline that is authorized to execute. The Oct-8 session proved the
spine could execute with seeded authority while production authorized nothing — Layer 3 exists so
that can never again be certified as ready.

**Permanent rule:** any test that seeds VALIDATED, inserts approvals, or provides perfect fixtures
proves *mechanism*, never *reachability*. A mechanism test's PASS must never be quoted as a
Layer-3 result.

### LAYER 4 — FULL SESSION SIMULATION

**Question:** "Can Argus survive an entire trading day?"

A realistic, entire market session driven through the **real runtime services** — premarket,
open, movers, churn, Quant scheduling, provider delays, AI outages, data gaps, Risk, entries,
exits, reconciliation, post-market — with accelerated virtual time where the physics allow it
(never where acceleration would falsify scheduler or timing behavior).

The scenario matrix must include, at minimum:

- Normal day with mixed winners/losers (losing-round-trip end-to-end coverage).
- AI providers fully down for the whole session (ALL_AI_DOWN_QUANT: validated quant must still trade).
- Provider latency spikes and partial outages.
- Data gaps (missing bars, delayed quotes, stale snapshots).
- Late-arriving movers (symbols appearing mid-session must be Quant-assessed within the SLA;
  no "wait a full cycle" behavior).
- Risk events (limit approaches, forced exits, reconciliation mismatches).
- Restart mid-session (crash recovery: order state resolvable, no duplicate orders).
- Backup running during trading hours (must be non-blocking; event-loop heartbeat maintained).
- Watchdog events (restart storms must trigger lockout, not cascades).

**Bounded-growth proof:** the session asserts every table it writes has a bounded-growth story
(registered sweeper, permanent record, or documented bounded) — see
`src/server/replay/synthetic/SyntheticSessionGuards.test.ts` for the existing mechanism — and a
session-scale p99 event-loop check.

- **Entry:** nightly; also before any release that touches runtime behavior.
- **Exit:** all scenario certifications green, bounded-growth assertion holds, no unresolved
  reconciliation mismatch at session end.
- **Guarantee:** the system survives a day. It does not prove *tomorrow's* state is ready —
  that is Layer 5.

### LAYER 5 — RELEASE / NEXT-SESSION CERTIFICATION

**Question:** "Is THIS exact build ready for tomorrow?"

Boot the **exact build, exact config, exact schema** for the next session against an **isolated
copy of production state** and require every mandatory readiness invariant. This is the
pre-market release gate; its checklist is defined in full in
`ARGUS_NEXT_SESSION_CERTIFICATION.md`.

**Verdict vocabulary (only these):**

- `READY` — every mandatory invariant green on the exact build + isolated production-state copy.
- `READY_WITH_CONDITIONS` — green except documented, operator-accepted conditions that do not
  touch safety; conditions are listed explicitly and expire at the next session.
- `NO_GO` — any mandatory invariant red. The session does not run under automation.

**Mandatory rule:** zero certified strategies is `QUANT_FIRST_OPERATIONALLY_INACTIVE` and a
**FAIL**, never a condition to be hand-waved. Authorization state may never be manufactured to
turn a NO_GO into a READY.

## 4. How the layers compose

```
Layer 1 (components behave)
   → Layer 2 (structure is safe)
      → Layer 3 (real state authorizes real strategies)
         → Layer 4 (the system survives a day)
            → Layer 5 (THIS build is ready for TOMORROW)
```

Each layer may assume the previous layers' guarantees and must state that assumption. No layer
may claim a later layer's guarantee. A release verdict (Layer 5) requires Layers 1–4 green for
the same build; a Layer-4 PASS against yesterday's build certifies nothing about today's.

## 5. Test labeling taxonomy

Every test carries exactly one label. Labels are not marketing; they define what a PASS may be
used to claim.

| Label | Proves | May never be used to claim |
|---|---|---|
| `UNIT` | a function/formula behaves per spec | system behavior |
| `COMPONENT` | a component behaves in isolation | integration behavior |
| `MECHANISM_E2E` | the mechanism works end-to-end *with a fixture* (seeded authority, synthetic DB, perfect data) | **PRODUCTION READY** — a MECHANISM_E2E PASS must never be interpreted as production readiness |
| `ARCHITECTURE_INVARIANT` | a structural safety property holds in the real code | that the system runs or is authorized |
| `PRODUCTION_STATE` | read-only facts about the real runtime state | that the code is correct (it assumes Layer 1–2) |
| `POINT_IN_TIME_REPLAY` | a past decision replays identically from retained provenance | that the strategy will behave that way tomorrow |
| `FAULT_INJECTION` | the system behaves safely under a specific fault | that all faults are covered |
| `SOAK` | resource behavior is stable over hours | correctness of any decision |
| `RELEASE_CERTIFICATION` | the exact build/config/schema/state is ready for the next session | anything about a different build |

**Labeling rules:**

- A test that seeds VALIDATED, inserts approvals, or provides perfect fixtures is `MECHANISM_E2E`
  at best, and its artifacts must carry `SYNTHETIC_SEEDED` / `CERTIFICATION_FIXTURE_ONLY` markers.
- Relabeling a `MECHANISM_E2E` result as `PRODUCTION_STATE` or `RELEASE_CERTIFICATION` is a
  certification defect, equivalent in severity to falsifying a gate.
- `POINT_IN_TIME_REPLAY` requires retained provenance: input bar IDs, observed/available-at
  timestamps, quote timestamps, and StrategyContext inputs. Without provenance, the label cannot
  be claimed (see OCT9_PIT_PROVENANCE_ESCAPE).

## 6. Suite tiers

| Tier | When | Budget | Contents | Blocks |
|---|---|---|---|---|
| **FAST PR GATE** | every PR | minutes | Layer 1 + Layer 2 (fast subset); lint/typecheck | merge |
| **PRE-MARKET RELEASE GATE** | before each session | tens of minutes | Layers 1–3 full; Layer 4 key scenarios (AI-down, restart, backup-during-hours); Layer 5 checklist | the session |
| **NIGHTLY** | overnight | hours | Full Layer 4 scenario + fault-injection/chaos matrix; SOAK runs; coverage/label audits | the next release |

A PR that changes runtime behavior must additionally pass the pre-market gate before the session
that follows its merge. The nightly tier may never be the first place a pre-market invariant is
checked.

## 7. Release invariants (Layer 5 checklist summary)

The full per-invariant definition — how each is checked, what FAIL means — lives in
`ARGUS_NEXT_SESSION_CERTIFICATION.md`. The mandatory set:

- `PAPER_MODE` — engine boots in PAPER; no LIVE arming path reachable.
- `LIVE_NO_GO` — LIVE remains disarmed; no credential or flag can silently arm it.
- `SINGLE_ENGINE` — atomic startup claim held; no second engine process can trade.
- `RECONCILIATION` — broker/account/position/order state reconcile; mismatches escalate, never
  silently acknowledged.
- `MARKET_DATA` — required feeds live and fresh; staleness bounds enforced.
- `QUANT_SCHEDULER_SLA` — evaluation cycles complete within SLA at production concurrency.
- `QUANT_COVERAGE_COMPLETENESS` — every enabled strategy evaluated every cycle; none skipped.
- `PRODUCTION_LIFECYCLE_CERTIFICATION` — Layer-3 report current; per-strategy reachability known.
- `AUTHORIZED_PAPER_QUANT_STRATEGIES > 0` **only if genuinely certified** — never seeded,
  never manufactured.
- `QUANT_POLICY_REACHABLE` — signal → policy → ChiefTrader path exercisable with real config.
- `ALL_AI_DOWN_QUANT` — validated quant trades with every AI provider killed.
- `RISK_SPINE` — ChiefTrader → RiskEngine → sizing → OMS → fill → exit, intact.
- `BACKUP_NON_BLOCKING` — backup runs in worker_thread; event loop unblocked during hours.
- `WATCHDOG_CHAOS` — maintenance-aware watchdog; restart storms lock out, not cascade.
- `MEMORY_SOAK` — bounded growth over the soak window; listener/timer counts stable.
- `QUEUE_BOUNDS` — all queues bounded with documented overflow behavior.
- `LISTENER_TIMER_STABILITY` — no listener/timer leaks across start/stop cycles.
- `PREMARKET_PIPELINE` — premarket refresh completes and emits its completion event.
- `PIT_REPLAY` — provenance retained; a past decision replays identically.

**Verdict:** `READY` / `READY_WITH_CONDITIONS` / `NO_GO` (see §3, Layer 5).
**Zero certified strategies** ⇒ `QUANT_FIRST_OPERATIONALLY_INACTIVE` = **FAIL**. Authorization is
an operator decision on the deployment host; the certification platform reports its absence, it
never manufactures its presence.

## 8. Permanent rules

1. **Seeded authority proves mechanism, not reachability.** Tests seeding VALIDATED, inserting
   approvals, or providing perfect fixtures are `MECHANISM_E2E`. Their PASS must never appear in
   a Layer-3 or Layer-5 report except labeled as mechanism-only.
2. **Readiness is per-build.** A verdict attaches to (build hash, config hash, schema version,
   state snapshot id). Any change to one invalidates the verdict.
3. **Fail closed.** An invariant that cannot be checked is FAIL, not "assumed green". Missing
   provenance ⇒ `PIT_REPLAY` FAIL. Missing lifecycle rows ⇒ `PRODUCTION_LIFECYCLE_CERTIFICATION`
   FAIL. Unmeasurable ⇒ red.
4. **Every escape becomes a registry entry and a gate.** See
   `ARGUS_DEFECT_ESCAPE_REGISTRY.md`. A defect that escaped testing must, before the fix is
   considered complete, add the test that would have caught it and the release invariant that
   now blocks on it.
5. **PAPER ONLY.** This platform certifies PAPER sessions. It may not arm, enable, or certify
   LIVE under any label or tier.
