# ARGUS synthetic certification gap analysis (2026-10-15)

Question: the 2026-10-14 synthetic suite (Test A production-calibrated, Test B positive capability, unit mutations M1-M12, session mutations SM1-SM5, soak, restart battery) passed on `32613911`, yet the 2026-10-15 production audit found a protective-exit rate-limit defect, an idle Jev integration, a calibration-row selection defect, heavy Kronos repetition and an unattributable news-provider failure stream. Why did certification not expose them? Every statement below was checked against source or evidence files; anything inferred is labelled. PAPER only; LIVE_NO_GO.

## 1. Root causes, per issue (verified)

### D1 - protective exits subject to the global idea cap
* **The synthetic path did use the real limiter.** Sessions run the real `EventBus.emit -> gateTradeIdea -> allowTradeIdea` path; `IDEA_RATE_LIMITED` is in the timeline vocabulary (`DecisionTimeline.ts:12`) and `CertificationGate.ts:100` maps it to a terminal reason. So this was not a bypassed component.
* **Missing load (verified):** `SyntheticSessionEngine.ts:550-567` disables `MacroAgent` and `FundamentalAgent` in-process for determinism, and the Test A/B funnels contain no Kronos ideas (agents seen: Technical, Quant, JavaCoreEnsemble, PortfolioManager; per-symbol counts are tens, e.g. LAAI: Quant 18, Technical 5). Production's saturating traffic was Kronos ~105/min + Macro ~29/min + Technical ~19/min + Quant/Java ~6/min = ~162/min against a cap of 120. Synthetic idea volume was orders of magnitude below the cap, so the limiter was never saturated and the condition could not occur.
* **Missing assertion / too-loose oracle (verified):** `exitOracle.ts` asserts only that a position is not left open longer than a grace window after a stop breach; `scripts/sim/exitCheck.ts` defaults to **15 minutes**. A dropped exit that is re-emitted on the next ~60 s monitor cycle still passes. No assertion checked delivery at the EventBus boundary.
* **Prior remediation hid the design question (verified):** the 2026-10-13 repair (`protective-exit-retry-throttle-20261013`, `portfolioIntel.ts` `IDEA_RATE_LIMITED` handler) made a dropped exit retry by releasing its cooldown. That treated drops as acceptable instead of asking whether exits should be rate-limited at all.
* **Old failure demonstrated; regression added:** `src/server/certification/productionFailureReplay/D1_protectiveExitUnderIdeaSaturation.test.ts` drives the real EventBus with 162 research ideas/minute for 5 simulated minutes (fake timers; saturation precondition asserted so it cannot become vacuous), injects genuine exits shaped like `PortfolioMonitor.emitRiskExit`, and asserts same-tick delivery, spoofed exits (agent-only, origin-only) still rate-limited, per-agent drop attribution, and thresholds unchanged. **Verified: fails on the deployed code (`expected false to be true` at "exit delivered") and passes on the fix.**

### D7 - Jev configured, implemented, idle
* Release certification passed `JEV_CONFIGURED` from key presence (`releaseCertificationDriver.ts`), reported `JEV_WIRING` as `NOT_CERTIFIED: ... not run by this probe` when configured, and had no check of the shadow flag at all. "Configured" was the only thing it could see.
* `JevShadowLedger.test.ts` header: DB round trips "intentionally NOT tested". Provider/governor tests used mocks; none crossed consumer -> governor -> provider HTTP -> validation -> ledger -> report.
* **Fixes:** `JEV_SHADOW_PARITY` certification check and `classifyFeatureParity` (statuses DISABLED_BY_CONFIGURATION / ENABLED_BUT_BLOCKED / ENABLED_NOT_YET_OBSERVED / INVOKED_NOT_PERSISTING / ACTIVE; "enabled but unobservable pre-deployment" is NOT_PROVEN, never PASS); `getJevShadowStatus()` in the `jev-calibration` report; `JevShadowIntegration.e2e.test.ts` (real consumer, governor, HTTP boundary, migrated SQLite ledger); a real authenticated isolated call succeeded (see the Jev root-cause document).

### D5 - calibration provider-row selection
* The synthetic calibration seeder (`CalibrationHistorySeeder.ts`, `AgentCalibrationProfiles.ts`) contains no provider handling at all, so every fixture had only `ALL` rows and the conflicting-rows state could not exist. In production only NewsAgent has per-provider rows (12 of 41) and its idea toggle is off, so production was unaffected today (measured).
* Existing regression: `ChiefTraderAgent.calibrationProviderSelection.test.ts` (2 tests, fail pre-fix). **Not yet done:** a production-derived fixture with randomized row ordering and a before/after on captured consensus decisions (NOT_PROVEN).

### D3 - repeated Kronos predictions / grading backlog
* No Kronos ideas appear in the Test A/B funnels (verified) and sessions are bounded (tens of minutes of simulated trading), so full-day prediction repetition, the 82k/day versus 2k/day grading mismatch and retention-before-grading could not be observed. **Not covered by any certification today.**

### Movers rejected at the open
* Reclassified as mostly legitimate (sub-$5 warrants and thin leveraged ETFs). The synthetic discovery market (`SyntheticDiscoveryMarket`) models its own candidates; whether its volume/spread distributions resemble partial-day IEX opening snapshots is NOT_PROVEN. Replaying captured opening snapshots through `screenAssets`/`evaluateScreen` is the right test and is not built.

### D8/D11 - observability and operator-report findings
* No synthetic scenario runs an operator report against a live-sized database or inspects persisted observability payloads for field loss (D11 is the fifth instance of the same whitelist gap). **Process finding:** my first D8 fix wrapped a route in a second guard and would have deadlocked against the router-level `operatorReportGuard`; the full test suite caught it before release (a real example of why the full suite, not just targeted tests, must run on the exact SHA).

## 2. What each test class proves

| Class | Proves | Does not prove |
|---|---|---|
| Test A (production-calibrated) | Argus can abstain under the tested production-like calibration and authorization | That a real candidate could be approved; behavior under production traffic volume |
| Test B (positive mechanics, seeded favourable history) | The BUY -> Risk -> OMS -> fill -> monitor -> SELL path works under constructed conditions | Alpha; anything about real calibration; behavior when the pipeline is saturated |
| Mutation tests M1-M12 / SM1-SM5 | Specific injected faults in accounting, protective stops, runtime are detected | Absence of other fault classes (event-delivery throttling was not in the inventory) |
| **Test C (new): PRODUCTION_FAILURE_REPLAY** | A specific observed production failure, reproduced with production-equivalent rates, configuration and process boundary, cannot recur | Anything not yet turned into a replay |
Zero trades in Test A and zero approvals on 2026-10-15 are consistent with each other and are not a certification failure. The failure was an escaped event-delivery defect.

## 3. Certification changes made today
1. **Test C** directory `src/server/certification/productionFailureReplay/` with the D1 replay (more replays are added one per confirmed production incident).
2. **CONFIGURATION_PARITY:** `featureParity.ts` + `JEV_SHADOW_PARITY` check; the driver reads `ARGUS_RELEASE_INTENDS_JEV_SHADOW=true|false` and reports `NOT_CERTIFIED` if intent is unstated.
3. **Defect-escape registry** (`docs/audits/defect-escape-registry.json`, enforced by `defectEscapeRegistry.test.ts`) gained six entries for 2026-10-15 with root causes and regression tests.
4. Rule adopted: every confirmed production defect gets a Test C replay before it is closed.

## 4. Coverage matrix and verdicts for the current candidate (honest; NOT_PROVEN is never PASS)
| Verdict area | Verdict | Basis |
|---|---|---|
| TRADING_MECHANICS | NOT_PROVEN on the new SHA | Test B passed on `32613911`; not re-run on the candidate (heavy; not run during market hours). The delta touches the idea gate and ChiefTrader's calibration lookup, so this is a real gap |
| PRODUCTION_POLICY_PARITY | NOT_PROVEN on the new SHA | Test A passed on `32613911`; not re-run |
| PROTECTIVE_EXIT_SAFETY | PASS for idea-cap delivery (Test C D1 + `EventBus.protectiveExitRate.test.ts`, pending full-suite on the final SHA); NOT_PROVEN for broker-failure/restart exit behaviour on the new SHA | |
| EVENT_DELIVERY | PASS at the idea-limiter boundary only; NOT_PROVEN for other routes | |
| PROVIDER_INTEGRATION | PASS for Jev (isolated real call + e2e test); NOT_PROVEN for every other provider | |
| CONFIGURATION_PARITY | **FAIL for the currently deployed configuration** (Jev intended active, flag unset); becomes PASS-pending-observation only when the release configuration sets `ARGUS_JEV_SHADOW_SCORING_ENABLED=true`; production invocation is NOT_PROVEN until a real event is observed | |
| GRADING_AND_RETENTION | NOT_PROVEN (no fix yet, no replay) | |
| RESTART_RECOVERY | NOT_PROVEN on the new SHA (restart battery passed on `32613911`; CLI isolation tests are in the full suite) | |
| RESOURCE_STRESS | NOT_PROVEN (no production-rate load/memory test) | |
| REAL_MARKET_ALPHA_VALIDATION | NOT_PROVEN (walk-forward OOS failed earlier; no established edge; mechanical tests say nothing about profitability) | |

## 5. Next permanent replays (queued, in priority order)
1. Production-rate soak including Kronos/Macro traffic over a simulated full session (resource stress, grading throughput, retention-before-grading).
2. Calibration fixture with mixed provider/`ALL` rows, randomized ordering, before/after on captured consensus decisions.
3. Opening-snapshot replay through the real discovery filters.
4. Tighten `exitOracle` grace to a protective-exit SLA measured in seconds for the delivery boundary (it is a separate, session-level check; the boundary assertion now lives in Test C).
5. Observability payload-loss scan as a certification check (any event type whose persisted payload is `{}` while its published payload is non-empty).
