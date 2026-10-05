---
kind: concept
family: portfolio
status: RESEARCHED
argus_status: MISSING_HIGH
argus_refs:
  - quant-core-java/src/main/java/io/argus/quantcore/institutional/models/OjAlgoPortfolioRiskEngine.java  # notes risk-parity as unimplemented
sources:
  - { title: "Risk Parity Portfolios", authors: "Edward Qian", year: 2005, url: "", license: "industry whitepaper (PanAgora)" }
  - { title: "Leverage Aversion and Risk Parity", authors: "Asness, Frazzini, Pedersen", year: 2012, url: "", license: "academic (Journal of Financial Economics 103(1); verify DOI before citing)" }
evidence_quality: 70
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: Risk parity allocates so each asset contributes equally to portfolio risk, rather than equally to capital. Qian (2005) formalized the risk-budgeting framework adopted by institutional "risk parity" funds (Bridgewater All Weather lineage).
- RESEARCH FINDING: Asness–Frazzini–Pedersen (2012) show risk parity's historical outperformance vs 60/40 is largely explained by leverage aversion: levering low-risk assets earns the leverage-aversion premium; unlevered risk parity is mostly a low-risk anomaly tilt.
- VERIFIED FACT: Argus has no risk-parity optimizer — `OjAlgoPortfolioRiskEngine.java`'s own comment states a risk-parity optimizer "remain[s] unimplemented" (verified by repo search 2026-10-05).
- INFERENCE: For Argus's concentrated swing portfolio (few positions, long-only, no leverage), textbook risk parity is overkill — but its *risk-budgeting* generalization (cap any single position's risk contribution) is directly applicable to the existing PositionSizing/RiskEngine layer.
- HYPOTHESIS: Equal-risk-contribution across Argus's open positions would damp the common failure where 3 correlated tech longs each pass single-position gates but the portfolio is one concentrated bet.

## Mathematics
Portfolio volatility `σ_p = √(w'Σw)`. Marginal risk contribution `MRC_i = (Σw)_i / σ_p`; risk contribution `RC_i = w_i · MRC_i`, with `Σ_i RC_i = σ_p`. Equal risk contribution (ERC): find `w` with `RC_i = RC_j ∀i,j`, `Σw_i = 1`, `w ≥ 0`. Spinu (2013) cyclical coordinate descent solves it efficiently: iteratively `w_i ← w_i · √(RC_target / RC_i)`-style updates until convergence. True risk parity adds leverage to reach a vol target: `w_RP = (σ_target / σ_ERC) · w_ERC`.

## Economic rationale
Risk-based, not behavioral: diversification across *risk* rather than *capital*. The AFP (2012) result reframes it — much of the "alpha" is the low-risk/leverage-aversion premium plus embedded leverage, i.e. risk compensation, not market inefficiency. That doesn't make it useless; it makes the return source honest.

## Argus mapping
MISSING_HIGH as an optimizer; the risk-budgeting *constraint* belongs in the RISK layer (RiskEngine/PositionSizing), not as a standalone strategy. Natural Java home: extend the portfolio analytics module next to `MeanVarianceOptimizer`. Prerequisite: covariance shrinkage (see `portfolio-covariance-shrinkage`) — ERC on a raw sample covariance inherits all of Markowitz's instability. Layer: portfolio construction / risk.

## Failure modes
(1) Correlation breakdown: ERC assumes the estimated Σ describes the future; in a crisis, correlations → 1 and "equal risk" becomes equal exposure to the same shock. (2) Leverage: textbook risk parity needs leverage to hit return targets — Argus has none, so expect bond-like returns from a naive implementation; the value here is risk control, not return enhancement. (3) Turnover: rebalancing to ERC on noisy covariance estimates churns; rebalance bands required.

## Verdict
RESEARCH FURTHER → specify ERC-with-shrunk-covariance as a portfolio-level risk overlay (not a return strategy). Do not implement textbook levered risk parity — no leverage, no mandate. The risk-budget cap per position is the near-term win.
