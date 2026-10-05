---
kind: method
family: portfolio
status: RESEARCHED
argus_status: MISSING_HIGH
argus_refs: []
sources:
  - { title: "Building Diversified Portfolios that Outperform Out-of-Sample", authors: "Marcos López de Prado", year: 2016, url: "https://doi.org/10.3905/jpm.2016.42.4.059", license: "academic" }
evidence_quality: 65
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: López de Prado (2016) proposes Hierarchical Risk Parity: use the correlation structure's hierarchy (tree clustering) to allocate, avoiding covariance-matrix inversion entirely.
- RESEARCH FINDING: The paper's simulations show HRP outperforming CLA (critical-line/Markowitz) and IVP out-of-sample, with the gap widening as the covariance matrix becomes more ill-conditioned. This is a *simulation* result on synthetic data-generating processes, not a market anomaly — evidence quality reflects that.
- RESEARCH FINDING: HRP needs no expected-return estimates at all — it is a pure risk-based allocator, which removes the noisiest input (mean returns) from the problem by construction.
- VERIFIED FACT: Argus has no HRP implementation (verified by repo search 2026-10-05); PyPortfolioOpt's HRP is the standard open-source reference (MIT).
- INFERENCE: HRP's real advantage for Argus is operational: deterministic, fast, no optimizer convergence failures, no corner solutions (weights don't collapse to 1-2 names) — the failure modes that make Markowitz unusable in an automated pipeline.
- HYPOTHESIS: For a small-N (3-10 position) long-only swing portfolio, HRP degrades gracefully to inverse-volatility weighting within clusters — sensible, but the diversification benefit is bounded by how few positions Argus holds.

## Mathematics
Three steps. (1) **Tree clustering:** distance `d_{i,j} = √[0.5·(1 − ρ_{i,j})]`; agglomerative clustering (single linkage) on `d`. (2) **Quasi-diagonalization:** reorder Σ's rows/columns by the dendrogram leaf order, so large covariances sit near the diagonal. (3) **Recursive bisection:** split the ordered list in halves; allocate between halves by inverse cluster variance: `α_1 = 1 − V_1/(V_1+V_2)`, `V_cluster = w̃'Σ_cluster w̃` with `w̃ ∝ 1/diag(Σ_cluster)` (inverse-variance weights inside the cluster); recurse. Base case: single asset keeps its weight. No matrix inversion anywhere.

## Economic rationale
Same family as risk parity: diversification as risk control, not alpha. The economic claim is narrower — HRP is a *robustification technique* for allocation under estimation error. It makes money only insofar as it prevents the concentrated blowups that naive optimizers produce.

## Argus mapping
MISSING_HIGH. Clean Java implementation target (pure linear algebra on the correlation matrix; ~200 lines). Belongs in the PORTFOLIO CONSTRUCTION layer, as the default multi-position allocator alongside (not replacing) the existing mean-variance optimizer. Prerequisite: none beyond a correlation matrix — but shrinkage still helps the clustering input. Note the charter layering: HRP allocates across *positions*, never generates signals. Layer: portfolio construction.

## Failure modes
(1) Single-linkage chaining on noisy correlations can produce degenerate clusters — use a linkage sanity check or average linkage. (2) With highly correlated universes (all tech), the tree is flat and HRP ≈ equal weight — harmless but no better than 1/N. (3) Ignores expected returns entirely: if Argus ever has genuine return forecasts, HRP leaves that information on the table (that's what Black-Litterman is for).

## Verdict
PROMOTE to specified → implemented in Java (from the paper + PyPortfolioOpt reference, clean-room). Best near-term portfolio-construction upgrade: robust, deterministic, no optimizer pathology, testable against 1/N and Markowitz on Argus's own paper-trade history.
