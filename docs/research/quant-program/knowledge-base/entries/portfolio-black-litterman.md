---
kind: method
family: portfolio
status: RESEARCHED
argus_status: MISSING_MEDIUM
argus_refs: []
sources:
  - { title: "Global Portfolio Optimization", authors: "Fischer Black, Robert Litterman", year: 1992, url: "", license: "industry (Goldman Sachs, verify URL before citing)" }
  - { title: "The Intuition Behind Black-Litterman Model Portfolios", authors: "Guangliang He, Robert Litterman", year: 1999, url: "", license: "industry (Goldman Sachs, verify URL before citing)" }
evidence_quality: 70
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: Black-Litterman (1992) solves the "garbage in, gospel out" problem of mean-variance: start from equilibrium-implied returns (reverse optimization from market-cap weights), then blend in subjective views with explicit confidence — the optimizer can no longer produce extreme weights from noisy historical means.
- RESEARCH FINDING: He & Litterman (1999) give the canonical practitioner exposition: the posterior expected return is a precision-weighted average of the equilibrium prior and the views; with no views, BL collapses exactly to the market portfolio.
- VERIFIED FACT: Argus has no Black-Litterman implementation (verified by repo search 2026-10-05).
- INFERENCE: BL is the *principled interface* between Argus's multi-agent view generation (ChiefTrader debate, AI consensus, quant signals) and portfolio weights: agent views become `P, Q, Ω` matrices instead of ad-hoc confidence scores — but only once views are calibrated. Today Argus's view confidences are uncalibrated (the OpportunityScreener `0.35 + 4×return` precedent), so BL would currently launder uncalibrated opinions through respectable math.
- HYPOTHESIS: The highest-value Argus application is not stock views but *regime/timing views*: a small set of well-calibrated macro/regime views (from the HMM regime engine) blended with equilibrium, rather than dozens of noisy per-symbol views.

## Mathematics
Equilibrium prior: `Π = δ·Σ·w_mkt` (`δ` risk aversion, `w_mkt` market-cap weights). Views: `P·μ = Q + ε`, `ε ~ N(0, Ω)` (`P` K×N pick matrix, `Q` K×1 view returns, `Ω` K×K view uncertainty, diagonal). Posterior: `μ_BL = [ (τΣ)^{-1} + P'Ω^{-1}P ]^{-1} [ (τΣ)^{-1}Π + P'Ω^{-1}Q ]`, `Σ_BL = Σ + [ (τΣ)^{-1} + P'Ω^{-1}P ]^{-1}` (`τ` prior uncertainty scale, typically 0.025–0.05). Feed `μ_BL, Σ_BL` into the standard mean-variance optimizer. View confidence enters through `Ω`: `Ω_{kk} = (P_k τΣ P_k') / confidence_k`-style scaling.

## Economic rationale
Equilibrium grounding: in the absence of genuine information, hold the market — the only "neutral" portfolio with economic justification (CAPM). Views earn deviations from neutral only to the extent they carry real information, with confidence controlling the deviation size. The economics are humility formalized.

## Argus mapping
MISSING_MEDIUM — medium because the prerequisite (calibrated views) doesn't exist yet. When it does, BL sits in PORTFOLIO CONSTRUCTION between view generation (ALPHA SIGNALS/FORECASTS) and the optimizer. Java implementation target; PyPortfolioOpt has a reference implementation (MIT) for spec-checking. Layer: portfolio construction.

## Failure modes
(1) Uncalibrated views in → overconfident tilts out; BL cannot fix bad views, it only sizes them politely. (2) `τ` and `Ω` are judgment calls masquerading as parameters — sensitivity analysis mandatory. (3) Market-cap weights for `w_mkt` need a defined universe; Argus's universe is dynamic (discovery funnels), so the "market" must be defined (e.g. SPY-sector proxies or the tracked universe).

## Verdict
RESEARCH FURTHER, gated on view calibration. Do not implement until Argus can demonstrate that some view source (regime engine, quant ensemble, AI consensus) has calibrated, OOS-validated confidence. When that day comes, BL is the correct layering — not before.
