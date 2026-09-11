# ARGUS — Phase 2 Preliminary Parity Checkpoint (2026-09-10)

**Status: real data, honestly small.** This is a first checkpoint on real accumulated
shadow-comparison data from the live paper engine — **not** the multi-day/week soak your own
mandate's Phase 4 gate requires before any live-vote consideration. 99 real observations over
~3.8 hours (2026-09-10T11:27–15:14Z), 28 real symbols. Reported honestly at this scale; do not
treat this as promotion evidence.

## Method

`QuantSignalAgent.ts`'s shadow caller (wired earlier today) compares TS's `bestStrategyIdea()`
result (filtered to the 5 CORE strategies only) against Java's real, bars-owning
`CoreStrategyRunner.runEnsemble()` result, logged as `QUANT_CORE_STRATEGY_PARITY_DIVERGENCE` to
`observability_events`. Queried directly from `data/argus.db` — not simulated, not sampled from
a synthetic fixture.

## Headline numbers

```
Total observations:        99
Direction agreement:       80.8% (80/99)
Java status:               89 HEALTHY, 10 UNAVAILABLE (insufficient bar history)
TS side distribution:      BUY 69, HOLD 16, SELL 14
Java side distribution:    BUY 71, SELL 17, HOLD 11
Avg confidence (agreements only): TS 0.659, Java 0.406
```

## Every disagreement, classified (0 UNKNOWN)

| Class | Count | Symbols | Root cause |
|---|---|---|---|
| `DATA_ALIGNMENT` | 6 | GS, SQQQ | Java's `CoreStrategyRunner` reported `status: UNAVAILABLE` — fewer than `MIN_BARS` (210) days of history available to the bars payload at evaluation time. Not a formula bug; a real data-completeness gap for these two symbols specifically at these moments. |
| `STRATEGY_LOGIC` (methodology difference, not a bug) | 12 | MSFT, META, NVDA, ALHC, M, KLAC, VNCE | TS's `bestStrategyIdea()` returned HOLD (no single CORE strategy cleared `MIN_STRATEGY_CONFIDENCE_TO_TRADE` individually) while Java's `QuantEnsembleEngine.combine()` found a real, if modest (0.27–0.53), correlation-weighted majority across the 5 strategies. **This is a genuine aggregation-methodology difference, not a defect in either side**: TS asks "does any one strategy clear a bar," Java asks "does the correlation-adjusted ensemble of all five resolve to a side." Worth knowing before ever comparing the two as if they compute the same thing. |
| `OTHER` (real disagreement, both sides had data) | 1 | ARM | TS=SELL(0.67), Java=HOLD(effIndep=0) — Java's own 5-strategy ensemble found no majority side despite real, sufficient data (`status: HEALTHY`). A genuine decision-boundary difference between the TS and Java strategy implementations for this case, not yet root-caused further — flagged, not investigated deeper at this sample size. |

## What this does and doesn't show

**Real, now confirmed:** the Phase 1 wiring works end-to-end against live market data — Java
computes its own features from real bars and produces real, non-fabricated ensemble decisions
that agree with TS's independent computation 80.8% of the time on direction. The `DATA_ALIGNMENT`
cases point at a concrete, fixable follow-up (some bars-window fetches are coming up short of 210
days for certain symbols) rather than a systemic issue.

**Not shown, and not claimed:** promotion-grade evidence. 99 samples over one partial session is
not the "real, dated, multi-week clean-divergence soak" your own architecture doc requires before
any of this touches a live vote. Per-strategy (not ensemble-level) parity also isn't measured here
— the shadow caller compares the 5-strategy *ensemble* output, not each CORE strategy
individually, so Phase 3's "each of the 5 CORE strategies individually validated" claim cannot
honestly be made from this dataset alone.

## What I did not do, and why

- **Did not wire this into ChiefTrader (Phase 4).** Your mandate's own gate requires real runtime
  evidence at a scale this ~4-hour checkpoint does not meet. Doing so now would be exactly the
  premature promotion the whole session's discipline has been built to avoid.
- **Did not attempt OOS/WFO (Phase 5).** Requires real elapsed calendar days by definition: cannot
  be produced from a few hours of same-day data no matter how it's sliced.
- **Did not fabricate per-strategy parity** for the individual CORE strategies — only the ensemble
  comparison exists in this data; said so plainly above rather than implying otherwise.

## Recommended next real step

Let this shadow comparison keep running across real trading days (it already is, no action
needed) and re-run this same query in a week — that's the actual path to Phase 2/3 evidence your
mandate asks for, not something that can be shortcut. Separately, worth a bounded look at why GS
and SQQQ's bars fetches came up short of 210 days in the `DATA_ALIGNMENT` cases — a concrete,
small, fixable item if you want it investigated.
