---
kind: strategy
family: momentum
status: IMPLEMENTED
argus_status: EXISTS_GOOD
argus_refs:
  - quant-core-java/src/main/java/io/argus/quantcore/strategy/institutional/TimeSeriesMomentum12MStrategy.java
  - quant-core-java/src/main/java/io/argus/quantcore/strategy/institutional/VolScaledMtfMomentumStrategy.java
sources:
  - { title: "Time Series Momentum", authors: "Moskowitz, Ooi, Pedersen", year: 2012, url: "https://doi.org/10.1016/j.jfineco.2011.11.003", license: "academic" }
  - { title: "Two Centuries of Trend-Following", authors: "Hurst, Ooi, Pedersen", year: 2017, url: "https://www.aqr.com/Insights/Research/Journal-Article/AT-Century-of-Evidence-on-Trend-Following-Investing", license: "academic" }
evidence_quality: 85
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: 12-month trailing-return sign predicts next-month return across 58 futures (1985-2009), diversified Sharpe ~1.0 (MOP 2012).
- RESEARCH FINDING: Trend-following evidence extends ~137 years across markets (Hurst-Ooi-Pedersen 2017).
- RESEARCH FINDING: Momentum crashes exist: Daniel & Moskowitz (2016) document severe drawdowns at regime turns.
- HYPOTHESIS: Vol-scaling the signal (Sharpe-like units) improves cross-regime comparability vs raw returns.
- VERIFIED FACT: Argus implements two variants in Java (12-1 canonical; 20/60d vol-scaled MTF), both RESEARCH status, paper-wiring in progress 2026-10-05.

## Mathematics
Signal: `s_t = sign(R_{t-252:t-21})`, where `R` is cumulative log return, most recent 21d skipped (12-1).
Vol-scaled score: `z = (R * 252/k) / sigma_ann`, `sigma_ann` = annualized stdev of daily log returns.
Position (MOP): sized to constant vol target (~40% ann. per instrument), equal-weighted, monthly rebalance.

## Economic rationale
Behavioral: initial underreaction + delayed overreaction; risk-based: momentum as compensation for crash risk at regime turns. Both debated; effect persists across centuries which weakens pure data-mining explanations.

## Argus mapping
EXISTS_GOOD as signal math (two Java strategies). Wiring to paper via InstitutionalStrategyVoteService (2026-10-05). Not yet: walk-forward validation, cost-aware net-Sharpe evidence.

## Failure modes
Regime-turn drawdowns (momentum crashes); whipsaw in choppy markets; turnover costs at high rebalance frequency.

## Verdict
PROMOTE to paper validation (wired 2026-10-05, flags default off). Require walk-forward + cost-aware evidence before any further promotion.
