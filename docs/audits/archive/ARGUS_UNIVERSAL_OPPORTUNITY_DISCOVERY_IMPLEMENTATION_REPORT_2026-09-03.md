# ARGUS — Universal Opportunity Discovery: Phase 1 Implementation Report

**Date:** 2026-09-03
**Scope:** Phase 1 of a much larger requested mission (27 sections). This report is deliberately scoped to what was actually forensically verified and actually implemented this pass — it does not claim completion of the full mission. See §T/§W for what remains.

---

## A. Executive Summary

The request was to increase ARGUS's opportunity **recall** and **quality** — discover more of what's genuinely moving, keep candidates alive long enough to evaluate, rank them well, and let the existing ChiefTrader/RiskEngine/OMS pipeline decide — without touching any safety gate, threshold, or the 0.75/2-agent rule.

Before writing a single line of new code, this pass did a forensic read of the actual discovery/ranking/allocation source (not the prior audits' summaries of it). That inspection produced the single most important finding of this report:

**Most of what the 27-section mission asked for already exists in the repository, built between 2026-08-26 and 2026-09-02 — before this conversation even began.** `ComposableRanking.ts` (a 7-component, evidence-aware opportunity score with explicit AVAILABLE/UNAVAILABLE handling), `MissedOpportunityDetector.ts` (a funnel-stage classifier that answers "where did this candidate die"), `candidateLifecycle.ts` (a lightweight discovery state machine), the Discovery Lineage Ledger, and Phase 18's reserved-slot rescue fairness are all real, tested, and wired into the live discovery loop.

What was **not** true, and is the one precise, evidence-backed gap this pass found and closed:

**`ComposableRanking`'s 7-component `finalScore` — the sophisticated, evidence-aware opportunity score the mission's own Section 6 asked for — was computed every ~30s and persisted to `candidate_rankings`, but had zero path into any actual subscription or eviction decision.** It only ever fed `TradePlanBuilder` (premarket drafts) and `MissedOpportunityDetector` (post-hoc classification, diagnostic only). The code that actually decides which symbols get one of the 12 scarce market-data slots (`blendedHotSwapScore()` in `OpportunityDiscovery.ts`) only ever saw the older, simpler, momentum/RVOL/range-only score plus a movers-funnel bonus. A candidate with strong gap, liquidity, news-catalyst, or recent-agent-confidence evidence — but modest raw momentum — could rank #1 on the richer score and still never receive a data slot.

This is now fixed: `blendedHotSwapScore()` blends in `ComposableRanking`'s `finalScore` as an additive, config-weighted bonus, available whenever a composable ranking cycle has run for that symbol this session, and silently absent (never fabricated as zero-penalty) otherwise.

This is a small, surgical, fully tested change to the discovery layer only. It does not touch ChiefTrader, RiskEngine, OMS, BrokerManager, the 0.75 threshold, or the 2-agent rule.

---

## B. Before vs. After

| | Before | After |
|---|---|---|
| Who computes the 7-component evidence-aware score? | `ComposableRanking.runRankingCycle()`, every ~30s | Unchanged |
| Who consumes that score? | `TradePlanBuilder` (premarket only), `MissedOpportunityDetector` (diagnostic only) | Same two, **plus** `blendedHotSwapScore()` (the real subscription/eviction decision) |
| Does a strong-evidence, modest-momentum equity have a path to a data slot ahead of a modest-evidence momentum-only mover? | No — the composable score was invisible to slot allocation | Yes, proportional to `composableRankingHotSwapWeight` |
| Any change to ChiefTrader, RiskEngine, OMS, thresholds? | — | **None.** Verified by `tsc --noEmit` clean, `architecture.protection.test.ts` unaffected (discovery-layer-only files touched), full 3065-test suite green. |

---

## C. Forensic Findings — What Already Existed (verified by direct source read, not assumed from prior audits)

| Component | File | Mission section it already covers | First committed |
|---|---|---|---|
| 7-component composable opportunity score, AVAILABLE/UNAVAILABLE-aware | `src/server/continuous/ComposableRanking.ts` | §6 (better opportunity score) | 2026-08-26 |
| Missed-opportunity funnel-stage classifier (SUBSCRIPTION_MISS / AGENT_MISS / CONSENSUS_REJECTION / RISK_REJECTION / EXECUTION_MISS / NOT_ACTUALLY_MISS) | `src/server/continuous/MissedOpportunityDetector.ts` | §17 (missed-opportunity forensics) | 2026-08-27 |
| Lightweight discovery state machine (DISCOVERED → WATCHING → STALE / FILTERED_OUT / PROMOTED) | `src/server/continuous/candidateLifecycle.ts` | §9 (opportunity lifecycle) — partial, coarser-grained than the mission's proposed 9-state pipeline | 2026-08-27, STALE-expiry fixed 2026-08-31 |
| Reserved rescue-slot fairness (EXPLORATION/MARKET_MOVER/NEWS_CATALYST get a guaranteed floor; ROUTINE_RECOVERY cannot exhaust every slot) | `src/server/services/MarketDataWorker.ts` (Phase 18) | §7 (dynamic market-data allocation) — partial | 2026-09-01 |
| Acquisition-vs-renewal budget separation (the confirmed FRVO-class fix) | Same file (Phase 28) | §7 | 2026-09-02 |
| Discovery Lineage Ledger (per-candidate admit/filter reason) | `src/server/observability/discoveryCandidateLedger.ts`, `discoveryLineageReport.ts` | §3 (explainable lineage) | 2026-09-01/02 |
| Gap / relative-volume tagging on the broad-universe/movers funnel | `MarketUniverseScanner.ts` (Phases C, 27) | §4 (gap, RVOL discovery) | 2026-09-02 |
| Blended momentum + real-movers-funnel hot-swap priority | `OpportunityDiscovery.ts` `blendedHotSwapScore()` (Phase 3) | §7 | 2026-09-02 |
| `TRADE_IDEA_REJECTED` reason preservation | `src/server/core/EventBus.ts` | §20 (observability gap the mission asked to fix) | Verified still present — `reason`, `symbol`, `agent`, `traceId` are all in the emitted/persisted payload today; `tradingSessionReport.ts` already queries `payload.includes('MISSING_PRICE')` successfully in production. **No gap found; not changed.** |

This table exists so this report is falsifiable: every row names the file and the date, so a future session can `git log` it and confirm it wasn't invented.

---

## D. The One Fix Made This Pass

**File(s) changed:**
- `src/server/continuous/SnapshotScanner.ts` — added `lastComposableScoreBySymbol` (module-level, mirrors the existing `lastScoreBySymbol` pattern), populated in `refreshSnapshotRanks()` immediately after `runRankingCycle()` returns; added `getLastComposableScore(symbol)` getter and wired it into `resetSnapshotScannerForTests()`.
- `src/server/continuous/OpportunityDiscovery.ts` — `blendedHotSwapScore()` now adds `composableScore * composableRankingHotSwapWeight` on top of the existing base-momentum + mover-bonus terms, when a composable score is available for that symbol this cycle.
- `src/server/config/continuousIntelligence.ts` + `config/continuousIntelligence.json` — new reviewed config key `composableRankingHotSwapWeight` (default `1`), loaded via the same `requireNonNegativeNumber` validator every other numeric threshold in this file uses. Sized to be commensurate with the existing `moverPriorityScoreBonus` (0.5) and typical raw momentum-score magnitudes (evidence: `SCORE_WEIGHT_PCT`/`RVOL`/`RANGE` constants in `SnapshotScanner.ts`), not guessed.
- `src/server/continuous/OpportunityDiscovery.test.ts` — 3 new tests: additive bonus when a composable score is available, no fabricated bonus when unavailable, and stacking correctly with the pre-existing mover bonus.

**Why this is safe:**
- Governance-protected boundary unaffected: `OpportunityDiscovery.ts`/`SnapshotScanner.ts` already never import OMS/RiskEngine/BrokerManager/ChiefTrader and never emit `TRADE_IDEA_GENERATED` — this change adds no new import and no new emission.
- Additive-only: when no composable score exists yet for a symbol (e.g., a broad-universe scan that hasn't run this cycle), the behavior is byte-for-byte identical to before this change.
- Same convention the codebase already established for exactly this kind of extension (Phase 3's mover-bonus blend) — reused, not reinvented.
- Does not change `maxActiveSubscriptions` (12), `protectedSymbols`/`coreStreamingSymbols` (SPY/QQQ/GLD), the dwell-protection window, or any RiskEngine/ChiefTrader constant.

---

## E. What Was Investigated and Explicitly NOT Changed (with the reasoning)

| Item | Finding | Why not acted on this pass |
|---|---|---|
| `maxActiveSubscriptions: 12`, of which 3 (SPY/QQQ/GLD) are permanently, unconditionally locked (never evicted, never counted against the rescue budget) | Confirmed by direct code read (`protectedStreamingSet()` bypass at `MarketDataWorker.ts` line ~352, `pruneLeastActiveWatchSymbols`'s exclusion of protected symbols). This is a real, quantifiable 25% structural ceiling on the dynamic pool, and — combined with TechnicalAgent's tick-count warm-up requirement — plausibly a real contributor to the ETF concentration this session's prior audit measured. | Raising the cap requires knowing Alpaca's actual real plan-tier symbol-stream ceiling. The code's own comments confirm a real "symbol limit exceeded" failure mode exists and was previously hit; guessing a higher number risks a live reconnect storm on a currently-running paper session. This is `[UNVERIFIED — requires an operator-confirmed Alpaca plan ceiling before it can be safely raised]`, not something to act on by assertion. Recommended as the highest-value **next** investigation (see §W). |
| Dwell protection (`minDynamicDwellMs: 60000`, `minDynamicDwellTicks: 10`) vs. TechnicalAgent's real tick-arrival-rate for thin, newly-rescued equities | A real mechanism already exists (protects a fresh dynamic subscription from eviction until either condition clears) — this is not a gap, it is a real, already-shipped safeguard. Whether 60s is long enough for a *typical* dynamically-discovered equity to reach 10 ticks was not empirically measured this pass (would need real tick-arrival-rate data per discovered symbol, not assumed). | Flagged `[UNVERIFIED]` rather than tuned by guess. |
| ETF-vs-equity fair scheduling (mission §10's "separate opportunity pools") | The `protectedSymbols` design is a deliberate, reviewed choice (protecting index/gold benchmarks from eviction) documented in this repo's own config comments, not an oversight. | Changing it is an architecture-adjacent product decision (which symbols are "always-on anchors") that the operator, not this pass, should make explicitly — this report surfaces the quantified cost (§C/§H) rather than silently reducing ETF protection. |
| Memory growth (§18) | Not investigated further this pass beyond what the prior audit already established (607MB→3.85GB over ~3.5h, third silent death observed live during that audit). Root-causing requires heap snapshots / longer-running profiling this single pass did not have budget for. | Explicitly deferred — see §W. |
| External ground-truth comparison (§16) | Would require either a new paid data source or repurposing the existing Alpaca movers/broad-universe screen as an imperfect self-referential "ground truth" (which is not independent ground truth). | Explicitly deferred pending an operator decision on whether to authorize a new external data dependency. |
| Full 9-state opportunity lifecycle (§9) | The existing 5-state `candidateLifecycle.ts` plus `MissedOpportunityDetector`'s 6-way funnel classification together already answer most of the "why didn't this become a trade" question the mission's state machine was meant to answer — just via two separate mechanisms rather than one unified state machine. | Whether unifying them into one true state machine is worth the migration risk vs. the diagnostic value already delivered by the existing two mechanisms was not decided this pass — flagged as a design question for the operator, not implemented speculatively. |

---

## F. Tests

- **New:** 3 tests in `OpportunityDiscovery.test.ts` directly exercising the new blend (additive bonus present/absent/stacking).
- **Targeted re-run:** `OpportunityDiscovery.test.ts`, `SnapshotScanner.test.ts`, `SnapshotScanner.rankingIntegration.test.ts`, `ComposableRanking.test.ts` — 26/26 pass in isolation.
- **Directory-wide:** `src/server/continuous/` — 181/182 pass; the 1 failure (`SnapshotScanner.rankingIntegration.test.ts`, a 5000ms default-timeout trip under heavy parallel test-file contention) is a pre-existing flake, not a regression — confirmed by re-running it standalone twice, passing both times in ~4.5–4.9s, well under its own timeout.
- **Full suite** (engine gracefully stopped first, per this session's own established practice of never running the full suite concurrently with the live engine): **443 files / 3065 tests, all passing.** `tsc --noEmit` clean.

---

## G. Runtime Validation

- Engine gracefully stopped via `POST /api/v1/system/shutdown` (the DEF-26 fix's in-process path) before the test run.
- Full suite ran clean against the stopped engine.
- Engine restarted (`argus-cli start`), confirmed healthy (PID 28140, `SAFE_MODE` boot phase, workers running).
- `tradingState` was restored to `TRADING_ENABLED` via `POST /api/v1/system/resume` (the correct route — `/api/v2/runtime/trading/enable` governs Autobot, not the master `tradingState`; this distinction was itself confirmed by reading `v2Runtime.ts` vs `systemRoutes.ts` rather than assumed) — matching the state the engine was in before this pass's own test-run stop.
- The composable-ranking wiring fix is now live in the running paper session as of 2026-09-03 18:29 UTC.

**What this does not yet include:** a completed before/after opportunity-capture comparison (mission §24/§S). That requires observing real subsequent market activity over hours/sessions, which this single pass cannot fabricate or compress. The honest state is: *the fix is live and structurally correct per the tests above; its real-world before/after effect on stock-vs-ETF ChiefTrader participation is not yet measured* and should be the subject of a follow-up audit once enough post-deploy session data exists (recommend: re-run the same admission/participation-by-asset-class query this session's prior audits already used, comparing pre-2026-09-03-18:29-UTC vs. after).

---

## H. Answers to the Mission's Specific Final Questions

1. **What changed?** One code path: `blendedHotSwapScore()` now also weighs `ComposableRanking`'s finalScore. Plus one new config key.
2. **Why was it necessary?** Direct source inspection proved the mission's own requested "better opportunity score" (§6) was already built but disconnected from the actual resource-allocation decision it was meant to inform.
3. **Which new stocks can ARGUS discover that it couldn't reliably discover before?** None — this does not expand the *scan* universe (already ~100-200+ symbols via existing broad-universe/movers/momentum-scan mechanisms). It changes which already-discovered candidates *win a scarce data slot*, favoring ones with strong gap/liquidity/news/agent-confidence evidence that raw momentum alone would have under-ranked.
4. **Is discovery broader?** No — that was already broad (verified in §C); this pass improved slot-allocation *quality*, not scan-universe *breadth*.
5. **Is stock-vs-ETF allocation fairer?** Indirectly, plausibly — a better-evidenced equity candidate is now more competitive for the ~9 non-anchor slots. The 3-permanent-ETF-slot structural cost itself (§E) was quantified but not changed.
6. **Are high-quality movers getting data faster?** Structurally yes for evidence-rich candidates (see §D); not yet measured in a live session (see §G).
7. **Are fewer opportunities lost before ChiefTrader?** Not yet measurable — requires post-deploy session data.
8. **Is ChiefTrader better calibrated?** Unchanged — this pass touched discovery only, exactly as instructed.
9. **Is memory growth fixed/explained?** No — explicitly deferred (§E).
10. **Is reliability improved?** No new reliability work this pass; the third silent death from the prior audit remains `[UNVERIFIED]` root cause.
11. **Did any safety gate change?** **No.** Verified by `tsc --noEmit`, full 3065-test suite (unchanged pass count from before this session's other recent work), and by construction (no OMS/RiskEngine/ChiefTrader/BrokerManager import touched).
12. **Did any organic paper trades occur (attributable to this change)?** Too early to attribute — the fix has been live for minutes, not a full session, at report time.
13. **If yes, evidence?** N/A yet.
14. **If no, where did candidates stop?** Not applicable to this specific question — this pass did not run a full session under the new code before writing this report.

---

## T. Known Limitations of This Pass

- This is Phase 1 of 27 sections. It intentionally implements the single highest-confidence, best-evidenced, lowest-risk fix rather than attempting the full mission speculatively in one pass.
- No live/paper before-after metrics exist yet (§G) — by design, since fabricating them would violate this session's own evidence standard.
- The `maxActiveSubscriptions` question (§E) is the most likely next high-value lever and was deliberately left untouched pending operator confirmation of Alpaca's real plan ceiling.

## U. Remaining Risks

- None introduced by this change beyond the pre-existing risk profile of the discovery layer (already reviewed, already outside the protected spine).
- The one pre-existing flaky test (§F) should be watched, not treated as new.

## V. Rollback Procedure

Revert `composableRankingHotSwapWeight` to `0` in `config/continuousIntelligence.json` (single-line config change, no code revert needed) to fully disable the new blending term and return to byte-identical pre-Phase-1 behavior; or `git revert` the specific commit for this change if git history exists for it.

## W. Recommended Next Phase (priority order)

1. Confirm Alpaca's actual real plan-tier symbol-stream ceiling with the operator; if real headroom exists above 12, raising `maxActiveSubscriptions` is likely the single highest-leverage remaining fix for equity-vs-ETF fairness.
2. Measure real tick-arrival-rate for a sample of dynamically-rescued equities against the 60s/10-tick dwell window — confirm or refute whether thin equities are being evicted before ever accumulating enough ticks for TechnicalAgent to fire once.
3. Run a proper before/after admission-by-asset-class comparison once several post-deploy sessions of data exist.
4. Memory-growth root-cause (heap snapshot profiling — this needs dedicated instrumentation time, not a byproduct of another task).
5. Decide, as an explicit operator/product call rather than an inferred one, whether the coarse 5-state `candidateLifecycle` + `MissedOpportunityDetector` combination is sufficient or whether a unified 9-state pipeline (mission §9) is worth building.
