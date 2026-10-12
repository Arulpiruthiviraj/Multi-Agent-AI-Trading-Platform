# Argus Production Certification Architecture

**Date:** 2026-10-11 (mission defect-closure rewrite; supersedes the 2026-10-09 design
sketch for the mission's purposes) · **Scope:** PAPER only, `LIVE_NO_GO`. Nothing in this
document may be read as authorization to enable LIVE, place real-money orders, lower
thresholds, promote strategies, or seed production state.

**Reference:** mission master mission Section 75 defines the four certification tiers
(PR_FAST / PREMARKET / NIGHTLY / DEEP). The Oct-8/9 forensic record is the motivating
evidence: unit tests were green while production ran with **zero authorized Quant
strategies**, backups blocked the event loop during trading hours, retention sweepers were
broken by an import cycle, certification reported `READY_WITH_CONDITIONS` without failing
on the one invariant that mattered, and — found on 2026-10-11 — the quant policy router
silently bypassed the strict >0.75 consensus bar while its tests asserted the old shape.
Each tier below is assigned to a class of escape that actually occurred. Per-defect record:
`ARGUS_DEFECT_ESCAPE_REGISTRY.md`.

## 1. Core testing principle

> **NO CRITICAL PATH MAY BE DECLARED READY MERELY BECAUSE A SYNTHETIC FIXTURE CAN EXERCISE IT.**

Readiness is a conjunction. A component, path, or strategy is **production ready** only
when the platform has shown that **current code + current build + current config + current
schema + current registry + current lifecycle state + current data capability + current
provider capability + current scheduler capacity + current resource behavior** work together,
against production or an isolated copy of production state. Any test that proves mechanism
by seeding authority, inserting outcomes, or forcing a signal is a mechanism test, not a
readiness test, and must be labeled `SYNTHETIC_SEEDED` / `NON_ORGANIC` /
`CERTIFICATION_FIXTURE_ONLY`.

## 2. The four tiers (mission Section 75)

### Tier 1 — PR_FAST (every pull request; minutes)

Static and fast unit suites that guard the invariants which, if broken, are safety-critical.
A PR_FAST red blocks merge.

| Suite | What it pins |
|---|---|
| `quantSpineInvariants.test.ts` | No approval primitives outside the consensus path; no `threshold: 0`; policy is a prefilter only (52b6933) |
| `ChiefTraderAgent.router.test.ts` | Policy-pass enters the pool; single voice and <0.75 ideas never approved |
| Consensus boundary tests (c78e98e) | exactly-0.75 -> NO TRADE; 0.7501 -> eligible (strict-> semantics, both sides) |
| `ChiefTraderAgent.sideLockWithhold.test.ts` | Operator CONFIRM side-lock holds on the consensus path |
| `jevCannotCauseOrder.test.ts` | No Jev file reaches an order path (15 tests) |
| `hotPathProhibition.test.ts` | No Jev/governor/advisory reference in tick handlers |
| Schema-vs-drizzle consistency test (4fd5f7b) | `schema.ts` and migrations agree |
| TS-Java bridge contract test (d89945b) | Static, mutation-checked bridge contract |
| AI-independence suites | Exits/risk/reconciliation never consult AI (`protectiveExitAiIndependence`, `riskAndReconciliationAiIndependence`, `quantAiIndependence`) |

### Tier 2 — PREMARKET (before every session; runs the release gate)

Executable driver: `argus certify-next-session [--db=<path>] [--json]`
(`scripts/argus-cli.ts` → `scripts/certifyNextSession.ts`). Runs against an **isolated copy
of production state** (see §4). Suites placed here:

| Suite | What it pins |
|---|---|
| `scripts/certifyQuantProductionState.ts` | Reads real lifecycle + config read-only: 21 registry members, 0 authorized, 20 missing lifecycle, 1 ineligible (exit 2 on zero authority) |
| `certify-next-session` gate | Verdicts READY / READY_WITH_CONDITIONS / NO_GO; currently NO_GO (`QUANT_FIRST_OPERATIONALLY_INACTIVE`) — the honest gate |
| Fast Lane lease suite (`fastLaneEvaluator.test.ts`) | `FAST_LANE_LEASE_TEST`: caller timeout never releases active capacity; quarantine eviction bounded |
| Scheduler SLA tests | HIGH start<=30s p95 / complete<=60s p95; NORMAL start<=60s / complete<=120s p95 (flag-gated path) |
| Broker adapter fail-closed suites | Request failure -> `[]`, never throw; exact side mappings; malformed rows skipped |
| Retention coverage (`retentionCoverage.test.ts`) | `RETENTION_COVERAGE`: every append-only table has a registered sweeper |
| HistoricalDataGateway boundary tests | Stale-tail gate, IBKR-empty path, cache-collision, coalescing retain-until-settle |

### Tier 3 — NIGHTLY (full targeted suites + chaos + replay)

| Suite | What it pins |
|---|---|
| Full `npm test` (excluding HTTP-server tests blocked in sandbox) | Targeted + related suites green across the tree |
| Chaos matrix (`src/testing/*`) | Provider/resource/chaos fault injection with honest event-loop modeling (11fa111) and designed circuit-open behavior (02f1188) |
| `decisionProvenance.test.ts` | PIT replay equality through the real `StrategyEngine.evaluateAll()`; future-data injection rejected at write and replay time; version-mismatch / truncated-context honesty |
| `AiOfflineQuantCertification.test.ts` | All-AI-down mechanism: real strategy -> policy -> Chief -> Risk -> sizing -> OMS -> paper broker -> real PortfolioMonitor exit (now certifies the honest NO_TRADE under the remediated consensus path) |
| Watchdog suites (47/47) | Storm lockout, maintenance deferral, startup grace, never-resumes-trading |
| Backup worker suites | Cross-process lease, orphan sweep, SKIPPED_DISK preflight, atomic publish |
| Scheduler forensic regressions | MRNA/CRCL/SNOW missed-opportunity regressions; moving-market scenario behavior |

### Tier 4 — DEEP (weekly or on demand; calendar time, not a unit test)

| Suite | What it pins |
|---|---|
| 3-hour wall-clock soak (`scripts/soak/threeHourSoakChild.ts`) | Resource-gated verdict (72c7169): units corrected (ns->ms), verdict gates on SOAK_MAX_RSS_MB / DELTA / EVENT_LOOP_P95_MS / DB_GROWTH / WAL_BYTES; boundViolations listed |
| Full synthetic session (Worker H: `ARGUS_FULL_SESSION_SYNTHETIC_CERTIFICATION.md`) | Synthetic clock/broker/data end-to-end mechanism; proves engineering capability, not alpha |
| Java defect-hunt + parity suites (Maven) | EMA seeding parity, JSON boundary serialization, slash-symbol routing |
| TS-Java parity at scale | `StrategyParityTest.java` / TS-side parity suites against deterministic inputs |

## 3. The driver design

- **Single executable gate:** `argus certify-next-session` is the Tier-2 driver. It
  snapshots, runs the Tier-2 suites against the snapshot, and emits one verdict:
  `READY` / `READY_WITH_CONDITIONS` / `NO_GO` (+ machine-readable JSON).
- **Tier selection is explicit:** `argus certify-next-session --tier=pr-fast|premarket|nightly|deep`.
  Tiers compose: PREMARKET assumes PR_FAST green; NIGHTLY assumes PREMARKET green; DEEP is
  standalone-calendar evidence.
- **PASS-only rule:** any mandatory invariant red ⇒ `NO_GO`; the session does not run under
  automation. `READY_WITH_CONDITIONS` is allowed ONLY for documented, operator-accepted
  conditions that do not touch safety (thresholds, gates, authority, reconciliation); each
  condition is listed explicitly and expires at the next session. Authorization state is
  never manufactured to turn a NO_GO into a READY. An invariant that cannot be checked is
  FAIL (fail closed).
- **Why-no-trade is part of the gate:** `buildWhyNoTradeReport` covers the quant path
  (`QUANT_POLICY_APPROVED`/`REJECTED`, `QUANT_NOT_AUTHORIZED`, terminal lifecycle states)
  so a NO_GO names the real reason, not a generic one.

## 4. Snapshot consistency

- Certification snapshots via atomic `sqlite3 .backup` into an isolated copy; the source
  DB is never written. The torn `copyFileSync` fallback was deleted (defect 11, 6083329):
  a failed consistent backup is a loud non-zero exit, never a silent torn snapshot.
- `certifyQuantProductionState.ts` copies production lifecycle+config into an isolated
  temp DB and runs the canonical authorization resolver there — read-only against
  production, zero authority manufactured.
- Windows path handling uses `node:path` basename (defect 12) so snapshot cleanup runs
  cross-platform.

## 5. Production-equivalence requirements

A certification result is valid only when:

1. **Same build SHA** as the deployed engine (RUNNING_SHA verified; provenance capture
   isolated per OCT10-16).
2. **Same config versions** (`config/tradingSafety.json`, strategy specs, risk gates) —
   provenance records configVersion (defect 21).
3. **Same schema** — schema-vs-migration consistency green (PR_FAST).
4. **Feature flags match deployment defaults** — e.g. the priority scheduler is default
   OFF; certifying the flag-ON path does not certify the default-OFF path. Flag-transition
   split-brain is covered (667e718).
5. **No seeded authority** — mechanism tests seed lifecycle authority into isolated DBs;
   readiness reads the real one. Conflating the two is the OCT8_LIFECYCLE_AUTHORITY_ESCAPE
   class.
6. **Same data capability** — provider entitlements are external conditions (IBKR code
   354/200), reported as conditions, never averaged into a verdict.

## 6. What certification cannot do

- It cannot prove alpha or positive expectancy (walk-forward OOS for checked quant combos
  failed; organic closed paper FILLED SELL P&L is 0; real PBO needs sufficient
  observations — see AGENTS.md ground truth).
- It cannot substitute for real-market observation: first-ten-minutes evidence gaps,
  IBKR streaming entitlements, and multi-minute backup behavior on the deployment host
  need the deployment host, not the test tree.
- Synthetic certification (Tier 4) proves engineering capability, not trading edge —
  fixtures are labeled and never presented as organic evidence.
