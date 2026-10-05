---
strategy: "52-week-high momentum"
family: "momentum"
source: { paper: "The 52-Week High and Momentum Investing", authors: "George, Hwang", year: 2004, url: "", license: "academic (Journal of Finance 59(5); verify DOI before citing)" }
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
evidence_quality: 75
last_reviewed: 2026-10-05
---

## Economic rationale
Behavioral anchoring: investors use the 52-week high as a reference point and are reluctant to bid prices through it (anchoring bias, Tversky–Kahneman), so good news diffuses slowly near highs — creating continuation. George & Hwang (2004) show nearness to the 52-week high predicts returns *better* than past returns alone and subsumes much of individual-stock momentum.

## Mathematical definition
Signal: `nearness_{i,t} = P_{i,t} / max(P_{i,t−252..t})` — current price divided by the trailing 252-day high. Each month, long stocks with nearness close to 1 (top 30%); the paper's long-short also shorts nearness-close-to-0, but Argus uses the long leg only (no shorting).

## Signal construction
1. Trailing 252-trading-day rolling maximum of closes (adjust for splits/dividends — the existing corporate-action check applies).
2. Compute nearness ratio daily; rank the liquid universe.
3. Enter on month-end (paper spec) or on a daily trigger variant: nearness crosses above 0.9 with the high at least 20 days old (avoids buying the exact breakout tick).

## Entry / Exit / Position sizing
Entry: top-decile nearness among liquid names. Exit: nearness falls below 0.7, or 6-month time stop (momentum decay), or stop-loss per `tradingSafety.stopLossAssumptionPct`. Sizing: equal-weight; cap names per sector to avoid a single-sector momentum cluster.

## Required data & frequency
Daily OHLCV only. 252-day lookback — trivially feasible.

## Transaction-cost sensitivity
MEDIUM. Monthly rebalance; the long leg trades less frantically than the long-short version. Breakout-chasing entries can suffer entry slippage — the 20-day-old-high filter mitigates buying exhaustion spikes.

## Expected capacity
MEDIUM-HIGH. Near-high stocks are liquid by construction.

## Regime dependence
Momentum-family: works in trending markets, suffers at sharp regime turns (same crash dynamics as TSMOM — the vol-scaling overlay in the risk-managed-momentum card applies here too). Anchoring logic weakens in low-attention microcaps (no analyst coverage → no anchor diffusion), so the liquid-universe restriction is a feature, not just a constraint.

## Known weaknesses
- Subsumption debate: later literature argues 52-week-high momentum and past-return momentum are hard to disentangle — for Argus this is fine (it holds both), but don't double-count them as independent signals in the ensemble (correlation-adjusted voting already handles this).
- The exact 252-day window and 0.9 threshold are researcher degrees of freedom; pre-register.
- Earnings-gap risk: buying near highs concentrates entries just before potential reversals on news.

## Academic evidence
George & Hwang (2004, JF): nearness to 52-week high predicts future returns; momentum profits are concentrated in stocks near their highs. Follow-ups (e.g. Huddart–Lang–Yetman 2009 on volume at highs; George–Hwang–Ni 2007 on anchoring vs options) support the behavioral mechanism. International replications exist but are thinner than for TSMOM.

## Post-publication evidence
Attenuated since publication but not dead — the standard momentum-decay pattern. The anchoring mechanism is harder to arbitrage than a pure price pattern (it's about *investor behavior* at reference points), which plausibly explains its persistence relative to simpler signals.

## Crowding risk
MEDIUM-LOW. Widely known, but the long-only implementation on a screened liquid universe is a crowded trade only in the sense that all momentum is crowded — no specific 52-week-high arbitrage vehicle dominates.

## Complexity
LOW. One rolling maximum and a ratio. The simplest card in this set.

## Argus relevance
8/10 — signal layer. `FiftyTwoWeekHighMomentumEngine.java` already exists in Java (RESEARCH, idle, zero consumers per the AGENTS.md inventory) — the math is built and waiting. What's missing: wiring to a paper vote service (same `InstitutionalStrategyVoteService` pattern as the TSMOM strategies), walk-forward validation, cost-aware evidence.

## Confidence
60% that wiring the existing engine to paper with proper validation yields a non-negative net-of-cost contribution. What would change it: walk-forward showing the engine's specific parameterization (thresholds, holding period) doesn't survive costs, or ensemble-correlation analysis showing it duplicates VolScaledMtfMomentum exactly (in which case: keep the better one, don't run both).

## Verdict
RESEARCH FURTHER — wire the existing Java engine to paper via the established vote-service pattern (flags default off), then walk-forward + cost-aware validation. No new math needed; this is an activation task, and activation is Argus's binding constraint per the AGENTS.md inventory note.
