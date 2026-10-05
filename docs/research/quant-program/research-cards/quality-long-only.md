---
strategy: "Quality factor, long-only tilt (QMJ long leg)"
family: "factor"
source: { paper: "Quality Minus Junk", authors: "Asness, Frazzini, Pedersen", year: 2019, url: "https://doi.org/10.2469/dig.v44.n1.18", license: "academic (CFA Digest summary of the 2013 AQR working paper; journal version Review of Accounting Studies 2019)" }
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
evidence_quality: 80
last_reviewed: 2026-10-05
---

## Economic rationale
Risk-based + behavioral: high-quality companies (profitable, growing, safe) should trade at a premium, but leverage constraints, benchmarking, and lottery preferences push investors toward junk — leaving a quality premium. Asness–Frazzini–Pedersen frame it as the flip side of the leverage-aversion / betting-against-beta mechanism. The "who pays" is benchmark-constrained and leverage-constrained capital.

## Mathematical definition
QMJ quality score per stock (AFP 2019): `Quality = z(Profitability) + z(Growth) + z(Safety) (+ z(Payout))`, where Profitability = gross profits/assets, ROE, ROA, cash flow/assets, gross margin, low accruals; Growth = 5-yr growth in those profitability measures; Safety = low beta, low leverage, low bankruptcy risk (Ohlson O / Altman Z), low ROE volatility. Each component cross-sectionally z-scored, then summed. Long-only variant: tilt toward top-quintile quality (overweight or long-only selection), no short leg.

## Signal construction
1. Collect as-reported fundamentals (profitability, leverage, growth — point-in-time).
2. Cross-sectional z-score per metric, sum to quality score (matches the existing `SmartBetaFactorEngine` value/quality pattern).
3. Rank universe; long-only: select top-quintile quality names passing Argus's liquidity screens; rebalance quarterly (fundamentals refresh slowly).

## Entry / Exit / Position sizing
Entry: quarterly rebalance into top-quintile quality. Exit: falls out of the top-40% buffer zone (drops out of quality quintile buffer zone — use a buffer to control turnover) or thesis invalidation (existing `thesisInvalidation.json` mechanism). Sizing: equal-weight or quality-score-proportional within the sleeve; sleeve capped as a fraction of the book.

## Required data & frequency
Fundamentals (quarterly, point-in-time): gross profits, assets, ROE/ROA components, leverage ratios, beta. Daily OHLCV for execution. Same data-availability HYPOTHESIS as PEAD — AlphaVantage coverage of these exact fields is unverified in this task.

## Transaction-cost sensitivity
LOW. Quarterly rebalance, low turnover, large-cap-tilted universe. The cheapest factor to trade in this set.

## Expected capacity
HIGH. Quality is a slow, large-cap-friendly signal.

## Regime dependence
Defensive character: quality outperforms in drawdowns and underperforms in speculative junk rallies (the "pain trade" is watching low-quality rally without you). Persistent across decades and markets in the AFP sample (US + 24 countries).

## Known weaknesses
- Slow signal: quarterly refresh means the portfolio can hold deteriorating names for months — needs the thesis-invalidation overlay.
- Definition risk: "quality" has many parameterizations; the AFP composite is canonical but any deviation is a researcher degree of freedom (pre-register the exact definition).
- Value interaction: quality at any price underperforms quality-at-reasonable-price; consider the value×quality interaction (Fama-French RMW/CMA territory) as a later refinement.

## Academic evidence
Asness–Frazzini–Pedersen (2019): QMJ earns significant risk-adjusted returns in the US (1957–2016) and globally; the long leg contributes positively on its own. Novy-Marx (2013, "The Other Side of Value") independently documents gross-profitability premia. Fama–French 5-factor (2015) absorbs profitability (RMW) and investment (CMA) as formal factors.

## Post-publication evidence
QMJ post-2019 has been mixed — quality had a strong 2020–2022 (defensive bid) and softer periods since; no clean refutation, but forward returns below the backtest, consistent with publication decay plus the general factor-crowding debate. The long-only implementation has fared better than the long-short (no short-side crowding/rebate drag).

## Crowding risk
MEDIUM. "Quality" is the most marketed smart-beta label in the industry; explicit quality ETFs run the same screen. Mitigant: Argus's version can use the full AFP composite (most ETFs use cruder proxies) and quarterly patience.

## Complexity
MEDIUM. Math is simple z-score composites; data plumbing (point-in-time fundamentals) is the work — shared with the PEAD card.

## Argus relevance
7/10 — signal layer. `SmartBetaFactorEngine` already computes value/quality scores in Java (RESEARCH, idle, caller-supplied fundamentals) — the math half exists; the data-feed half and the paper wiring don't. Pairs naturally with the existing value work as a quality sleeve.

## Confidence
50% that a long-only quality sleeve adds net-of-cost value vs Argus's current opportunity set. What would change it: (a) fundamentals data verified point-in-time; (b) backtest showing the sleeve diversifies (not duplicates) the existing momentum/stat-arb exposures; (c) evidence the post-2019 decay is terminal rather than cyclical.

## Verdict
RESEARCH FURTHER — implement the data spike jointly with PEAD (same fundamentals feed question), then wire the *existing* `SmartBetaFactorEngine` quality scores to a paper vote service. Do not build a second quality engine; the Java math already exists.
