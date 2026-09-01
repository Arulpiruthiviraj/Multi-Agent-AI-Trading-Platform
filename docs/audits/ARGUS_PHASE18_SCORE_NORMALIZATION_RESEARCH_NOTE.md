# Phase 18, Part 9 — setupScore Cross-Strategy Normalization Research Note

**Status: RESEARCH ONLY. No code, config, or threshold changed by this note.**
Per the Phase 18 mission's explicit instruction: "do NOT touch score normalization yet, produce a
research-only design note instead." This document does exactly that and nothing more.

## 1. What the current code actually does (PROVEN, by source inspection)

`evaluateAll()` (quant strategy engine) sorts all 21 strategies' evaluations descending by raw
`setupScore` and hands that array to `bestStrategyIdea()`, which unconditionally picks `eligible[0]`
— the single highest raw `setupScore` across every strategy family, with no per-strategy adjustment.
`StrategyExplorationScheduler.selectWithBoundedExploration()` (Phase 15) only bounds *how often* a
non-top pick is allowed to be promoted instead of the natural top pick — it does not change the
underlying comparison, which remains raw cross-strategy `setupScore` ranking (confirmed at
`src/server/quant/strategies/StrategyExplorationScheduler.ts:4-58`, comment block explicitly says
"sorts them by setupScore" and "unconditionally picks only eligible[0]").

## 2. The real evidence that motivates this question (PROVEN, Phase 17 audit)

The Phase 17 forensic audit measured real `setupScore` distributions across strategy families in
this deployment and found they are **not on a comparable scale**:

- `MEAN_REVERSION`: mean setupScore ≈ 18.3
- `OSCILLATOR_MOMENTUM`: mean setupScore ≈ 76.7

A ~4x difference in typical score magnitude between two CORE-adjacent families means raw
cross-strategy comparison structurally favors whichever strategy's scoring function happens to
produce larger numbers, independent of which one is actually a better trade candidate. This is the
concrete mechanism behind the CRM/ONON finding: a strategy with an intrinsically low-scoring formula
can be correctly evaluated, correctly eligible, and still never win natural promotion because its
whole score range sits below other strategies' floor.

## 3. Do strategy condition counts differ, and does that explain the gap? (PROVEN, correlational)

Yes — strategies with more confirming conditions/filters chained into their score (e.g. multi-factor
oscillator confluence) tend to produce compounding, larger scores than single-signal mean-reversion
formulas that intentionally stay conservative near a reversion band. This is consistent with, but not
a complete explanation for, the magnitude gap above — each strategy file (`src/server/quant/strategies/
*.ts`) defines its own scoring formula independently, with no shared normalization contract between
them. This is an architectural property (independent per-strategy scoring functions), not a bug in
any single strategy's math.

## 4. Would percentile/z-score normalization be statistically appropriate? (INFERRED — real trade-offs, no clear winner)

Considered and rejected as "the obvious fix" for now, for concrete reasons:

- **Percentile normalization requires a stable reference distribution.** Computing a live percentile
  needs either (a) a rolling historical sample of that strategy's own past `setupScore` values, which
  does not currently exist as a maintained store, or (b) the current cross-sectional snapshot across
  symbols at evaluation time, which is unstable intraday (few symbols actively evaluated at any one
  moment inflates/deflates percentile estimates from run to run).
- **Look-ahead risk.** A percentile computed from a rolling window that includes the evaluation bar
  itself (or backfilled future bars during backtest/replay) would leak information not available at
  decision time — this is exactly the class of bug `canonicalNextBarEngine.ts` (NEXT_BAR_OPEN) exists
  to prevent elsewhere in this codebase. Any normalization implementation must be built strictly
  point-in-time, using only completed prior bars, or it silently corrupts every backtest/replay
  metric that consumes normalized scores downstream.
- **Small-sample instability.** Several strategy families do not fire often enough per symbol per day
  to build a statistically meaningful rolling distribution quickly; a percentile against 5–10 samples
  is noisy and could flip a promotion decision on outlier draws.

None of these are unsolvable, but none is "just add a z-score" either — each requires new persisted
state, a point-in-time contract, and a minimum-sample floor before it can be trusted, which is exactly
the kind of design decision the Phase 18 mission asked to be deferred rather than implemented ad hoc.

## 5. Does per-strategy calibration already exist anywhere? (PROVEN, but at the wrong granularity)

Yes, but not at the strategy-family level this question is about. `ReflectionEngine` (~60s cycle)
scores *agent-level* predictions against realized price and updates `agent_performance_stats.
currentWeight` — this recalibrates how much ChiefTrader trusts each **idea agent** (TechnicalAgent,
NewsEngine, FundamentalAgent, etc.), not how comparable one **quant strategy's** setupScore is to
another's. There is currently no equivalent recalibration loop scoped to individual quant strategies
inside `evaluateAll()`'s own ranking step. Reusing `ReflectionEngine`'s existing pattern (weight
learned from real outcome history) at the strategy level is a plausible future design, not something
that exists today.

## 6. Would strategy-specific thresholds be safer than global percentile normalization? (INFERRED)

Likely yes, as a smaller and more auditable first step than distributional normalization:
- A fixed, config-driven "eligible-if-above-X" floor per strategy (already partially present as the
  existing eligibility gate, separate from the cross-strategy ranking step) is simpler to reason about,
  requires no rolling-window state, and has no look-ahead surface.
- It does not, by itself, fix ranking *among* eligible strategies — it only raises or lowers each
  strategy's bar for eligibility. The CRM/ONON-style problem (an eligible-but-low-raw-score strategy
  losing every natural-pick comparison) would still need a ranking-side answer, not just an
  eligibility-side one.
- This is why Part 8 (Invariant 9 / backward compatibility) of the fairness fix in this same phase was
  deliberately scoped to admission fairness (rescue slots) rather than attempting to also fix ranking
  fairness (setupScore comparison) in the same change — mixing an admission fix with a scoring-model
  change in one commit would have made the safety-diff review (Part 11) much harder to audit cleanly.

## 7. Should ranking consider Expected Value instead of (or alongside) raw setupScore? (INFERRED — real infrastructure already exists)

`src/server/quant/risk/ExpectedValue.ts` already exports `expectedValue(winProbability, rrRatio)` and
is real, tested infrastructure used today to **suppress** Quant ideas (an idea can be vetoed for
negative EV) — it is not currently used to **rank** among strategies with positive EV. Using EV as a
secondary or primary ranking key instead of raw `setupScore` is architecturally straightforward to
wire (the computation already exists), but requires answering a prior question this note does not
resolve: does every strategy currently produce a calibrated `winProbability` and `rrRatio` pair
suitable for EV computation, or would some strategies need new estimation logic added first? That
audit was out of scope for this research note and should be the first task of any follow-on
implementation phase.

## 8. Summary recommendation (INFERRED, not a decision — for the operator/repository owner to make)

In order of increasing implementation risk:
1. **Do nothing yet.** The Phase 18 rescue-fairness fix already gives currently-starved
   exploration/mover candidates a reserved data-availability path; it does not touch ranking. Observe
   `exploration-health` output over real sessions first — it is possible the admission fix alone
   meaningfully changes outcomes for some of the previously-starved candidates before any ranking
   change is attempted.
2. **Per-strategy eligibility floors** (config-driven, no rolling state, no look-ahead risk) as a
   smaller, more auditable first step than full normalization.
3. **EV-based secondary ranking** among eligible strategies, contingent on confirming every core/
   experimental strategy can produce a trustworthy `winProbability`/`rrRatio` pair.
4. **Percentile/z-score cross-strategy normalization**, only after a point-in-time-safe rolling
   distribution store exists and a minimum-sample floor is defined — the highest-effort, highest-risk
   option, and not recommended as a first move.

This note makes no changes to `evaluateAll()`, `bestStrategyIdea()`, `StrategyExplorationScheduler`,
`setupScore` formulas, `ExpectedValue.ts`, or any config file. It is evidence and options only.
