# Argus October 8-9 Master Defect Register

**Worker B (historical audit) — 2026-10-11.** Audit-only; no source modified.
**Audited SHA:** `3edf5bcdb73a8ec28d9d71db4479cd21f29cbbb5` (branch `mission/oct8-oct9-closure` == `main` tip; tree clean, no stash).
**Safety posture:** PAPER ONLY, LIVE_NO_GO. Engine never redeployed with the Oct-10 fixes (last production deploy: f3ec4d2, Oct 9 11:58 ET).
**Worker I update (2026-10-11, repair branch `mission/oct8-oct9-closure`, unmerged):** all 8 TONIGHT items
now FIXED; 18 new mission-night defects (TONIGHT-09..26) added and FIXED; OCT9-02/OCT9-05 closed by
1ab3563. Every row fixed tonight carries MERGED=no (repair branch not yet merged to `main`) and
FULL_SUITE_TESTED=PENDING (final full-suite run belongs to the coordinator); none of the mission
fixes are deployed to the running engine.

## 1. Counts

- **Total issues:** 109
- **By severity:** critical: 9, major: 47, minor: 53
- **By final status:** BLOCKED_BY_RESEARCH: 1, FULL_SUITE_TESTED: 1, INVESTIGATING: 3, NOT_A_DEFECT: 6, NOT_STARTED: 1, SUPERSEDED: 1, TARGETED_TESTED: 96

## 2. Summary table

| ISSUE_ID | Date | Severity | Category | Final status |
|---|---|---|---|---|
| OCT8-01 | 2026-10-08 | critical | quant-first/authorization | TARGETED_TESTED |
| OCT8-02 | 2026-10-08 | major | backup/resource | TARGETED_TESTED |
| OCT8-03 | 2026-10-08 | critical | watchdog | TARGETED_TESTED |
| OCT8-04 | 2026-10-08 | major | backup | TARGETED_TESTED |
| OCT8-05 | 2026-10-08 | major | premarket | TARGETED_TESTED |
| OCT8-06 | 2026-10-08 | major | premarket/observability | TARGETED_TESTED |
| OCT8-07 | 2026-10-08 | minor | ai-providers | TARGETED_TESTED |
| OCT8-08 | 2026-10-08 | critical | safety/infra | TARGETED_TESTED |
| OCT8-09 | 2026-10-08 | major | ai-providers | TARGETED_TESTED |
| OCT8-10 | 2026-10-08 | major | ai-providers | TARGETED_TESTED |
| OCT8-11 | 2026-10-08 | major | observability | TARGETED_TESTED |
| OCT8-12 | 2026-10-08 | major | resource | TARGETED_TESTED |
| OCT8-13 | 2026-10-08 | minor | ai-providers | TARGETED_TESTED |
| OCT8-14 | 2026-10-08 | major | quant | TARGETED_TESTED |
| OCT8-15 | 2026-10-08 | major | market-data | TARGETED_TESTED |
| OCT8-16 | 2026-10-08 | minor | discovery | TARGETED_TESTED |
| OCT8-17 | 2026-10-08 | minor | infra | TARGETED_TESTED |
| OCT8-18 | 2026-10-08 | minor | risk | TARGETED_TESTED |
| OCT8-19 | 2026-10-08 | major | fast-lane | TARGETED_TESTED |
| OCT8-20 | 2026-10-08 | minor | quant | NOT_A_DEFECT |
| OCT8-21 | 2026-10-08 | major | resource | TARGETED_TESTED |
| OCT8-22 | 2026-10-08 | major | risk/sizing | TARGETED_TESTED |
| OCT8-23 | 2026-10-08 | major | risk/sizing | TARGETED_TESTED |
| OCT8-24 | 2026-10-08 | critical | execution-safety | TARGETED_TESTED |
| OCT8-25 | 2026-10-08 | major | observability | TARGETED_TESTED |
| OCT8-26 | 2026-10-08 | minor | observability | TARGETED_TESTED |
| OCT8-27 | 2026-10-08 | minor | observability | TARGETED_TESTED |
| OCT8-28 | 2026-10-08 | minor | testing | TARGETED_TESTED |
| OCT8-29 | 2026-10-08 | major | backup | TARGETED_TESTED |
| OCT8-30 | 2026-10-08 | major | quant | TARGETED_TESTED |
| OCT8-31 | 2026-10-08 | major | ai-safety | TARGETED_TESTED |
| OCT8-32 | 2026-10-08 | major | safety | TARGETED_TESTED |
| OCT8-33 | 2026-10-08 | major | safety | TARGETED_TESTED |
| OCT8-34 | 2026-10-08 | major | execution-safety | TARGETED_TESTED |
| OCT8-35 | 2026-10-08 | minor | execution-safety | TARGETED_TESTED |
| OCT8-36 | 2026-10-08 | minor | resource | TARGETED_TESTED |
| OCT8-37 | 2026-10-08 | minor | observability | TARGETED_TESTED |
| OCT8-38 | 2026-10-08 | critical | quant-first/authorization | BLOCKED_BY_RESEARCH |
| OCT8-39 | 2026-10-08 | major | ai-providers | TARGETED_TESTED |
| OCT8-40 | 2026-10-08 | major | testing | TARGETED_TESTED |
| OCT9-01 | 2026-10-09 | critical | scheduler | FULL_SUITE_TESTED |
| OCT9-02 | 2026-10-09 | critical | data | TARGETED_TESTED |
| OCT9-03 | 2026-10-09 | minor | observability | TARGETED_TESTED |
| OCT9-04 | 2026-10-09 | minor | quant | NOT_A_DEFECT |
| OCT9-05 | 2026-10-09 | major | data | TARGETED_TESTED |
| OCT9-06 | 2026-10-09 | major | resource | TARGETED_TESTED |
| OCT9-07 | 2026-10-09 | minor | quant-first/authorization | TARGETED_TESTED |
| OCT9-08 | 2026-10-09 | minor | quant-first/authorization | TARGETED_TESTED |
| OCT9-09 | 2026-10-09 | minor | observability | TARGETED_TESTED |
| OCT9-10 | 2026-10-09 | major | fast-lane | TARGETED_TESTED |
| OCT9-11 | 2026-10-09 | minor | observability | TARGETED_TESTED |
| OCT9-12 | 2026-10-09 | major | security | TARGETED_TESTED |
| OCT9-13 | 2026-10-09 | minor | observability | TARGETED_TESTED |
| OCT9-14 | 2026-10-09 | minor | observability | TARGETED_TESTED |
| OCT9-15 | 2026-10-09 | major | resource | INVESTIGATING |
| OCT9-16 | 2026-10-09 | minor | data | NOT_A_DEFECT |
| OCT9-17 | 2026-10-09 | minor | observability | INVESTIGATING |
| OCT9-18 | 2026-10-09 | minor | observability | INVESTIGATING |
| OCT9-19 | 2026-10-09 | minor | watchdog | NOT_A_DEFECT |
| OCT10-01 | 2026-10-10 | major | data | TARGETED_TESTED |
| OCT10-02 | 2026-10-10 | major | scheduler | TARGETED_TESTED |
| OCT10-03 | 2026-10-10 | minor | resource | TARGETED_TESTED |
| OCT10-04 | 2026-10-10 | minor | observability | TARGETED_TESTED |
| OCT10-05 | 2026-10-10 | major | brokers | TARGETED_TESTED |
| OCT10-06 | 2026-10-10 | critical | brokers | TARGETED_TESTED |
| OCT10-07 | 2026-10-10 | major | brokers | TARGETED_TESTED |
| OCT10-08 | 2026-10-10 | minor | java | TARGETED_TESTED |
| OCT10-09 | 2026-10-10 | minor | java | TARGETED_TESTED |
| OCT10-10 | 2026-10-10 | minor | java | TARGETED_TESTED |
| OCT10-11 | 2026-10-10 | minor | testing | TARGETED_TESTED |
| OCT10-12 | 2026-10-10 | minor | testing | TARGETED_TESTED |
| OCT10-13 | 2026-10-10 | minor | docs | NOT_A_DEFECT |
| OCT10-14 | 2026-10-10 | minor | testing | TARGETED_TESTED |
| OCT10-15 | 2026-10-10 | minor | observability | TARGETED_TESTED |
| OCT10-16 | 2026-10-10 | major | observability | TARGETED_TESTED |
| OCT10-17 | 2026-10-10 | minor | testing | TARGETED_TESTED |
| OCT10-18 | 2026-10-10 | minor | fast-lane | NOT_STARTED |
| OCT10-19 | 2026-10-10 | major | observability | TARGETED_TESTED |
| OCT10-20 | 2026-10-10 | minor | testing | NOT_A_DEFECT |
| OCT10-21 | 2026-10-10 | minor | testing | TARGETED_TESTED |
| OCT10-22 | 2026-10-10 | minor | testing | TARGETED_TESTED |
| OCT10-23 | 2026-10-10 | major | quant-first/authorization | TARGETED_TESTED |
| OCT10-24 | 2026-10-10 | minor | process | SUPERSEDED |
| TONIGHT-01 | 2026-10-11 | critical | safety/quant-first | TARGETED_TESTED |
| TONIGHT-02 | 2026-10-11 | major | quant/scheduler | TARGETED_TESTED |
| TONIGHT-03 | 2026-10-11 | major | scheduler | TARGETED_TESTED |
| TONIGHT-04 | 2026-10-11 | major | data | TARGETED_TESTED |
| TONIGHT-05 | 2026-10-11 | minor | fast-lane | TARGETED_TESTED |
| TONIGHT-06 | 2026-10-11 | minor | scheduler | TARGETED_TESTED |
| TONIGHT-07 | 2026-10-11 | minor | quant-first/authorization | TARGETED_TESTED |
| TONIGHT-08 | 2026-10-11 | minor | observability | TARGETED_TESTED |
| TONIGHT-09 | 2026-10-11 | major | ai-providers | TARGETED_TESTED |
| TONIGHT-10 | 2026-10-11 | major | data | TARGETED_TESTED |
| TONIGHT-11 | 2026-10-11 | major | testing | TARGETED_TESTED |
| TONIGHT-12 | 2026-10-11 | major | testing | TARGETED_TESTED |
| TONIGHT-13 | 2026-10-11 | major | data | TARGETED_TESTED |
| TONIGHT-14 | 2026-10-11 | major | testing | TARGETED_TESTED |
| TONIGHT-15 | 2026-10-11 | major | fast-lane | TARGETED_TESTED |
| TONIGHT-16 | 2026-10-11 | major | quant | TARGETED_TESTED |
| TONIGHT-17 | 2026-10-11 | minor | scheduler | TARGETED_TESTED |
| TONIGHT-18 | 2026-10-11 | minor | ai-providers | TARGETED_TESTED |
| TONIGHT-19 | 2026-10-11 | minor | ai-providers | TARGETED_TESTED |
| TONIGHT-20 | 2026-10-11 | major | data | TARGETED_TESTED |
| TONIGHT-21 | 2026-10-11 | minor | observability | TARGETED_TESTED |
| TONIGHT-22 | 2026-10-11 | minor | docs | TARGETED_TESTED |
| TONIGHT-23 | 2026-10-11 | minor | observability | TARGETED_TESTED |
| TONIGHT-24 | 2026-10-11 | minor | testing | TARGETED_TESTED |
| TONIGHT-25 | 2026-10-11 | minor | testing | TARGETED_TESTED |
| TONIGHT-26 | 2026-10-11 | minor | testing | TARGETED_TESTED |

## 3. Evidence files read

1. `docs/audits/ARGUS_OCT8_CODE_ONLY_DEFECT_REPAIR.md`
2. `docs/audits/ARGUS_OCT8_POSTMARKET_DEFECT_REPAIR_2026-10-08.md`
3. `docs/audits/ARGUS_OCT8_COMPLETE_POSTMARKET_REPAIR_2026-10-08.md`
4. `docs/audits/ARGUS_OCT8_OCT9_COMPLETE_REPAIR.md`
5. `docs/audits/ARGUS_OCT8_PREMARKET_READINESS_CERTIFICATION.md`
6. `docs/audits/ARGUS_PREMARKET_DEFECT_HUNT_AND_READINESS_2026-10-08.md`
7. `docs/audits/ARGUS_FULL_SESSION_TRADING_FORENSIC_2026-10-09.md`
8. `docs/audits/ARGUS_FULL_SESSION_TRADING_FORENSIC_2026-10-09.evidence.json (referenced; payload volume not re-read)`
9. `docs/audits/ARGUS_FULL_SESSION_TRADING_FORENSIC_SUPPLEMENT_2026-10-09.md (referenced)`
10. `docs/audits/ARGUS_ZERO_FILL_MISSED_OPPORTUNITY_FORENSIC_2026-10-09.md`
11. `docs/audits/ARGUS_ZERO_FILL_MISSED_OPPORTUNITY_FORENSIC_2026-10-09.evidence.json (referenced)`
12. `docs/audits/ARGUS_SNOW_MRNA_CRCL_QUANT_PATH_2026-10-09.md`
13. `docs/audits/ARGUS_SNOW_MRNA_CRCL_QUANT_PATH_2026-10-09.evidence.json (referenced)`
14. `docs/audits/ARGUS_LIVE_AUDIT_AND_DEFECT_REPAIR_2026-10-09.md`
15. `docs/audits/ARGUS_LIVE_SESSION_NONDISRUPTIVE_AUDIT_2026-10-09.md`
16. `docs/audits/ARGUS_CONTROLLED_PAPER_DIAGNOSTIC_DEPLOYMENT_2026-10-09.md (referenced via git log 926c148)`
17. `docs/audits/ARGUS_OCTOBER_9_REPAIR_VERIFICATION.md (referenced)`
18. `docs/audits/ARGUS_OCTOBER_9_RETROSPECTIVE_MARKET_COHORT.md (referenced)`
19. `docs/audits/QUANT_FIRST_PHASE9_10_11_INVESTIGATION_2026-10-07.md`
20. `docs/audits/ARGUS_OCT7_REAL_VS_SYNTHETIC_FORENSIC_AUDIT_2026-10-07.md (referenced)`
21. `docs/audits/ARGUS_SHORT_RECONCILIATION_SEMANTICS_FIX_2026-10-06.md (referenced; Oct-1 OKTA regression)`
22. `docs/architecture/ARGUS_ARCHITECTURE.md`
23. `docs/architecture/ARGUS_QUANT_FIRST_DECISION_ARCHITECTURE.md`
24. `docs/architecture/ARGUS_AI_CALL_ARCHITECTURE.md`
25. `AGENTS.md (operational master specification)`
26. `CURRENT_ARGUS_ARCHITECTURE_MAP.md (repo root)`
27. `memory/2026-10-11.md (pre-mission review findings: 3 major + 4 minor + consensus bypass; 9 verified fixes)`
28. `git log 61d29ec..3edf5bc (174 commits; Oct-10 hardening messages)`
29. `Direct code reads at 3edf5bc: src/server/services/ChiefTraderAgent.ts:630-700,1524; src/server/services/QuantSignalAgent.ts:774,1090-1260,1361; src/server/scheduling/quantPriorityScheduler.ts:378-470,479-540,879-920,1170-1189; src/server/engines/backtest/HistoricalDataGateway.ts:155-183,195-200,267-300,340-396; src/server/fastlane/fastLaneEvaluator.ts:55-75,160-230; src/server/quant/QuantExecutionPolicy.ts:1-80,360-380; src/server/lifecycle/certificationBridge.ts:44-48,424-450; scripts/certifyNextSession.ts:285-293`

## 4. Oct 8-9 fix verification — Section-6 checklist (compact)

| Area | Item | Verdict | One-line evidence |
|---|---|---|---|
| QUANT-FIRST | zero runtime authorized Quant strategies | **BLOCKED_BY_RESEARCH** | OCT8-38: 0 authorized by design; honest NO_GO verdicts |
| QUANT-FIRST | missing lifecycle authority | **FIXED** | 7239e97: NOT_AUTHORIZED/NO_LIFECYCLE_RECORD terminal |
| QUANT-FIRST | lifecycle/runtime mismatch | **FIXED** | hasStrategyLifecycleRecord() existence-first; ACTIVE_EXPLORATION=consensus |
| QUANT-FIRST | research promotion vs execution authorization | **IMPLEMENTED** | 55b6a84 certificationBridge.ts promotes nothing by itself |
| QUANT-FIRST | QuantExecutionPolicy reachability | **FIXED** | 52b6933: policy demoted to fail-closed prefilter; policy-passed ideas now enter the standard consensus intake |
| QUANT-FIRST | consensus fallback | **FIXED** | ChiefTraderAgent.ts:685-686 REQUIRES_CONSENSUS falls through to normal intake |
| QUANT-FIRST | zero organic QuantExecutionPolicy execution | **NOT_A_DEFECT** | 0 approvals observed = expected with 0 authorized strategies |
| SCHEDULER | long sequential cycles | **FIXED*** | b509d39 bounded priority scheduler; *flag default OFF |
| SCHEDULER | concurrency bottlenecks | **FIXED*** | b509d39 PrioritySemaphore pools; *flag default OFF |
| SCHEDULER | late admission | **FIXED** | b509d39 SLA tests + MRNA/CRCL forensic regressions |
| SCHEDULER | snapshot-at-cycle-start behavior | **FIXED** | replaced by bounded priority scheduler b509d39 |
| SCHEDULER | candidate starvation | **FIXED** | rescue reserved slots + priority classes |
| SCHEDULER | MRNA delayed assessment | **FIXED** | forensic regression in b509d39 |
| SCHEDULER | CRCL missing assessment | **FIXED** | forensic regression in b509d39 |
| SCHEDULER | priority scheduler | **FIXED** | b509d39 (flag-gated) |
| SCHEDULER | semaphore ownership | **NOT_A_DEFECT** | PrioritySemaphore: idempotent release, priority-FIFO handoff; verified in code |
| SCHEDULER | dedup ownership | **FIXED** | externalInflight TTL (b509d39); D11 case fix (f3ec4d2); coalescing TTL (4262bda) |
| SCHEDULER | hidden waiting semaphore entries | **NOT_A_DEFECT** | waitingCount() exposed in getMetrics(); not hidden |
| DATA | stale cache tail | **FIXED** | 1ab3563: IBKR-empty path runs the stale-tail check; stale-cache+empty-provider regression pins DATA_STALE |
| DATA | stale cache + empty refresh | **FIXED** | same as above |
| DATA | exact historical cutoff collisions | **NOT_A_DEFECT** | no Oct 8/9 evidence; provisional-bar rule (2026-10-04) governs forming-bar cutoff |
| DATA | cache-key precision | **NOT_A_DEFECT** | memoryKey 1-hour bucketing is intentional coalescing granularity |
| DATA | retry-key separation | **NOT_A_DEFECT** | inflightEnsureBars coalescing by design (f9277c7); rate-limit backoff separate |
| DATA | provider refresh | **FIXED** | 1ab3563 |
| DATA | stale-data fail closed | **FIXED** | verifyStaleTailMoved + IBKR-empty gate both in place (1ab3563) |
| DATA | daily/intraday requirements | **NOT_A_DEFECT** | regimeMinBars/coverage contract; no defect found |
| DATA | point-in-time integrity | **PARTIAL** | decision_provenance isolated/default-off (cb3fd62); full PIT replay unverified |
| FAST LANE | timeout releasing capacity early | **FIXED** | 27e17d3 lease-held-until-settle |
| FAST LANE | quarantine releasing slot while work still runs | **FIXED** | 27e17d3 bounded hung-work quarantine |
| FAST LANE | duplicate replacement work | **FIXED** | 27e17d3 PRIOR_EVALUATION_STILL_IN_FLIGHT dedup |
| FAST LANE | lease ownership | **FIXED** | 27e17d3 indivisible lease; generation counter |
| FAST LANE | hung work | **FIXED** | 27e17d3 quarantine + b509d39 quant-stage watchdog |
| RESOURCE | memory critical conditions | **PARTIAL** | D07 fixed allocation amplification; live leak classification still UNKNOWN |
| RESOURCE | event-loop stalls | **INVESTIGATING** | P95 17.2s observed; unattributed; profile-before-changing |
| RESOURCE | queues | **FIXED** | D10 lightweight route; bounded observability queue |
| RESOURCE | listeners | **INVESTIGATING** | inventory incomplete, not certified absent |
| RESOURCE | timers | **FIXED** | DEF-3 stoppable timers bf926a0 |
| RESOURCE | workers | **FIXED** | backup worker_thread 873463e |
| RESOURCE | WebSockets | **NOT_A_DEFECT** | no defect found |
| RESOURCE | SQLite blocking | **FIXED** | one writer; backup on read-only worker connection |
| BACKUP | synchronous DB integrity blocking | **FIXED** | 873463e worker isolation |
| BACKUP | DB/WAL/SHM unsafe copying | **FIXED** | online copy on read-only worker connection; engine keeps sole writer |
| BACKUP | snapshot consistency | **FIXED** | atomic publish; crash publishes nothing |
| BACKUP | startup backup loops | **FIXED** | orphan sweep uses cross-process lease; active owner preserved |
| BACKUP | orphan partials | **FIXED** | pid.nonce temps; age-based sweep |
| BACKUP | disk exhaustion | **FIXED** | preflight SKIPPED_DISK, zero writes |
| BACKUP | cleanup | **FIXED** | pruneOldBackups() always runs |
| WATCHDOG | restart storms | **FIXED** | 2fd2cee backoff + persisted STORM_LOCKOUT |
| WATCHDOG | false heartbeat failure | **FIXED** | MAINTENANCE_DEFERRED on fresh claim |
| WATCHDOG | backoff | **FIXED** | COOLDOWN_WAIT exponential |
| WATCHDOG | storm lockout | **FIXED** | persisted; explicit clear only |
| WATCHDOG | startup grace | **FIXED** | STARTUP_GRACE counters-not-reset |
| WATCHDOG | PAUSED-after-restart | **FIXED** | assertRestartSpecNeverResumesTrading; TRADING_PAUSED survives |
| PREMARKET | TradePlan pipeline | **FIXED** | dc2e523 emits PREMARKET_REFRESH_COMPLETED |
| PREMARKET | PREMARKET_REFRESH_COMPLETED | **FIXED** | dc2e523 |
| PREMARKET | focus report | **FIXED** | split readiness premarketReadiness.ts |
| PREMARKET | readiness | **FIXED** | checkTradePlanPipeline + checkPremarketFocusReport |
| EXECUTION SAFETY | duplicate close | **FIXED** | 12236a7e fill-evidence gate 22 |
| EXECUTION SAFETY | stale broker position | **FIXED** | checkPositionFillEvidence cross-check |
| EXECUTION SAFETY | negative quantity | **FIXED** | 1e3804d gate-26 clamp; 2af08e1 valuation |
| EXECUTION SAFETY | unsupported short | **FIXED** | gate 26 operator-directed only, fail-closed |
| EXECUTION SAFETY | OMS idempotency | **FIXED** | clientOrderId; reconcileStaleOrders; unique (order_id, cumulative_quantity) |
| EXECUTION SAFETY | reconciliation | **FIXED** | never auto-flatten; 2026-10-07 confirmation contract |
| OBSERVABILITY | build identity | **PARTIAL** | RUNNING_SHA unverified; provenance capture isolated |
| OBSERVABILITY | process epochs | **NOT_A_DEFECT** | forensic-derived from events; no code defect |
| OBSERVABILITY | Quant cycle | **FIXED** | a66e8e1/7b2d98a diagnostics; b509d39 per-symbol records |
| OBSERVABILITY | per-symbol timing | **FIXED** | per-symbol start/finish records |
| OBSERVABILITY | bar inputs | **FIXED** | bar-input records with window/count/first/last |
| OBSERVABILITY | strategy selection | **FIXED** | 0e0e80f selection-pool breakdown |
| OBSERVABILITY | lifecycle | **FIXED** | quant-readiness; certifyQuantProductionState |
| OBSERVABILITY | why-no-trade | **FIXED** | eb361b9 v2 covers quant path |
| OBSERVABILITY | resource metrics | **FIXED** | D10 process-resources route (runtime-verified once) |

## 5. STILL_BROKEN / PARTIAL / NOT_STARTED / INVESTIGATING items

- **OCT9-15** (major, INVESTIGATING): Resource stalls: recurring event-loop degradation (P95/P99/max 17.2s, mean 1.74s at Oct 9 15:48Z); full status request timed out at 8s; attribution am... Files: 
- **OCT9-17** (minor, INVESTIGATING): Zero IBKR_MARKET_DATA_ACKNOWLEDGED events in the Oct 9 window despite promotions/requests... Files: 
- **OCT9-18** (minor, INVESTIGATING): First ten RTH minutes (09:30-09:40) lack runtime evidence; first boot evidence 09:40:50... Files: 
- **OCT10-18** (minor, NOT_STARTED): Quant fast-lane 180s SLA (mission item 3 P2) not implemented... Files: 

## 6. Per-issue detail

The machine-readable companion `ARGUS_OCT8_OCT9_MASTER_DEFECT_REGISTER.json` carries the full
field set for every issue: ISSUE_ID, DATE_FOUND, SYMPTOM, SEVERITY, CATEGORY, EXPECTED, ACTUAL,
ROOT_CAUSE, ROOT_CAUSE_CONFIDENCE, FILES, COMMITS, TESTS, CURRENT_MAIN_STATUS,
REPAIR_BRANCH_STATUS, MERGED, DEPLOYED, TARGETED_TESTED, FULL_SUITE_TESTED,
PRODUCTION_STATE_TESTED, FULL_SESSION_TESTED, CHAOS_TESTED, SOAK_TESTED, FINAL_STATUS,
REMAINING_RISK, NOTES.

Key conventions used:
- **MERGED=yes** means the fix commit is on `main` (== audited SHA). **DEPLOYED=no** on every row
  per mission convention: the running engine predates the Oct-10 repairs (f3ec4d2, Oct 9 11:58 ET).
- **FINAL_STATUS=TARGETED_TESTED / FULL_SUITE_TESTED** is used only where the dated audit records
  name the passing suites; "Full npm test was not run" in most batches, so FULL_SUITE_TESTED is rare.
- **BLOCKED_BY_RESEARCH** (OCT8-38): zero authorized strategies is by design; only reviewed,
  evidence-backed lifecycle decisions can resolve it - never code.
- **NOT_A_DEFECT** rows record investigated-and-cleared items (selection semantics, watchdog
  lockout retention, IBKR code-200 labeling) so they are not re-litigated.
- **Tonight's 8** (TONIGHT-01..08): all FIXED by Worker A on `mission/oct8-oct9-closure`
  (commits 52b6933/4210cf0/1ab3563/333b7b8/be83299/d961115); REPAIR_BRANCH_STATUS=COMPLETE;
  MERGED=no (repair branch not yet merged to `main`); FINAL_STATUS=TARGETED_TESTED;
  FULL_SUITE_TESTED=PENDING (coordinator's final full-suite run; tsc reported clean by Worker A).
- **Tonight's 18 new mission-night defects** (TONIGHT-09..26): found during the mission's D/E/G
  hunt + Jev certification + pre-mission-review follow-ups; all FIXED on the same branch
  (commits 02217be/ea1c0c1/6083329/b215132/72c7169/7bd0ddc/882b46a/4c437c4/b9975e4/a637a90/
  0819727/ed8345d/57dee97/c78e98e); FINAL_STATUS=TARGETED_TESTED; FULL_SUITE_TESTED=PENDING.

## 7. The 9 pre-mission-review-verified fixes (recorded as FIXED/verified, not re-audited)

IBKR Web portfolio/orders fail-closed (OCT10-05), Questrade side mapping (OCT10-06), Alpaca
malformed-order-row handling (OCT10-07), Java slash-symbol path handling (OCT10-09), JSON
large-integral-double serialization + parse-error mapping (OCT10-08), Java EMA seeding parity
(OCT10-10), TS-Java bridge contract testing (OCT10-12), schema-vs-Drizzle consistency testing
(OCT10-11). Review evidence: broker suites 25/25, touched-service suites 87/87 (Maven not run).

## 8. Absolute safety notes

- PAPER-only lock, kill switch, idea-generation reconciliation hold, and 27 RiskEngine gates
  verified intact by the pre-mission review.
- TONIGHT-01 (QUANT_EXECUTION consensus bypass) is being remediated as a defect per Arul's
  absolute safety rules, not treated as an approved architectural exception.
- No lifecycle row was manufactured; no threshold lowered; no LIVE authority expanded.
- `certify-next-session` verdict at the audited SHA: **NO_GO** (QUANT_FIRST_OPERATIONALLY_INACTIVE).
