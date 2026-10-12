# Argus Unknown-Defect Hunt Report (from-zero, 2026-10-10 → 2026-10-11)

**Author:** Worker I, documenting Worker G's hunt + the mission's hunt lineage. **Method:**
this report reconstructs the hunt from verifiable artifacts only — fix commits, test files,
and the register — and says plainly where a datum comes from a commit message vs. a
handoff. No hit counts are invented; where a count is commit-derived it is labeled so.

**Safety posture:** PAPER ONLY, `LIVE_NO_GO`. The hunt never lowered a threshold, never
manufactured authority, never touched a live path.

## 1. Hunt lineage

The from-zero hunt ran in three waves:

1. **2026-10-08** (commit fc6b2f0): defect-hunt batch — bridge eviction, RSI null-guard,
   lifecycle tie-break, expiry fail-closed (malformed expiresAt).
2. **2026-10-10** (commits 3edf5bc..ab30389, "Cross-cutting / Backend / Java defect hunt"):
   the cross-cutting from-zero sweep across brokers, Java boundary, bridge contracts,
   schema consistency, and env documentation.
3. **2026-10-11 mission night** (Worker D/E/G hunt + pre-mission review follow-ups):
   scheduler/data/fast-lane re-review, async-ownership audit, Jev call-site inventory —
   yielding mission defects 1–26 (fixed by Worker A).

## 2. Patterns searched and hit counts

"Hit" = a confirmed defect with a fix commit. Counts are commit-derived.

| Pattern searched | Scope | Hits | Fix commits |
|---|---|---|---|
| Broker adapter fail-closed contract (request failure -> `[]`, never throw; exact side mappings; malformed-row resilience) | IBKR Web, Questrade, Alpaca adapters | 3 | 3edf5bc, 577510b (IBKR Web portfolio/orders); 781bfb3 (Questrade side mislabel); 1856513 (Alpaca malformed rows) |
| Java/TS boundary (serialization edges, path-param parsing, seeding parity) | quant-core-java + TS bridge | 4 | 6294ace + 170b19c (Json.write Long.MAX_VALUE; malformed-JSON 500→400); 4151eab (slash-in-symbol truncation); fc8cb23 (EMA seeding parity) |
| Bridge/schema contract drift | TS-Java bridge, schema.ts vs drizzle | 2 (tooling) | d89945b (bridge contract test), 4fd5f7b (schema-vs-migration consistency test) |
| Env documentation drift | `.env.example` | 1 (tooling) | ab30389 (62 env vars documented) |
| Cert tooling drift | certify-next-session | 3 | d779e25 (stale suite-map pointers); 6083329 defects 11/12 (torn backup fallback; Windows path guard) |
| Scheduler ownership (liveness, singleton reuse, waiter pruning, stage attribution) | quantPriorityScheduler, QuantSignalAgent | 5 | 4210cf0 (defects 1, 2, 5); 4c437c4 (defect 17); 57dee97 (defect 23) |
| Data contract (stale tail, cache identity, coalescing ownership, fetch bounds) | HistoricalDataGateway | 5 | 1ab3563 (defect 3); ea1c0c1 (defect 10); b215132 (defect 13); 0819727 (defect 20); 4262bda+OCT10-01 (coalesce wedge) |
| Async ownership (singleflight, dedup TTL, coalesced waiters) | AICallGovernor, AIRouter, fastLaneEvaluator | 4 | b9975e4 (18), a637a90 (19), 333b7b8 (defect 4), 7bd0ddc (defect 15) |
| Lifecycle/certification (provenance, rung reachability, SHADOW rationale) | certificationBridge | 3 | ed8345d (21, 22), be83299 (defect 6) |
| Consensus invariant violations (silent bypasses, unguarded boundaries) | ChiefTraderAgent | 2 | 52b6933 (consensus bypass); c78e98e defect 26 (0.75 boundary) |
| AI-provider governance | NewsEngine/Jev | 1 | 02217be (defect 9, D1) |
| Soak/test infrastructure honesty | soak child, soak path retention, test timeouts | 4 | 72c7169 (14); 1b1e104/e4ffb7b (OCT10-03); c78e98e (24, 25) |
| Outcome-grading integrity | MultiHorizonOutcomeEvaluator | 1 | 882b46a (defect 16) |
| Pre-mission code review (read-only, 2026-10-11) | changed non-test source | 8 | 3 major + 4 minor + consensus bypass → mission defects 1–8 |

Total confirmed findings across all waves: **26 mission defects** (all fixed by Worker A,
23 commits) plus the Oct-10 wave's 9 review-verified fixes and the Oct-8 wave's fc6b2f0
batch. **Zero findings were left open without a fix or an explicit deferral** (the one
deferral: OCT10-18 fast-lane 180s SLA, deferred with a design doc + `it.fails` tripwire).

## 3. Triage

Every hit was triaged into one of:

- **Fix now** (safety/correctness): consensus bypass (52b6933), stale-tail re-open
  (1ab3563), cache collision (ea1c0c1), scheduler emission gate (4210cf0), quarantine
  pinning (7bd0ddc), coalescing ownership (b215132), pagination timeouts (0819727),
  broker fail-closed (3edf5bc/577510b/781bfb3/1856513), outcome-grading (882b46a).
- **Fix now (tooling/tests)**: certify-next-session safety (6083329, d779e25, d961115),
  soak-unit/verdict (72c7169), boundary pins (c78e98e), bridge/schema contracts
  (d89945b, 4fd5f7b), env docs (ab30389).
- **Document (fail-closed by design, not a hole)**: CHAMPION rung unreachable (be83299 —
  deliberate; making it reachable would manufacture a promotion), SHADOW
  backtest-qualifiable (ed8345d — documented rationale), quarantine-as-safe-abandonment
  (7bd0ddc — mission adjudication).
- **Defer with tripwire**: OCT10-18 fast-lane 180s SLA (ed562fa, expected-fail tripwire
  in testing/slow/tier4).

## 4. Confirmed findings (mission defects 1–26, all FIXED)

| # | Defect | Commit |
|---|---|---|
| 1 | Expired/quarantined scheduler work could emit before late-settle rejection (at-emit gate missing) | 4210cf0 |
| 2 | Stopped scheduler singleton silently reused → zero-evaluation cycles | 4210cf0 |
| 3 | IBKR-empty path bypassed the stale-tail gate (re-opened OCT9-02) | 1ab3563 |
| 4 | Fast Lane coalesced callers lacked the claimed watchdog | 333b7b8 |
| 5 | Scheduler data-readiness docstring described dead exemption behavior | 4210cf0 |
| 6 | certificationBridge CHAMPION rung unreachable (fail-closed; documented) | be83299 |
| 7 | certify-next-session intraday probe used UTC midnight | d961115 |
| 8 | SILENT QUANT_EXECUTION consensus bypass (threshold 0, zero agents) | 52b6933 |
| 9 (D1) | NewsEngine.tryJevFirstAnalysis bypassed AICallGovernor | 02217be |
| 10 | HistoricalDataGateway cache collision (hour-bucket key, unfiltered hits) | ea1c0c1 |
| 11 | certify-next-session torn copyFileSync fallback | 6083329 |
| 12 | certify-next-session Windows path guard | 6083329 |
| 13 | Coalesce-entry TTL deleted in-flight entries (duplicate fetch + zombie clobber) | b215132 |
| 14 | Soak child ns→ms mislabel + un-gated stability verdict | 72c7169 |
| 15 | fastLane quarantined-lease unbounded age (symbol pinned forever) | 7bd0ddc |
| 16 | MultiHorizonOutcomeEvaluator: no entry guard + positional horizon selection | 882b46a |
| 17 | PrioritySemaphore dead-waiter handoff | 4c437c4 |
| 18 | AICallGovernor singleflight deleted at race-settle instead of invoke-settle | b9975e4 |
| 19 | AIRouter dedup pruned running executions by TTL alone | a637a90 |
| 20 | Alpaca pagination loops: no timeout, no AbortSignal | 0819727 |
| 21 | CertificationProvenance lacked structured period/regimes/configVersion | ed8345d |
| 22 | SHADOW backtest-qualifiable rationale undocumented | ed8345d |
| 23 | QUANT_STAGE black box (worker vs selection time) | 57dee97 |
| 24 | positionFillEvidence property test timeout | c78e98e |
| 25 | SessionLifecycle getRefinedSnapshot timeouts | c78e98e |
| 26 | Consensus strict->0.75 boundary unguarded | c78e98e |

Per-issue detail (root cause, regression, remaining risk): the master defect register
(TONIGHT-01..26) and the final issue matrix.

## 5. Adversarial answers summary

The hunt was conducted adversarially: the pre-mission review and the D/E/G hunt assumed
the fixes were wrong and looked for invariant violations, not confirmations. The
adversarial posture's conclusions:

- **The most severe finding was the one the tests blessed.** The QUANT_EXECUTION
  consensus bypass (defect 8) shipped with the spine tests asserting the OLD shape —
  the tests were green and the invariant was violated. Lesson encoded: PR_FAST now
  carries static pins (no approval primitives outside consensus, no threshold: 0) and
  the 0.75 boundary is tested from both sides (defect 26).
- **Sibling paths re-open closed defects.** TONIGHT-04 (IBKR-empty) re-opened OCT9-02;
  D1 (Phase 2 Jev escalation) repeated OCT8-10's class on a sibling call path. Lesson
  encoded: every provider-response shape (empty/partial/error) must be exercised against
  a stale cache; every Jev call site must be governor-routed (static call-site
  inventory).
- **TTL must never delete live shared state.** Defects 13, 15, 17, 18, 19 are one
  pattern: a bound (TTL, prune, eviction) applied to state that was still live. Lesson
  encoded: retain-until-settle, settle-flagged prune, generation guards, loud logs.
- **A verdict that gates nothing is not evidence.** Defect 14 (soak verdict inferred
  PASS from zero errors while resource bounds gated nothing) and the pre-mission
  NO_GO-vs-READY discipline both say the same thing: the gate must name what it checks,
  and an uncheckable invariant is FAIL.
- **No manufactured anything.** The hunt produced zero manufactured authority, zero
  lowered thresholds, zero new execution paths. Three "findings" resolved to
  documented fail-closed design (CHAMPION rung, SHADOW rationale, quarantine blessing)
  rather than holes.

## 6. What the hunt did not find (and does not claim)

- No live-trade path was found anywhere in the changed code (PAPER-only lock,
  `LIVE_NO_GO` intact; the bypass stayed downstream of RiskEngine/OMS/PAPER).
- The hunt does not claim "zero defects" — it claims 26 confirmed defects fixed with
  regression tests, plus explicit deferral (OCT10-18) and explicit open research
  (OCT8-38, OCT9-15/17/18). Unknown unknowns remain possible; the escape registry and
  the four-tier certification architecture are the standing defense.
