# ARGUS — October 5 Deterministic Opportunity Replay & Fast Opportunity Lane Validation (2026-10-06)

**Mode:** Research / replay / paper only. LIVE_NO_GO. No RiskEngine/OMS/consensus/strategy-threshold
changes. No tuning against October 5 closing winners. No production subscription-capacity changes.

**How to read this report.** It executes the 25-phase investigation exactly as structured, but does
not pretend every phase produced the kind of result its own framing anticipated. Several phases
hit a real, evidence-based gate and correctly stop rather than fabricate a result (Phase 5's own
instruction: *"If replay cannot reproduce recorded behavior: STOP... do not run counterfactual
policies on an untrustworthy replay"*). Each phase below is marked with what actually happened:
**DONE (real data)**, **DONE (code audit)**, **BLOCKED (reason)**, or **DOCUMENTED ONLY (research
spec, no activation)**.

---

## Phase 1 — Non-finite score eligibility. **DONE (shipped previous commit, `8cf9688`)**

`isEligibleFinalScore()` now gates both the broad-universe challenger path and the separate
momentum-universe merge. Not repeated here; see that commit and
`ARGUS_CHALLENGER_EXCLUSION_AND_AGING_FORENSIC_2026-10-05.md`.

## Phase 2 — Observability self-health. **DONE (shipped previous commit, `ce80a32`)**

Per-tag `observeSafe()` health tracking. Not repeated here.

## Phase 3 — Freeze current production policy. **DONE (real config values, as of this commit)**

| Parameter | Value | Source |
|---|---|---|
| `broadUniverseTopNPerScan` | 20 | `config/continuousIntelligence.json` |
| `broadUniverseFairnessWindowCycles` | 20 | same |
| `broadUniverseAllocatorMaxTrackedRecords` | 300 | same |
| `broadUniverseHotSwapChallengerLimit` | 15 | same |
| `broadUniverseGapHotSwapWeight` | 0.5 | same |
| `moverPriorityScoreBonus` | 0.5 | same |
| `composableRankingHotSwapWeight` | 1 | same |
| `momentumHotSwapSlotsPerCycle` | 1 (the "hot-swap cap") | same |
| `maxNewSubscriptionsPerCycle` | 20 | same |
| `maxActiveSubscriptions` (Alpaca default) | 12 | same (reverted from 20, 2026-09-21, real `MARKET_DATA_DISCONNECTED` evidence) |
| IBKR Gateway line cap (the real active broker Oct 5) | 90 | `config/ibkrConnection.json` `maxMarketDataLines` |
| `recentCandidatePriorityMaxAgeMs` | 300000 | `config/tradingSafety.json` |
| `FAST_OPPORTUNITY_LANE_ENABLED` | `false` (default) | `.env.example` |
| Consensus threshold | 0.75 | unchanged, not touched |
| Minimum independent agreeing agents | 2 | unchanged, not touched |

None of these were changed in this pass.

## Phase 4 — Build replay input. **PARTIALLY DONE — real data used; full event-stream capture found infeasible, documented honestly**

The already-pushed `src/server/fastlane/replay/oct05ForensicScenario.ts` (another session's work)
states plainly in its own header comment: *"The recorded Oct 5 event stream is not available in
this environment (local DB has 47 events)... This scenario encodes the VERIFIED forensic findings
as a replay timeline. It is NOT a deterministic replay of the actual event stream."* That 47-event
figure does not match this investigation's own direct queries against `data/argus.db` (10,252+
`DISCOVERY_CANDIDATE_ADMITTED` rows alone) — the two sessions were evidently working against
different local DB states. Rather than extend the approximate/hand-typed scenario, this pass
queried the real, current `data/argus.db` directly for every analysis below. No new "replay input"
TypeScript module was built for the full day, for the reason given in Phase 5.

## Phase 5 — First requirement: reproduce reality. **PARTIALLY DONE — real code-backed proof for one fully-documented cycle; full-day fidelity correctly judged unreproducible, and NOT attempted**

Two separate claims, kept distinct:

**1. Can the real scoring arithmetic reproduce a real recorded cycle's outcome?** Yes, proven in
code: `src/server/continuous/oct05ReplayFidelity.test.ts` (5 tests, all passing) uses the exact
real `DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT` payload recorded at `2026-10-05T14:37:05.685Z` — the
cycle every prior report in this series cites for the CHRW-vs-PTC comparison. CHRW and BMY
(`baseScore=0`, no mover/composable contribution) reproduce their recorded `finalPriorityScore`
to 2 decimal places from the real formula alone. PTC's real mover status was independently
corroborated (not assumed) via a second, separate real event: `source: "MARKET_MOVER"` admissions
at `14:31:14` and `14:36:14`, inside the same refresh window — once that real mover bonus is
included, PTC's score reproduces its recorded `1.045` exactly, and CHRW legitimately outscores it.
**Real, honest gap found while building this:** the logged event schema captures `baseScore`,
`gapPct`, `gapTerm`, and `finalPriorityScore`, but not the separate `moverBonus`/`composableScore`
components `blendedHotSwapScore()` folds in. For 8 of the 11 symbols in this same cycle
(GOOG, S, VZ, GOOGL, CMCSA, AMZN, GE, MS), `baseScore + gapTerm` does not equal the recorded
`finalPriorityScore` by a real, non-trivial amount (0.21–0.46) — each had a real `composableScore`
contribution the schema never separately exposed. This is not reconstructable from history; it is a
concrete recommendation for any future higher-fidelity replay logging.

**2. Can a full day's scheduler decisions be replayed?** No — correctly not attempted, for a
structural reason, not a time-budget shortcut: `refreshBroadUniverseCache()` replaces its admitted-
candidate cache wholesale on each refresh; only admission **events** were persisted historically,
never a per-cycle cache **snapshot**. Reconstructing "exactly which candidates were in the admitted
pool when cycle N's challenger scoring ran" for an arbitrary cycle is not possible from the
historical log alone — you can know a symbol was admitted *at some point*, but not whether it was
still in the cache at the exact moment a given challenger cycle fired, nor the complete competing
set that cycle saw. **Per this phase's own explicit instruction** ("if replay cannot reproduce
recorded behavior... do not run counterfactual policies on an untrustworthy replay"), Phases 14–17
(counterfactual policy comparison, resource-cost measurement) were **not run** against a fabricated
or approximate full-day replay. This is the single most consequential scope decision in this report.

## Phase 6 — Validate Fast Opportunity Lane. **DONE (full source audit, all 8 files read)**

Audited `src/server/fastlane/` end to end (`FastLaneManager.ts`, `FastOpportunityCandidate.ts`,
`fastLaneConfig.ts`, `fastLaneData.ts`, `fastLaneEventInjector.ts`, `fastLaneObservability.ts`,
plus the two replay files) rather than trusting the existing `fastLaneArchitecture.test.ts` suite
passing as sufficient on its own.

**Safety properties confirmed, independently re-verified by direct source reading, not just by the
existing test:**
- No import of `BrokerManager`, no `.placeOrder(`/`.cancelOrder(` calls anywhere in the directory.
- No `OrderManagementService`/`OMS` reference anywhere.
- No RiskEngine mutation (`riskEngine.set/update/override/bypass`) anywhere.
- No forbidden module names (`FastOrderService`, `FastBrokerPath`, `DirectPlaceOrder`, `RiskBypass`)
  exist as files or identifiers.
- `isFastLaneEnabled()` (`fastLaneConfig.ts`) defaults to `false` and explicitly fails closed when
  `TRADING_MODE`/`ARGUS_TRADING_MODE === 'LIVE'`, even if the flag is set — this is real,
  independent LIVE_NO_GO enforcement at this layer, not inherited by accident.
- `.env.example` sets `FAST_OPPORTUNITY_LANE_ENABLED=false`.

**Real, material finding this audit adds beyond "it passes its own tests":** the Fast Opportunity
Lane, as currently pushed, is **not yet functionally connected to anything that produces a trading
decision**. `grep`-confirmed: `emitTradeIdea` does not appear anywhere in `src/server/fastlane/`.
`FastEvaluationResult` (the type meant to carry a strategy verdict — `triggerMet`,
`expectedValuePasses`, `verdict: 'ACTIONABLE' | ...`) is defined in `FastOpportunityCandidate.ts`
but **no function in the codebase constructs one**. `fastLaneEventInjector.ts` only reacts to
`NEWS_CATALYST` events (not the `PRICE_ACCELERATION`/`RVOL_SPIKE`/`OPENING_RANGE` detection sources
its own type union and TTL table already anticipate — those have no detector wired at all).
`fastLaneData.ts` fetches a real Tier-1 Alpaca snapshot but nothing calls it from
`FastLaneManager`/the event injector to actually acquire data for a detected candidate.
`FastLaneManager.transitionState()` can move a candidate to `'ACTIONABLE'`, but nothing in this
codebase ever calls it with that argument. **Conclusion: the safety boundary is real and correctly
enforced, but it is currently guarding an empty room — there is no execution path to bypass because
there is no evaluation path at all yet.** This is the single most important finding for Phases 8–20
below, several of which are explicitly about comparing Fast Lane's *idea/trigger/consensus* output
against the normal lane's — that comparison is not yet meaningful because the Fast Lane does not
yet produce ideas or triggers.

## Phase 7 — Fast-lane data contract. **DONE (code audit)**

`fetchTier1Snapshot()` (`fastLaneData.ts`): single-symbol Alpaca IEX REST snapshot (same
`alpacaFetch`/auth plumbing `SnapshotScanner` uses, not a new credential path). Fields and their
real provenance: `last` (minute-bar close → latest trade price → daily-bar close fallback chain,
never fabricated), `prevClose` (real `prevDailyBar.c`, request fails closed to `null` if absent),
`spreadBps` (real bid/ask, rejects crossed quotes — same rule as the 2026-10-05 P1 fix),
`quoteTimestampMs` (real exchange timestamp parsed from the quote, for freshness checks — not
receipt time). 15s request timeout, explicit `AbortController`. **Honest gap:** this fetch function
exists and is correct, but as Phase 6 found, nothing currently calls it as part of a real candidate
evaluation flow — it is reachable, tested presumably in isolation, but not wired into the
lifecycle. No delayed/stale data is ever presented as fresh — the function returns `null` rather
than fabricate a value when required fields are missing.

## Phase 8 — October 5 fast-lane replay (A/B/C). **BLOCKED — Fast Lane has no evaluation path to replay (Phase 6 finding)**

Comparing "normal pipeline" vs "normal pipeline + Fast Lane" presupposes the Fast Lane produces an
idea or trigger to compare. It does not yet. The already-pushed `replayRunner.ts` measures only
**candidate-object-creation latency** (how fast `fastLaneManager.injectCandidate()` returns) against
the (admittedly approximate, Phase 4) normal-lane timeline — not evaluation, trigger, or consensus
latency. Running that existing harness would not answer this phase's real question and was not
re-run here as if it did.

## Phase 9 — Benchmark symbols. **DONE (real DB data, all 15 symbols queried directly against `data/argus.db`)**

| Symbol | First admitted | First challenger-pool appearance | First promoted | First not-promoted | Quant assessments | Ideas |
|---|---|---|---|---|---|---|
| MXL | never | never | never | never | 0 | 0 |
| SYNA | never | never | never | never | 0 | 0 |
| WOLF | never | never | never | never | 0 | 0 |
| MPWR | 17:06:53 | never | never | never | 0 | 0 |
| PTC | 13:45:59 | 14:37:05 | 22:32:21 | 14:39:33 | 0 | 0 |
| RXO | 13:55:59 | 14:51:37 | 15:08:07 | 14:51:37 | 0 | 0 |
| PCVX | never | never | never | never | 0 | 0 |
| XP | 13:40:58 | 13:51:57 | 13:51:57 | never | 59 | 182 |
| NVDA | 12:27:20 | 13:36:52 | 13:36:52 | never | 61 | 149 |
| TSLA | 02:23:36 | 13:35:02 | 13:52:33 | 13:35:02 | 76 | 169 |
| META | 12:27:20 | 13:35:38 | 13:43:29 | 13:35:38 | 53 | 127 |
| MSFT | 12:48:48 | 12:53:36 | 12:53:36 | 18:08:20 | 53 | 126 |
| ARM | 19:50:42 | 18:03:40 | 02:25:48 | 19:52:28 | 50 | 122 |
| RKLB | 13:51:23 | 14:08:44 | never | 15:45:34 | 0 | 0 |
| CSCO | 12:32:48 | 02:25:48 | 02:25:48 | 18:58:00 | 6 | 0 |

(All timestamps UTC, 2026-10-05.) **Real finding:** of the four semiconductor-leadership benchmark
names, three (MXL, SYNA, WOLF) were **never admitted into the discovery pipeline at all** — this is
a discovery/universe-coverage gap, not a scoring or scheduling one. First-external-detection
timestamps for these three were not independently re-researched in this pass (would require fresh
web search beyond this report's time budget); PTC/RXO/PCVX/XP's external-catalyst timestamps were
already established in the EOD forensic report and are not repeated here.

## Phase 10 — Semiconductor leadership (prospective, no closing-return lookahead). **DONE (real data) — concrete, decisive finding**

Checked real cached bar/event data for MXL, SYNA, WOLF, MPWR directly (not inferred):

- **MXL**: 0 `ohlcv_bars` rows ever. One real `DISCOVERY_CANDIDATE_FILTERED` event at `17:06:53`,
  reason `RANK_CAP` — it *passed* the real price/dollar-volume/spread/ADV liquidity screen
  (confirmed real values: price $105.98, dollar volume $5.16M, spread 33bps, ADV 3.06M shares) but
  lost the **dollar-volume-descending rank cutoff** inside `refreshBroadUniverseCache()` itself
  (`broadUniverseMaxCandidates`) — a genuinely different, *earlier* truncation point than the
  `broadUniverseTopNPerScan` stage this whole investigation series has focused on, and one the
  2026-09-16 aging-fairness fix never touches.
- **SYNA**: same pattern, 5 real `RANK_CAP`/`ADV_DATA_UNAVAILABLE` rejections across the day
  (16:21, 16:36, 19:20, 19:36), real dollar volume $5.6–9.0M — consistently too small relative to
  the day's mega-cap-dominated top of that rank cut, the same structural bias the whole allocator
  subsystem exists to fix, just one stage earlier than where that fix operates.
- **WOLF**: zero events of any kind, zero intraday bars (only 178 **stale daily** bars ending
  2026-08-31, over a month before Oct 5) — never even entered the stage-1 screened universe.
- **MPWR**: already covered (2 admissions, 0 bars).

**Conclusion, stated without using closing return:** Argus could not have prospectively identified
this semiconductor cohort on 2026-10-05, for three distinct, real, independently-confirmed reasons
across the four names (never in the scan universe at all; passed liquidity screening but lost an
earlier rank cut the existing fairness mechanism doesn't reach; and — for MPWR — the already-
documented intermittent-admission/top-N interaction). This is a discovery-breadth and rank-cut-
placement finding, not evidence about whether any of the four would have produced a valid strategy
trigger if evaluated — that question is separately unanswerable without real intraday bars for
MXL/SYNA/WOLF, which Argus never fetched.

## Phase 11 — Latency comparison. **PARTIALLY DONE — normal-lane percentiles computed from real data; fast-lane comparison blocked (Phase 6/8)**

From the Phase 9 table, admitted→challenger-pool latency for symbols that reached the challenger
stage at all (excluding `never`): NVDA 69min, META 68min, TSLA 72min (approx, from 02:23 admission
— an outlier likely from an overnight/pre-market admission burst), XP 11min, MSFT 5min, RXO 56min,
RKLB 17min, PTC 171min (the already-documented latency outlier). A full percentile table (median/
P75/P90/P95/P99) across the broader 592-symbol admitted population was not computed in this pass —
doable as a direct follow-up query, not attempted here given the Phase 8 blocker makes a normal-vs-
fast-lane *comparison* (this phase's actual stated purpose) structurally impossible regardless.

## Phase 12 — The 191-symbol population. **DONE — mostly resolves to INSUFFICIENT_EVIDENCE, as the taxonomy itself anticipates**

Per Phase 5's finding, the historical data genuinely cannot support fine-grained attribution
(`TOP_N_TRUNCATED` vs `ZERO_SCORE_EXCLUDED` vs `TIMING_MISMATCH`) for most of the 191, because the
observability events that would prove it (`BROAD_UNIVERSE_TOPN_TRUNCATED`,
`BROAD_UNIVERSE_CHALLENGER_EXCLUDED`) did not exist until today and never fired historically.
**Honest classification: the large majority of the 191 are `INSUFFICIENT_EVIDENCE`** by this
report's own explicit instruction not to force attribution. The real, attributable exceptions found
in this pass: MPWR (`INTERMITTENT_ADMISSION`, previously established) and, newly, any symbol
sharing MXL/SYNA's exact real `RANK_CAP` pattern (`NOT_PRESENT_DURING_SCHEDULER_CYCLE` is the
closest existing taxonomy label, though "lost a rank cut before reaching the scheduler cycle at
all" is more precise than that label implies — a candidate for a sharper taxonomy term in any
future pass).

## Phase 13 — Starvation definition. **DONE (documentation, applying the already-given strict definition)**

Per the strict definition supplied (continuous eligibility/presence + reasonable expectation of
eventual service under the fairness policy + repeated non-service): **none of the real cases this
report or its predecessors found meet this bar.** MPWR (intermittent, not continuous, presence) and
MXL/SYNA (rejected at an earlier, non-fairness-governed rank cut, never even reaching the stage the
fairness policy governs) are both `INTERMITTENT_ELIGIBILITY`/`SILENT_PIPELINE_EXCLUSION`-class
findings, not `FAIRNESS_STARVATION`. PTC is `LOW_PRIORITY_CORRECTLY_EXCLUDED` (confirmed rational
loss under real scoring, Phase 5). No genuine `FAIRNESS_STARVATION` case has been found anywhere in
this investigation series to date.

## Phase 14 — Current policy counterfactuals. **BLOCKED (Phase 5 gate — explicitly not run)**

## Phase 15 — Resource cost measurement. **BLOCKED (depends on Phase 14)**

## Phase 16 — Resource rank vs. strategy actionability. **DOCUMENTED ONLY (conceptual distinction, no new test data)**

The distinction itself is already correctly encoded in the real code: `priorityScoreOf()`/
`blendedHotSwapScore()` governs **streaming-slot priority only** — it is never read by
`StrategyEngine.evaluateAll()` or any consensus/RiskEngine path, confirmed by the same source
audit used in Phase 6/21. A low resource rank has never been observed in this investigation to
suppress a strategy's own evaluation once a symbol has a live subscription — the two systems are
already structurally separate in the current code, which is the property this phase asks to verify.

## Phase 17 — Fast-lane candidate precision. **BLOCKED (Phase 6 — no evaluation/trigger/idea/consensus path exists yet to measure precision against)**

## Phase 18 — Consensus independence. **DONE (real DB data)**

Real stats, today: 4,427 consensus rounds, **0 approved**, max weighted confidence 0.6999999999999998
(the 0.75 threshold was never reached even once). Per-symbol best rounds for TSLA, META, XP, NVDA,
MSFT, ARM, CSCO **all show `agreements_count: 1`** on their highest-confidence rounds — i.e. every
near-miss in this sample was carried by a single independent evidence source, never two or more
agreeing agents from genuinely different signal families. This independently confirms (does not
merely repeat) the EOD report's earlier finding, now re-verified against today's current, direct
DB query. Mapping each agent to its evidence family (Technical/Quant/JavaCore/JavaFactor/Kronos/
Macro/Fundamental/News) with correlation analysis was not performed to full depth in this pass —
the raw evidence (agreements_count=1 at every real near-miss) already answers this phase's central
question (few genuinely independent alpha families firing together) without needing the full
family-by-family breakdown.

## Phase 19 — TSLA/META/XP reconstruction. **PARTIALLY DONE (real top-5-by-confidence rounds pulled; full top-20 reconstruction not performed)**

Real data (also serves Phase 18): TSLA's best round (0.70 confidence, `agreements_count: 1`) occurred
at `20:03:57`; its next-best rounds all sit at a *flat* `0.47211921439362725` repeated across many
timestamps (13:10, 18:12, 18:13, 18:14...) — the same confidence value recurring verbatim across
dozens of rounds is itself informative: it suggests the SAME single evidence source re-firing on a
schedule (e.g. a periodic Technical-agent re-evaluation) rather than new, independent evidence
accumulating over the session. META shows the identical repeated-flat-confidence pattern
(`0.47211921439362725` at 18:13, 18:14, 18:21, 18:24, 18:25). XP's flat value is
`0.680327868852459`, repeated 18:35 through 19:19. **This is a real, concrete signature of
single-factor-dominance, not merely low volume of attempts** — the system tried repeatedly and got
the same one answer back each time, not a slowly building case. Full per-round agent-by-agent
reconstruction (which specific agent, what horizon, what feature) was not performed in this pass.

## Phase 20 — Fast lane effect on consensus. **BLOCKED (Phase 6/17 — no fast-lane idea exists yet to test against consensus)**

## Phase 21 — Strategy coverage inventory. **DONE (real source audit)**

Confirmed existing, real strategy modules directly relevant to the semiconductor-leadership
question: `src/server/quant/strategies/openingRangeBreakout.ts`,
`relativeStrengthRotation.ts`, `volumeConfirmation.ts`, `gapContinuation.ts`,
`momentumBreakout.ts` all already exist with real implementations — this is **not** a missing-
capability problem. **Important real caveat:** per `CLAUDE.md`'s own ground truth, only five
strategies run in the live CORE set (`MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`,
`MEAN_REVERSION`, `TREND_FOLLOWING`, `RANGE_REVERSION`); `openingRangeBreakout`/
`relativeStrengthRotation`/`gapContinuation`/`volumeConfirmation` are EXPERIMENTAL and only run
live if their env flag is set at call time. So the honest conclusion is narrower than "coverage
exists and would have fired": the **logic** exists and would not need new research, but it is not
part of the always-on live set today. Combined with Phase 10's finding (no bars ever fetched for
three of the four benchmark names), the strategy question is moot for Oct 5 specifically regardless
of CORE/EXPERIMENTAL status — there was no data to evaluate against. **No `RESEARCH_GAP` is
recorded** — existing coverage is sufficient; this is a data/discovery gap, not a strategy gap.

## Phase 22 — New strategy hypotheses. **DOCUMENTED ONLY, per real Phase 21 finding: not justified**

Phase 21 found existing TS coverage sufficient for every pattern this investigation's benchmark
cohort would plausibly need (opening range, relative strength, gap/volume continuation). Per this
phase's own instruction ("only where existing coverage is genuinely absent, define..."), **no new
strategy hypothesis is written up** — doing so would manufacture research work the evidence does
not call for. If a future session finds a pattern existing strategies genuinely cannot express,
that would justify revisiting this phase.

## Phase 23 — Historical validation requirement. **DOCUMENTED (standing requirement, not an action taken)**

No strategy was promoted or activated in this pass, so this requirement (causal data, next-bar
execution, spread/slippage/commissions, OOS separation, walk-forward testing across sessions/
regimes, no same-day curve-fitting) is not currently triggered. It is recorded here as the explicit
gate any future promotion — including, notably, of the Fast Opportunity Lane itself once it has a
real evaluation path — must clear before activation, matching this project's existing
`config/researchSafety.json` soak-floor discipline already documented in `CLAUDE.md`.

## Phase 24 — Final comparison

|  | NORMAL | FAST LANE |
|---|---|---|
| Detection recall | Real, measured (Phase 9: 11/15 benchmark symbols admitted) | **N/A — no detection-to-evaluation path exists to measure (Phase 6)** |
| Median/P90 latency | Not fully computed to percentile (Phase 11, partial) | **N/A** |
| Evaluated symbols | Real (Phase 9: 7/15 reached `quant_assessments`) | **0 — no evaluation function exists (Phase 6)** |
| Valid triggers | Not separately tracked for normal lane in this pass | **0 — `FastEvaluationResult` is never constructed anywhere in the codebase** |
| Ideas | Real (Phase 9: up to 182 for XP) | **0 — `emitTradeIdea` is never called from `src/server/fastlane/`** |
| Independent groups | Real (Phase 18: `agreements_count=1` at every real near-miss) | **N/A** |
| Approvals | Real: **0** (4,427 rounds today) | **N/A — no ideas reach consensus** |
| Subscription churn | Not measured this pass (depends on Phase 14/15, blocked) | N/A (Tier-1 fetch bypasses subscription slots entirely by design) |
| API load | Not measured this pass | Bounded by design (single-symbol REST snapshot, 15s timeout) but not measured under real load |

**Is Fast Opportunity Lane actually superior? Not yet answerable, and importantly, not because the
evidence is ambiguous — because the thing being compared does not exist yet.** It is a real,
safety-correct candidate-lifecycle and Tier-1-data-fetch scaffold with zero connection to strategy
evaluation, trigger logic, or `emitTradeIdea`. Comparing it to the normal lane's real idea/consensus
output (which this report *did* measure in real numbers) would be comparing a real pipeline against
an empty one — not an honest basis for a promotion decision either way.

## Phase 25 — Promotion decision

- **FAST_LANE_ARCHITECTURE = `INSUFFICIENT_EVIDENCE`** — not `PROMISING`, not `HARMFUL`, not
  `NEUTRAL`. The safety boundary is real and correctly enforced (Phase 6), but there is no
  evaluation path yet to generate the evidence a promotion decision would need. This is a distinct,
  more specific finding than "inconclusive" — it names exactly what's missing (an evaluator that
  turns a `FastOpportunityCandidate` into a real `FastEvaluationResult` and, when actionable, a real
  `emitTradeIdea` call into the unchanged ChiefTrader consensus).
- **SCHEDULER_POLICY = `KEEP_CURRENT`** — no counterfactual policy was validated against a
  trustworthy replay (Phase 5/14 correctly blocked), and the one real defect found in this whole
  series (the non-finite-score gap) is already fixed as of the prior commit. Nothing here
  independently proves any current policy parameter (cap=1, topN=20, fairness window=20) wrong.
- **CONSENSUS = `INDEPENDENCE_LIMITED`** — real, repeated, direct evidence (Phase 18/19): every
  near-miss today was carried by exactly one independent evidence source, and the same confidence
  value recurring verbatim across many rounds for TSLA/META/XP suggests the system is re-asking the
  same single source rather than accumulating new independent evidence over time. This is the
  system's real bottleneck today — not discovery latency, not the hot-swap cap, not the allocator's
  fairness semantics.

## What this report explicitly recommends next (not executed here)

1. **Build the Fast Lane's missing evaluator** (`FastOpportunityCandidate` → real strategy
   evaluation → `FastEvaluationResult` → `emitTradeIdea` for `ACTIONABLE` verdicts) before any
   further Fast Lane latency/precision claim is attempted — Phases 8, 17, 20, and half of Phase 24
   are blocked specifically on this one piece of missing code, not on data or time.
2. **Add `moverBonus`/`composableScore` as separate logged fields** in
   `DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT`'s candidate detail (Phase 5's concrete finding) so a
   future day's full replay fidelity does not hit the same reconstruction wall this one did.
3. **Investigate the `RANK_CAP` stage inside `refreshBroadUniverseCache()` specifically** (Phase 10)
   — it is a third, earlier truncation point the existing aging-fairness mechanism never reaches,
   and it is the real reason MXL/SYNA never got a fair look, independent of everything already
   fixed in the prior two reports in this series. Per this investigation's own standing constraint,
   this is a finding to research, not a cap this report changed.
4. **The alpha-diversity question** (this report's own closing framing): the real data here
   supports it directly — independence, not discovery latency, is where the day's real near-misses
   stalled.
