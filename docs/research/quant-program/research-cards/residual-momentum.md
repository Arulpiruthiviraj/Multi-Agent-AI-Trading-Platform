---
strategy: "Residual (idiosyncratic) momentum"
family: "momentum"
source: { paper: "Residual Momentum", authors: "Blitz, Huij, Martens", year: 2011, url: "https://doi.org/10.1016/j.jempfin.2011.01.003", license: "academic (Journal of Empirical Finance)" }
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
evidence_quality: 75
last_reviewed: 2026-10-05
---

## Economic rationale
Decomposition insight: total-return momentum mixes systematic (factor-driven) continuation with idiosyncratic (stock-specific) continuation. Blitz–Huij–Martens (2011) show the idiosyncratic component is the stronger, more persistent predictor — systematic momentum is largely time-varying factor exposure in disguise, while residual momentum captures genuine slow diffusion of firm-specific news (the same underreaction mechanism as PEAD, at a different frequency).

## Mathematical definition
For each stock `i`, estimate over the formation window (12 months, skip most recent month): `r_{i,t} = α_i + β_i'F_t + ε_{i,t}` via OLS on Fama–French 3 factors (market, SMB, HML) — or, for the Argus-feasible simplification, a single-factor market model vs SPY. Residual return: `ε_{i,t}`. Signal: `resmom_{i} = Σ_{t∈[T−252, T−21]} ε_{i,t}` (cumulative residual over 12-1). Rank universe; long top decile (long-only variant).

## Signal construction
1. Rolling OLS of stock returns on benchmark/factor returns (252-day window, skip 21 days).
2. Cumulate residuals → residual momentum score.
3. Rank the liquid universe monthly; long top decile.

## Entry / Exit / Position sizing
Entry: top-decile residual momentum at month-end rebalance. Exit: falls below median, or 12-month time stop. Sizing: equal-weight; residual momentum is naturally diversified across factors (that's the point), but still cap sector concentration.

## Required data & frequency
Daily OHLCV for stocks + benchmark (SPY) or FF factors. 252-day lookback + regression — feasible.

## Transaction-cost sensitivity
MEDIUM. Monthly rebalance like other momentum variants; residual portfolios turn over slightly less than total-return momentum (residuals are less jumpy than raw returns).

## Expected capacity
MEDIUM. Same universe as momentum; fine for Argus's size.

## Regime dependence
More defensive than raw momentum: by construction it is factor-neutral-ish, so it doesn't inherit value/growth regime bets. Underperforms when the omitted factors are the whole story (e.g. a pure beta rally where idiosyncratic selection adds noise).

## Known weaknesses
- Factor-model dependence: "residual" is defined *relative to a model* — single-factor vs FF3 vs FF5 give different residuals; the choice is a researcher degree of freedom (pre-register; the single-factor SPY version is the defensible default for Argus).
- Estimation noise: 252-day rolling betas are noisy; residual = return − noisy fit, so part of the "signal" is estimation error. Shrinkage on beta (or the vasicek adjustment) is a refinement, not a prerequisite.
- Correlation with the existing stat-arb/residual engines: `ResidualReturnEngine.java` already computes residual momentum as one of its outputs — must not double-count in the ensemble.

## Academic evidence
Blitz–Huij–Martens (2011, JEMS): residual momentum earns higher risk-adjusted returns than total-return momentum, 1930–2009, and survives controls. Gutierrez & Pirinsky (2007) document firm-specific momentum at shorter horizons. The result has replicated in European and Asian samples (thinner than US).

## Post-publication evidence
Holds up reasonably — residual momentum attracted less arbitrage attention than headline momentum factors, and its factor-neutral construction aged well through the factor-crowding debates of the 2010s. No clean refutation found in this survey.

## Crowding risk
LOW-MEDIUM. Less trafficked than raw momentum; the implementation details (which factor model, which window) fragment whatever crowding exists.

## Complexity
MEDIUM. Rolling OLS per symbol per month — trivial compute, but the pipeline (aligned returns, regression, residual cumulation) has more moving parts than the 52-week-high card.

## Argus relevance
7/10 — signal layer. `ResidualReturnEngine.java` already computes `residualMomentum` (RESEARCH, idle) — like the 52-week-high card, the math exists and the gap is activation + validation. Also relevant as a *diagnostic*: decomposing any momentum signal into systematic vs residual halves tells you what you're actually betting on.

## Confidence
55% that a long-only residual-momentum sleeve beats raw TSMOM on risk-adjusted net-of-cost returns in Argus's universe. What would change it: (a) walk-forward showing the single-factor simplification loses the BHM result (their FF3 version may not survive simplification); (b) ensemble analysis showing it correlates >0.8 with existing momentum engines (then it's redundant, not diversifying).

## Verdict
RESEARCH FURTHER — activate the existing `ResidualReturnEngine.residualMomentum` output behind a paper vote flag, walk-forward vs the TSMOM baseline, and check ensemble correlation before treating it as an independent signal. Test the FF3-vs-single-factor simplification explicitly; don't assume BHM's result ports to the simplified version.
