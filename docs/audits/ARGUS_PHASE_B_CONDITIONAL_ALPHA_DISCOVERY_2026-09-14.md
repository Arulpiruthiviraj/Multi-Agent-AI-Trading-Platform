# ARGUS — Phase B: Conditional Alpha Discovery, Pass 1 (2026-09-14)

**Mandate**: audit-and-plan, evidence-discovery only. Per the operator's own explicit rule for this
pass: no threshold changes, no calibration changes, no strategy changes, no trading changes, no
hypothesis promotion. Discovery ≠ promotion. Method throughout: bounded, `readonly` SQLite queries
with aggregation computed inside SQLite (`GROUP BY`/`AVG`/`COUNT`), never an unscoped full-table
materialization or a live heavy HTTP analytics call against the running engine — see the incident
record below for why.

**Verdict**: **PHASE B PASS 1 — NO VALIDATED CONDITIONAL ALPHA DISCOVERED.**

A legitimate, evidence-backed research result, not a failure of the investigation. The system
correctly continued to reject every candidate that looked promising at raw sample size.

---

## 0. Preceding incident (context for the "bounded queries only" method)

During this same session, a heavy live-HTTP diagnostic (`argus-cli strategy-fairness`, run against
the live engine process) is the leading suspected trigger for an unplanned engine crash
(~90s downtime, `quant_assessments` cycle interruption ~6m47s). No `crash.log` entry was produced —
consistent with a V8 fatal OOM rather than a catchable exception, though the exact mechanism is
unconfirmed. **No capital exposure resulted** (zero open positions/orders throughout); the watchdog
(started earlier this session) auto-recovered the engine; reconciliation checks bracketing the
incident all showed `matches:true`; `sessionRecovery.ts`'s `holdNewEntryIdeas` mechanism correctly
held new BUY-side idea generation until a real `RECONCILIATION_MATCH` fired. Recorded as a separate
**P1 reliability finding** (root cause unconfirmed), distinct from the alpha-discovery findings
below. Recommended remediation (not yet implemented): bound/limit heavy diagnostic endpoints;
measure event-loop lag and memory during heavy analytics; consider isolating research analytics
into a separate process/plane from the trading engine; verify an unclean restart requires the same
persisted-and-verified reactivation discipline `EMERGENCY_STOP` already has (currently: it does
not — `TRADING_ENABLED` is restored as-is from `settings.tradingState`, `CONTROL VERIFIED (PARTIAL)`
via the narrower BUY-hold mechanism only). Every query in this document, from this incident forward,
was run as a bounded, `readonly`, standalone SQLite connection — never a live HTTP call against the
running engine.

## 1. Corpus scoping correction

The originally proposed corpus, `prediction_outcome_horizons` (the explicit multi-horizon table,
`MultiHorizonOutcomeEvaluator.ts`), has **zero rows** — real, wired (started at boot since
2026-09-12), but genuinely empty. The codebase's own 2026-09-13 audit comment
(`forecastEngine.ts`) already documents this honestly as `IMPLEMENTED_BUT_IDLE`, "needing real
elapsed time to accumulate." The multi-bar horizon dimension (1-bar/5-bar/20-bar/60-bar) is
therefore **not available** for this pass.

The real, populated substitute used instead: **`prediction_outcomes`** — 81,736 total rows, 74,266
with a real `WIN`/`LOSS` outcome (excluding `N_A`). Single-horizon per row (each agent's own
config-driven evaluation window, `config/evaluationHorizons.json`), joinable to `agent_predictions`
for agent name, side, confidence, and (where captured) regime.

## 2. QuantEngine data-integrity check (Phase B.1)

Requested because the initial pass-1 aggregate showed an apparent contradiction in QuantEngine's
SELL buckets (high win rate paired with a large-magnitude negative mean return, and the inverse in
an adjacent bucket) that looked like it could indicate a measurement defect (sign/outcome mismatch,
mixed evaluation conventions, or a PIT violation).

| Check | Result |
|---|---|
| Sign/outcome consistency (agent-wide, all 3,845 graded QuantEngine rows) | **0 mismatches.** `outcome='WIN'` iff (BUY ∧ `actual_return>0`) or (SELL ∧ `actual_return<0`), exactly as coded. |
| Evaluation-path mixing | **0 rows** used the side-adjusted "exit-aware" path (`TrendFollowingExitEvaluator.ts`, reserved for `TREND_FOLLOWING` only per `evaluationHorizons.exitAwareStrategyIds`). 100% of QuantEngine's graded rows used the raw/unsigned fixed-horizon path. No convention-mixing occurred in this dataset. |
| PIT integrity | **0/3,846** rows have `evaluatedAt <= predictionTimestamp`. No look-ahead. |

**Verdict: integrity PASS.** The originally-flagged "contradiction" was a self-correction, not a
defect: `actual_return` is raw/unsigned by design
(`PredictionOutcomeEvaluator.ts:101`, `actualReturn = (finalPrice-entryPrice)/entryPrice`) — for a
correct SELL call (price fell), a *negative* raw return is the expected, correct result, not a sign
error. This was flagged as a possible defect in an earlier pass of this same investigation and
retracted after tracing the source; recorded here for the chronology, not to inflate the audit with
a non-finding presented as one.

## 3. Step 6: concentration + effective-N + Wilson bound, three candidates

Method: reused the codebase's own canonical clustering module (`effectiveSampleSize.ts` —
`clusterByTimeGap`, `rawVsEffectiveDirectional`, `wilsonInterval`; also used in production by
`agent-edge`), imported directly (pure, no DB dependency) rather than reimplemented. Cluster gap:
`independenceClusterGapMs(agentName)` — `tradingSafety.evaluationHorizonMs` (60 min) for both
agents tested here.

| Candidate | Raw N | Raw win rate | Raw Wilson | Effective N | Inflation | Effective win rate | Effective Wilson | Verdict |
|---|---|---|---|---|---|---|---|---|
| QuantEngine BUY 0.7–0.8 | 631 | 70.4% | [66.7%, 73.8%] | **6** | 105.2× | 66.7% | **[30.0%, 90.3%]** | ❌ No evidence |
| QuantEngine SELL 0.6–0.7 | 516 | 88.4% | [85.3%, 90.9%] | **10** | 51.6× | 70.0% | **[39.7%, 89.2%]** | ❌ No evidence |
| TechnicalAgent BUY (all buckets) | 57,458 | 44.2% | [43.8%, 44.6%] | 203 | 283.0× | 45.3% | [38.6%, 52.2%] | ❌ No evidence |
| TechnicalAgent SELL (all buckets) | 1,895 | 60.2% | [57.9%, 62.3%] | 154 | 12.3× | 50.6% | [42.8%, 58.4%] | ❌ No evidence |

**Concentration driving the two QuantEngine collapses**: BUY 0.7–0.8 is 99.8% a single symbol
(QQQ, 630/631 rows); SELL 0.6–0.7 is 96.9% a single symbol (AMD, 500/516 rows, clustered within a
10-day window, 2026-08-21 to 2026-08-31). Both are almost certainly `COLD_START_BOOTSTRAP`-sourced
(no rows matched the `QuantEngine/<STRATEGY>:` reasoning pattern for a named CORE strategy). The
repeated identical top-gain/top-loss values in the raw return distribution (e.g. "top 3 gains:
1.06%, 1.06%, 1.06%") are themselves the visible signature of one clustered event counted many
times, not three independent wins.

**TechnicalAgent SELL-vs-BUY incremental-information test**: the raw gap (44.2% vs 60.2%, 16
points) looked like a real, well-powered directional asymmetry. After effective-N correction, the
gap narrows to 5.3 points (45.3% vs 50.6%) with heavily overlapping Wilson intervals. A two-proportion
test on the effective counts (pooled p̂ ≈ 0.476, n₁=203, n₂=154) gives **z ≈ 0.99** — far short of
the ≈1.96 threshold for even weak 95% significance. Side does not survive as incremental
information over the base rate once dependence is corrected.

**Secondary, non-alpha finding**: TechnicalAgent's BUY signal has a 283× raw/effective inflation
factor versus SELL's 12.3× — BUY re-fires far more repetitively on an unchanged market condition
than SELL does. A real fact about the signal's firing behavior, not evidence of predictive value.

## 4. The bigger finding: raw-N inflation as a first-class research problem

The three candidates collapsed via three different, substantial inflation factors: 283× (Technical
BUY), 105× (Quant BUY candidate), 51.6× (Quant SELL candidate). This is the same phenomenon the
2026-08-20 forensic audit first found (21×–770× inflation) recurring here across an independent set
of candidates. The pattern observed, three times, in this pass:

```
raw observations → looks promising → effective-N correction → signal disappears
```

**Implication carried forward, not yet built**: Argus currently records *signal evaluations*, not
*independent prediction events*. Effective-N correction already exists and is applied downstream
(calibration, `agent-edge`), but nothing yet distinguishes the two concepts upstream, at write time
or at the strategy/calibration/certification boundary generally — every consumer of raw N has to
independently know to re-derive effective N via clustering after the fact. Recommended next
research-architecture direction (design only, not implemented this pass): a **Signal
Independence / Eventization** phase — treat "100 evaluations → 42 same-symbol/time clusters → 17
independent market events → effective evidence ≈ 17" as the canonical evidence unit that strategy
evaluation, calibration, certification, and eventually portfolio construction all consume, rather
than each consumer separately re-deriving it. This directly prevents the failure mode observed
today: a strategy could manufacture an impressive-looking raw sample size simply by firing
repeatedly while the underlying market condition is unchanged.

## 5. Why Argus isn't trading — the fuller answer

Zero trades today is not fully explained by "confidence threshold is high" or "agents disagreed."
This pass adds a deeper layer: **even Argus's most promising-looking signals, when corrected for
repeated observation of the same underlying market event, show no statistically defensible edge.**
The zero-trade state reflects a genuine absence of validated alpha, not merely conservative gating
on top of real alpha.

## 6. Recommendation and current state

**Close Phase B Pass 1.** Do not continue slicing (regime-conditioned, larger agent-combination
matrix) in search of a surviving cell — three independent candidates have now shown the identical
collapse pattern; continuing would risk becoming exactly the search-until-something-looks-good
exercise this whole methodology exists to prevent. Recommended next phase: **Signal
Independence / Eventization** as a research-architecture project, ahead of adding new strategies or
building portfolio construction — design and prototype only, per this document's own opening rule,
not begun in this pass.

**Safety state, unchanged throughout**: `PAPER ONLY`, `LIVE_NO_GO`, `tradingState: TRADING_ENABLED`
(paper), all confidence/independence/calibration thresholds untouched, zero code or config changes
made during this investigation.
