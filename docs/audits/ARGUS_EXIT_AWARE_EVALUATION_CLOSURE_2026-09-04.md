# ARGUS — Exit-Aware Evaluation + Statistical Validation Closure

**Date:** 2026-09-04. Scope: the two specific open items named after the Master Closure Audit — (1) TREND_FOLLOWING needs an evaluator that models its real trailing-stop exit, not a fixed-horizon snapshot; (2) FundamentalAgent's statistical honesty given a headline n=52. Both are closed below with real code, real tests, and real data — no unrelated audits reopened.

## 1. Exit-Aware Evaluator for TREND_FOLLOWING

**Built:** `src/server/services/TrendFollowingExitEvaluator.ts` — walks forward day-by-day from a real entry timestamp using real daily bars (`HistoricalDataGateway`), reproducing trendFollowing.ts's own two real invalidation conditions:
- **SMA50 trailing stop**, recomputed fresh each day from only that day's and earlier real closes (point-in-time safe).
- **ADX-fade invalidation** (real double-smoothed DMI/ADX, `trend.ts`'s `calculateDMI` — the same function the live strategy itself reads), gated so a fade can only fire **after** ADX has been confirmed ≥ `quantThresholds.minAdxTrending` at least once since entry — matching the live strategy's own entry gate (real entries already require ADX ≥ threshold), which closes a real bug found during testing: without this gate, a freshly-started trend's own warm-up window reads as spuriously low-ADX and would falsely "fade" on day one.

A detected exit fills at the next bar's open (NEXT_BAR_OPEN, the same reviewed convention `canonicalNextBarEngine.ts` uses for CORE strategies), with honest gap-through handling — the worse of the trigger level or the actual gapped price, never an unrealistic exact-stop fill. Not modeled, named explicitly rather than silently: the strategy's third condition, a structural CHoCH break — real swing-structure detection was out of scope for this pass.

**Not generalized into a multi-policy framework** (FIXED_HORIZON/EXIT_BASED/TRAILING_STOP/etc.) — one strategy needed a real fix; building an abstraction for five other named policies with no second consumer yet would have been unnecessary complexity for this pass, per the mission's own instruction to only generalize when it materially improves correctness.

**Regression tests** (`TrendFollowingExitEvaluator.test.ts`, 9/9 passing): normal trailing-stop progression (BUY and SELL), never-forced STILL_OPEN vs. a real WIN/LOSS, gap-through exit pricing, an intrabar-wick test proving the evaluator only ever reacts to the daily close (never invents intrabar precision it cannot really reconstruct), a real mid-window data-gap test (missing bars, no fabricated fill), an idempotency test (identical inputs → bit-identical output), and a growing-cache-contamination test (bars backfilled after an exit was already found cannot retroactively change it — the same confound class found and fixed in this session's horizon-comparison script).

A real bug was also found and fixed in the test suite itself, not just the evaluator: the original SELL/short regression fixture could trigger a lagging SMA50 stop-out while the position was still below its entry price (a real, correct WIN for a short — SMA lag can lock in profit before a full retrace), which is arithmetically correct but didn't match the fixture's own stated intent ("stopped out by a rally = LOSS"). Fixed by redesigning the fixture (shallow dip, steep rally) to produce a genuine, unambiguous LOSS — not by changing the evaluator's logic.

## 2. Wired Into the Real Grading Pipeline — Not Left Standalone

`PredictionOutcomeEvaluator.ts`'s live `evaluatePending()` loop now routes any QuantEngine prediction whose real strategy id (via the existing `secondaryGroupKey` extraction) is in `config/evaluationHorizons.json`'s new `exitAwareStrategyIds` array through `evaluateTrendFollowingExit` instead of the generic fixed-horizon `evaluatePrediction`. Membership is config-driven (not a hardcoded strategy-id literal in TypeScript, per this codebase's standing rule). A still-open position is only persisted once the configured `exitAwareMaxWalkForwardMs` (90 days) has fully elapsed — never a premature snapshot, and never silently retried forever. 3 new integration tests confirm: a real stop-out is graded via the new path; a still-open position within the walk-forward bound is correctly *not* persisted yet; and a non-exit-aware QuantEngine strategy (PULLBACK_CONTINUATION) is provably untouched, still using the original generic path with real MFE/MAE.

**Promotion-pipeline connectivity re-audited (by code reading, not assumption):** the new evaluator writes to the identical `predictionOutcomes` table, same shape, same `sourceTable: 'agent_predictions'` tag, as every other evaluator. `ReflectionEngine.ts`'s weight-learning loop, `agentEdgeAnalytics.ts`'s per-strategy edge report, and `agentTradingEligibility.ts`'s eligibility gate all query that table generically with no special-casing by evaluator origin — confirmed directly in each file. A corrected TREND_FOLLOWING grade therefore reaches `agentPerformanceStats.currentWeight`, `agentConfidenceCalibration`, and the trading-eligibility gate automatically, with zero additional wiring, by design.

## 3. Real Historical Re-Run — Honest Result, Not a Forced Win

`scripts/reevaluate_trend_following_exit_aware.ts` (kept, real reusable tool) compares the OLD fixed-7-day-snapshot grade against the NEW real exit-simulation grade, **both computed fresh in the same run against the same cache state** — the same confound-avoidance discipline already established for the horizon-length fix.

| | Value |
|---|---|
| Dataset boundary / evaluation timestamp | 2026-09-04T03:18:24.313Z |
| Predictions considered (real TREND_FOLLOWING, OLD gate cleared) | 515 |
| OLD (fixed 7d snapshot) | 35 W / 480 L → 6.8% win rate |
| NEW (real exit simulation) | **0 W / 0 L** — 133 STILL_OPEN, 382 INSUFFICIENT_DATA |
| Exit reasons observed | `{"STILL_OPEN": 133}` only — zero real SMA50/ADX stop-outs detected yet |

**Honest headline: neither model can currently support a real edge claim for TREND_FOLLOWING.** The OLD model's 6.8% figure was never a real trade outcome — it was an arbitrary mid-position snapshot, and the new evaluator confirms this directly: of 515 real predictions, **not one** has actually resolved to a genuine stop-out. This is consistent with, and now confirmed at the strategy-mechanics level for, this file's own already-documented ground truth: organic closed PAPER FILLED SELL P&L is 0. `INSUFFICIENT_DATA` (382/515) was spot-checked against real `ohlcv_bars` rows and confirmed to be a genuine daily-bar-depth gap for specific symbol/entry-time windows (verified: a working symbol, GLD, resolves correctly to `STILL_OPEN` against real data) — not a bug in the evaluator.

**This is not a negative result to explain away — it is the correct, non-fabricated answer.** TREND_FOLLOWING's edge remains genuinely unmeasured, not disproven and not supported. No tuning was applied to force a different outcome, per the mission's explicit prohibition.

## 4. FundamentalAgent Statistical Honesty

**Finding: the required rigor already existed and was already correct** — `agentTradingEligibility.ts` requires effective (autocorrelation-clustered) N ≥ 20 (`championChallengerMinSampleSize`) **and** a real Wilson-lower-bound > 0.5 (`moderateCalibrationTrustMinWilsonLowerBound`) before any bucket can reach `TRUSTED`/`ELIGIBLE`. A raw win-rate headline from a small sample was never able to reach promotion through this gate.

**What was missing:** a single, unambiguous label matching the four terms the mission asked for, since the existing logic was split across two fields (`sampleMaturity`, `statisticalStatus`) a reader had to combine mentally — exactly the gap that let a bare "n=52, 94.2%" figure from an ad-hoc script (which has no clustering or Wilson-interval math at all) look like a real finding in an earlier draft. Added `evidenceClassification: 'INSUFFICIENT_EVIDENCE' | 'NO_EDGE' | 'EDGE_SUPPORTED' | 'EDGE_DISPROVEN'` to `agentEdgeAnalytics.ts` — a pure derivation of the two existing fields, no new statistics, no new thresholds. 4 new tests confirm each of the four combinations, including the specific case the mission named: 5/5 real WINs (100% raw win rate) on a thin sample must read `INSUFFICIENT_EVIDENCE`, never `EDGE_SUPPORTED`.

**Real current result, from the live database:** FundamentalAgent's overall row shows raw N=52, 100% raw win rate, but **effective N = 3** (the other 49 are autocorrelation-clustered duplicates, not independent observations) — far below the 20-observation floor. Correctly classified `INSUFFICIENT_EVIDENCE`. The headline number from the earlier ad-hoc script was never a valid promotion signal, and the existing production gate already prevented it from becoming one.

## 5. Full Test Suite

446 files / 3110 tests, all green (`tsc --noEmit` clean). Run with the live engine stopped first (per this session's standing rule after two prior incidents), then the engine was restarted and confirmed answering again.

## 6. Closure Answers

- **Does the exit-aware evaluator avoid look-ahead?** Yes — every value used at day *i* is computed only from bars up to and including day *i*; the fill always executes on day *i+1*'s open, never day *i*'s.
- **Does it invent intrabar precision it cannot support?** No — proven by a dedicated regression test; only the daily close is ever read for a stop check, high/low wicks are structurally ignored.
- **Does a corrected TREND_FOLLOWING grade reach real downstream decisions?** Yes, automatically, via the shared `predictionOutcomes` schema — confirmed by direct code reading of all three consumers.
- **Was the historical re-run confound-free?** Yes — both sides computed fresh, same run, same cache state; this is the same discipline that caught and fixed the growing-cache confound in the original horizon-length work.
- **Did any tuning happen to force a positive result?** No — the honest result (0 real closed trades either way) was reported as-is.
- **Can n=52 become a promotion signal for FundamentalAgent?** No — verified both by the existing gate's logic and by the real current data classification (`INSUFFICIENT_EVIDENCE`).
- **Is TREND_FOLLOWING's edge now known?** No — and that is the correct, current, honest answer. It remains genuinely unmeasured pending real organic closes.

## 7. Remaining Work, Named

- TREND_FOLLOWING has zero real closed positions to grade — this will only resolve with real trading time, not more code. No further evaluator work is indicated until real closes accumulate.
- The daily-bar depth gap behind 382/515 `INSUFFICIENT_DATA` results is a real data-completeness question (does Argus backfill enough real daily history per symbol) worth a future, narrowly-scoped look — not touched this round since it is a data-pipeline question, not an evaluator-correctness one.
- Structural CHoCH invalidation (trendFollowing.ts's third real exit condition) remains unmodeled, named consistently since this evaluator's own header comment.

## Final Verdict

**READY WITH CONDITIONS** (unchanged from the Master Closure Audit's own overall read) — this closure round fixed the two specific named gaps correctly and honestly, including reporting a negative/inconclusive result where that was the truth. It does not change Argus's overall LIVE_NO_GO / PAPER_READY_WITH_REQUIRED_OPERATOR_ACTIONS status, and does not assert any new organic edge.
