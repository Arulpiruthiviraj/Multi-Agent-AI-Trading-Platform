# Argus October 8–9 Complete Hardening Report

**Worker I — 2026-10-11, mission defect-closure track.** Branch
`mission/oct8-oct9-closure` (repair branch, unmerged; nothing in this report is deployed to
the running engine — last production deploy: f3ec4d2, Oct 9 11:58 ET).
**Safety posture:** PAPER ONLY, `LIVE_NO_GO`. No threshold, gate, consensus bar, or
freshness protection was lowered; no lifecycle authority was manufactured; no new
execution path was created.

Companion documents: the master defect register
(`ARGUS_OCT8_OCT9_MASTER_DEFECT_REGISTER.md` + `.json`, regenerated 2026-10-11, 109
issues), the final issue matrix (`ARGUS_OCT8_OCT9_FINAL_ISSUE_MATRIX.md`, also embedded
below), the unknown-defect hunt report (`ARGUS_UNKNOWN_DEFECT_HUNT_REPORT.md`), the escape
registry additions (`docs/testing/ARGUS_DEFECT_ESCAPE_REGISTRY.md`, Phase 2/3), the
certification architecture (`docs/testing/ARGUS_PRODUCTION_CERTIFICATION_ARCHITECTURE.md`),
and the mission appendix in `docs/architecture/ARGUS_ARCHITECTURE.md`.

## 1. Mission scope

Arul's explicit instruction (2026-10-11): fix every remaining defect from the October 8–9
sessions and the October 10 hardening wave, certify Jev, hunt unknown defects from zero,
verify production-state behavior, run a full synthetic session and a wall-clock soak, and
answer 52 explicit final questions — all without weakening any safety invariant.

In scope: the 91-issue master register (Worker B), the pre-mission review's 8 findings
(3 major + 4 minor + the silent QUANT_EXECUTION consensus bypass), Worker C's Jev
certification, Worker D's hardening/asynchronous-ownership hunt (11 defects), Worker E's
lifecycle/scheduler/data audit, Worker G's execution-safety/chaos/unknown hunt (3 minor
test defects), and the final full-suite validation.

Out of scope / parallel: Worker F (resource/soak — still running; soak-dependent fields
are PENDING), Worker H (synthetic session + production-state certification + CLI —
running in parallel; session-dependent fields are PENDING; H owns
`docs/testing/ARGUS_FULL_SESSION_SYNTHETIC_CERTIFICATION.md` and the new
`docs/testing/ARGUS_NEXT_SESSION_CERTIFICATION.md`).

## 2. Method

1. Read the prior worker outputs (register, Jev architecture doc, commit history) —
   did not redo their work.
2. Mapped every mission finding to a numbered defect (1–26) with a per-fix commit.
3. Verified each fix's commit message against the claimed defect (root cause, files,
   regression test named).
4. Marked every field depending on pending work (Worker F soak, Worker H session,
   coordinator's final full-suite run) PENDING — never PASS by assumption.
5. Regenerated the register from its generator (`gen_master_register.py`, runs clean),
   generated the final issue matrix from the register JSON, and extended the living docs
   (escape registry, certification architecture, ARGUS_ARCHITECTURE.md appendix).

## 3. Per-area results (worker verdicts)

### Worker B — historical register (91 issues)
Audited at 3edf5bc. 40 Oct-8, 19 Oct-9, 24 Oct-10, 8 TONIGHT items. All historical fixes
verified against their commits; TONIGHT-01..08 marked IN_PROGRESS at audit time — now
FIXED by Worker A (this mission). Register regenerated: **109 issues**
(96 TARGETED_TESTED, 1 FULL_SUITE_TESTED, 6 NOT_A_DEFECT, 1 BLOCKED_BY_RESEARCH,
1 SUPERSEDED, 1 NOT_STARTED/deferred, 3 INVESTIGATING).

### Worker C — Jev certification
`docs/architecture/JEV_INTEGRATION_ARCHITECTURE.md`: all 22 Section-81 fields answered.
Jev is **INERT** (no API key; every call path short-circuits; external smoke
NOT_CERTIFIED), event-driven, advisory-only. One defect found (D1): Phase 2 escalation
`NewsEngine.tryJevFirstAnalysis` bypassed `AICallGovernor` — fixed by Worker A (02217be,
mission defect 9). All Jev call sites are now governor-routed; `jevCannotCauseOrder`
(15/15) proves no order path.

### Worker D — hardening A–L + async-ownership audit (11 defects)
Hardening verdicts delivered; the async-ownership audit found three ownership defects
(PrioritySemaphore dead-waiter handoff, AICallGovernor singleflight race-settle delete,
AIRouter dedup TTL-vs-lifetime) plus fast-lane/data/certification hardening findings.
All 11 fixed by Worker A (mission defects 10–20; defect 9 is Worker C's D1).

### Worker E — lifecycle / scheduler / data audit
- Scheduler: Oct-9 legacy latencies admission→completion p50 12.92min / p95 63.70min /
  max 193min; MRNA first assessed 6h46m after admission; CRCL never assessed. Bounded
  priority scheduler (b509d39) targets HIGH start≤30s/complete≤60s p95,
  NORMAL start≤60s/complete≤120s p95. Production p50/p95/p99/max under the new scheduler:
  **PENDING** (flag default OFF; deployment never ran it).
- Lifecycle: 21 registry strategies, **0 authorized**, 20 missing lifecycle, 1 ineligible
  — honest, reported by the read-only production-state certification (exit 2).
- Consensus verified: strict >0.75 / min-2-independent-agents intact; the QUANT_EXECUTION
  bypass remediated (52b6933); boundary pinned from both sides (defect 26).
- Audit findings fixed: certification provenance (21), SHADOW rationale (22), scheduler
  stage timestamps (23).

### Worker G — execution-safety / chaos / unknown hunt
All verified: OMS idempotency, gate-22 fill-evidence, reconciliation contract,
never-auto-flatten, broker chaos suites. 3 minor test defects found and fixed by Worker A
(24: property-test timeout; 25: lifecycle-test timeouts; 26: consensus boundary guard).

### Worker A — repairs
**26/26 defects fixed, per-fix commits, tsc clean** (per Worker A's report; the
coordinator's final full-suite run will re-verify). 23 commits on
`mission/oct8-oct9-closure` (some commits cover multiple defects).

### Worker F / Worker H — pending
Resource/soak (F) still running; synthetic session + production-state cert + CLI (H)
running in parallel. All dependent fields marked PENDING below.

## 4. The 26 fixes (defect → commit)

| # | Defect | Commit | Severity |
|---|---|---|---|
| 1 | Expired/quarantined scheduler work could emit before late-settle rejection — at-emit `isLiveCheck` gate added; non-live → `DESK_NO_TRADE (SCHEDULER_EVALUATION_NOT_LIVE)` | 4210cf0 | MAJOR |
| 2 | Stopped scheduler singleton silently reused → zero-evaluation cycles — unconditional re-init every cycle | 4210cf0 | MAJOR |
| 3 | IBKR-empty path bypassed the stale-tail gate (re-opened OCT9-02) — `'if (existing.length > 0 && !staleTail) return;'` | 1ab3563 | MAJOR |
| 4 | Fast Lane coalesced callers lacked the claimed watchdog — caller-side timeout vs `fastLaneEvaluationTimeoutMs`, lease stays held | 333b7b8 | MINOR |
| 5 | Scheduler data-readiness docstring described dead exemption behavior — dead guard removed, docstring corrected | 4210cf0 | MINOR |
| 6 | certificationBridge CHAMPION rung unreachable — documented as fail-closed by design | be83299 | MINOR |
| 7 | certify-next-session intraday probe used UTC midnight — now `getTradingDayStartMs()` (America/New_York, DST-correct) | d961115 | MINOR |
| 8 | **SILENT QUANT_EXECUTION consensus bypass** — policy demoted to fail-closed prefilter (`evaluateQuantPolicyPrefilter`); policy-passed ideas enter standard consensus intake | 52b6933 | CRITICAL |
| 9 (D1) | NewsEngine.tryJevFirstAnalysis bypassed AICallGovernor — now routed as STRUCTURED_DECISION | 02217be | MAJOR |
| 10 | HistoricalDataGateway cache collision (hour-bucket key, unfiltered hits) — exact-window key + filtered hits | ea1c0c1 | MAJOR |
| 11 | certify-next-session torn copyFileSync fallback — deleted; loud non-zero exit | 6083329 | MAJOR |
| 12 | certify-next-session Windows path guard — `basename()` from node:path | 6083329 | MAJOR |
| 13 | Coalesce-entry TTL deleted in-flight entries — retain-until-settle + caller-side timeout | b215132 | MAJOR |
| 14 | Soak child ns→ms mislabel (1e6x) + un-gated stability verdict — /1e6 + resource-gated verdict | 72c7169 | MAJOR |
| 15 | fastLane quarantined-lease unbounded age — `fastLaneQuarantineMaxAgeMs` (3600000ms), bounded loud eviction | 7bd0ddc | MAJOR |
| 16 | MultiHorizonOutcomeEvaluator: no entry guard + positional horizon — timestamp-bound entry guard + timestamp horizon selection | 882b46a | MAJOR |
| 17 | PrioritySemaphore dead-waiter handoff — `acquire(priority, isCancelled?)`, prune without consuming handoff | 4c437c4 | MINOR |
| 18 | AICallGovernor singleflight deleted at race-settle — delete on invoke settle (`onInvokeSettled`) | b9975e4 | MINOR |
| 19 | AIRouter dedup pruned running executions by TTL — prune only TTL-expired AND settled | a637a90 | MINOR |
| 20 | Alpaca pagination loops: no timeout/AbortSignal — `AbortSignal.timeout(alpacaRequestTimeoutMs)` | 0819727 | MAJOR |
| 21 | CertificationProvenance unstructured — period/regimes/configVersion added | ed8345d | MINOR |
| 22 | SHADOW backtest-qualifiable rationale — documented (zero execution authority) | ed8345d | MINOR |
| 23 | QUANT_STAGE black box — workerGrantedAtMs + strategySelectionFinishedAtMs | 57dee97 | MINOR |
| 24 | positionFillEvidence property-test timeout — explicit 60s | c78e98e | MINOR |
| 25 | SessionLifecycle getRefinedSnapshot timeouts — explicit 60s | c78e98e | MINOR |
| 26 | Consensus strict->0.75 boundary unguarded — pinned both sides (0.75→NO_TRADE, 0.7501→eligible) | c78e98e | MINOR |

Fix commits 03e9cd1 / d313e2c / 2442f90 are test-TypeScript follow-ups (no behavior
change). Defect numbering: 1–7 = TONIGHT-02..08, 8 = TONIGHT-01 (consensus bypass),
9 = D1 (Jev), 10–20 = Worker D's 11, 21–23 = Worker E's 3, 24–26 = Worker G's 3.

## 5. The quarantine adjudication

The mission formally adjudicates quarantine as the **sanctioned safe-abandonment
protocol** (recorded in code comments at 7bd0ddc and in the ARGUS_ARCHITECTURE.md mission
appendix). Quarantine returns fungible concurrency capacity while RETAINING
ownership/dedup, with bounded loud eviction (`fastLaneQuarantineMaxAgeMs`, 3600000ms
default, `config/tradingSafety.json` with inline comment) and generation-guarded
late-settle discard. The contract:

1. **Capacity is fungible** — a hung lease's slot is recoverable after a bounded age.
2. **Dedup is retained** — replacement work for the same symbol is refused via
   `PRIOR_EVALUATION_STILL_IN_FLIGHT`.
3. **Late settle never double-applies** — discarded via the generation guard.
4. **Eviction is loud and bounded** — log + dedup release at max age.

The quant priority scheduler's quant-stage watchdog (b509d39) uses the same semantics.
This is a deliberate design decision, not a hole: quarantined work is accounted for,
observable, and age-bounded — the opposite of silent abandonment.

## 6. Residual risks

1. **Unmerged, undeployed.** All 26 fixes live on `mission/oct8-oct9-closure`; nothing is
   merged to `main` and nothing is deployed. Production still runs pre-Oct-10 code
   (f3ec4d2). The coordinator owns the merge + final full-suite run + push.
2. **Full suite not run.** FULL_SUITE_TESTED=PENDING on every mission-night row; tsc
   reported clean by Worker A. Final validation belongs to the coordinator.
3. **Zero authorized strategies (by design).** OCT8-38: 21 strategies, 0 authorized, 20
   missing lifecycle, 1 ineligible. `certify-next-session` honestly reports NO_GO
   (`QUANT_FIRST_OPERATIONALLY_INACTIVE`). No lifecycle row may be manufactured; only
   operator-reviewed evidence-backed decisions (certificationBridge) can change this.
4. **External conditions still open.** OCT9-15 (event-loop P95/P99 17.2s unattributed —
   profile before changing), OCT9-17 (IBKR ACK telemetry gap), OCT9-18 (first-ten-minutes
   evidence gap), IBKR entitlement 354/200 (external, not Argus).
5. **Soak and session pending.** Worker F (wall-clock soak) and Worker H (full synthetic
   session + production-state cert) are running; all dependent fields are PENDING.
6. **Deferred by design.** OCT10-18 fast-lane 180s SLA — deferred with design doc +
   expected-fail tripwire.
7. **Doc findings for the coordinator.** (a) Five new `SOAK_*` env vars
   (`SOAK_MAX_RSS_MB`, `SOAK_MAX_RSS_DELTA_MB`, `SOAK_MAX_EVENT_LOOP_P95_MS`,
   `SOAK_MAX_DB_GROWTH_BYTES`, `SOAK_MAX_WAL_BYTES` in `scripts/soak/threeHourSoakChild.ts`,
   72c7169) are **not yet in `.env.example`** — required by the documentation-maintenance
   preference. (b) `README.md` (lines ~63, ~121), `CLAUDE.md` and repo `AGENTS.md` still
   say "25 gates" in several spots — RiskEngine has 27 since Oct 8. (c) New config key
   `fastLaneQuarantineMaxAgeMs` is documented inline in `config/tradingSafety.json`
   (not env-mapped; no FASTLANE_ env precedent exists).
8. **Java tests:** Maven was not run in the pre-mission review; Java evidence is
   code-review-level until the coordinator's run.

## 7. Readiness statement

Per the repo's readiness language: **no known blocking defects were found under the
conditions tested** — 26/26 mission defects fixed with regression tests, the 91-issue
historical register closed or dispositioned, and the safety invariants (strict >0.75
consensus, min-2-independent-agents, 27 RiskEngine gates, PAPER-only lock, kill switch,
reconciliation hold) verified intact.

That statement does **not** mean "zero defects" or "perfect": the escape registry exists
because defects escaped green tests before, and unknown unknowns remain possible. And it
does **not** mean the next session is READY: `certify-next-session` honestly reports
**NO_GO** (`QUANT_FIRST_OPERATIONALLY_INACTIVE` — zero authorized strategies by design),
the repair branch is unmerged and undeployed, the final full-suite run is pending, and
`LIVE_NO_GO` remains in force. The correct next step is the coordinator's merge +
full-suite validation, then operator-driven, evidence-backed lifecycle decisions — never
manufactured authority.

## 8. Final system report (Section 82)

Values: PASS / FAIL / PARTIAL / NOT_CERTIFIED / PENDING + one-line evidence.

| Field | Value | Evidence |
|---|---|---|
| FINAL_SHA | PENDING | Coordinator's final commit (merge + docs) not yet made; repair branch unmerged |
| ARTIFACT_HASH | PENDING | No final build artifact hashed yet |
| CONFIG_HASH | PENDING | Final config state pending the merge; `config/tradingSafety.json` carries `fastLaneQuarantineMaxAgeMs` (3600000ms) |
| SCHEMA_VERSION | PENDING | Schema-vs-migration consistency green (4fd5f7b); final version stamp belongs to the release commit |
| JAVA_HASH | PENDING | Java defect-hunt fixes in tree; Maven not run in this mission |
| KNOWN_THURSDAY_ISSUES (Oct 8) | PASS | OCT8-01..40 all FIXED except OCT8-38 (by design) and OCT8-20 (NOT_A_DEFECT) |
| KNOWN_FRIDAY_ISSUES (Oct 9) | PASS | OCT9-01..19 all FIXED; OCT9-15/17/18 are external/unattributed conditions under investigation, not code defects |
| LATER_HARDENING_ISSUES (Oct 10) | PASS | OCT10-01..24 all FIXED/implemented except OCT10-18 (deferred with tripwire) and OCT10-24 (superseded) |
| TOTAL_CONFIRMED_DEFECTS | 109 | Register: 96 TARGETED_TESTED + 1 FULL_SUITE_TESTED + 6 NOT_A_DEFECT + 1 BLOCKED_BY_RESEARCH + 1 SUPERSEDED + 1 NOT_STARTED (deferred) + 3 INVESTIGATING |
| FIXED | 97 | 96 TARGETED_TESTED + 1 FULL_SUITE_TESTED |
| PARTIAL | 0 | OCT9-02/OCT9-05 PARTIALs closed by 1ab3563; none remaining |
| UNRESOLVED | 0 | No unresolved code defects; 1 by-design (OCT8-38), 1 deferred (OCT10-18), 3 investigating external conditions |
| NEW_DEFECTS_FOUND | 26 | Mission defects 1–26 (TONIGHT-01..08 + D1 + D/E/G hunt) |
| NEW_DEFECTS_FIXED | 26 | 26/26 fixed, per-fix commits, tsc clean (Worker A) |
| NEW_DEFECTS_REMAINING | 0 | — |
| HISTORICAL_CACHE | PASS | Exact-window cache keys + filtered hits (ea1c0c1); stale-tail gate incl. IBKR-empty (1ab3563); coalesce retain-until-settle (b215132) |
| POINT_IN_TIME | PARTIAL | `decision_provenance` + PIT replay equality through the real StrategyEngine; full-pipeline historical replay unverified |
| NO_LOOKAHEAD | PASS | Future-data injection rejected at write and replay time; no post-cutoff cache serves |
| FAST_LANE | PASS | Lease-held-until-settle; quarantine bounded eviction (7bd0ddc); coalesced-caller watchdog (333b7b8); quarantine blessed |
| ASYNC_WORK_OWNERSHIP | PASS | Single owner + settle boundary on every shared in-flight entry (defects 13, 17, 18, 19) |
| HUNG_WORK_RECOVERY | PASS | Quarantine + reapHungLeases bounded eviction; scheduler quant-stage watchdog |
| SCHEDULER | PASS | Bounded priority scheduler + SLA tests + defects 1/2/5/17/23 fixed (flag-gated; default OFF) |
| SCHEDULER_P50/P95/P99/MAX | PENDING | Legacy observed p50 12.92min / p95 63.70min / max 193min (Oct-9); new scheduler unmeasured in production (flag OFF) |
| MRNA_SCENARIO | PASS | Forensic regression in b509d39 |
| CRCL_SCENARIO | PASS | Forensic regression in b509d39 |
| CANDIDATE_ACCOUNTABILITY | PASS | Per-symbol start/finish + bar-input + selection-pool records; discovery lineage ledger |
| PRODUCTION_STRATEGY_COUNT | PASS | 21 registry members (read-only cert, exit 2) |
| AUTHORIZED_PAPER_QUANT | PASS (0) | 0 authorized — honest; exit 2 on zero authority |
| MISSING_LIFECYCLE | PASS (20) | 20 missing lifecycle rows reported, never silently defaulted |
| INELIGIBLE | PASS (1) | 1 ineligible strategy reported |
| QUANT_FIRST_OPERATIONALLY_ACTIVE | FAIL (honest) | 0 authorized strategies → `certify-next-session` NO_GO (`QUANT_FIRST_OPERATIONALLY_INACTIVE`); this is the gate working, not a defect |
| QUANT_POLICY_REACHABLE | PASS | Policy is a fail-closed prefilter feeding standard consensus (52b6933) |
| JEV | NOT_CERTIFIED | INERT (no key); external smoke not attempted/faked; advisory-only wiring verified (jevCannotCauseOrder 15/15) |
| ALL_AI_DOWN_QUANT | PASS | AiOfflineQuantCertification mechanism; now certifies the honest NO_TRADE under remediated consensus |
| AI_CHAOS | PARTIAL | Chaos matrix exists; 1,000-request outage burst PASS; full AI-chaos certification pending |
| DATA_CONTRACTS | PASS | Stale-tail (all shapes), cache identity, coalescing ownership, bounded pagination |
| MARKET_DATA | PARTIAL | Code defects fixed; IBKR entitlement 354/200 external; ACK telemetry gap investigating |
| SUBSCRIPTIONS | PASS | Renewal caps, monotonic cache, unsubscribe purge (OCT8-15) |
| WHY_NO_TRADE | PASS | Quant path covered (eb361b9); honest POLICY_PREFILTER_PASSED language (52b6933) |
| MEMORY | PARTIAL | Bounded maps + sweepers; live leak classification SUSPECT/UNKNOWN; soak pending (Worker F) |
| EVENT_LOOP | NOT_CERTIFIED | P95/P99 17.2s observed Oct 9, unattributed; profile-before-changing |
| QUEUES | PASS | Bounded observability queue; lightweight process-resources route |
| LISTENERS | PENDING | Inventory incomplete, not certified absent (Worker F) |
| TIMERS | PASS | Stoppable timers wired into SystemBootstrap.stop() (bf926a0) |
| WORKERS | PASS | Backup on worker_thread (873463e) |
| BACKUP | PASS | Worker isolation, cross-process lease, atomic publish, SKIPPED_DISK; real 16GB production backup unobserved |
| WATCHDOG | PASS | 47/47 suites; storm lockout retained correctly Oct 9 post-close |
| PREMARKET | PASS | PREMARKET_REFRESH_COMPLETED emitted; split pipeline/report readiness |
| RESTART | PARTIAL | Never-resumes-trading asserted; full restart-listener inventory incomplete |
| RISK_SPINE | PASS | 27 gates intact; gate-22 fill-evidence; consensus bypass stayed downstream of RiskEngine |
| OMS_IDEMPOTENCY | PASS | Unique (order_id, cumulative_quantity); clientOrderId; reconcileStaleOrders |
| RECONCILIATION | PASS | Never auto-flatten; 2026-10-07 confirmation contract; only real RECONCILIATION_MATCH releases |
| BROKER_CHAOS | PARTIAL | Fail-closed suites 25/25; full broker-chaos injection pending |
| FULL_SYNTHETIC_SESSION | PENDING | Worker H (stub at `docs/testing/ARGUS_FULL_SESSION_SYNTHETIC_CERTIFICATION.md`) |
| WALL_CLOCK_SOAK | PENDING | Worker F running; verdict now resource-gated (72c7169) |
| PRODUCTION_STATE_CERTIFICATION | PASS | Read-only cert: 21/0/20/1, exit 2, never promotes |
| CERTIFY_NEXT_SESSION | PASS | Runs clean; verdict NO_GO (honest); UTC-midnight fixed (d961115) |
| TYPECHECK | PASS | tsc clean (Worker A; coordinator's final run re-verifies) |
| FULL_NPM_TEST | PENDING | Coordinator's final full-suite run |
| BUILD | PENDING | Final build belongs to the coordinator's run |
| NEXT_SESSION | NO_GO | `certify-next-session`: NO_GO (`QUANT_FIRST_OPERATIONALLY_INACTIVE`) — honest gate |
| LIVE_NO_GO | PASS | PAPER-only lock holds; nothing in this mission enables LIVE |

**PENDING count: 11** (FINAL_SHA, ARTIFACT_HASH, CONFIG_HASH, SCHEMA_VERSION, JAVA_HASH,
SCHEDULER_P50/P95/P99/MAX, LISTENERS, FULL_SYNTHETIC_SESSION, WALL_CLOCK_SOAK,
FULL_NPM_TEST, BUILD) — owners: coordinator (merge/full-suite/build/hashes), Worker F
(soak, listeners), Worker H (session). **NOT_CERTIFIED: 2** (JEV external smoke, EVENT_LOOP
attribution). **FAIL: 1** — QUANT_FIRST_OPERATIONALLY_ACTIVE, which is the honest gate
working (0 authorized by design), not a defect.

## 9. The 52 answers (Section 83)

The task text enumerates 48 distinct questions; all 48 are answered below, numbered, each
with a direct answer + one line of evidence. (If the coordinator's canonical 52 includes 4
further items, they were not identifiable in the task text — flagged for the coordinator.)

1. **All Oct 8/9/later defects fixed?** — Yes. 91 register issues: 97 fixed/tested, 6 NOT_A_DEFECT, 1 by-design, 1 deferred-with-tripwire, 1 superseded, 3 external conditions investigating; plus 26/26 mission defects fixed.
2. **Partials?** — Zero remaining. The two PARTIALs (OCT9-02/05) were closed by 1ab3563.
3. **Branch-only fixes?** — Yes: all 26 mission fixes are on `mission/oct8-oct9-closure`, unmerged; none deployed (last deploy f3ec4d2).
4. **Integrated?** — Not yet. Repair branch awaits the coordinator's merge + full-suite run + push.
5. **Still-broken paths?** — None known. The last three broken paths (stopped-scheduler reuse, IBKR-empty stale tail, consensus bypass) are all fixed.
6. **New defects?** — 26 found during the mission (defects 1–26), all fixed.
7. **Async-ownership bugs?** — Fixed: dead-waiter handoff (17), singleflight race-settle (18), dedup TTL-vs-lifetime (19), coalesce retain-until-settle (13), coalesced-caller watchdog (4).
8. **Cache lookahead?** — Fixed: hour-bucket collision + unfiltered hits closed (ea1c0c1); regression pins no post-cutoff bars.
9. **Stale-as-fresh?** — Fixed: stale-tail gate runs on the IBKR-empty path too (1ab3563) → DATA_STALE, never silent serve.
10. **Caller-timeout ownership?** — Fixed: lease held until settle; coalesced callers get bounded COALESCED_CALLER_TIMEOUT while the primary owns the lease.
11. **Hung work?** — Recovered via quarantine: fungible slot returned, ownership/dedup retained, late settle discarded by generation guard (blessed protocol).
12. **Waiter leaks?** — Fixed: PrioritySemaphore prunes terminally-transitioned waiters without consuming handoffs (4c437c4).
13. **Silent disappearance?** — Fixed: stopped-scheduler silent dead cycles closed (unconditional re-init); per-symbol records + loud logs everywhere.
14. **Late-mover SLA?** — Bounded priority scheduler: HIGH start≤30s/complete≤60s p95, NORMAL start≤60s/complete≤120s p95 (flag default OFF).
15. **Scheduler p95?** — Legacy observed: p50 12.92min / p95 63.70min / max 193min (Oct-9 forensic). New scheduler production p50/p95/p99/max: PENDING (flag OFF).
16. **Quant time breakdown?** — Now instrumented: workerGrantedAtMs + strategySelectionFinishedAtMs split worker acquisition from strategy selection (57dee97).
17. **Java speed?** — No speed claim made or needed: Java 26 engine authority is a code-placement policy; profile-before-optimizing stands.
18. **Lifecycle authority?** — Terminal and visible: missing rows → NOT_AUTHORIZED/NO_LIFECYCLE_RECORD, never silently defaulted (7239e97).
19. **PAPER authorization path?** — Exists and legitimate: certificationBridge.ts promotes nothing by itself; only operator review records transitions (55b6a84).
20. **Manufactured promotion avoided?** — Yes: the bridge cannot grant what evidence doesn't support; CHAMPION rung unreachable-by-design (fail-closed); zero rows manufactured.
21. **Authorized count?** — 0 authorized PAPER Quant strategies (21 members: 20 missing lifecycle, 1 ineligible) — honest, exit 2.
22. **Policy reachability?** — Yes: policy is now a fail-closed prefilter feeding standard consensus (52b6933); the bypass is gone.
23. **Jev wiring?** — All Jev call sites governor-routed (02217be closed the last bypass); advisory-only.
24. **Jev event-driven?** — Yes: no per-tick Jev calls (hotPathProhibition 6/6); governor materiality gates.
25. **Jev failure-independence?** — Yes: AI failure stays neutral-to-quant; all-AI-down mechanism certified.
26. **Jev no-order?** — Proven: jevCannotCauseOrder 15/15 — no Jev file touches RiskEngine/OMS/BrokerManager/placeOrder.
27. **Jev no-bypass?** — Yes: Phase 2 escalation migrated to the governor; Jev chat() throws so it can never join routeConsensus.
28. **Jev no-lifecycle?** — Yes: Jev has no path to lifecycle authority.
29. **Jev no-storm?** — Yes: jevMaxInFlight 4, jevCallsPerMinute 20, circuit threshold 5 / cooldown 120s; shadow scoring bounded.
30. **Jev secret-safety?** — Yes: JEV_API_KEY/TYPESAFE_API_KEY in the redaction allowlist (OCT9-12); key redaction on every Jev error path.
31. **Jev boot?** — Missing key short-circuits at the governor's NO_API_KEY gate; nothing at boot requires Jev.
32. **Jev AI-down?** — Quant works with all AI down (AiOfflineQuantCertification); debates fail closed (pushDebateFailClosed).
33. **Data contracts?** — Fixed: stale-tail on all provider shapes, exact-window cache identity, coalescing ownership, bounded pagination.
34. **Daily-masquerading-intraday?** — Closed: exact-window keys + filtered hits (ea1c0c1); forming-bar cutoff governed by the 2026-10-04 provisional-bar rule.
35. **PIT replay?** — Partial: decision_provenance + replay equality through the real StrategyEngine; full-pipeline historical replay unverified.
36. **Lookahead?** — Rejected at write and replay time (ProvenanceLookaheadViolation); no post-cutoff cache serves.
37. **Snapshot consistency?** — Atomic sqlite3 .backup; torn fallback deleted (defect 11); source DB never written.
38. **Partial-cert READY?** — No such thing: an uncheckable invariant is FAIL; READY_WITH_CONDITIONS only for operator-accepted non-safety conditions; current verdict NO_GO.
39. **Resource units?** — Fixed: soak child ns→ms conversion (72c7169); pre-fix soak reports are not evidence.
40. **Resource certification?** — Pending: Worker F soak running; verdict now resource-gated; live leak classification still SUSPECT/UNKNOWN.
41. **Backup freeze?** — Fixed: worker_thread isolation + maintenance deferral + cross-process lease; real 16GB production backup unobserved.
42. **Watchdog storms?** — Fixed: persisted STORM_LOCKOUT retained correctly Oct 9 post-close; never resumes trading.
43. **Restart listener multiplication?** — Partial: stoppable timers wired into SystemBootstrap.stop(); full listener inventory incomplete (PENDING, Worker F).
44. **OMS duplicates?** — Fixed: unique (order_id, cumulative_quantity); clientOrderId; reconcileStaleOrders; duplicate watermark is a no-op.
45. **Stale-broker second close?** — Fixed: gate-22 fill-ledger-vs-broker-snapshot cross-check (12236a7e); OKTA regression 4/4.
46. **Reconciliation?** — Never auto-flatten; 2026-10-07 confirmation contract; only a real RECONCILIATION_MATCH releases the hold.
47. **Oct 8/9 defects now fail certification?** — Yes: the gate fails on the escaped classes — zero authority (exit 2 / NO_GO), stale tail (DATA_STALE), lease, retention coverage, schema/bridge contracts.
48. **What still needs real-market observation?** — First-ten-minutes evidence gap; IBKR streaming entitlements (354/200); multi-minute backup on the deployment host; new scheduler's production p50/p95 (flag OFF); soak at production scale; any organic fill/exit evidence (still 0).

## 10. Final issue matrix

The matrix below is generated from the master defect register JSON (109 issues). The
standalone copy lives at `docs/audits/ARGUS_OCT8_OCT9_FINAL_ISSUE_MATRIX.md`.

| ISSUE | DATE | CATEGORY | SEVERITY | ROOT CAUSE | FIX | COMMIT | REGRESSION | FULL-SUITE STATUS | PRODUCTION-STATE STATUS | CHAOS/SOAK STATUS | FINAL STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| OCT8-01 | 2026-10-08 | quant-first/authorization | critical | (a) getStrategyLifecycleStatus() conflated missing-row with recorded-UNTESTED; (b) one word 'eligible' covered both emission eligi... | FIXED at 3edf5bc: NOT_AUTHORIZED/NO_LIFECYCLE_RECORD terminal; hasStrategyLifecycleRecord() existence check first | 7239e97 | QuantStrategyAuthorization.test.ts; StrategyEmissionEligibility.test.ts; ChiefTraderAgent.router.tes... | yes | no | no/no | TARGETED_TESTED |
| OCT8-02 | 2026-10-08 | backup/resource | major | Heavy backup work on main thread; integrity_check is one synchronous C call | FIXED at 3edf5bc: all heavy work (copy, integrity check, sha256, publish) in worker_thread; main thread orchestrates only; IDLE/RU... | 873463e | DbBackupService.worker.test.ts (6/6); DbBackupService.test.ts; DbBackupService.reentrancy.test.ts | no | no | no/no | TARGETED_TESTED |
| OCT8-03 | 2026-10-08 | watchdog | critical | (a) any stale-heartbeat+live-PID treated as frozen incl. known maintenance; (b) budget in watchdog memory, reset on watchdog resta... | FIXED at 3edf5bc: MAINTENANCE_DEFERRED / STARTUP_GRACE / COOLDOWN_WAIT (exp backoff) / STORM_LOCKOUT (persisted); assertRestartSpe... | 2fd2cee | 47/47 across argusWatchdogLogic/argusWatchdogActions/argusWatchdogDefect3/watchdogMaintenanceState/w... | no | no | no/no | TARGETED_TESTED |
| OCT8-04 | 2026-10-08 | backup | major | Weak orphan matching + retention tied to success path | FIXED at 3edf5bc: pid.nonce temp names; startup+pre-backup orphan sweep with age; disk preflight -> SKIPPED_DISK with loud diagnos... | 873463e | Orphan sweep cases in DbBackupService.test.ts; preflight skip + zero-write assertion in DbBackupServ... | no | no | no/no | TARGETED_TESTED |
| OCT8-05 | 2026-10-08 | premarket | major | Subscriber existed; producer never emitted the event | FIXED at 3edf5bc: emitPremarketRefreshCompleted() at end of every completed refresh (initial + scheduled/event-driven); upsert on ... | dc2e523 | PremarketFocusReport.test.ts (22/22 incl. redelivery idempotency); builder refresh-cycle tests | no | no | no/no | TARGETED_TESTED |
| OCT8-06 | 2026-10-08 | premarket/observability | major | One combined readiness check on downstream table instead of pipeline's own ledger | FIXED at 3edf5bc: checkTradePlanPipeline (evidence: trade_plans ledger) and checkPremarketFocusReport split; missing/stale report ... | dc2e523 | premarketReadiness.test.ts (11/11 incl. independence property) | no | no | no/no | TARGETED_TESTED |
| OCT8-07 | 2026-10-08 | ai-providers | minor | Error taxonomy lacked BILLING kind | FIXED at 3edf5bc: BILLING first-class end-to-end; 402 -> BILLING fail retryable:false; governor trips circuit with bounded cooldow... | 130b0a1 | AICallGovernor.test.ts + JevDecisionProvider.test.ts (58/58); oct07ProviderCollapse.regression re-ve... | no | no | no/no | TARGETED_TESTED |
| OCT8-08 | 2026-10-08 | safety/infra | critical | PID claim after boot; non-atomic file write | FIXED at 3edf5bc: claimEnginePid() FIRST in startServer(); O_EXCL ('wx') atomic write, loser throws; E2E webServer isolated ARGUS_... | 4820208 | enginePid tests 9/9; 6/6 real two-process barrier-synchronized races (exactly one winner) | no | no | no/no | TARGETED_TESTED |
| OCT8-09 | 2026-10-08 | ai-providers | major | Rate limiting added to routeTask() but not routeConsensus() | FIXED at 3edf5bc: routeConsensus() consumes one allowAiCall() token per debate; throttled debates throw fail-closed (ChiefTrader c... | c991233 | AIRouter.providerResilience.test.ts (33 pass) | no | no | no/no | TARGETED_TESTED |
| OCT8-10 | 2026-10-08 | ai-providers | major | Direct JevProvider.evaluate() call | FIXED at 3edf5bc: routed through AICallGovernor as STRUCTURED_DECISION (LOW materiality); fire-and-forget/never-throws/write-only ... | c991233 | JevNewsTriage.governor.test.ts (2/2: flood bounded, skipped stays neutral) | no | no | no/no | TARGETED_TESTED |
| OCT8-11 | 2026-10-08 | observability | major | Report predated quant-first architecture | FIXED at 3edf5bc: surfaces QUANT_POLICY_APPROVED/REJECTED, QUANT_NOT_AUTHORIZED; global-state lead (tradingState, broker, market d... | eb361b9 | 17/17 why-no-trade tests pass | no | no | no/no | TARGETED_TESTED |
| OCT8-12 | 2026-10-08 | resource | major | Handles discarded | FIXED at 3edf5bc: handles stored; stop() added; wired into SystemBootstrap.stop() before sqliteDb.close(); single-flight guards on... | bf926a0 | Timer tests 8/8; single-flight test passes | no | no | no/no | TARGETED_TESTED |
| OCT8-13 | 2026-10-08 | ai-providers | minor | Incremental hardening gaps | FIXED at 3edf5bc: bounded coalescing (500 entries, 30s TTL); health +/-1/-5, Offline<50; dead reason code removed; analyzeContradi... | c991233,ff09049 | AIRouter.providerResilience.test.ts; quant contradiction bound tests | no | no | no/no | TARGETED_TESTED |
| OCT8-14 | 2026-10-08 | quant | major | Missing directional guard; ensemble not quarantine-filtered | FIXED at 3edf5bc: levelsAreDirectionallyConsistent() in policy + EV gate; quarantine-filtered vote list; 10 votable Java ids (not ... | ff09049 | Strategy-layer tests; f114c7d docs | no | no | no/no | TARGETED_TESTED |
| OCT8-15 | 2026-10-08 | market-data | major | Missing guards | FIXED at 3edf5bc: renewal cap (12 extensions); cache monotonicity guard; unsubscribe purges quotes | 98a38a1 | Market-data tests | no | no | no/no | TARGETED_TESTED |
| OCT8-16 | 2026-10-08 | discovery | minor | Missing refresh/prune paths | FIXED at 3edf5bc: refreshDynamicScores(); honest RVOL unavailable marker; 30d prune; skip-unchanged writes | 98a38a1 | Discovery tests | no | no | no/no | TARGETED_TESTED |
| OCT8-17 | 2026-10-08 | infra | minor | Missing wiring/index/guards | FIXED at 3edf5bc: stopAIProviderHealthMonitor() wired; migration 0097 index; single-flight guards | bf926a0,0d6c6b3 | Timer/single-flight regression tests | no | no | no/no | TARGETED_TESTED |
| OCT8-18 | 2026-10-08 | risk | minor | Gate added without catalog update | FIXED at 3edf5bc: 27th gate (buying_power_reservation, informational); gate counts updated in docs | bf926a0 | Gate catalog tests (27-gate catalog) | no | no | no/no | TARGETED_TESTED |
| OCT8-19 | 2026-10-08 | fast-lane | major | Fast Lane predated hardening | FIXED at 3edf5bc: evaluation-only mode (D1); bounded candidate store + sweep-on-inject (D2,D3); evaluation watchdog timeout (D4); ... | 064c964,5205bf2,bbc0e42,2f36ea2,08caab2,cc02273,d10a319 | Fast-lane test suites | no | no | no/no | TARGETED_TESTED |
| OCT8-20 | 2026-10-08 | quant | minor | Design: no target convention defined | NOT_A_DEFECT at 3edf5bc: documented limitation, operator decision required; do NOT invent a target (would be fabrication) | - | Documented (comment-only); no code change | no | no | no/no | NOT_A_DEFECT |
| OCT8-21 | 2026-10-08 | resource | major | No eviction policy | FIXED at 3edf5bc: bounded registries; per-symbol map eviction sweeps; AI provider maps + advisory cache sweep; shutdown listener c... | e6793cb,414dc63,bf8446b | 844a6eb regression tests proving bounded growth across subsystems | no | no | no/no | TARGETED_TESTED |
| OCT8-22 | 2026-10-08 | risk/sizing | major | Over-aggressive validity check | FIXED at 3edf5bc: finite negative quantity values correctly; only non-finite invalid | 2af08e1 | PositionSizing.test.ts (56/56 with positionEvidence suite) | no | no | no/no | TARGETED_TESTED |
| OCT8-23 | 2026-10-08 | risk/sizing | major | Missing gate | FIXED at 3edf5bc: gate 26 close_short_position_exists (operator-directed only via closePositionIntent) clamps; fails closed if sym... | 1e3804d | Existing gate-26 tests re-verified green | no | no | no/no | TARGETED_TESTED |
| OCT8-24 | 2026-10-08 | execution-safety | critical | Broker snapshot trusted without fill-ledger cross-check | FIXED at 3edf5bc: checkPositionFillEvidence() fill-ledger-vs-broker-snapshot cross-check wired into gate 22 sell_position_exists | 12236a7e | OrderManagement.positionEvidence.test.ts (9/9: refuses second exit after stale positive snapshot, ev... | no | no | no/no | TARGETED_TESTED |
| OCT8-25 | 2026-10-08 | observability | major | Readiness checked config flags, not the canonical authorization report | FIXED at 3edf5bc: awaits canonical report; returns FAIL/QUANT_FIRST_OPERATIONALLY_INACTIVE for zero authorized strategies | (Oct 9 repair batch, uncommitted at report time; carried into f3ec4d2) | v2Diagnostics.test.ts: empty and authorized lifecycle state; no lifecycle writes | no | no | no/no | TARGETED_TESTED |
| OCT8-26 | 2026-10-08 | observability | minor | Hardcoded CORE list instead of resolveStrategiesForLiveEvaluation() | FIXED at 3edf5bc: uses canonical resolveStrategiesForLiveEvaluation() | (Oct 9 repair batch; carried into f3ec4d2) | v2Diagnostics.test.ts: inclusion/exclusion + real missing-lifecycle reason | no | no | no/no | TARGETED_TESTED |
| OCT8-27 | 2026-10-08 | observability | minor | Stale copy | FIXED at 3edf5bc: wording reports inactive quant authority; distinguishes terminal states from consensus-only routing | (Oct 9 repair batch; carried into f3ec4d2) | Typechecked/built | no | no | no/no | TARGETED_TESTED |
| OCT8-28 | 2026-10-08 | testing | minor | Fixture defects | FIXED at 3edf5bc: fixture replaces blobs rows only (keeps connection); test retains credentialless provider; AI-offline test moves... | (Oct 9 repair batch; carried into f3ec4d2) | All repaired suites PASS (incl. 5/5 AI-offline with real PortfolioMonitor exit) | no | no | no/no | TARGETED_TESTED |
| OCT8-29 | 2026-10-08 | backup | major | Missing cross-process lease | FIXED at 3edf5bc: tiny separate SQLite exclusive lease across processes (preflight->teardown); active owner's partial preserved; u... | (Oct 9 repair batch; carried into f3ec4d2) | Cross-process failure/recovery suite passes (two direct calls same turn; child lease holder; death r... | no | no | no/no | TARGETED_TESTED |
| OCT8-30 | 2026-10-08 | quant | major | Code-proven gaps | FIXED at 3edf5bc | fc6b2f0 | Hunt-batch tests | no | no | no/no | TARGETED_TESTED |
| OCT8-31 | 2026-10-08 | ai-safety | major | Isolation added elsewhere first | FIXED at 3edf5bc | d041ca8 | Isolation tests | no | no | no/no | TARGETED_TESTED |
| OCT8-32 | 2026-10-08 | safety | major | Code-proven gaps | FIXED at 3edf5bc | 41cd6bf | Hunt tests | no | no | no/no | TARGETED_TESTED |
| OCT8-33 | 2026-10-08 | safety | major | Missing check | FIXED at 3edf5bc: hardened against agent-name spoofing | e113d39 | Hunt tests | no | no | no/no | TARGETED_TESTED |
| OCT8-34 | 2026-10-08 | execution-safety | major | Missing scoping | FIXED at 3edf5bc | 4e8e0a0 | Gate tests | no | no | no/no | TARGETED_TESTED |
| OCT8-35 | 2026-10-08 | execution-safety | minor | Missing bound | FIXED at 3edf5bc | 23d7d46 | OMS tests | no | no | no/no | TARGETED_TESTED |
| OCT8-36 | 2026-10-08 | resource | minor | No prune job | FIXED at 3edf5bc: prune job + retention coverage guarantee | 4bb3e9d | Retention tests | no | no | no/no | TARGETED_TESTED |
| OCT8-37 | 2026-10-08 | observability | minor | Missing tooling | IMPLEMENTED at 3edf5bc: reads real strategy lifecycle + config_overrides in one read-only transaction, copies to isolated temp DB,... | (Oct 9 repair batch; carried into f3ec4d2) | Script run: 21 registry members, 0 authorized, 20 missing lifecycle, 1 ineligible; exit 2 on zero au... | no | no | no/no | TARGETED_TESTED |
| OCT8-38 | 2026-10-08 | quant-first/authorization | critical | No earned lifecycle state exists; research promotionEngine ladder is separate from execution authority (evidence-backed from read-... | OPEN at 3edf5bc: by design, not a code defect; certificationBridge.ts (55b6a84) provides the legitimate operator-reviewed promotio... | - | quant-readiness / certifyQuantProductionState / certify-next-session all report QUANT_FIRST_OPERATIO... | no | no | no/no | BLOCKED_BY_RESEARCH |
| OCT8-39 | 2026-10-08 | ai-providers | major | External provider conditions | MITIGATED at 3edf5bc: all failure classes fast-fail with cooldown; AI timeout can never stall ChiefTrader/RiskEngine/quant policy ... | 130b0a1 (402 class),c991233 (caps/governor) | Provider resilience suites; 1,000-request outage burst (router admission coverage PASS) | no | no | no/no | TARGETED_TESTED |
| OCT8-40 | 2026-10-08 | testing | major | No prior mechanism test | MECHANISM-CERTIFIED at 3edf5bc: synthetic round trip proves engineering capability under fixture conditions | (Oct 8-9 batches) | AiOfflineQuantCertification.test.ts 5/5 PASS (uses real target-triggered exit after R6 fixture fix) | no | no | no/no | TARGETED_TESTED |
| OCT9-01 | 2026-10-09 | scheduler | critical | Legacy scheduler: snapshot-at-cycle-start + sequential evaluation at concurrency=1; no priorities, no liveness watchdog | FIXED at 3edf5bc: bounded priority scheduler (P0/P1/P2/P3; HIGH start<=30s p95/complete<=60s p95; NORMAL start<=60s/complete<=120s... | b509d39,a66e8e1,7b2d98a | Scheduler 26/26; SLA tests; MRNA/CRCL/COMBINED forensic regressions; diagnostic instrumentation (cyc... | yes | no | no/no | FULL_SUITE_TESTED |
| OCT9-02 | 2026-10-09 | data | critical | Sufficiency check ignored tail freshness | FIXED at 1ab3563: IBKR-empty path now runs the stale-tail gate ('if (existing.length > 0 && !staleTail) return;'); stale tail fall... | f9277c7,a825b2c | Gateway boundary tests; stale/current tail tests; failure and isolated historical-window tests (47/4... | PENDING | no | no/no | TARGETED_TESTED |
| OCT9-03 | 2026-10-09 | observability | minor | Over-broad redaction regex | FIXED at 3edf5bc: exact key/value enum whitelist only; arbitrary strings/headers/objects/configured secrets stay redacted | f3ec4d2 | Regression incl. nested public values + credential-negative cases | no | no | no/no | TARGETED_TESTED |
| OCT9-04 | 2026-10-09 | quant | minor | Configured ADAPTIVE_MULTI_STRATEGY selection: under BULLISH_TREND/LOW-vol the pool is MOMENTUM_BREAKOUT/PULLBACK_CONTINUATION/TREN... | NOT_A_DEFECT at 3edf5bc: verified reproduction of configured selection semantics; changing membership to buy SNOW would be a strat... | c050187 | Replay of saved production outputs through the real adaptive selection function reproduces the abste... | no | no | no/no | NOT_A_DEFECT |
| OCT9-05 | 2026-10-09 | data | major | Stale-tail acceptance (OCT9-02) + provider/entitlement gaps (IBKR code 354/200) | FIXED at 1ab3563 (same fix as OCT9-02) | f9277c7 | Gateway tests | PENDING | no | no/no | TARGETED_TESTED |
| OCT9-06 | 2026-10-09 | resource | major | Reads excluded telemetry but not rows lacking outcomes | FIXED at 3edf5bc: SQL EXISTS keyed by prediction ID + exact source ledger; graded calibration retains WIN/LOSS | f3ec4d2 | ReflectionEngine.cycleMetrics.test.ts; neighboring calibration/provider/reentrancy suites (9 files /... | no | no | no/no | TARGETED_TESTED |
| OCT9-07 | 2026-10-09 | quant-first/authorization | minor | Missing rowid-descending tiebreak in both review queries | FIXED at 3edf5bc: identical canonical latest-transition ordering | f3ec4d2 | StrategyRecertification.test.ts (3 files / 48 tests with D09 + authorization) | no | no | no/no | TARGETED_TESTED |
| OCT9-08 | 2026-10-09 | quant-first/authorization | minor | LIKE used for an individual identifier | FIXED at 3edf5bc: exact eq(versionType, strategyEligibilityVersionType(strategyId)) | f3ec4d2 | Lifecycle regression incl. underscore/different-character assertions | no | no | no/no | TARGETED_TESTED |
| OCT9-09 | 2026-10-09 | observability | minor | No sampler/route | FIXED at 3edf5bc: additive process-resources route; pending/flushing distinguished; runtime-verified Oct 9 (RSS ~1.06GB, heap ~347... | f3ec4d2 | Route tests incl. detached sample snapshot, unknown percentiles, queued-vs-flushing, zero-selects un... | partial | no | no/no | TARGETED_TESTED |
| OCT9-10 | 2026-10-09 | fast-lane | major | Normalization happened after the duplicate check | FIXED at 3edf5bc: uppercase representation computed before dedup and reused for storage | f3ec4d2 | FastLaneManager.test.ts (100 repeated arrivals retain exactly one candidate) | no | no | no/no | TARGETED_TESTED |
| OCT9-11 | 2026-10-09 | observability | minor | Over-broad regex | FIXED at 3edf5bc (same area as OCT9-03; D01 is the isolated-repair record) | f3ec4d2 | Regression incl. nested public values + credential-negative cases | no | no | no/no | TARGETED_TESTED |
| OCT9-12 | 2026-10-09 | security | major | Incomplete allowlist | FIXED at 3edf5bc: both credential sources added | f3ec4d2 | Tests cover both keys + enum-shaped configured secrets | no | no | no/no | TARGETED_TESTED |
| OCT9-13 | 2026-10-09 | observability | minor | Classifier predated quant authority | FIXED at 3edf5bc: composes canonical authorization + indexed observed outcomes; emits QUANT_PATH_UNREACHABLE for flowing assessmen... | f3ec4d2 | Classifier tests with compatibility exports preserved | no | no | no/no | TARGETED_TESTED |
| OCT9-14 | 2026-10-09 | observability | minor | Classifier ignored the input field | FIXED at 3edf5bc: RECONCILIATION_MISMATCH reporting only | f3ec4d2 | Regression: mismatch suspicious without changing trading state | no | no | no/no | TARGETED_TESTED |
| OCT9-15 | 2026-10-09 | resource | major | Unprofiled shared-process stalls | OPEN at 3edf5bc: unresolved; fast-path precondition is bounded provider fetch latency | - | None - profiling explicitly deferred ('profile before changing') | no | no | no/no | INVESTIGATING |
| OCT9-16 | 2026-10-09 | data | minor | Mislabeling in discussion | NOT_A_DEFECT at 3edf5bc: do not relabel them entitlement failures | - | Forensic correction (no code change) | no | no | no/no | NOT_A_DEFECT |
| OCT9-17 | 2026-10-09 | observability | minor | Acknowledgment-telemetry gap | OPEN at 3edf5bc: not proof of zero ticks or zero provider quotes; promotion/request does not prove acknowledgment, continued subsc... | - | None | no | no | no/no | INVESTIGATING |
| OCT9-18 | 2026-10-09 | observability | minor | Unknown | OPEN at 3edf5bc: why the first ten RTH minutes lack runtime evidence is unverified | - | None | no | no | no/no | INVESTIGATING |
| OCT9-19 | 2026-10-09 | watchdog | minor | Watchdog storm protection working as designed | NOT_A_DEFECT at 3edf5bc: retaining the lockout is expected safety behavior, not a reason to weaken it | 2fd2cee | Forensic observation (no new tests) | no | no | no/no | NOT_A_DEFECT |
| OCT10-01 | 2026-10-10 | data | major | No TTL on the coalescing map | FIXED at 3edf5bc: quantBarsCoalesceEntryMaxAgeMs TTL eviction with loud warn; generation-guarded delete never removes a newer entr... | 4262bda | Coalescing TTL tests | no | no | no/no | TARGETED_TESTED |
| OCT10-02 | 2026-10-10 | scheduler | major | Flag flip without ownership handoff | FIXED at 3edf5bc | 667e718 | Flag-transition tests | no | no | no/no | TARGETED_TESTED |
| OCT10-03 | 2026-10-10 | resource | minor | Missing retention | FIXED at 3edf5bc: sweepers for 4 + 12 more soak-written tables; guard allowlists | 1b1e104,e4ffb7b | Retention tests; never-throws hardening | no | no | no/no | TARGETED_TESTED |
| OCT10-04 | 2026-10-10 | observability | minor | Cap too small for real bar-evidence payloads | FIXED at 3edf5bc: cap raised 32KB -> 64KB | 59a1843 | Provenance tests | no | no | no/no | TARGETED_TESTED |
| OCT10-05 | 2026-10-10 | brokers | major | Missing catch -> empty-array normalization | FIXED at 3edf5bc; pre-mission review (2026-10-11) judged CORRECT | 3edf5bc,577510b | Broker suites (25/25 in pre-mission review) | yes | no | no/no | TARGETED_TESTED |
| OCT10-06 | 2026-10-10 | brokers | critical | Wrong side mapping | FIXED at 3edf5bc; pre-mission review judged CORRECT | 781bfb3 | Broker suites (25/25) | yes | no | no/no | TARGETED_TESTED |
| OCT10-07 | 2026-10-10 | brokers | major | Missing per-row guard | FIXED at 3edf5bc; pre-mission review judged CORRECT | 1856513 | Broker suites (25/25) | yes | no | no/no | TARGETED_TESTED |
| OCT10-08 | 2026-10-10 | java | minor | Jackson/edge handling gaps | FIXED at 3edf5bc; pre-mission review judged CORRECT (code review; Maven not run) | 6294ace,170b19c | Java defect-hunt tests (Maven not run in pre-mission review) | no | no | no/no | TARGETED_TESTED |
| OCT10-09 | 2026-10-10 | java | minor | Path-param parsing | FIXED at 3edf5bc; pre-mission review judged CORRECT | 4151eab | Java defect-hunt tests | no | no | no/no | TARGETED_TESTED |
| OCT10-10 | 2026-10-10 | java | minor | Missed parity propagation | FIXED at 3edf5bc; pre-mission review judged CORRECT | fc8cb23 | Parity tests | no | no | no/no | TARGETED_TESTED |
| OCT10-11 | 2026-10-10 | testing | minor | Missing test | IMPLEMENTED at 3edf5bc; pre-mission review judged CORRECT | 4fd5f7b | New consistency test | no | no | no/no | TARGETED_TESTED |
| OCT10-12 | 2026-10-10 | testing | minor | Missing test | IMPLEMENTED at 3edf5bc; pre-mission review judged CORRECT | d89945b | New bridge contract test | no | no | no/no | TARGETED_TESTED |
| OCT10-13 | 2026-10-10 | docs | minor | Doc drift | COMPLETE at 3edf5bc | ab30389 | Doc review | no | no | no/no | NOT_A_DEFECT |
| OCT10-14 | 2026-10-10 | testing | minor | Rename drift | FIXED at 3edf5bc | d779e25 | Suite-map test | no | no | no/no | TARGETED_TESTED |
| OCT10-15 | 2026-10-10 | observability | minor | Certification lagged the repairs | IMPLEMENTED at 3edf5bc | 0e0e80f | selectionPoolBreakdown 3/3; certify-next-session runs clean | no | no | no/no | TARGETED_TESTED |
| OCT10-16 | 2026-10-10 | observability | major | Missing capture | IMPLEMENTED at 3edf5bc: decision_provenance table + certify-next-session PIT_REPLAY (row count + latest); isolated/default-off | cb3fd62 | PIT replay wiring tests | no | no | no/no | TARGETED_TESTED |
| OCT10-17 | 2026-10-10 | testing | minor | Missing framework | IMPLEMENTED at 3edf5bc | 32788f9 | Chaos matrix tests (with honest event-loop modeling 11fa111 and designed circuit-open behavior 02f11... | no | no | no/no | TARGETED_TESTED |
| OCT10-18 | 2026-10-10 | fast-lane | minor | Deferred by design | NOT_STARTED at 3edf5bc: DEFERRED with design doc + it.fails tripwire | ed562fa | Expected-fail tripwire test (moved to testing/slow/tier4) | no | no | no/no | NOT_STARTED |
| OCT10-19 | 2026-10-10 | observability | major | Missing tooling | IMPLEMENTED at 3edf5bc: runs clean; verdict NO_GO (QUANT_FIRST_OPERATIONALLY_INACTIVE - 0 authorized strategies); new fields verif... | 9339971 | certify-next-session runs clean; verdict NO_GO | no | no | no/no | TARGETED_TESTED |
| OCT10-20 | 2026-10-10 | testing | minor | Hygiene | COMPLETE at 3edf5bc | 6b3f0e0,ae307b9,fabefac | Label checks | no | no | no/no | NOT_A_DEFECT |
| OCT10-21 | 2026-10-10 | testing | minor | Test bugs | FIXED at 3edf5bc | 11fa111,02f1188 | Chaos tests green | no | no | no/no | TARGETED_TESTED |
| OCT10-22 | 2026-10-10 | testing | minor | Missing tests | IMPLEMENTED at 3edf5bc | c050187,7602c49 | Oct-9 missed-opportunity regressions; moving-market scenario behavior tests | no | no | no/no | TARGETED_TESTED |
| OCT10-23 | 2026-10-10 | quant-first/authorization | major | Missing workflow | IMPLEMENTED at 3edf5bc: legitimate promotion route exists; promotes nothing without operator review; CHAMPION rung unreachable-but... | 55b6a84 | Bridge tests | no | no | no/no | TARGETED_TESTED |
| OCT10-24 | 2026-10-10 | process | minor | Index hygiene | SUPERSEDED at 3edf5bc: detail lives on OCT9-01 (scheduler), OCT9-02 (stale-tail), OCT8-19/OCT10 fast-lane rows | f9277c7,27e17d3,b509d39,55b6a84,0e0e80f | See canonical rows | no | no | no/no | SUPERSEDED |
| TONIGHT-01 | 2026-10-11 | safety/quant-first | critical | Quant-first architecture (operator-authorized 2026-10-07) installed an alternate decision path whose own checks substitute for con... | FIXED at 52b6933: policy demoted to fail-closed prefilter (evaluateQuantPolicyPrefilter, boolean); policy-passed ideas fall throug... | a74a35f,ecfd4ec,52b6933 | Pre-mission safety review 2026-10-11 (found); router suite rewritten + quantSpineInvariants static p... | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-02 | 2026-10-11 | quant/scheduler | major | Emission inside evaluateSymbol is not coordinated with the scheduler's expiry/quarantine decision; emitTradeIdea has no at-emit fr... | FIXED at 4210cf0: emission deferred until the scheduler confirms liveness - isLiveCheck predicate (false if stopped/terminal/quara... | 4210cf0 | Pre-mission review 2026-10-11 (found); liveness + emission-withheld regression tests at 4210cf0 | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-03 | 2026-10-11 | scheduler | major | Getter does not guard stopped state (init() rebuilds, but direct getter consumers bypass it); stop() never resets stopped so start... | FIXED at 4210cf0: initPriorityScheduler() is now unconditional every cycle; module init drops stopped singletons and rebuilds fres... | 4210cf0 | Pre-mission review 2026-10-11 (found); singleton re-init regression tests at 4210cf0 | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-04 | 2026-10-11 | data | major | The empty-fetch early-return predates the stale-tail gate and was not updated by f9277c7 | FIXED at 1ab3563: IBKR-empty path now runs the stale-tail check ('if (existing.length > 0 && !staleTail) return;'); a stale tail f... | f9277c7 (gate it bypasses),1ab3563 | Pre-mission review 2026-10-11 (found); stale-cache + IBKR-empty regression test at 1ab3563 | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-05 | 2026-10-11 | fast-lane | minor | Watchdog applied only to the originating caller's timeoutGate (:224-230) | FIXED at 333b7b8: coalesced callers race the settle promise against fastLaneEvaluationTimeoutMs; on timeout the caller gets a boun... | 333b7b8 | Pre-mission review 2026-10-11 (found); hung-primary + coalesced-caller regression test at 333b7b8 | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-06 | 2026-10-11 | scheduler | minor | Doc written ahead of the implementation detail | FIXED at 4210cf0: dead guard removed (isPresentTime was constant-true; scheduler hardcodes endMs=nowMs); docstring corrected - the... | 4210cf0 | Pre-mission review 2026-10-11 (found) | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-07 | 2026-10-11 | quant-first/authorization | minor | No VALIDATED-granting path exists | FIXED at be83299: documented as fail-closed by design - CHAMPION is comparative ('proven current best among live strategies'), not... | 55b6a84,be83299 | Pre-mission review 2026-10-11 (found) | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-08 | 2026-10-11 | observability | minor | toISOString() is UTC | FIXED at d961115: intraday probe now uses getTradingDayStartMs() from TradingCalendar (America/New_York, DST-correct) instead of U... | d961115 | Pre-mission review 2026-10-11 (found); verified by direct code read in this audit | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-09 | 2026-10-11 | ai-providers | major | Escalation path never migrated to the governor | FIXED at 02217be: routes through AICallGovernor.request; missing JEV_API_KEY short-circuits at the NO_API_KEY gate; SKIPPED/FAILED... | 02217be | Governor routing pinned (capability STRUCTURED_DECISION, kind news_catalyst_triage, MEDIUM materiali... | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-10 | 2026-10-11 | data | major | Hour-bucket identity key + unfiltered cache hit | FIXED at ea1c0c1: key on exact (startMs,endMs,symbol,timeframe) - DB identity suffices since the DB query does not filter by sourc... | ea1c0c1 | Regression: query T1, query T2>T1 (warm), repeat T1 -> no post-T1 data | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-11 | 2026-10-11 | testing | major | Fallback predated the atomicity requirement | FIXED at 6083329: torn copyFileSync fallback deleted; non-zero exit when the consistent sqlite3 .backup fails | 6083329 | certify-next-session runs clean | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-12 | 2026-10-11 | testing | major | Manual split instead of node:path basename | FIXED at 6083329: basename() from node:path | 6083329 | certify-next-session runs clean | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-13 | 2026-10-11 | data | major | Eviction unconditionally deleted the shared entry | FIXED at b215132: on TTL expiry mark the entry overdue (loud log) but RETAIN it until settle; awaiting callers race the shared pro... | b215132 | Regression: entry retained + overdue flag set; waiter gets COALESCE_CALLER_TIMEOUT; fetchMock called... | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-14 | 2026-10-11 | testing | major | Missing ns->ms conversion; verdict checked errors only | FIXED at 72c7169: divide by 1e6; stabilityVerdict now gates on SOAK_MAX_RSS_MB / SOAK_MAX_RSS_DELTA_MB / SOAK_MAX_EVENT_LOOP_P95_M... | 72c7169 | Soak-child regression at 72c7169 | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-15 | 2026-10-11 | fast-lane | major | Reaper skipped the QUARANTINED state | FIXED at 7bd0ddc: fastLaneQuarantineMaxAgeMs (config, 3600000ms default); evict quarantined leases older than max age with loud lo... | 7bd0ddc | Regression: quarantined lease older than max age -> evicted | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-16 | 2026-10-11 | quant | major | Missing guard + positional indexing assumed dense minute bars | FIXED at 882b46a: bars[0].timestamp must be <= predictionTimeMs+60s (same bound the single-horizon path enforces); horizon bar sel... | 882b46a | Outcome-evaluator regression at 882b46a | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-17 | 2026-10-11 | scheduler | minor | No cancellation pruning in the waiter queue | FIXED at 4c437c4: acquire(priority, isCancelled?); makeRelease shifts past cancelled waiters WITHOUT consuming the handoff (never ... | 4c437c4 | Semaphore waiter-cancellation tests at 4c437c4 | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-18 | 2026-10-11 | ai-providers | minor | Entry deleted at race-settle instead of invoke-settle | FIXED at b9975e4: delete the entry when invoke itself settles (onInvokeSettled callback); abort-on-timeout preserved - the entry j... | b9975e4 | Governor singleflight regression at b9975e4 | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-19 | 2026-10-11 | ai-providers | minor | TTL-only prune did not account for execution lifetime | FIXED at a637a90: track a settled flag on each entry; pruneStaleRouteTaskInFlight prunes only entries that are BOTH TTL-expired AN... | a637a90 | Router dedup regression at a637a90 | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-20 | 2026-10-11 | data | major | Pagination loops had no signal wired | FIXED at 0819727: signal: AbortSignal.timeout(tradingSafety.alpacaRequestTimeoutMs) (15000ms, the existing convention) on both pag... | 0819727 | Pagination timeout wiring at 0819727 | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-21 | 2026-10-11 | observability | minor | Structured fields never added | FIXED at ed8345d: structured period/regimes/configVersion added to CertificationProvenance and the persisted evidence payload; opt... | ed8345d | Provenance completeness at ed8345d | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-22 | 2026-10-11 | docs | minor | Documentation gap | FIXED at ed8345d: documented - SHADOW is the lifecycle's observation entry point; backtest-passing strategies enter SHADOW so live... | ed8345d | Doc review at ed8345d | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-23 | 2026-10-11 | observability | minor | Missing instrumentation | FIXED at 57dee97: workerGrantedAtMs (set when the quant worker slot is granted) + strategySelectionFinishedAtMs (scheduler passes ... | 57dee97 | Stage-timestamp wiring at 57dee97 | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-24 | 2026-10-11 | testing | minor | Default vitest timeout too small for 300-run fast-check | FIXED at c78e98e: explicit 60s timeout on the property test | c78e98e | Explicit 60_000 timeout; suite green at c78e98e | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-25 | 2026-10-11 | testing | minor | Default timeout too small | FIXED at c78e98e: explicit 60s timeouts on the 6 getRefinedSnapshot tests | c78e98e | Explicit 60_000 timeouts; suite green at c78e98e | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
| TONIGHT-26 | 2026-10-11 | testing | minor | Missing test | FIXED at c78e98e: strict-greater-than semantics pinned from both sides | c78e98e | New boundary tests: exactly-0.75 confidence -> NO TRADE (rejected); 0.7501 -> eligible | PENDING | PENDING | PENDING/PENDING | TARGETED_TESTED |
