---
kind: method
family: portfolio
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
argus_refs:
  - src/server/research/kellyResearch.ts
  - src/server/quant/risk/ExpectedValue.ts
sources:
  - { title: "A New Interpretation of Information Rate", authors: "J. L. Kelly Jr.", year: 1956, url: "https://doi.org/10.1002/j.1538-7305.1956.tb03809.x", license: "academic" }
evidence_quality: 75
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: Kelly (1956) derived the bet fraction maximizing long-run logarithmic growth: for a binary bet with win probability `p`, win/loss ratio `b`, the optimal fraction is `f* = (bp − q)/b` (`q = 1 − p`).
- RESEARCH FINDING: Full Kelly is rarely used in practice because it maximizes growth at the cost of extreme volatility — practitioners (Thorp, Buffett's managers, professional gamblers) use *fractional* Kelly (`f = c·f*`, `c ∈ [0.25, 0.5]`) trading growth for drawdown control. The half-Kelly drawdown profile is well documented in the practitioner literature.
- RESEARCH FINDING: Kelly's optimality assumes *known* probabilities and payoffs; with estimated `p` and `b`, full Kelly systematically overbets — estimation error converts directly into overbetting, the same pathology as Markowitz with noisy means.
- VERIFIED FACT: Argus has a research-only Kelly implementation (`kellyResearch.ts` → `fractionalKelly` in `ExpectedValue.ts`) that explicitly returns `usedByRiskEngine: false` — it is not wired into sizing (verified by repo read 2026-10-05).
- INFERENCE: Kelly answers a different question than RiskEngine's current fixed-fraction sizing: "what fraction maximizes long-run growth given my edge statistics?" vs "what fraction keeps any single loss small?" Both are legitimate; Kelly needs validated edge statistics Argus does not yet have (organic closed paper P&L is 0).
- HYPOTHESIS: A defensible Argus path is fractional-Kelly *as a cap, not a target*: size = min(current risk-based size, c·f*) once per-strategy win-rate/payoff statistics clear a sample-size bar (`MIN_SAMPLE_SIZE_FOR_KELLY` already exists in the codebase).

## Mathematics
Binary: `f* = (bp − q)/b`. General (multiple outcomes): maximize `G(f) = Σ_i p_i·ln(1 + f·x_i)` over `f`, where `x_i` is the net-odds outcome. Continuous approximation: `f* ≈ μ/σ²` (excess return over variance) — the "Kelly fraction equals Sharpe over vol" form. Fractional: `f_c = c·f*`. Growth-drawdown tradeoff: half Kelly gives ~75% of full-Kelly growth at ~50% of the volatility (standard result, e.g. MacLean–Thorp–Ziemba literature).

## Economic rationale
Log-utility maximization: the long-run growth-optimal policy under repeated reinvestment. The economics are in the *compounding* insight — sizing is a growth-rate decision, not a per-trade risk decision. Misapplication (overbetting on phantom edge) is the leading cause of quant blowups, which is why the fractional form dominates practice.

## Argus mapping
EXISTS_INCOMPLETE. The math exists in TS research code; it is not in Java (violates the engine authority if promoted as-is), not wired to RiskEngine, and — critically — not fed by validated edge statistics. The existing `MIN_SAMPLE_SIZE_FOR_KELLY` gate shows the original author understood the estimation problem. Layer: portfolio construction / risk (sizing).

## Failure modes
(1) Overbetting on unvalidated edge — the base rate for retail Kelly blowups; Argus's zero organic paper P&L means `p` and `b` are currently *assumed*, and Kelly on assumptions is just leverage with footnotes. (2) Non-stationarity: Kelly fractions from a bull-market sample overbet the regime change. (3) Correlated simultaneous bets: univariate Kelly overbets a portfolio of correlated positions — needs the multivariate (growth-optimal portfolio) form.

## Verdict
RESEARCH FURTHER. Migrate the math to Java when sizing work is next touched (engine authority), keep it unwired, and define the promotion precondition explicitly: per-strategy OOS win-rate/payoff statistics with N ≥ the existing minimum-sample gate, then fractional (≤ half) Kelly as a *cap* on risk-based sizing — never as a lever to size up.
